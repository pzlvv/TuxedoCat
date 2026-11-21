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

  finish();
});
