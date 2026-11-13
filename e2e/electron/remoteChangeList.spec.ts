import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'ssh2';
import { startMockLlm } from '../helpers/mockLlmServer';
import { launchApp, mainEval } from '../helpers/electronApp';
import type { AppHandle } from '../helpers/electronApp';
import type { MockLlm } from '../helpers/mockLlmServer';
import type { SerializedWorkspaceRef } from '../../src/host/workspaceState';
import { CONFIG_DIR_NAME, CORE_BINARY_NAME, ENV_PREFIX, LOG_FILE_NAME } from '../../src/config/project';
import { requireSshEnvironment, detectLlmAdvertiseHost } from '../helpers/testEnvironment';

/** 远端状态目录 / 进程匹配模式（产品身份唯一来源 `src/config/project.json`，
 *  用例里不落字面量；pkill 模式首字符加 [] 不匹配执行它的远端 shell 自身） */
const REMOTE_RUN_DIR = `~/${CONFIG_DIR_NAME}/run`;
const CORE_PROCESS_PATTERN = `[${CORE_BINARY_NAME[0]}]${CORE_BINARY_NAME.slice(1)}`;

/**
 * 本机构建的 Core 指纹（部署到远端的槽位名就是它）。
 *
 * 远端状态文件名形如 `core-daemon-<fingerprint>.json`，指纹由本机 Core 产物内容算出
 * （`dist/resources/core/<arch>-<platform>/fingerprint`），因此收尾时按本机指纹拼出
 * 文件名而不是猜一个。产物缺失时返回 null（产物缺失本身已由 playwright 配置在加载期
 * 拦下，这里只是不在那种状态下抛错）。
 */
function localCoreFingerprint(): string | null {
  try {
    return fs.readFileSync(
      path.join(process.cwd().replace(/[\\/]e2e$/, ''), 'dist', 'resources', 'core', 'x64-linux', 'fingerprint'),
      'utf8',
    ).trim();
  } catch {
    return null;
  }
}

/** 侧栏文件分区的定位常量（与 e2e/electron/fileExplorer.spec.ts 的本地车道同一套选择器） */
const FILES_HEADER = '#filesHeader';
const FILES_TREE = '#filesTree';
const FILE_ROWS = `${FILES_TREE} .file-row[data-path]`;
const modeSeg = (mode: 'tree' | 'doc' | 'changes') => `#filesModeSwitch .files-mode-seg[data-mode="${mode}"]`;

/**
 * 远程（真实 SSH）工作区的变更清单取数：往返次数与条目数解耦
 * （`specs/defects/remote-change-list-n-plus-one-round-trips.md` 的 RT-1 … RT-7）。
 *
 * 与既有的「US-63 远程文档视图」用例（`remoteSshExecution.spec.ts`）分工：那条覆盖
 * 「远端 git 口径能列出变更 + 哨兵自动刷新」，本文件覆盖缺陷规格的**取数形态**——
 * 条目数变多时往返次数不变（不再是每条目一次 SFTP）、已删除不进清单、未跟踪文件按
 * 全文行数计新增（内容不出远端）、工作区是仓库子目录时路径仍是工作区相对、取数不触发
 * 自己的哨兵、非 git 工作区保持既有失败语义。
 *
 * 环境：`e2e/environments.json` 的 ssh 段（不入库，从 `e2e/environments.example.json`
 * 复制填写，见 e2e/README.md「测试环境配置」）。环境无效直接报错、不做任何修复。
 * 前置：`npm run build:core:linux-x64`（远端是 Linux，本机必须携带对应产物）。
 * 运行：`npx playwright test -c e2e/playwright.config.ts --project=electron-ssh remoteChangeList`
 */

const SSH = requireSshEnvironment();
const ADVERTISE_HOST = SSH.llmAdvertiseHost ?? detectLlmAdvertiseHost();

/**
 * 打开主进程的远端取数计数钩子（`electron/main.ts` 的 `E2E_REMOTE_GIT_OPS_ENV`）。
 *
 * 启动器把 `process.env` 原样透传给 Electron 子进程，因此在模块加载期置上这一个
 * 变量即可；产品代码只因它多记几个内存计数（不设它时那条路径完全不变）。
 * 变量名由 `<envPrefix>` 派生，与主进程共用同一个来源。
 */
process.env[`${ENV_PREFIX}_E2E_REMOTE_GIT_OPS`] = '1';

test.setTimeout(600_000);

function sshConnect(): Client {
  const client = new Client();
  client.connect({ host: SSH.host, port: SSH.port, username: SSH.user, password: SSH.password, readyTimeout: 20_000 });
  return client;
}

/**
 * 在远端执行一条命令（一次性连接，测试脚手架用）。
 *
 * 链路层带重试：实测这台远端（Ubuntu 24.04 上的 OpenSSH，30 次连续建链里约 1 次直接
 * `read ECONNRESET` / `Timed out while waiting for handshake`，同机 `ssh` 命令行也复现），
 * 且失败也可能落在 `ready` 之后、exec 通道打开之前的瞬间。这是远端链路层的瞬时失败，
 * 不是被测行为。重试判据是「命令**还没**被远端受理」（`ready` 之前，或 exec 通道尚未
 * 打开）：一次已经在跑的远端命令不会被执行两遍，只有通道都没建起来才重试。
 */
function sshExec(command: string, timeoutMs = 60_000, attempt = 1): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const client = sshConnect();
    /** 远端是否已受理这条命令（exec 通道打开 = 命令开始执行） */
    let dispatched = false;
    const fail = (error: Error): void => {
      client.end();
      if (!dispatched && attempt < 3) {
        setTimeout(() => { sshExec(command, timeoutMs, attempt + 1).then(resolve, reject); }, 500);
        return;
      }
      reject(error);
    };
    client.on('error', fail);
    client.on('ready', () => {
      client.exec(command, (err, stream) => {
        if (err) return fail(err);
        dispatched = true;
        let stdout = '';
        let stderr = '';
        stream.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
        stream.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
        stream.on('close', (code: number | null) => {
          client.end();
          resolve({ stdout, stderr, code });
        });
      });
    });
    setTimeout(() => fail(new Error(`ssh exec 超时: ${command}`)), timeoutMs);
  });
}

/** 远端 shell 片段里的单引号转义（路径 / 文件名逐个单引号包住） */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 远端 home / 本轮唯一工作区目录（`afterAll` 整目录清理） */
let remoteHome = '';
let remoteWs = '';
let remoteRef: SerializedWorkspaceRef;
let mockLlm: MockLlm | null = null;
let app: AppHandle | null = null;

/**
 * 本机到远端的单次网络往返（RTT）实测值，2026-11 实测于 Windows（Git Bash）→
 * 8.136.22.171:22，ssh2 在同一条连接上串行 exec 20 次取平均：**≈195ms／次**（ICMP
 * 平均 29ms，SSH 通道建立 exec 会话的额外开销远大于 ICMP）。这就是缺陷描述里
 * 「单次 RTT 60ms 估算」在真机上的量级修正：旧形态 200 条约 200 × 195ms ≈ 39 秒，
 * 新形态固定 2 次往返 ≈ 0.4 秒＋git / grep 在远端的自身耗时。
 */
const MEASURED_SSH_RTT_MS = 195;

test.beforeAll(async () => {
  const home = await sshExec('pwd');
  if (home.code !== 0) throw new Error(`远端 pwd 失败: ${home.stderr}`);
  remoteHome = home.stdout.trim();
  remoteWs = `${remoteHome}/tuxedo-e2e-ssh-${process.pid}`;
  await sshExec(`mkdir -p ${remoteWs}`);
  remoteRef = {
    scheme: 'ssh',
    path: remoteWs,
    endpoint: { host: SSH.host, port: SSH.port, user: SSH.user, auth: { kind: 'sshPassword', password: SSH.password } },
  };
});

test.beforeEach(async () => {
  // 环境有效性判断（每个用例开头）：SSH 可达且远端是携带产物支持的平台。
  // 无效直接报错——不换凭证重试、不清远端状态、不做任何修复。
  const probe = await sshExec('uname -sm');
  if (probe.code !== 0) {
    throw new Error(
      `SSH 测试环境无效（${SSH.user}@${SSH.host}:${SSH.port}）：uname 失败（exit=${probe.code}）：`
      + `${probe.stderr.trim() || 'no output'}。不做修复，请先恢复环境或修正 e2e/environments.json。`,
    );
  }
  const [system] = probe.stdout.trim().split(/\s+/);
  if (system !== 'Linux') {
    throw new Error(
      `SSH 测试环境无效：远端平台 "${system ?? 'unknown'}" 不被支持（本机携带的 Core 产物只覆盖 Linux）。`
      + '不做修复，请换 Linux 远端或在 e2e/environments.json 改指其它环境。',
    );
  }
});

/**
 * 远端 daemon 清场：杀进程 + 删本指纹槽位的状态文件。
 *
 * 为什么每轮都要清（而不是只在 `afterAll`）：上一条用例结束时宿主关窗，远端 daemon
 * 仍可能处在空闲退出倒计时里，`run/core-daemon-<fingerprint>.json` 也还在。下一条用例
 * 立刻建链时若命中这个半死的 daemon，握手就挂在那儿，表现为「等待活动聊天视图超时
 * （候选 0 个）」——首轮复跑即如此（RT-3 红在启动阶段，前后两条用例都绿）。这是
 * `e2e/README.md` 已知坑 11 记的同一件事，`remoteSshExecution.spec.ts` 的冷部署用例
 * 也在 `beforeAll` 之外各自清场。
 */
async function resetRemoteDaemon(): Promise<void> {
  await sshExec(`pkill -f '${CORE_PROCESS_PATTERN}' || true; sleep 1`).catch(() => undefined);
  const fingerprint = localCoreFingerprint();
  if (fingerprint) {
    await sshExec(`rm -f ${REMOTE_RUN_DIR}/core-daemon-${fingerprint}.json`).catch(() => undefined);
  }
}

test.afterAll(async () => {
  // 收尾分三步（远端是共享机器，用例结束不留目录也不留后台进程）：
  // 1) 删本轮唯一目录；2) 杀残留 daemon；3) 删 daemon 状态文件
  if (remoteWs) await sshExec(`rm -rf ${remoteWs}`).catch(() => undefined);
  await resetRemoteDaemon();
});

test.afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  mockLlm?.close();
  mockLlm = null;
  // 关窗之后远端 daemon 才进入空闲退出倒计时：在这里清，下一条用例的建链才不会撞上
  // 一个正在退出的 daemon（见 resetRemoteDaemon 的注释）
  await resetRemoteDaemon();
});

/**
 * 在远端 `$HOME` 之外建一个真实的 git 仓，返回仓库路径。
 *
 * 「在登录目录之外」是必须的：批处理曾经丢过 `-C <root>`，git 于是在 SSH 登录目录
 * 找仓库（`specs/defects/remote-git-batch-drops-worktree-cwd.md`），工作区落在
 * `$HOME` 里时那条缺陷会静默通过（`$HOME` 恰好有仓库时更隐蔽）。
 */
async function initRemoteRepo(name: string): Promise<string> {
  const repo = `${remoteWs}/${name}`;
  await sshExec(
    `rm -rf ${shQuote(repo)} && mkdir -p ${shQuote(repo)} && cd ${shQuote(repo)}`
      + ' && git init -q && git config user.email e2e@example.com && git config user.name e2e',
  );
  return repo;
}

/** 启动应用并打开远程工作区；返回侧栏页（文件浏览器在上面的固定容器里） */
async function launchWithRemoteWorkspace(remotePath: string): Promise<Awaited<ReturnType<AppHandle['sidebarPage']>>> {
  const ref = remotePath === remoteWs ? remoteRef : { ...remoteRef, path: remotePath };
  mockLlm = await startMockLlm({ workspaceDir: remotePath, listenHost: '0.0.0.0', advertiseHost: ADVERTISE_HOST });
  app = await launchApp({
    repoRoot: process.cwd().replace(/[\\/]e2e$/, ''),
    mockLlm,
    workspaceDir: remotePath,
    openWorkspaces: [ref],
    agentMode: 'auto',
  });
  // 远程工作区冷部署（SSH 引导上传 Core / ripgrep）要走完整预算
  try {
    await app.chatPage({ workspaceIncludes: 'tuxedo-e2e-ssh' }, 240_000);
  } catch (err) {
    // 启动阶段失败时「候选 0 个」本身不含任何可诊断信息：把当前页面清单、沙箱 home 里的
    // 主进程日志与远端 daemon 状态一起打出来，否则只能靠反复重跑猜（实测踩过多次）
    const urls = app.context.pages().map((p) => p.url());
    const logTail = appLog().split('\n').slice(-25);
    console.log(`[诊断] 启动远程工作区失败（${remotePath}）`);
    console.log(`[诊断] 现有页面（${urls.length}）：\n${urls.join('\n')}`);
    console.log(`[诊断] 主进程日志末 ${logTail.length} 行：\n${logTail.join('\n')}`);
    const daemon = await sshExec('ls -la ~/.tuxedo-cat/run/ 2>/dev/null; ps -eo pid,etime,cmd | grep "[t]uxedo-cat-core" | head -5')
      .catch(() => null);
    console.log(`[诊断] 远端 daemon：\n${daemon?.stdout.trim() ?? '<查询失败>'}`);
    console.log(`[诊断] 沙箱 home（含日志）：${app.homeDir}`);
    throw err;
  }
  return app.sidebarPage();
}

/**
 * 展开文件分区（幂等：已展开时不点，点分区条会折叠）。
 *
 * 分区标题是折叠开关，不是「打开分区」按钮——重复点击会把分区收起来，之后分段 switch
 * 整体隐藏，等它可见就永远等不到。
 */
async function openFilesSection(sb: Awaited<ReturnType<AppHandle['sidebarPage']>>): Promise<void> {
  await expect(sb.locator(FILES_HEADER)).toBeVisible({ timeout: 60_000 });
  const expanded = await sb.locator('#filesSection').evaluate((el) => el.classList.contains('expanded'));
  if (!expanded) await sb.locator(FILES_HEADER).click();
  await expect(sb.locator(modeSeg('tree'))).toBeVisible({ timeout: 30_000 });
}

/** 展开文件分区并切到某个变更视图（分区展开才有分段 switch） */
async function openFilesMode(
  sb: Awaited<ReturnType<AppHandle['sidebarPage']>>,
  mode: 'doc' | 'changes',
): Promise<void> {
  await openFilesSection(sb);
  await sb.locator(modeSeg(mode)).click();
  await expect(sb.locator(modeSeg(mode))).toHaveAttribute('aria-checked', 'true');
}

/**
 * 侧栏主进程日志（`[sidebar-files]` / `[ssh]` 行）：变更视图的取数形态只有在这里
 * 能事后核对（打包态没有 console）。宿未起时返回空串。
 */
function appLog(): string {
  try {
    return fs.readFileSync(path.join(app!.homeDir, CONFIG_DIR_NAME, 'logs', LOG_FILE_NAME), 'utf8');
  } catch {
    return '';
  }
}

/**
 * 日志里某个工作区的 doc-list 失败行，按成因分两类返回。
 *
 * 分类是必须的：这台远端链路有约 3% 的瞬时失败（见文件头 `sshExec` 的实测），落在取数
 * 那一次 exec 上时同样会写一行 `doc-list failed`——那是链路抖动，不是取数形态的缺陷。
 * 用例要判的是「取数本身有没有失败」（`--diff-filter=d` 的批处理是否整批炸掉），所以
 * 只有**非传输层**的失败才算数；传输层失败单独计数并打印，用于区分「真红」与「链路抖」。
 */
function docListFailures(workspacePath: string): { total: number; transport: number } {
  const lines = appLog()
    .split('\n')
    .filter((line) => line.includes('[sidebar-files]') && line.includes('doc-list failed') && line.includes(workspacePath));
  const transport = lines.filter((line) =>
    /SSH connection to .* failed|ECONNRESET|handshake|connection closed|Timed out while waiting/i.test(line)).length;
  return { total: lines.length, transport };
}

/**
 * 远端取数计数（主进程的 `__tcE2ERemoteGitOps`）。
 *
 * 缺陷的定义就是「远端调用次数随条目数增长」，而这只有主进程自己知道——界面只显示
 * 结果、耗时又被远端负载与首轮冷启动扰动。计数由一个**纯测试钩子**给出
 *（`electron/main.ts` 的 `E2E_REMOTE_GIT_OPS_ENV`，置上环境变量才存在，不设时产品
 * 路径无任何行为差异、也没有落盘字段或 IPC 通道）。
 */
interface RemoteGitOps {
  run: number;
  runBatch: number;
  lineCounts: number;
  readFile: number;
  exists: number;
}

async function remoteGitOps(): Promise<RemoteGitOps> {
  // 返回**字符串**再解析：主进程求值（`mainEval`）取的是 CDP 的 `value`，对象只带
  // objectId、取回来是 undefined。
  const raw = await mainEval<string | null>(
    app!,
    '(function(){ var c = globalThis.__tcE2ERemoteGitOps; return c ? JSON.stringify(c) : null; })()',
  );
  if (!raw) {
    throw new Error(
      '远端取数计数未启用：本文件的用例依赖 <envPrefix>_E2E_REMOTE_GIT_OPS（'
      + 'electron/main.ts 的 E2E_REMOTE_GIT_OPS_ENV）。请在启动应用前设置它（见文件头的模块加载期赋值）。',
    );
  }
  return JSON.parse(raw) as RemoteGitOps;
}

/** 取数一次前后计数的增量（哪个字段涨了就是这个原语被调用了几次） */
function diffOps(before: RemoteGitOps, after: RemoteGitOps): RemoteGitOps {
  return {
    run: after.run - before.run,
    runBatch: after.runBatch - before.runBatch,
    lineCounts: after.lineCounts - before.lineCounts,
    readFile: after.readFile - before.readFile,
    exists: after.exists - before.exists,
  };
}

/**
 * 等一个「取数已出结果」的判据成立：期间替用户点掉错误态的重试，返回退避耗掉的毫秒数。
 *
 * 为什么需要重试而不是放宽超时：这台远端链路有约 3% 的瞬时失败（见文件头 `sshExec`
 * 的同一段实测）。失败落在取数那一次 exec 上时，侧栏进入既定错误态「读取失败，点击
 * 重试」——这是产品**应有**的行为（不静默空列表，specs/041 FR-003），不是缺陷。用例
 * 若只等结果出现，就会把链路抖动判成产品回归（首轮全量跑即如此：RT-2 红在 `keep.md`
 * 不出现，而单跑与复跑都绿）。
 *
 * **重试必须有上限与退避**：每点一次「重试」都真的重发一次远端取数。上一版按 250ms
 * 轮询点击，链路持续抖动时 120 秒里点了 324 次（诊断日志里的 `runBatch: 324`），等于
 * 用例自己造了一场往返风暴，还会把后续用例的取数计数基线搅乱。现在：最多重试 3 次、
 * 间隔指数退避（1s / 2s / 4s），且只在**错误态**出现时点——加载中不点（那时点了没用，
 * 还会作废在途回包）。
 *
 * **返回退避耗掉的毫秒数**：调用方的计时断言量的是「取数本身的耗时」，抖动触发的重试
 * 退避（最多 7 秒）不是取数的一部分。把它从墙钟里扣掉，计时判据才仍然只反映取数形态
 * ——否则一次抖动就能让 121 条那次凭空多出几秒、把计时断言打成假红（实测发生过一次）。
 *
 * `settled` 是「取数已出结果」的判据（行可见 / 徽标文本符合），返回 true 即完成；
 * 只读一次快照、不阻塞，轮询与退避都由本函数控制。
 */
async function waitForDocResult(
  sb: Awaited<ReturnType<AppHandle['sidebarPage']>>,
  what: string,
  settled: () => Promise<boolean>,
): Promise<number> {
  // 错误态的重试行只在「非 not-a-git-workspace」时带 data-retry-doc（见 sidebar 的 renderDocFiles）
  const retry = sb.locator(`${FILES_TREE} .file-error[data-retry-doc]`);
  const deadline = Date.now() + 120_000;
  /** 已点过的重试次数（上限 3：3% 的抖动连中四次的概率可以忽略） */
  let retries = 0;
  /** 退避累计（调用方从耗时里扣掉，见上面的注释） */
  let backoffMs = 0;
  for (;;) {
    if (await settled()) return backoffMs;
    if (retries < 3 && await retry.isVisible().catch(() => false)) {
      retries += 1;
      console.log(`[诊断] 等 ${what} 时侧栏报错，第 ${retries} 次点重试`);
      await retry.click({ timeout: 10_000 }).catch(() => undefined);
      // 指数退避：给远端一次真正重新建链 / 重取的机会，别把重试打成风暴
      const waitMs = 1_000 * 2 ** (retries - 1);
      backoffMs += waitMs;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  // 预算用尽：先把现场打出来（否则只剩「元素不存在」，看不出是取数失败、空集还是没触发），
  // 再用短超时的 expect 报错，让失败信息里带 locator 的完整现场
  const logTail = appLog()
    .split('\n')
    .filter((line) => line.includes('[sidebar-files]') || line.includes('[ssh]'))
    .slice(-15);
  console.log(`[诊断] 等 ${what} 超时（重试 ${retries} 次）；侧栏当前态：${await sb.locator(FILES_TREE).textContent().catch(() => '<读不到>')}`);
  console.log(`[诊断] 主进程日志末 ${logTail.length} 行：\n${logTail.join('\n')}`);
  console.log(`[诊断] 远端取数计数：${JSON.stringify(await remoteGitOps().catch(() => null))}`);
  expect(await settled(), `等待 ${what} 超时`).toBe(true);
  return backoffMs;
}

/** 等某一行出现在变更清单里（取数完成的可视判据），返回抖动退避耗时 */
async function expectRowVisible(
  sb: Awaited<ReturnType<AppHandle['sidebarPage']>>,
  rel: string,
): Promise<number> {
  const row = sb.locator(`${FILES_TREE} .file-row[data-path="${rel}"]`);
  return waitForDocResult(sb, rel, () => row.isVisible().catch(() => false));
}

/** 等某一行带某段徽标文本（`+N` / `-M`），返回抖动退避耗时 */
async function expectBadge(
  sb: Awaited<ReturnType<AppHandle['sidebarPage']>>,
  rel: string,
  badge: '.doc-plus' | '.doc-minus',
  text: string,
): Promise<number> {
  const target = sb.locator(`${FILES_TREE} .file-row[data-path="${rel}"] ${badge}`);
  return waitForDocResult(sb, `${rel} ${badge}=${text}`, async () => {
    const actual = await target.textContent().catch(() => null);
    return actual === text;
  });
}

// ==================== RT-1 / RT-2 / RT-3：往返次数与条目数解耦 ====================
// 缺陷的判定就是「条目数一多就慢到不可用」：旧形态每个条目各付一次 SFTP（未跟踪文件
// 读整份内容、已跟踪条目逐条 stat），新形态固定 2 次 exec（批处理 + 批量计行）。
// 断言分两层：
// 1) 语义层（判定性）：120 条改动全部列出、行数口径正确——修复前整条失败或漏条目；
// 2) 时间层（量级）：120 条与 1 条的取数耗时差是「远端 git 自身耗时」级别，不是
//    「条目数 × RTT」级别——实测 RTT ≈195ms，旧形态 120 条未跟踪要 120 × 195 ≈ 23 秒
//    以上，两种规模之差至少是秒级；新形态两者都在 1 秒内（见用例末尾打印的真实值）。
// 不用固定阈值卡秒数（机器负载会让绝对值飘），比较**两种规模的比值**：旧形态的比值随
// 条目数线性增长（≥几十倍），新形态接近 1（远端 git 扫 120 个文件的自身耗时才是主项）。

test('RT-1/RT-2/RT-3 远端 120 条改动一次取数：往返次数与条目数解耦，行数口径与本地一致', async () => {
  const repo = await initRemoteRepo('manyrepo');
  // 基线：60 个已跟踪 md + 1 个已跟踪非 md（用来验证 --diff-filter=d 之外的正常条目）
  await sshExec(
    `cd ${shQuote(repo)}`
      + ' && for i in $(seq 1 60); do printf "line1\\nline2\\n" > "t$i.md"; done'
      + ' && printf "plain\\ndoomed\\n" > notes.txt && git add -A && git commit -qm base',
  );
  // 改动：60 个已跟踪 md 各 +2 行、60 个未跟踪 md（新建，各 3 行）、notes.txt 改掉一行
  // → 命中 121 条（60 已跟踪 + 60 未跟踪 + notes.txt）
  await sshExec(
    `cd ${shQuote(repo)}`
      + ' && for i in $(seq 1 60); do printf "line1\\nline2\\nadded1\\nadded2\\n" > "t$i.md"; done'
      + ' && for i in $(seq 1 60); do printf "u1\\nu2\\nu3\\n" > "u$i.md"; done'
      + ' && printf "plain\\nchanged\\n" > notes.txt',
  );
  const changeCount = await sshExec(
    `cd ${shQuote(repo)} && git --no-optional-locks -c core.untrackedCache=false status --porcelain | wc -l`,
  );
  expect(Number(changeCount.stdout.trim()), '场景预置应命中 121 条改动').toBe(121);

  const sb = await launchWithRemoteWorkspace(repo);
  // 取数计数基线：这里只关心「开这一次视图」产生的远端调用增量
  const beforeBulk = await remoteGitOps();
  const startedAt = Date.now();
  await openFilesMode(sb, 'changes');
  // 取数完成的判据：一条已跟踪 md、一条未跟踪 md、一个其它类型都在清单里
  //（三次等待各自返回它用掉的抖动退避，下面从墙钟里扣掉：计时判据只量取数形态）
  const bulkBackoff = (await expectRowVisible(sb, 't1.md'))
    + (await expectRowVisible(sb, 'u60.md'))
    + (await expectRowVisible(sb, 'notes.txt'));
  const bulkMs = Date.now() - startedAt - bulkBackoff;
  const bulkOps = diffOps(beforeBulk, await remoteGitOps());
  const bulkFailures = docListFailures(repo);

  // 行数口径：已跟踪 md 的 +2/-0、未跟踪 md 的 +3/-0（全文行数）、notes.txt 的 +1/-1
  const row = (rel: string) => sb.locator(`${FILES_TREE} .file-row[data-path="${rel}"]`);
  await expect(row('t1.md').locator('.doc-plus')).toHaveText('+2');
  await expect(row('t1.md').locator('.doc-minus')).toHaveText('-0');
  await expect(row('u1.md').locator('.doc-plus')).toHaveText('+3');
  await expect(row('notes.txt').locator('.doc-plus')).toHaveText('+1');
  await expect(row('notes.txt').locator('.doc-minus')).toHaveText('-1');
  // 121 条同名规格的文件全在（防止「只列了一部分」也算通过）
  const listed = await sb.locator(FILE_ROWS).count();
  expect(listed, `清单应含 121 条改动（含目录不铺开时的全部文件行），实际 ${listed}`).toBe(121);

  // 单条目规模对照：清空改动后再取一次，同样量一次远端调用次数
  await sshExec(`cd ${shQuote(repo)} && git checkout -q -- . && git clean -qfd`);
  await sshExec(`cd ${shQuote(repo)} && printf "line1\\nline2\\nadded1\\n" > t1.md`);
  const beforeSingle = await remoteGitOps();
  const singleStartedAt = Date.now();
  await sb.locator('#filesRefresh').click();
  // 徽标等待同样走抖动重试助手（否则一次抖动就让这次测量挂到 120s 超时），退避从墙钟扣掉
  const singleBackoff = await expectBadge(sb, 't1.md', '.doc-plus', '+1');
  const singleMs = Date.now() - singleStartedAt - singleBackoff;
  const singleOps = diffOps(beforeSingle, await remoteGitOps());

  console.log(
    `[RT-1] 121 条改动：${bulkMs}ms，远端调用 ${JSON.stringify(bulkOps)}；`
    + `1 条改动：${singleMs}ms，远端调用 ${JSON.stringify(singleOps)}；`
    + `单次 RTT 实测 ${MEASURED_SSH_RTT_MS}ms；doc-list 失败 ${bulkFailures.total} 行`
    + `（其中链路抖动 ${bulkFailures.transport} 行）`,
  );

  // 判定一（确定性，缺陷的定义）：两种规模的远端调用次数**相同**且与条目数无关。
  // 旧形态的增量是 `run` 4 次 + 未跟踪文件各一次 `readFile` + 每个条目一次 `exists`
  //（121 条时约 185 次远端往返）；新形态固定 runBatch 1 + lineCounts 1。
  expect(bulkOps.readFile, '未跟踪文件不得逐条整文件读回宿主（旧形态每条一次 SFTP）').toBe(0);
  expect(bulkOps.exists, '已删除过滤不得逐条 stat（旧形态每条一次 SFTP）').toBe(0);
  expect(bulkOps.runBatch, '四条 git 事实应合并为一次批处理').toBe(1);
  expect(bulkOps.lineCounts, '未跟踪行数应一次批量取回').toBe(1);
  // `run` 只允许探测那一条（`probeGitWorkspace` 的结果决定走 git 还是记录口径，必须先于
  // 取数、且不能并进批处理）；再多的 `run` 就是又回到逐条 exec 了
  expect(bulkOps.run, '除 git 工作区探测外不得再有逐条 exec').toBe(1);
  // 单条目规模：没有未跟踪文件时不发批量计行（一次往返都不白付），且逐条调用同样为 0
  expect(singleOps.lineCounts, '没有未跟踪文件时不发批量计行').toBe(0);
  expect(singleOps.readFile + singleOps.exists, '单条目规模也不得逐条往返').toBe(0);

  // 判定二（量级）：条目数从 121 降到 1 时的耗时差不得随条目数线性增长。
  // 旧形态 121 条未跟踪文件 × 195ms ≈ 23.6 秒；新形态两次都在常数级。
  expect(
    bulkFailures.total - bulkFailures.transport,
    `取数本身不得报错（doc-list 非传输层失败 ${bulkFailures.total - bulkFailures.transport} 行；`
    + `另有链路抖动 ${bulkFailures.transport} 行，不计入判据）`,
  ).toBe(0);
  expect(
    bulkMs - singleMs,
    `121 条与 1 条的取数耗时差应远小于条目数 × RTT（旧形态 ≥23 秒）；实测差 ${bulkMs - singleMs}ms`,
  ).toBeLessThan(121 * MEASURED_SSH_RTT_MS / 4);

  await sshExec(`rm -rf ${shQuote(repo)}`).catch(() => undefined);
});

// ==================== 已删除文件不进清单（--diff-filter=d） ====================
// `diff` 带 `--diff-filter=d` 让 git 自己剔掉删除，从而去掉「取数后逐条 stat」那一轮
// 往返。判定必须同时看两侧：删除的行不出现（剔掉了），同批其它改动照常出现（不是整批
// 失败 / 整批被过滤）。

test('RT-2 远端删掉已跟踪 md：两个变更视图都不出现该行，同批其它改动照常列出', async () => {
  const repo = await initRemoteRepo('delrepo');
  await sshExec(
    `cd ${shQuote(repo)}`
      + ' && printf "keep1\\nkeep2\\n" > keep.md && printf "doomed\\nline\\n" > doomed.md'
      + ' && printf "plain\\n" > notes.txt && git add -A && git commit -qm base',
  );
  // doomed.md 删除（不暂存，工作区层面消失）；keep.md 改动；notes.txt 改动；新建 new.md
  await sshExec(
    `cd ${shQuote(repo)}`
      + ' && rm doomed.md && printf "keep1\\nkeep2\\nkeep3\\n" > keep.md'
      + ' && printf "plain\\nchanged\\n" > notes.txt && printf "brand new\\n" > new.md',
  );

  const sb = await launchWithRemoteWorkspace(repo);
  await openFilesMode(sb, 'doc');
  // 文档视图（scope=doc）：keep.md / new.md 在，doomed.md 不在
  await expectRowVisible(sb, 'keep.md');
  await expectRowVisible(sb, 'new.md');
  await expect(sb.locator(`${FILES_TREE} .file-row[data-path="doomed.md"]`)).toHaveCount(0);
  await expect(sb.locator(`${FILES_TREE} .file-row[data-path="keep.md"] .doc-plus`)).toHaveText('+1');

  // 差异视图（scope=all）：同样的剔除语义，且非 md 的 notes.txt 在
  await openFilesMode(sb, 'changes');
  await expectRowVisible(sb, 'notes.txt');
  await expect(sb.locator(`${FILES_TREE} .file-row[data-path="doomed.md"]`)).toHaveCount(0);
  await expect(sb.locator(`${FILES_TREE} .file-row[data-path="keep.md"]`)).toBeVisible();

  // 取数没有退化成「整批失败」：日志里没有该工作区的非传输层 doc-list 失败行
  //（链路抖动会自己恢复、且在视图里表现为可点重试的错误态，不是「整批失败」）
  const failures = docListFailures(repo);
  expect(
    failures.total - failures.transport,
    `删除剔除不得伴随取数失败（非传输层失败 ${failures.total - failures.transport} 行；`
    + `另有链路抖动 ${failures.transport} 行）`,
  ).toBe(0);

  await sshExec(`rm -rf ${shQuote(repo)}`).catch(() => undefined);
});

// ==================== 未跟踪文件按全文行数计新增（lineCounts） ====================
// 未跟踪文件的 `+N` 是全文行数，由 `lineCounts` 在远端数出来。三个口径必须与
// `countLines` 一致：N 行 → +N、空文件 → +0、末行无换行 → 末行不另计。

test('RT-3 远端未跟踪文件的行数：N 行 +N、空文件 +0、末行无换行与 countLines 同口径', async () => {
  const repo = await initRemoteRepo('untrackedrepo');
  await sshExec(`cd ${shQuote(repo)} && printf "base\\n" > base.md && git add -A && git commit -qm base`);
  // five.md = 5 行（末尾有换行）；empty.md = 0 字节；noeol.md = 3 行但末行无换行
  await sshExec(
    `cd ${shQuote(repo)}`
      + ' && printf "l1\\nl2\\nl3\\nl4\\nl5\\n" > five.md'
      + ' && : > empty.md'
      + ' && printf "a\\nb\\nc" > noeol.md',
  );

  const sb = await launchWithRemoteWorkspace(repo);
  await openFilesMode(sb, 'doc');
  await expectRowVisible(sb, 'five.md');
  const row = (rel: string) => sb.locator(`${FILES_TREE} .file-row[data-path="${rel}"]`);
  // 远端 `grep -a -c ''` 与宿主 `countLines` 同口径
  await expect(row('five.md').locator('.doc-plus')).toHaveText('+5');
  await expect(row('empty.md').locator('.doc-plus')).toHaveText('+0');
  await expect(row('noeol.md').locator('.doc-plus')).toHaveText('+3');
  // 未跟踪文件的新增行数是全文，减号恒为 0
  await expect(row('five.md').locator('.doc-minus')).toHaveText('-0');

  await sshExec(`rm -rf ${shQuote(repo)}`).catch(() => undefined);
});

test('RT-3 远端超大未跟踪文件：内容不出远端，取数耗时不随体积线性增长', async () => {
  const repo = await initRemoteRepo('bigfilerepo');
  await sshExec(`cd ${shQuote(repo)} && printf "base\\n" > base.md && git add -A && git commit -qm base`);
  // 12MB / 40 万行的未跟踪文件：旧形态要把它整份经 SFTP 拉回宿主再数行（实测本机到
  // 该远端 SFTP ≈1.4MB/s，单这条就要 8 秒以上）；新形态只在远端 grep -c。
  const lineCount = 400_000;
  await sshExec(
    `cd ${shQuote(repo)} && yes "0123456789abcdef0123456789abcdef" | head -n ${lineCount} > big.log`
      + ` && ls -l big.log | awk '{print $5}'`,
  );

  const sb = await launchWithRemoteWorkspace(repo);
  const startedAt = Date.now();
  await openFilesMode(sb, 'changes');
  await expectRowVisible(sb, 'big.log');
  const elapsed = Date.now() - startedAt;
  const plus = await sb.locator(`${FILES_TREE} .file-row[data-path="big.log"] .doc-plus`).textContent();
  console.log(`[RT-3] 12MB 未跟踪文件取数 ${elapsed}ms，+${plus}`);

  // 行数正确（内容留在远端数出来的）
  expect(plus).toBe(`+${lineCount}`);
  // 判定：不是「把 12MB 拖回来」的量级（1.4MB/s 下 ≥8 秒）。远端 grep -c 本身是
  // 百毫秒级，加上建链与两次 exec 的固定往返，留到 6 秒的余量即可区分两种形态。
  expect(
    elapsed,
    `12MB 未跟踪文件的取数不应把内容拉回宿主（SFTP 实测 ≈1.4MB/s，旧形态 ≥8s）；实测 ${elapsed}ms`,
  ).toBeLessThan(6_000);

  await sshExec(`rm -rf ${shQuote(repo)}`).catch(() => undefined);
});

// ==================== 工作区是仓库子目录（--relative） ====================
// 旧形态下 git 默认输出「仓库根相对」路径，工作区是子目录时这些路径回查不到、被
// 存在性过滤整条丢掉（`sub/x.md` 的改动消失）。`--relative` 让输出与未跟踪文件同一套
// 「工作区相对」路径。

test('RT-7 工作区是仓库子目录：改动行仍在清单里且 data-path 是工作区相对路径', async () => {
  const repo = await initRemoteRepo('subrepo');
  await sshExec(
    `cd ${shQuote(repo)} && mkdir -p sub`
      + ' && printf "x1\\nx2\\n" > sub/x.md && printf "other\\n" > other.md'
      + ' && git add -A && git commit -qm base',
  );
  // 在 sub 里：改一个已跟踪 md、新建一个未跟踪 md
  await sshExec(
    `cd ${shQuote(repo)}/sub && printf "x1\\nx2\\nx3\\n" > x.md && printf "n1\\n" > new.md`,
  );

  const workspace = `${repo}/sub`;
  const sb = await launchWithRemoteWorkspace(workspace);
  await openFilesMode(sb, 'doc');

  // 两条都在清单里，路径是工作区相对（`x.md` / `new.md`，不是 `sub/x.md`）
  await expectRowVisible(sb, 'x.md');
  await expectRowVisible(sb, 'new.md');
  await expect(sb.locator(`${FILES_TREE} .file-row[data-path="sub/x.md"]`)).toHaveCount(0);
  await expect(sb.locator(`${FILES_TREE} .file-row[data-path="x.md"] .doc-plus`)).toHaveText('+1');
  await expect(sb.locator(`${FILES_TREE} .file-row[data-path="new.md"] .doc-plus`)).toHaveText('+1');
  // 仓库根的 other.md 不属于这个工作区
  await expect(sb.locator(`${FILES_TREE} .file-row[data-path="other.md"]`)).toHaveCount(0);

  await sshExec(`rm -rf ${shQuote(repo)}`).catch(() => undefined);
});

// ==================== 取数不触发自己的哨兵（--no-optional-locks 等） ====================
// 变更视图开着时哨兵在监听 `.git`；取数自己写一次索引就会「取数 → 哨兵失效 → 全量
// 重扫」连环。断言两层：取数前后 `.git/index` 的内容哈希与 mtime 不变，且日志里没有
// 反复重扫导致的失败行累积。

test('RT-4 远端取数不改写 .git/index，也不触发自己触发的全量重扫', async () => {
  const repo = await initRemoteRepo('sentinelrepo');
  await sshExec(
    `cd ${shQuote(repo)} && printf "a1\\na2\\n" > a.md && printf "b1\\n" > b.md`
      + ' && git add -A && git commit -qm base',
  );
  await sshExec(`cd ${shQuote(repo)} && printf "a1\\na2\\na3\\n" > a.md && printf "new\\n" > new.md`);

  const sb = await launchWithRemoteWorkspace(repo);
  await openFilesMode(sb, 'changes');
  await expectRowVisible(sb, 'a.md');

  // 记下索引的内容哈希 + mtime（st_mtime 纳秒与 st_size 一起看：内容不变也可能只改
  // stat 缓存，两种改写都算「取数写了索引」）
  const indexState = async (): Promise<string> =>
    (await sshExec(`cd ${shQuote(repo)} && sha256sum .git/index | cut -d" " -f1 && stat -c "%Y.%N" .git/index`))
      .stdout.trim();
  const before = await indexState();
  // 睡眠 1.1 秒让 mtime 秒级分辨率能区分「之后又被写过一次」
  await new Promise((resolve) => setTimeout(resolve, 1_100));

  // 触发取数：点刷新（变更视图上刷新按钮 = 重取当前视图的数据）
  await sb.locator('#filesRefresh').click();
  await expectRowVisible(sb, 'a.md');
  await expectRowVisible(sb, 'new.md');
  // 再切到文档视图、切回差异视图（换 scope 必然重取一次）
  await openFilesMode(sb, 'doc');
  await expectRowVisible(sb, 'a.md');
  await openFilesMode(sb, 'changes');
  await expectRowVisible(sb, 'a.md');

  const after = await indexState();
  console.log(`[RT-4] 取数前索引 ${before.replace(/\n/g, ' | ')}；取数后 ${after.replace(/\n/g, ' | ')}`);
  expect(after, '取数不得改写远端 .git/index（内容哈希与 mtime 都要保持不变）').toBe(before);
  // 取数本身不得报错（链路抖动不计：它同样会让一次取数失败，但不改索引、也不是取数形态问题）
  const failures = docListFailures(repo);
  expect(
    failures.total - failures.transport,
    `取数不得报错（非传输层失败 ${failures.total - failures.transport} 行；另有链路抖动 ${failures.transport} 行）`,
  ).toBe(0);

  await sshExec(`rm -rf ${shQuote(repo)}`).catch(() => undefined);
});

// ==================== 失败语义不变（非 git 工作区） ====================
// 取数形态重构不得改变既有判别值：非 git 工作区的「差异」给提示、
// 「文档」回落记录口径（specs/041 FR-003 / AC-7），而不是静默空列表。

test('RT-5 远端非 git 工作区：差异给 not-a-git-workspace 提示，文档回落记录口径', async () => {
  const plain = `${remoteWs}/plainsub`;
  await sshExec(`rm -rf ${shQuote(plain)} && mkdir -p ${shQuote(plain)} && printf "doc\\n" > ${shQuote(plain)}/plain.md`);

  const sb = await launchWithRemoteWorkspace(plain);
  await openFilesMode(sb, 'changes');
  await expect(sb.getByText('不在 git 仓库内，无法列出变更')).toBeVisible({ timeout: 120_000 });
  await expect(sb.getByText('没有变更的文件')).toHaveCount(0);

  // 文档视图回落记录口径：没有 conversation 记录过改动 → 记录口径空态文案
  await openFilesMode(sb, 'doc');
  await expect(sb.getByText('没有记录的修改文档')).toBeVisible({ timeout: 120_000 });

  await sshExec(`rm -rf ${shQuote(plain)}`).catch(() => undefined);
});
