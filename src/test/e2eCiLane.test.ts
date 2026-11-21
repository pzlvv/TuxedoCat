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
const TEST_ENVIRONMENT = path.join(REPO_ROOT, 'e2e', 'helpers', 'testEnvironment.ts');

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

/** ssh job 的 env 块传进去的 secret 源名（`${{ secrets.X }}` 的 X） */
function passedSecrets(block: string): string[] {
  return [...block.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((match) => match[1]);
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

  // RT-2：job 里传的 secret 都要被脚本读到（改名后的残留变量会被静默忽略）
  const readNames = new Set([...script.matchAll(/process\.env\.([A-Za-z0-9_]+)/g)].map((m) => m[1]));
  check(
    'ssh job 传的每个 secret 都被脚本读取（无死变量）',
    passed.length > 0 && passed.every((name) => readNames.has(name)),
  );

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

  finish();
});
