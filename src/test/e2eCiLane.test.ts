/**
 * CI 车道与 secrets 的一致性（`e2e/README.md` 的「CI 车道」一节）。
 *
 * 为什么要有这条守卫：`electron-ssh` 车道的环境文件由 secrets 现写，链路是
 * `all.yml 的 env 块` → `scripts/write-e2e-environments.mjs` → `e2e/environments.json`。
 * 三处任一处改名而另两处没跟上时，失败只发生在**整点定时的全量车道**上，而且长得像
 * 「远端环境坏了」：脚本读不到变量 → 写文件报错，或写入的字段名对不上
 * `requireSshEnvironment()` 的类型 → 用例收集期报错。MR 的冒烟闸门跑不到这条车道
 * （`all.yml` 不挂 pull_request），没人会在合入前发现。
 *
 * 这里只做静态对照（读 yml 文本 / 脚本源码），不跑 CI：
 * - `all.yml` 的 ssh job 把脚本列出的每个必填 secret 都传进 env（缺一个 = 脚本必失败）；
 * - 反过来，ssh job 里传的每个 `E2E_SSH_*` 都被脚本读过（打错字的变量名不会被静默忽略）；
 * - 脚本写的字段名与 `e2e/helpers/testEnvironment.ts` 的校验字段一致；
 * - 事故防线：脚本不把 secret 写进 stdout（日志泄露）。
 *
 * 运行方式：`npm run test:unit -- e2e ciLane`
 */

import * as fs from 'fs';
import * as path from 'path';
import { createChecker, runTests } from './helpers/harness';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ALL_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'all.yml');
const WRITE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'write-e2e-environments.mjs');
const SCAN_SCRIPT = path.join(REPO_ROOT, 'scripts', 'scan-e2e-artifacts-for-secrets.mjs');
const TEST_ENVIRONMENT = path.join(REPO_ROOT, 'e2e', 'helpers', 'testEnvironment.ts');
const PLAYWRIGHT_CONFIG = path.join(REPO_ROOT, 'e2e', 'playwright.config.ts');

function read(file: string): string {
  if (!fs.existsSync(file)) throw new Error(`缺少文件：${path.relative(REPO_ROOT, file)}`);
  return fs.readFileSync(file, 'utf-8');
}

/**
 * `all.yml` 里 ssh job 的文本块。
 *
 * 按顶层 job 缩进切：`  ssh:` 起、下一个 `  <name>:` 止。不引 yaml 解析器是为了不把
 * 新增依赖带进单测（仓库当前只用它做 CI 编排，没有运行时消费方）。
 */
function sshJobBlock(workflow: string): string {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => /^ {2}ssh:\s*$/.test(line));
  if (start < 0) throw new Error('all.yml 里没有 ssh job（e2e-ssh 车道）');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/** 脚本里 `REQUIRED` 表登记的 secret 名（第一列） */
function requiredSecrets(script: string): string[] {
  const start = script.indexOf('const REQUIRED = [');
  if (start < 0) throw new Error('write-e2e-environments.mjs 里找不到 REQUIRED 表');
  const end = script.indexOf('];', start);
  if (end < 0) throw new Error('write-e2e-environments.mjs 的 REQUIRED 表没有收尾');
  const block = script.slice(start, end);
  return [...block.matchAll(/\[\s*'(E2E_[A-Z0-9_]+)'/g)].map((match) => match[1]);
}

/**
 * ssh job 的 env 块传进去的 secret 源名（`${{ secrets.X }}` 的 X）。
 *
 * `job` 里有两处传 secret：写环境文件的步骤（6 个）与凭证扫描步骤（2 个口令）。
 * 本函数只用于「脚本要的都传齐了」这条判据，取并集；「是否有死变量」由
 * `scopedSecrets` 按步骤分别对照。
 */
function passedSecrets(block: string): string[] {
  return [...block.matchAll(SECRET_REF)].map((match) => match[1]);
}

/**
 * GitHub Actions 的 secret 引用：`${{ secrets.X }}`。
 *
 * 必须带 `${{ }}` 外壳而不是裸 `secrets.X`——仓库里有
 * `scripts/scan-e2e-artifacts-for-secrets.mjs`，它的文件名里就含 `secrets.mjs`，
 * 裸匹配会把 `mjs` 当成一个 secret 名。
 */
const SECRET_REF = /\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * 把 workflow 的某个步骤块（从 `- name:` 或 `- run:` 起，到下一个 `- ` 起）按脚本切分：
 * 返回 `{ body, secrets }`，secrets 是该步骤 env 里传的 secret 名。
 *
 * 为什么要按步骤切：同一个 secret 可能被多个步骤用到（口令既写环境文件、又参与
 * 上传前扫描），按整段 job 判「有无死变量」会把「只在一个步骤里」的合法用法误判。
 */
function stepBlocks(job: string): { body: string; secrets: string[] }[] {
  const lines = job.split(/\r?\n/);
  const starts = lines
    .map((line, index) => (/^\s{6}- /.test(line) ? index : -1))
    .filter((index) => index >= 0);
  return starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : lines.length;
    const body = lines.slice(start, end).join('\n');
    // 只认 `${{ secrets.X }}`：文件名里的 `-for-secrets.mjs` 不是引用（见 SECRET_REF）
    const secrets = [...body.matchAll(SECRET_REF)].map((m) => m[1]);
    return { body, secrets };
  });
}

/** 步骤里 `run:` 调用的脚本路径（`node scripts/x.mjs` 的 x.mjs） */
function stepScript(body: string): string | null {
  const match = /node\s+(scripts\/[A-Za-z0-9._-]+\.mjs)/.exec(body);
  return match ? match[1] : null;
}

/**
 * `SshTestEnvironment` 的**必填**字段（带 `?` 的是可选段：`llmAdvertiseHost` /
 * `sudoPasswordRequired`，CI 里前者可选、后者由脚本固定写出）。
 */
function sshInterfaceFields(source: string): string[] {
  const start = source.indexOf('export interface SshTestEnvironment {');
  if (start < 0) throw new Error('testEnvironment.ts 里找不到 SshTestEnvironment 接口');
  const end = source.indexOf('\n}', start);
  if (end < 0) throw new Error('SshTestEnvironment 接口没有收尾');
  const body = source.slice(start, end);
  return [...body.matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*)(\??):/gm)]
    .filter((match) => match[2] !== '?')
    .map((match) => match[1]);
}

/**
 * `write-e2e-environments.mjs` 的 `environments.ssh` 对象里写出的键名。
 *
 * 两种写法都算：`key: value` 与简写 `key,`（`port` 变量同名简写，漏了简写这一支就会
 * 误报成「少写一个字段」）。
 */
function writtenSshKeys(source: string): string[] {
  const start = source.indexOf('  ssh: {');
  if (start < 0) throw new Error('脚本里找不到 environments.ssh 对象');
  const end = source.indexOf('\n  },', start);
  if (end < 0) throw new Error('environments.ssh 对象没有收尾');
  const keys: string[] = [];
  for (const line of source.slice(start, end).split(/\r?\n/)) {
    // 四空格缩进 = ssh 段的直接成员；嵌套层（sudoPasswordRequired / 三元里的对象）更深
    const match = /^ {4}([A-Za-z][A-Za-z0-9]*)(?:\s*:|\s*,)/.exec(line);
    if (match) keys.push(match[1]);
  }
  return keys;
}

/**
 * `e2e/playwright.config.ts` 里 `name: 'electron-ssh'` 那条 project 的文本块。
 *
 * 按行长切：从 `{ name: 'electron-ssh'` 起，到该行闭合的 `},` 止（单行写法也在块内）。
 */
function sshProjectBlock(config: string): string {
  const lines = config.split(/\r?\n/);
  const start = lines.findIndex((line) => /name:\s*'electron-ssh'/.test(line));
  if (start < 0) throw new Error("playwright.config.ts 里没有 electron-ssh project");
  // 单行写法（`{ name: 'electron-ssh', ... }`）直接返回这一行
  if (lines[start].includes('},')) return lines[start];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\}\s*,?\s*$/.test(lines[i])) {
      end = i + 1;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

runTests('e2eCiLane', () => {
  const { check, finish } = createChecker();
  const workflow = read(ALL_WORKFLOW);
  const script = read(WRITE_SCRIPT);
  const testEnvironment = read(TEST_ENVIRONMENT);

  const job = sshJobBlock(workflow);
  const required = requiredSecrets(script);
  const passed = passedSecrets(job);

  // RT-1：脚本要的 secret 一个都不能漏传（漏传 = 整点车道必红）
  check(
    `all.yml 的 ssh job 传齐了脚本要求的 ${required.length} 个 secret`,
    required.length > 0 && required.every((name) => passed.includes(name)),
  );

  // RT-2：每个步骤传的 secret 都要被该步骤调用的脚本读到（改名后的残留变量会被静默忽略）。
  // 按步骤对照而不是按整段 job：同一口令既进环境文件、又进上传前扫描，两个步骤各读各的
  const steps = stepBlocks(job);
  const deadSecrets: string[] = [];
  for (const step of steps) {
    const rel = stepScript(step.body);
    if (rel === null || step.secrets.length === 0) continue;
    const source = read(path.join(REPO_ROOT, rel));
    for (const name of step.secrets) {
      if (!new RegExp(`process\\.env\\.${name}\\b`).test(source)
        && !new RegExp(`'${name}'`).test(source)) {
        deadSecrets.push(`${rel} 不读 ${name}`);
      }
    }
  }
  check(
    'ssh job 每个步骤传的 secret 都被该步骤的脚本读取（无死变量）',
    deadSecrets.length === 0 && steps.some((step) => step.secrets.length > 0),
  );
  if (deadSecrets.length > 0) console.error(`     ${deadSecrets.join('；')}`);

  // RT-3：车道本身挂在 all.yml 上，并跑 electron-ssh project（否则「接进 CI」是空话）
  check(
    'all.yml 的 ssh job 跑 --project=electron-ssh',
    /--project=electron-ssh/.test(job),
  );

  // RT-4：写出来的字段名与 testEnvironment 的类型一致——字段改名只改一侧时，用例在
  // 收集期才报错（那时已经烧掉一次定时车道的构建时间）。对照 `SshTestEnvironment`
  // 接口的字段名与 ssh job 写出的 JSON 键，不靠「两边都出现某字符串」这种弱判据
  const interfaceFields = sshInterfaceFields(testEnvironment);
  const writtenKeys = writtenSshKeys(script);
  check(
    `写入的 ssh 字段与 SshTestEnvironment 接口一致（接口 ${interfaceFields.join(' / ')}）`,
    interfaceFields.length > 0
    && interfaceFields.every((field) => writtenKeys.includes(field)),
  );
  check(
    '脚本写出 ssh.sudoPasswordRequired 段（overlayMountProxyRemote 依赖它）',
    /sudoPasswordRequired\s*:\s*\{/.test(script),
  );

  // RT-5：不打印 secret——CI 日志里出现一次就等于泄露（derived 值不会被 GitHub 遮蔽）
  check(
    '脚本不把 secret 值写进 stdout / stderr',
    !/console\.(log|error)\([^)]*process\.env\./.test(script)
    && !/process\.env\.E2E_SSH_PASSWORD[^\n]*console/.test(script),
  );

  // RT-6：缺项时必须非零退出（静默跳过会让车道「绿着不跑」）
  check(
    '缺 secret 时脚本以非零码退出',
    /process\.exit\(1\)/.test(script),
  );

  // ---------- 凭证不进 artifact（`e2e/README.md` 的「凭证不进 artifact」一节） ----------
  //
  // 背景：`overlayMountProxyRemote.spec.ts` 要把远端 sudo 口令 `fill()` 进密码框，而
  // Playwright 的 trace 会把 fill 的值原样记进动作参数 / 动作日志 / DOM 快照（实测）。
  // 仓库是 public，失败时 trace 作为 artifact 上传就是公开泄露。下面是三道防线的断言：
  // 项目配置关 trace、上传前扫明文、ssh 车道不再上传 trace。

  const playwrightConfig = read(PLAYWRIGHT_CONFIG);

  // RT-7：electron-ssh project 必须显式关掉 trace（继承全局 retain-on-failure 就会记口令）
  const sshProject = sshProjectBlock(playwrightConfig);
  check(
    'electron-ssh project 显式设置 trace: off',
    /trace:\s*'off'/.test(sshProject),
  );

  // RT-8：ssh job 在上传任何 artifact 之前跑凭证扫描，且扫描带了两个口令 secret
  const scanScript = read(SCAN_SCRIPT);
  check(
    'all.yml 的 ssh job 调用凭证扫描脚本',
    /scripts\/scan-e2e-artifacts-for-secrets\.mjs/.test(job),
  );
  check(
    'ssh job 的扫描步骤拿到两个口令 secret',
    ['E2E_SSH_PASSWORD', 'E2E_SSH_SUDO_PASSWORD'].every((name) =>
      scanScript.includes(name) && job.includes(`secrets.${name}`)),
  );
  check(
    '扫描脚本命中即非零退出（不静默放行）',
    /process\.exit\(1\)/.test(scanScript),
  );
  check(
    '扫描脚本不打印命中的凭证内容',
    !/console\.(log|error)\([^)]*(secret\.value|values\[)/.test(scanScript),
  );

  // RT-9：ssh 车道不再把 test-results 当 artifact 上传（关 trace 后目录为空，
  // 留着上传入口等于给将来重开 trace 留后门）
  check(
    'ssh job 不上传 test-results artifact',
    !/upload-artifact/.test(job) || !/path:\s*\|?\s*\n?\s*test-results/.test(job),
  );

  // ---------- 整条 all 在 30 分钟内出结论 ----------
  //
  // 事故形态：`all.yml` 的某个 job 不设上限时 GitHub 给 6 小时，一个挂死的步骤
  // （实测 `electron-ssh` 的 remoteChangeList 卡 50 分钟）会把整条车道连同排队的一起
  // 拖住。下面四条把「30 分钟内必出结论」拆成可对照的编排事实：
  //   1. 每个 job 都有 `timeout-minutes`，且不超过总预算；
  //   2. ssh 矩阵不串行（串行的墙钟是四个文件之和 = 43 分钟，装不进预算）；
  //   3. Playwright 侧有单用例 / 整轮 / 失败早停三道闸门；
  //   4. 失败不重试（重试把失败用例的墙钟翻倍）。

  /** 顶层 job 名 → job 文本块（`  <name>:` 到下一个顶层 job 键为止，只看 `jobs:` 之后） */
  const jobBlocks = ((): Map<string, string> => {
    const lines = workflow.split(/\r?\n/);
    const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
    if (jobsAt < 0) throw new Error('all.yml 里找不到 jobs:');
    const blocks = new Map<string, string>();
    let current: string | null = null;
    let body: string[] = [];
    const flush = (): void => {
      if (current !== null) blocks.set(current, body.join('\n'));
    };
    for (const line of lines.slice(jobsAt + 1)) {
      const key = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
      if (key) {
        flush();
        current = key[1];
        body = [line];
        continue;
      }
      if (current !== null) body.push(line);
    }
    flush();
    return blocks;
  })();

  /** job 里 `timeout-minutes:` 的取值（没有则 null） */
  const jobTimeout = (block: string): number | null => {
    const match = /^\s{4}timeout-minutes:\s*(\d+)\s*$/m.exec(block);
    return match ? Number(match[1]) : null;
  };

  // RT-10：每个 job 都有显式上限；且**关键路径**（prepare + 最慢 e2e 车道）不超过
  // 30 分钟总预算。单看每个 job 都「≤ 30」是弱判据：prepare 25 + ssh 25 也满足，
  // 实际墙钟却是 50 分钟。这里按依赖关系算真实关键路径。
  const ALL_LANE_BUDGET_MINUTES = 30;
  const missingTimeout = [...jobBlocks.entries()]
    .filter(([name, block]) => name !== 'smoke' && jobTimeout(block) === null)
    .map(([name]) => name);
  check(
    `all.yml 的每个 job 都有 timeout-minutes（缺：${missingTimeout.join('、') || '无'}）`,
    missingTimeout.length === 0,
  );
  const overBudget = [...jobBlocks.entries()]
    .filter(([, block]) => {
      const value = jobTimeout(block);
      return value !== null && value > ALL_LANE_BUDGET_MINUTES;
    })
    .map(([name, block]) => `${name}=${jobTimeout(block)}min`);
  check(
    `all.yml 的 job 上限都不超过 ${ALL_LANE_BUDGET_MINUTES} 分钟（超：${overBudget.join('、') || '无'}）`,
    overBudget.length === 0,
  );

  // 关键路径 = prepare + 它下游最慢的那个 e2e 车道（smoke 与 prepare 并行，不是瓶颈）
  const workTime = (name: string): number | null => {
    const block = jobBlocks.get(name);
    return block ? jobTimeout(block) : null;
  };
  /** `needs: prepare` 的车道（e2e 的四个 + 矩阵展开的 ssh） */
  const e2eLanes = [...jobBlocks.entries()]
    .filter(([, block]) => /^\s{4}needs:\s*prepare\s*$/m.test(block))
    .map(([name]) => name);
  const e2eCaps = e2eLanes.map((name) => workTime(name));
  const criticalPath = (workTime('prepare') ?? Number.POSITIVE_INFINITY)
    + Math.max(...e2eCaps.map((cap) => cap ?? Number.POSITIVE_INFINITY));
  check(
    `all.yml 的关键路径（prepare ${workTime('prepare')}min + 最慢车道 `
      + `${Math.max(...e2eCaps.map((cap) => cap ?? 0))}min = ${criticalPath}min）不超过 `
      + `${ALL_LANE_BUDGET_MINUTES} 分钟`,
    e2eLanes.length >= 4 && criticalPath <= ALL_LANE_BUDGET_MINUTES,
  );

  // 单车道上限不能低于 Playwright 的整轮上限：低了对应用例还没被杀就先被 job 杀掉，
  // 拿不到「哪条用例挂住」的日志，只剩一句 job 超时。
  const runTimeout = ((): number | null => {
    const minutes = /const RUN_TIMEOUT_MS = ([0-9_]+) \* 60_000/.exec(playwrightConfig);
    return minutes ? Number(minutes[1].replace(/_/g, '')) : null;
  })();
  const tooTight = e2eLanes.filter((name) => {
    const cap = workTime(name);
    return runTimeout === null || cap === null || cap < runTimeout;
  });
  check(
    `每个 e2e 车道的 job 上限都不低于 Playwright 整轮上限 ${runTimeout ?? '?'} 分钟`
      + `（低：${tooTight.join('、') || '无'}）`,
    tooTight.length === 0,
  );

  // RT-11：ssh 矩阵必须并行——串行的墙钟是四个文件之和（实测 43 分钟），30 分钟装不进
  check(
    'all.yml 的 ssh 矩阵不限制 max-parallel（四路并行，否则墙钟超预算）',
    !/max-parallel:/.test(job),
  );
  // 也接受「显式并行但小于四」的折中（墙钟 2 批约 24 分钟）——只拒绝串行与非法值
  const maxParallel = /max-parallel:\s*(\d+)/.exec(job);
  check(
    'all.yml 的 ssh 矩阵若显式给 max-parallel，取值必须 ≥ 2',
    maxParallel === null || Number(maxParallel[1]) >= 2,
  );

  // RT-12：Playwright 侧三道闸门——单用例分档 / 整轮上限 / 5 条失败即停，且不重试
  check(
    'playwright 配置的 CI 整轮上限由 RUN_TIMEOUT_MS 派生（globalTimeout）',
    /globalTimeout:\s*process\.env\.CI\s*\?\s*RUN_TIMEOUT_MS\s*:\s*0/.test(playwrightConfig),
  );
  const globalTimeoutMinutes = ((): number | null => {
    const match = /const RUN_TIMEOUT_MS = ([0-9_]+) \* 60_000/.exec(playwrightConfig);
    return match ? Number(match[1].replace(/_/g, '')) : null;
  })();
  check(
    `playwright 配置的整轮上限在 15 分钟内（当前：${globalTimeoutMinutes ?? '未声明'} 分钟）`,
    globalTimeoutMinutes !== null && globalTimeoutMinutes <= 15,
  );
  check(
    'playwright 配置失败 5 条即停（maxFailures）',
    /maxFailures:\s*process\.env\.CI\s*\?\s*5\s*:\s*0/.test(playwrightConfig),
  );
  check('playwright 配置 CI 上不重试（retries: 0）', /retries:\s*0[,]/.test(playwrightConfig));
  // 单用例默认档 = 30s；重车道各自有 project 级覆盖（断言存在，不锁具体数值）
  check(
    'playwright 配置的默认单用例上限是 30s（快车道）',
    /const FAST_TEST_TIMEOUT_MS = 30_000;/.test(playwrightConfig),
  );
  check(
    'electron-app / electron-ssh 两个重车道各有 project 级 timeout 覆盖',
    /timeout:\s*ELECTRON_APP_TEST_TIMEOUT_MS/.test(playwrightConfig)
      && /timeout:\s*SSH_TEST_TIMEOUT_MS/.test(playwrightConfig),
  );

  // RT-13：**每个 project 块**的取值。
  //
  // 上面几条读的是整个文件的文本，能拦住「删掉一行」，拦不住「写错位置」——把
  // `timeout` 写到 project 外、把档位常量改成只被注释引用、「30s 档」被误改成 90s
  // 而断言只看「有没有 timeout」，都会静默通过。这里按 project 切块对照：默认档常量
  // 的取值、两个重车道的 project 覆盖、前端三个车道不覆盖（沿用默认档）。
  const constantValue = (name: string): number | null => {
    const match = new RegExp(`const ${name} = ([^;]+);`).exec(playwrightConfig);
    if (!match) return null;
    // 只认「数字字面量」与「数字 * 60_000」两种写法，避免引入表达式求值
    const literal = /^([0-9][0-9_]*)$/.exec(match[1].trim());
    if (literal) return Number(literal[1].replace(/_/g, ''));
    const minutes = /^([0-9][0-9_]*)\s*\*\s*60_000$/.exec(match[1].trim());
    return minutes ? Number(minutes[1].replace(/_/g, '')) * 60_000 : null;
  };

  /**
   * project 块：`name: '<name>'` 起到**下一个 project 的 `name:`** 为止。
   *
   * 不用花括号配对——project 里嵌了 `use: { … }`，配对要写完整的括号扫描；而
   * 「下一个 `name:` 之前」对本目录的判据（有没有 `timeout:`）是精确的，且对
   * 单行对象（`electron-ssh`）与多行对象（`electron-app`）同样成立。
   */
  const projectBlock = (name: string): string | null => {
    const start = playwrightConfig.indexOf(`name: '${name}'`);
    if (start < 0) return null;
    const rest = playwrightConfig.slice(start + 1);
    const next = rest.search(/[{,]\s*\n?\s*name: '/);
    return next > 0 ? playwrightConfig.slice(start, start + 1 + next) : playwrightConfig.slice(start);
  };

  check(
    '默认档常量 = 30s（FAST_TEST_TIMEOUT_MS）',
    constantValue('FAST_TEST_TIMEOUT_MS') === 30_000,
  );
  check(
    '整轮上限常量 = 15 分钟（RUN_TIMEOUT_MS）',
    constantValue('RUN_TIMEOUT_MS') === 15 * 60_000,
  );
  check(
    '整应用档常量 = 60s（ELECTRON_APP_TEST_TIMEOUT_MS）',
    constantValue('ELECTRON_APP_TEST_TIMEOUT_MS') === 60_000,
  );
  check(
    '真实 SSH 档常量 = 60s（SSH_TEST_TIMEOUT_MS）',
    constantValue('SSH_TEST_TIMEOUT_MS') === 60_000,
  );

  const electronAppBlock = projectBlock('electron-app');
  const electronSshBlock = projectBlock('electron-ssh');
  check(
    'electron-app project 块内设置 timeout（不是只写了常量）',
    electronAppBlock !== null && /timeout:\s*ELECTRON_APP_TEST_TIMEOUT_MS/.test(electronAppBlock),
  );
  check(
    'electron-ssh project 块内设置 timeout（不是只写了常量）',
    electronSshBlock !== null && /timeout:\s*SSH_TEST_TIMEOUT_MS/.test(electronSshBlock),
  );
  const fastLaneBlocks = ['webview-ui', 'remote-workspace-ui', 'terminal-ui']
    .map((name) => projectBlock(name));
  check(
    '前端三个车道不覆盖 timeout（沿用 30s 默认档）',
    fastLaneBlocks.every((block) => block !== null && !/\btimeout:/.test(block)),
  );

  // 用例体内放宽必须写明理由：放宽本身是允许的，静默放宽才是漏洞。
  // 判据取「同一文件里 `test.setTimeout(` 的每一处，前面 3 行内都有注释」——
  // 长任务用例的写法见 `remoteTaskSurvival.spec.ts`。
  const sshSpecs = [
    'e2e/electron/remoteSshExecution.spec.ts',
    'e2e/electron/remoteChangeList.spec.ts',
    'e2e/electron/remoteTaskSurvival.spec.ts',
    'e2e/electron/overlayMountProxyRemote.spec.ts',
  ];
  const undocumented: string[] = [];
  for (const rel of sshSpecs) {
    const lines = read(path.join(REPO_ROOT, rel)).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!/test\.setTimeout\(/.test(line)) return;
      const context = lines.slice(Math.max(0, index - 3), index).join('\n');
      if (!/\/\/|\*/.test(context)) undocumented.push(`${rel}:${index + 1}`);
    });
  }
  check(
    `真实 SSH 车道的每处 test.setTimeout 都带注释说明（缺：${undocumented.join('、') || '无'}）`,
    undocumented.length === 0,
  );

  // RT-14：Electron 二进制必须在**用例开始前**就位。
  //
  // `node_modules/electron` 没有 postinstall：第一次 `require('electron')` 才同步 spawn
  // `install.js` 现下 ~100MB。落在用例里时它吃掉的是单用例预算——run `44998731954` 的
  // 两个 ssh job 里前 5 条用例各烧 60s 后因 5 条失败早停整条掐掉，日志特征就是
  // `Downloading Electron binary...`。预热脚本与它在每条车道里的调用点都要在：
  // 少一处就会让那条车道重演同一个故障。
  const warmScript = path.join(REPO_ROOT, 'scripts', 'warm-electron.cjs');
  check(
    '存在 Electron 预热脚本（scripts/warm-electron.cjs）',
    fs.existsSync(warmScript),
  );
  const packageJson = JSON.parse(read(path.join(REPO_ROOT, 'package.json'))) as {
    scripts: Record<string, string>;
  };
  const unwarmedScripts = ['test:e2e', 'test:e2e:local', 'test:e2e:electron', 'test:e2e:ssh']
    .filter((name) => !/warm-electron\.cjs/.test(packageJson.scripts[name] ?? ''));
  check(
    `跑 Electron 的 npm 脚本都先预热（缺：${unwarmedScripts.join('、') || '无'}）`,
    unwarmedScripts.length === 0,
  );
  // 两个直接调 npx playwright 的 workflow 步骤（all.yml 的 electron / ssh、e2e-debug）
  const workflowNeedsWarm = [
    ['.github/workflows/all.yml', 2],
    ['.github/workflows/e2e-debug.yml', 1],
  ] as const;
  const missingWarm = workflowNeedsWarm
    .filter(([rel, count]) => {
      const text = read(path.join(REPO_ROOT, rel));
      const hits = [...text.matchAll(/node scripts\/warm-electron\.cjs/g)].length;
      return hits < count;
    })
    .map(([rel]) => rel);
  check(
    `all.yml（electron + ssh 两处）与 e2e-debug.yml 都在跑用例前预热 Electron（缺：${missingWarm.join('、') || '无'}）`,
    missingWarm.length === 0,
  );

  // RT-15：自托管车道必须用并发分片脚本取产物，不能用 actions/download-artifact。
  //
  // 原因：官方 action 用**单条连接**拉 blob，而自托管机器到 `*.blob.core.windows.net`
  // 的单连接吞吐只有 ~25KB/s（实测 25–31KB/s；banana 代理各节点 4–35KB/s 更差）。
  // 30MB 产物要 20 分钟，四个 ssh job 全撞 18 分钟上限红在下载这一步，产物目录根本
  // 没落出来（run 45027408803 / 45030636920 的
  // `chmod: cannot access 'dist/resources/core'` 即此）。切成 32 段并发后实测 165s。
  //
  // 退回官方 action 就等于退回那个 20 分钟，而红在下载这一步的症状（缺产物目录）
  // 与「构建漏了某产物」不易区分——所以这里把调用点钉住。
  const downloadScript = 'scripts/download-artifact-parallel.mjs';
  check(
    `存在并发分片下载脚本（${downloadScript}）`,
    fs.existsSync(path.join(REPO_ROOT, downloadScript)),
  );
  check(
    'all.yml 的 ssh job 用并行分片脚本取产物',
    job.includes(`node ${downloadScript}`),
  );
  check(
    'all.yml 的 ssh job 不再用单连接的 actions/download-artifact',
    // 只认「实际用到该 action 的步骤行」；注释里提到它是正当的（说明为什么不用）
    !/^\s*-?\s*uses:\s*actions\/download-artifact@/m.test(job),
  );

  finish();
});
