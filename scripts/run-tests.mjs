#!/usr/bin/env node
/**
 * 单元测试聚合 runner。
 *
 * 为什么需要它：
 * - `tsc -p tsconfig.test.json` 只负责编译，不会执行任何用例；此前每个测试文件都得在
 *   package.json 里单独挂一条 `test:<name>` 脚本。结果是脚本越堆越多，而新写的测试
 *   一旦忘了挂脚本，就成了永远不跑的孤儿（历史上 `repetitionDetector`、`streamTimeout`
 *   就是这样躺了很久）。
 * - 这里按目录约定自动发现 `src/test/*.test.ts`，逐个用**独立 node 进程**运行。
 *   必须独立进程：每个测试文件都会 `setGlobalEventBus` / `setProjectRootProvider` 这类
 *   全局单例，塞进同一个进程会互相污染。既然本来就是「一文件一进程」，进程之间没有
 *   共享内存，那么**并发**执行不引入新的隔离问题——只多出一条要求：别在仓库工作树
 *   里写文件（见下面的 `SERIAL_FILES`）。
 *
 * 并发是墙钟的必需品：134 个文件串行合计约 62s，其中 5 个文件就吃掉 37s（它们各自
 * 在等网络 / 子进程 / 定时器），串行跑等于把这些等待直接相加。并发跑之后墙钟接近
 * 「最慢那个文件」而不是「所有文件之和」。
 *
 * 用法：
 *   node scripts/run-tests.mjs                     # 全部（默认并发数 = min(4, CPU 核数)）
 *   node scripts/run-tests.mjs edit-diff bus       # 只跑名字里含这些片段的
 *   node scripts/run-tests.mjs --list              # 只列不跑
 *   node scripts/run-tests.mjs --bail              # 首个失败即停（不再派发新文件）
 *   node scripts/run-tests.mjs --jobs 2            # 显式指定并发数
 *   node scripts/run-tests.mjs --serial            # 全部串行（排查并发相关问题时用）
 *
 * 环境变量 `<envPrefix>_TEST_JOBS` 优先于默认值、低于 `--jobs`（名字由
 * `project.config.cjs` 的 `envPrefix` 派生，不写死品牌字面量）。
 *
 * 输出：每个文件的 stdout / stderr 先缓冲，跑完再整段打印。并发直通输出会把两个文件
 * 的断言行交错在一起，失败现场反而看不清。
 *
 * 通常经 `npm run test:unit [-- <片段>]` 调用（它先编译再进来）。
 *
 * 不跑这里的东西：`src/test/vscodeHost/`（需要真实 VS Code 宿主，走 `npm test`）、
 * `src/test/memtest/`（Playwright 性能 harness，手动跑）、`src/test/helpers/`（夹具）。
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import project from '../project.config.cjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(repoRoot, 'src', 'test');
const outDir = join(repoRoot, 'out', 'src', 'test');
const TEST_SUFFIX = '.test.ts';
const COMPILED_SUFFIX = '.test.js';
/** 并发数的环境变量名（品牌字面量只在 `src/config/project.json` 定义一次） */
const JOBS_ENV = `${project.envPrefix}_TEST_JOBS`;

/**
 * 必须串行、且排在其他文件**之前**跑的文件。
 *
 * 判据：会在仓库工作树里写 / 改名 / 删除文件（不是临时目录）。并发或与别的文件交错时
 * 它们会踩到别人的输入：
 * - `docsLintLocalOnlyPaths` 把 `e2e/environments.json` 与 `resources/core/` 临时改名，
 *   期间 `standalone*` 系列会找不到 Core 产物而误报「跳过」；
 * - `docsLint` 往仓库根写一个临时 md 探针再删，期间 docsLint 自己的路径存在性检查
 *   会看到它。
 * 两者又都要扫全仓，所以先串行跑完它们，其余文件才进来。
 *
 * **前提：同一时刻只有一个 runner 进程。** 这份名单只在单进程内排序，管不住「两个
 * `npm run test:unit` 同时跑」——那种情况下前者的改名窗口照样会撞上后者的 standalone
 * 用例。本地要并行跑两个入口时，用 `--serial` 或给它们不同的工作区副本。
 */
const SERIAL_FILES = ['docsLint', 'docsLintLocalOnlyPaths'];

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((arg) => arg.startsWith('-')));
/** `--jobs N` 的取值（`--jobs=N` 也认）；非法值直接报错，不静默回落 */
function readJobsOption(args) {
  const inline = args.find((arg) => arg.startsWith('--jobs='));
  if (inline) return inline.slice('--jobs='.length);
  const index = args.indexOf('--jobs');
  return index === -1 ? null : (args[index + 1] ?? '');
}
const jobsOption = readJobsOption(argv);
// `--jobs N` 的 N 是选项值而不是文件名片段：跳过紧跟 `--jobs` 的那一个参数
// （`--jobs=N` 形式本身以 `-` 开头，下面的 flag 判定已经排除）
const jobsValueIndex = argv.indexOf('--jobs') === -1 ? -1 : argv.indexOf('--jobs') + 1;
const filters = argv.filter((arg, index) => !arg.startsWith('-') && index !== jobsValueIndex);

if (flags.has('--help') || flags.has('-h')) {
  console.log(`用法: node scripts/run-tests.mjs [片段...] [--list] [--bail] [--jobs N] [--serial]

自动发现并运行 src/test/*.test.ts（编译产物在 out/src/test/）。
  片段      只跑文件名包含该片段的用例，可给多个
  --list    只列出将被运行的用例
  --bail    第一个失败就停止（已在跑的文件不再打断，只是不再派发新的）
  --jobs N  并发文件数（默认 min(4, CPU 核数)；${JOBS_ENV} 可覆盖默认值）
  --serial  并发数降为 1`);
  process.exit(0);
}

if (!existsSync(outDir)) {
  console.error(`找不到编译产物目录 ${relative(repoRoot, outDir)}，先执行：npm run compile-tests`);
  process.exit(1);
}

/** camelCase → kebab-case：让 `host-info`、`edit-diff` 这类旧脚本写法照样能筛到 hostInfo / editDiff */
function kebabCase(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

// 从**源码**目录发现用例，而不是扫描 out/：
// 源码里新增了测试却没编译出来时，这里会直接报错，而不是把它静默跳过。
const discovered = readdirSync(sourceDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(TEST_SUFFIX))
  .map((entry) => entry.name.slice(0, -TEST_SUFFIX.length))
  .sort();

if (discovered.length === 0) {
  console.error(`没有在 ${relative(repoRoot, sourceDir)} 下找到任何 *${TEST_SUFFIX}`);
  process.exit(1);
}

let selected = discovered;
if (filters.length > 0) {
  selected = discovered.filter((name) => {
    const fragments = [name.toLowerCase(), kebabCase(name)];
    return filters.some((filter) => fragments.some((fragment) => fragment.includes(filter.toLowerCase())));
  });
  if (selected.length === 0) {
    console.error(`没有匹配 ${filters.map((f) => `"${f}"`).join(' / ')} 的用例。`);
    console.error(`可选项：${discovered.join('、')}`);
    process.exit(1);
  }
}

if (flags.has('--list')) {
  for (const name of selected) {
    console.log(name);
  }
  process.exit(0);
}

/**
 * 解析并发数：`--jobs N` > `${JOBS_ENV}` > `min(4, CPU 核数)`。
 *
 * 上限默认 4 而不是「核数」：CI 的托管 runner 是 2–4 核，本地开发机动辄 16 核，
 * 但每个测试文件都可能自己再起子进程（`standalone*` 驱动真实 Core、`fileLock` 起
 * node 子进程），并发数再高只是把它们互相抢 CPU。4 是「等 I/O 的同时不把核占满」。
 */
function resolveJobs() {
  if (flags.has('--serial')) return 1;
  // `--jobs` 给了却没带值（`--jobs` 结尾）与空字符串同样算错：宁可报错也不静默回落到
  // 默认并发数——CI 上「以为限了并发，其实跑的是 4 路」比直接红更难查。
  if (jobsOption !== null && jobsOption.trim() === '') {
    console.error('--jobs 需要一个值（>= 1 的整数）。');
    process.exit(1);
  }
  const raw = jobsOption !== null ? jobsOption : process.env[JOBS_ENV];
  if (raw === undefined || raw.trim() === '') return Math.min(4, Math.max(1, cpus().length));
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    console.error(`无效的并发数 "${raw}"：要一个 >= 1 的整数（--jobs N / ${JOBS_ENV}）。`);
    process.exit(1);
  }
  return parsed;
}

const jobs = resolveJobs();

/** 跑一个测试文件；子进程退出码即结论。stdout / stderr 缓冲后随结果一并返回 */
function runOne(name) {
  const jsPath = join(outDir, `${name}${COMPILED_SUFFIX}`);
  if (!existsSync(jsPath)) {
    return Promise.resolve({
      name,
      outcome: 'fail',
      ms: 0,
      output: `FAIL ${name}：缺少编译产物 ${relative(repoRoot, jsPath)}（先跑 npm run compile-tests）\n`,
    });
  }

  const startedAt = Date.now();
  return new Promise((settle) => {
    const child = spawn(process.execPath, [jsPath], {
      cwd: repoRoot,
      // 捕获而不是 inherit：并发下直通输出会把两个文件的断言行交错在一起，失败现场
      // 反而更难读。缓冲后按文件整段打印（顺序与串行一致）。结论只看退出码。
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', (err) => {
      settle({
        name,
        outcome: 'fail',
        ms: Date.now() - startedAt,
        output: `${output}FAIL ${name}：无法启动子进程 ${err.message}\n`,
      });
    });
    child.on('close', (code, signal) => {
      // 0=通过，3=有段落被 markSkipped（环境前置不满足，harness.ts 的退出码约定），
      // 其余=失败。跳过单列计数、不算失败：本地不构建 Core 产物时保住可用性，
      // 但「真实 Core 集成实际没跑」必须在汇总里可见，不能混进「通过」
      const outcome = code === 0 ? 'pass' : code === 3 ? 'skip' : 'fail';
      const signalNote =
        outcome === 'fail' && signal ? `FAIL ${name}：被信号 ${signal} 终止\n` : '';
      settle({ name, outcome, ms: Date.now() - startedAt, output: output + signalNote });
    });
  });
}

/**
 * 跑一组用例，同时最多 `jobs` 个子进程。
 *
 * `runOne` 一次只返回结论，打印由调用方按文件名顺序做——这样并发不会打乱日志，
 * 单文件失败时现场仍然完整。
 */
async function runAll(names, results) {
  const pending = [...names];
  const running = new Map();
  let bailing = false;

  const start = (name) => {
    const promise = runOne(name).then((result) => {
      running.delete(name);
      results.push(result);
      return result;
    });
    running.set(name, promise);
  };

  while (pending.length > 0 || running.size > 0) {
    while (!bailing && pending.length > 0 && running.size < jobs) {
      start(pending.shift());
    }
    if (running.size === 0) break;
    // 任一文件跑完就立刻补位（不是「等一批全完成」），否则最慢的那条会把整批拖住
    const finished = await Promise.race(running.values());
    if (finished.outcome === 'fail' && flags.has('--bail')) {
      bailing = true;
      console.log('--bail：遇到失败，不再派发新文件。\n');
    }
  }
}

console.log(
  `运行 ${selected.length} 个测试文件（共发现 ${discovered.length} 个，并发 ${jobs}）\n`,
);

const results = [];
const startedAt = Date.now();

// 先串行跑会动仓库工作树的那几个，再并发跑其余
const serialFirst = selected.filter((name) => SERIAL_FILES.includes(name));
const rest = selected.filter((name) => !SERIAL_FILES.includes(name));
let bailTriggered = false;
for (const name of serialFirst) {
  console.log(`── ${name}（串行）${'─'.repeat(Math.max(0, 48 - name.length))}`);
  const result = await runOne(name);
  results.push(result);
  process.stdout.write(result.output);
  const verdict =
    result.outcome === 'pass' ? '通过' : result.outcome === 'skip' ? '跳过（部分用例的环境前置不满足）' : '失败';
  console.log(`=> ${name} ${verdict}（${result.ms}ms）\n`);
  if (result.outcome === 'fail' && flags.has('--bail')) {
    console.log('--bail：遇到失败，提前结束。\n');
    bailTriggered = true;
    break;
  }
}

if (rest.length > 0 && !bailTriggered) {
  await runAll(rest, results);
  // 缓冲的输出按文件名顺序打印，与串行时的观感一致
  for (const result of [...results].filter((r) => rest.includes(r.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`── ${result.name} ${'─'.repeat(Math.max(0, 60 - result.name.length))}`);
    process.stdout.write(result.output);
    const verdict =
      result.outcome === 'pass' ? '通过' : result.outcome === 'skip' ? '跳过（部分用例的环境前置不满足）' : '失败';
    console.log(`=> ${result.name} ${verdict}（${result.ms}ms）\n`);
  }
}

const failed = results.filter((r) => r.outcome === 'fail');
const skippedFiles = results.filter((r) => r.outcome === 'skip');
const notRun = selected.length - results.length;
const nameWidth = Math.max(...results.map((r) => r.name.length));
const outcomeTag = { pass: 'ok  ', skip: 'skip', fail: 'FAIL' };

console.log('='.repeat(64));
// 汇总按文件名排序：并发下完成顺序不固定，观感与串行时保持一致
for (const result of [...results].sort((a, b) => a.name.localeCompare(b.name))) {
  console.log(
    `${outcomeTag[result.outcome]} ${result.name.padEnd(nameWidth)}  ${String(result.ms).padStart(6)}ms`,
  );
}
console.log('='.repeat(64));
console.log(
  `${results.length - failed.length - skippedFiles.length} 通过 / ${failed.length} 失败` +
    (skippedFiles.length > 0 ? ` / ${skippedFiles.length} 跳过` : '') +
    (notRun > 0 ? ` / ${notRun} 未运行` : '') +
    `，总耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
);
if (skippedFiles.length > 0) {
  console.log(
    `\n跳过（环境前置不满足，跑的是 skip 分支，原因见上方各文件的 skip 行）：${skippedFiles.map((r) => r.name).join('、')}`,
  );
}

if (failed.length > 0) {
  console.log(`\n失败：${failed.map((r) => r.name).join('、')}`);
  process.exitCode = 1;
}
