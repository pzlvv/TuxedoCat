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
 *   全局单例，塞进同一个进程会互相污染。
 *
 * 用法：
 *   node scripts/run-tests.mjs                     # 全部
 *   node scripts/run-tests.mjs edit-diff bus       # 只跑名字里含这些片段的
 *   node scripts/run-tests.mjs --list              # 只列不跑
 *   node scripts/run-tests.mjs --bail              # 首个失败即停
 *
 * 通常经 `npm run test:all [-- <片段>]` 调用（它先编译再进来）。
 *
 * 不跑这里的东西：`src/test/vscodeHost/`（需要真实 VS Code 宿主，走 `npm test`）、
 * `src/test/memtest/`（Playwright 性能 harness，手动跑）、`src/test/helpers/`（夹具）。
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(repoRoot, 'src', 'test');
const outDir = join(repoRoot, 'out', 'src', 'test');
const TEST_SUFFIX = '.test.ts';
const COMPILED_SUFFIX = '.test.js';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((arg) => arg.startsWith('-')));
const filters = argv.filter((arg) => !arg.startsWith('-'));

if (flags.has('--help') || flags.has('-h')) {
  console.log(`用法: node scripts/run-tests.mjs [片段...] [--list] [--bail]

自动发现并运行 src/test/*.test.ts（编译产物在 out/src/test/）。
  片段      只跑文件名包含该片段的用例，可给多个
  --list    只列出将被运行的用例
  --bail    第一个失败就停止`);
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

/** 跑一个测试文件；子进程退出码即结论 */
function runOne(name) {
  const jsPath = join(outDir, `${name}${COMPILED_SUFFIX}`);
  if (!existsSync(jsPath)) {
    console.error(`FAIL ${name}：缺少编译产物 ${relative(repoRoot, jsPath)}（先跑 npm run compile-tests）`);
    return Promise.resolve({ name, outcome: 'fail', ms: 0 });
  }

  const startedAt = Date.now();
  return new Promise((settle) => {
    const child = spawn(process.execPath, [jsPath], {
      cwd: repoRoot,
      // 不捕获输出：受限沙箱里给子进程开管道会 EPERM，且直通输出让失败现场原样可见。
      // 结论只依赖退出码，不依赖解析文本。
      stdio: 'inherit',
    });
    child.on('error', (err) => {
      console.error(`FAIL ${name}：无法启动子进程 ${err.message}`);
      settle({ name, outcome: 'fail', ms: Date.now() - startedAt });
    });
    child.on('close', (code, signal) => {
      // 0=通过，3=有段落被 markSkipped（环境前置不满足，harness.ts 的退出码约定），
      // 其余=失败。跳过单列计数、不算失败：本地不构建 Core 产物时保住可用性，
      // 但「真实 Core 集成实际没跑」必须在汇总里可见，不能混进「通过」
      const outcome = code === 0 ? 'pass' : code === 3 ? 'skip' : 'fail';
      if (outcome === 'fail' && signal) {
        console.error(`FAIL ${name}：被信号 ${signal} 终止`);
      }
      settle({ name, outcome, ms: Date.now() - startedAt });
    });
  });
}

console.log(`运行 ${selected.length} 个测试文件（共发现 ${discovered.length} 个）\n`);

const results = [];
const startedAt = Date.now();
for (const name of selected) {
  console.log(`── ${name} ${'─'.repeat(Math.max(0, 60 - name.length))}`);
  const result = await runOne(name);
  const verdict =
    result.outcome === 'pass' ? '通过' : result.outcome === 'skip' ? '跳过（部分用例的环境前置不满足）' : '失败';
  console.log(`=> ${name} ${verdict}（${result.ms}ms）\n`);
  results.push(result);
  if (result.outcome === 'fail' && flags.has('--bail')) {
    console.log('--bail：遇到失败，提前结束。\n');
    break;
  }
}

const failed = results.filter((r) => r.outcome === 'fail');
const skippedFiles = results.filter((r) => r.outcome === 'skip');
const notRun = selected.length - results.length;
const nameWidth = Math.max(...results.map((r) => r.name.length));
const outcomeTag = { pass: 'ok  ', skip: 'skip', fail: 'FAIL' };

console.log('='.repeat(64));
for (const result of results) {
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
