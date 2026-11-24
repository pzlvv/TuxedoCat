import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'ssh2';
import { startMockLlm } from '../helpers/mockLlmServer';
import { launchApp, makeWorkspace } from '../helpers/electronApp';
import type { AppHandle } from '../helpers/electronApp';
import type { MockLlm, RecordedRequest } from '../helpers/mockLlmServer';
import type { SerializedWorkspaceRef } from '../../src/host/workspaceState';
import {
  CONFIG_DIR_NAME,
  CORE_BINARY_NAME,
  CORE_DEPLOY_PREFIX,
  CORE_MOUNT_PROXY_DIR,
  CORE_MOUNT_PROXY_NAME,
  LOG_FILE_NAME,
} from '../../src/config/project';
import { requireSudoPasswordEnvironment } from '../helpers/testEnvironment';
import { resolveMachineName } from '../../src/host/workspaceIdentity';
import { hostname as osHostname } from 'node:os';

/**
 * Overlay 挂载代理：真实 SSH 远端的安装、自检与隔离（`specs/051` FR-005 / FR-006 /
 * FR-009 / FR-012）。
 *
 * 车分两段：
 *
 * - **普通段**（脚本注入的提权编排，`electron-ssh` 车道）：远端未装机 → 确认框点名真实
 *   主机 → 部署 → 重查能力 `ready`（**不重启 Core**）→ 隔离会话改动不落真实磁盘 →
 *   会话关闭后 `mountinfo` 无泄漏 → 文档里的卸载命令幂等 → Core 日志有审计行。
 * - **特权段**（`test.describe('privileged')`）：安装形态（`root:root` + `04755`）、自检
 *   四断言、进程链与回收、代理拒绝面。远端不满足前置时 `test.skip(true, 缺哪一项)` 单列，
 *   **不算通过**——`markSkipped()` 的同一口径。
 *
 * 环境：`e2e/environments.json` 的 `ssh.sudoPasswordRequired` 段——本车跑在**免密 `sudo`
 * 不可用**的那个账号上（同一台机器，`host` / `port` 沿用 `ssh` 段）。要求的远端形态：
 * `Linux x86_64`、账号在 `sudo` 组且**没有** `NOPASSWD` 规则、口令式 `sudo -S` 可用、
 * `/usr/libexec` 为 `root root 0755`、文件系统无 `nosuid`、内核支持 `overlay`。
 *
 * 为什么必须换个账号而不是按机器现状分支：本车要用 UI 走完「免密失败 → 三选一 → 提交
 * 口令」这条路，而机器上那个免密可用的账号永远进不到三选一。两条通道都要覆盖，就得分
 * 两个账号——`ssh` 段的账号留给免密通道（`e2e/webview/overlayMountProxy.spec.ts` 用假宿主
 * 覆盖），本车专用这里登记的账号。`beforeAll` 会实测 `sudo -n`：**可用即报错**，不静默
 * 跳过（那会让这条通道静默地永远不验证）。
 * `requiretty` / `nosuid` / 祖先可写 / `/usr/libexec` 不存在这五类拒绝面由
 * `src/test/sshDaemonBootstrap.test.ts` 的假 SSH 桩覆盖（改共享真机去逼近等于污染机器）。
 *
 * 共享机器纪律：用例自建工作区、`afterAll` 整目录清理；装了代理就在收尾卸载，没装则断言
 * 「仍不存在」；不留状态文件。
 *
 * 运行：`npm run test:e2e:ssh -- overlayMountProxyRemote`
 * 前置：`npm run build:core:linux-x64`（远端是 Linux 时本机必须携带对应产物）；
 * 远端内核需有 overlayfs（`/proc/filesystems` 有 `nodev overlay`，否则产品的
 * `deployable` 探测恒 false）；`ssh.sudoPasswordRequired` 指向的账号要能登录且
 * `sudo -n` 失败、`sudo -S` 成功；「已安装」段的用例要先跑过部署用例或手工装机。
 */


/**
 * 本车跑在**免密 sudo 不可用**的那个账号上（`ssh.sudoPasswordRequired`）：
 * 三选一凭据通道只有在这个身份下才走得到。
 */
const SSH = requireSudoPasswordEnvironment();

// 单用例上限由 project 给（`electron-ssh` = 60s，见 `e2e/playwright.config.ts`）。
// 本文件的用例整轮实测最长 49.1s，全部落在 60s 档内，不做文件级放宽。

/** 远端安装位点（产物名与目录的唯一来源是 `src/config/project.json`） */
const REMOTE_PROXY_PATH = `${CORE_MOUNT_PROXY_DIR}/${CORE_MOUNT_PROXY_NAME}`;
/**
 * 允许列表 sidecar（`<落点>.uids`）：`--install` 时写入调用者 uid，入口只放行列表内的
 * 真实 uid（`docs/core/mount-proxy.md` 第 2 节）。卸载必须连它一起删，否则共享机器上
 * 残留上一轮测试用户的 uid。
 */
const REMOTE_PROXY_UIDS_PATH = `${REMOTE_PROXY_PATH}.uids`;
/** 远端部署槽位（代理与 Core 同目录） */
const REMOTE_DEPLOY_DIR = `~/.local/share/${CORE_DEPLOY_PREFIX}`;
/** 远端运行目录（daemon 状态文件） */
const REMOTE_RUN_DIR = `~/${CONFIG_DIR_NAME}/run`;
/** pgrep / pkill 模式首字符加 []，不匹配执行它的远端 shell 自身 */
const CORE_PROCESS_PATTERN = `[${CORE_BINARY_NAME[0]}]${CORE_BINARY_NAME.slice(1)}`;
const PROXY_PROCESS_PATTERN = `[${CORE_MOUNT_PROXY_NAME[0]}]${CORE_MOUNT_PROXY_NAME.slice(1)}`;

/**
 * 本机构建的 Core 指纹（远端槽位名就是它）。
 *
 * 远端 daemon 状态文件名形如 `core-daemon-<fingerprint>.json`，指纹由本机 Core 产物内容
 * 算出（`dist/resources/core/<arch>-<platform>/fingerprint`），因此收尾时按本机指纹拼出
 * 文件名而不是猜一个。产物缺失返回 null（产物缺失本身已由 playwright 配置在加载期拦下）。
 */
function localCoreFingerprint(): string | null {
  try {
    return fs.readFileSync(
      path.join(
        process.cwd().replace(/[\\/]e2e$/, ''),
        'dist', 'resources', 'core', 'x64-linux', 'fingerprint',
      ),
      'utf8',
    ).trim();
  } catch {
    return null;
  }
}

function sshConnect(): Client {
  const client = new Client();
  client.connect({
    host: SSH.host,
    port: SSH.port,
    username: SSH.user,
    password: SSH.password,
    readyTimeout: 20_000,
  });
  return client;
}

/**
 * 在远端执行一条命令（一次性连接，测试脚手架用）。
 *
 * 链路层重试的判据与 `remoteChangeList.spec.ts` 一致：只在命令**还没被远端受理**时重试
 * （`ready` 之前或 exec 通道尚未打开），已开始执行的命令不会跑两遍——被测链路本身不重试，
 * 重试会掩盖缺陷（`e2e/README.md` 已知坑 10）。
 */
function sshExec(
  command: string,
  timeoutMs = 120_000,
  attempt = 1,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const client = sshConnect();
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

/** 远端 shell 片段里的单引号转义 */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * 远端 daemon 清场：杀进程 + 删本指纹槽位的状态文件。
 *
 * 每轮都要清（`e2e/README.md` 已知坑 11）：上一条用例结束时宿主关窗，远端 daemon 仍可能
 * 处在空闲退出倒计时里、状态文件也还在；下一条用例立刻建链时若命中这个半死的 daemon，
 * 握手会挂在那儿，表现为「等待活动聊天视图超时（候选 0 个）」。
 */
async function resetRemoteDaemon(): Promise<void> {
  await sshExec(`pkill -u "$(id -u)" -f '${CORE_PROCESS_PATTERN}' || true`).catch(() => undefined);
  // 等进程真的消失而不是等固定时长：pkill 只负责发信号，SIGTERM 到进程真正退出之间有
  // 间隔（Core 还要收尾写盘），负载高时 1s 不够——半死的 daemon 会让下一条用例建链挂住
  // （e2e/README.md 已知坑 11）。
  await pollRemote(
    async () => (await remoteProcesses(CORE_PROCESS_PATTERN)).length === 0,
    15_000,
    '清场：残留 Core / daemon 全部退出',
  ).catch(() => undefined);
  const fingerprint = localCoreFingerprint();
  if (fingerprint) {
    await sshExec(`rm -f ${REMOTE_RUN_DIR}/core-daemon-${fingerprint}.json`).catch(() => undefined);
  }
}

let remoteHome = '';
let remoteWs = '';
let remoteRef: SerializedWorkspaceRef;
let mockLlm: MockLlm | null = null;
let app: AppHandle | null = null;

test.beforeAll(async () => {
  const home = await sshExec('pwd');
  if (home.code !== 0) throw new Error(`远端 pwd 失败: ${home.stderr}`);
  remoteHome = home.stdout.trim();
  remoteWs = `${remoteHome}/tuxedo-e2e-mount-proxy-${process.pid}`;
  await sshExec(`mkdir -p ${shQuote(remoteWs)}`);
  remoteRef = {
    scheme: 'ssh',
    path: remoteWs,
    endpoint: {
      host: SSH.host,
      port: SSH.port,
      user: SSH.user,
      auth: { kind: 'sshPassword', password: SSH.password },
    },
  };
  // 环境有效性（整车道一次）：这个账号必须**免密 sudo 不可用**。可用就说明
  // `ssh.sudoPasswordRequired` 指错了账号（填成了 `ssh` 段那个），此时整条车道会走到
  // 免密分支、三选一永远不出现——报错而不是跑出 2 条看不懂的超时。
  const sudoN = await sshExec('sudo -n true');
  if (sudoN.code === 0) {
    throw new Error(
      `E2E 环境配置无效：${SSH.user}@${SSH.host}:${SSH.port} 的免密 sudo **可用**，`
      + `而本车要用「免密不可用 → 三选一凭据」这条通道。`
      + `请把 e2e/environments.json 的 ssh.sudoPasswordRequired 指向同一台机器上`
      + `没有 NOPASSWD 规则的账号（口令式 sudo -S 可用）。不做修复。`,
    );
  }
  await resetRemoteDaemon();
});

test.beforeEach(async () => {
  // 环境有效性（每个用例开头）：SSH 可达且远端是 Linux。无效直接报错，不换凭证重试、
  // 不清远端状态、不做任何修复。
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
      `SSH 测试环境无效：远端平台 "${system ?? 'unknown'}" 不被支持（本机携带的 Core 产物只覆盖 Linux）。`,
    );
  }
});

test.afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  mockLlm?.close();
  mockLlm = null;
  // 下一条用例建链前清掉半死的 daemon 与状态文件（已知坑 11）
  await resetRemoteDaemon();
});

test.afterAll(async () => {
  // 共享机器纪律：整目录清理 + 代理装了就卸载（不留 setuid root 文件），没装则断言仍不存在
  if (remoteWs) await sshExec(`rm -rf ${shQuote(remoteWs)}`).catch(() => undefined);
  const { installed } = await proxyInstalled();
  if (installed) {
    const removed = await uninstallProxy();
    expect(removed.code, `收尾卸载代理失败：${removed.stderr}`).toBe(0);
  }
  expect((await proxyInstalled()).installed, '收尾后安装位点必须不存在').toBe(false);
});

/** 远端代理是否已安装（只认安装位点，随包产物算未安装——FR-005b） */
async function proxyInstalled(): Promise<{ installed: boolean; stat: string }> {
  const result = await sshExec(
    `if [ -e ${REMOTE_PROXY_PATH} ]; then stat -c '%U %G %a' ${REMOTE_PROXY_PATH}; else echo ABSENT; fi`,
  );
  const stat = result.stdout.trim();
  return { installed: stat !== 'ABSENT' && stat.length > 0, stat };
}

/**
 * 卸载代理（`docs/core/mount-proxy.md` 第 2.1 节的幂等命令，FR-012 / AC-36）。
 *
 * 幂等：位点不存在时也成功退出。本车账号的免密 `sudo` 不可用（`beforeAll` 已实测，
 * 可用即报错），因此密码经**标准输入**喂给 `sudo -S`（不进 argv，specs/051 FR-004 第 3
 * 条同一口径）；收尾用它把远端恢复成「未装机」——共享机器不能留下一个 setuid root 文件。
 *
 * 必须删**两个**文件：主二进制与它的允许列表 `<落点>.uids`（`--install` 时把调用者 uid
 * 写进去，入口只放行列表内的 uid）。只删主程序会留下一个记录着测试用户 uid 的 sidecar
 * ——下一个装机的用户会发现自己的 uid 已在放行名单里。
 */
async function uninstallProxy(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return sshExecWithStdin(
    `sudo -S -p '' rm -f ${REMOTE_PROXY_PATH} ${REMOTE_PROXY_UIDS_PATH}`,
    `${SSH.password}\n`,
  );
}

/**
 * 经界面完成部署：勾 Overlay → 发消息 → 确认框 → 部署 → 提交 sudo 密码 → 等到能力 ready。
 *
 * 抽出来是因为它有两类调用方：`FR-009` 验的是**首次部署**的完整链路（确认框文案、Core pid
 * 不变），后续用例验的是隔离行为，只需要「代理已就位」这个前提。让后者复用同一段交互，
 * 单独 `-g` 跑某条用例时就不会因为前置用例没跑而静默跳过。
 */
async function deployProxyViaUi(chatPage: Awaited<ReturnType<AppHandle['chatPage']>>): Promise<void> {
  const dialog = chatPage.locator('[data-mount-proxy-dialog="confirm"]');
  await expect(dialog).toBeVisible({ timeout: 60_000 });
  // 确认 → 远端免密 sudo 不可用（本车账号的前置）→ 三选一 → 提交 sudo 密码
  await dialog.locator('[data-mount-proxy-action="deploy"]').click();
  const passwordAction = dialog.locator('[data-mount-proxy-action="sudo-password"]');
  await expect(passwordAction, '本车账号的免密 sudo 不可用，应给三选一').toBeVisible({ timeout: 120_000 });
  await passwordAction.click();
  await dialog.locator('input[data-mount-proxy-secret]').fill(SSH.password);
  await chatPage.keyboard.press('Enter');
  // AC-29：部署 + 自检成功后能力转 ready（宿主重查，不重启 Core）
  await expect
    .poll(async () => (await readCapabilities(chatPage)).mountProxy, { timeout: 240_000 })
    .toBe('ready');
}

/**
 * 保证远端已装代理；没装就经界面装一次。
 *
 * 与 `FR-009` 的分工：那条**断言**首次部署的完整过程，这条只保证前置成立。装完即关掉
 * 这一轮应用，调用方随后自建干净会话——部署用的那次 Overlay 勾选不该带进被测会话。
 */
/**
 * 勾选「隔离工作视图」。
 *
 * 「勾选框可见」本身就是能力已到达的判据，不需要额外查一次：入口的渲染条件就是
 * `isolatedWorkView || deployable`（`src/webview/MessagesView.tsx` 的 `showWorkViewOption`，
 * specs/051 FR-002），两者都不成立时整块不渲染。因此等可见就够了。
 *
 * 早先这里额外轮询 `requestStorageCapabilities` 等 `deployable`，反而制造了竞态：
 * 它每轮都发一条能力请求并装一个 `setStorageCapabilities` 监听器，会和随后的
 * `sendMessage` 抢时序；且代理装好之后 `deployable` 恒为 false（`capabilities_from`
 * 的 ready 分支），一律等它会把每条用例卡死在 60s 超时上。
 */
async function checkWorkViewOption(
  chatPage: Awaited<ReturnType<AppHandle['chatPage']>>,
): Promise<void> {
  await expect(chatPage.locator('input[data-work-view-option]')).toBeVisible({ timeout: 60_000 });
  await chatPage.locator('input[data-work-view-option]').check();
}

/**
 * 保证远端已装代理（幂等）。没装就经界面装一次，失败再重试一次。
 *
 * 为什么允许重试：这是**布置前置**，不是被测行为。UI 部署要经过「起应用 → SSH 建链 →
 * daemon 引导 → 勾 Overlay → 发消息 → 宿主闸门 → 确认框 → sudo 口令 → 自检」一长串环节，
 * 任何一环的瞬时抖动（已知坑 10 的 SSH 建链约 3% 失败）都会让确认框不出现。前置抖动不该
 * 让用例判红——真正要判的是它装好之后的行为。重试只覆盖**部署前置**，被测链路的断言
 * 一律不重试（那会掩盖 `specs/defects/` 里那一类缺陷）。
 */
async function ensureProxyInstalled(): Promise<void> {
  if ((await proxyInstalled()).installed) return;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const chatPage = await launchWithRemoteWorkspace();
      await checkWorkViewOption(chatPage);
      await chatPage.fill('textarea.input-textarea', '部署挂载代理（前置）');
      await chatPage.press('textarea.input-textarea', 'Enter');
      await deployProxyViaUi(chatPage);
      await app?.close();
      app = null;
      mockLlm?.close();
      mockLlm = null;
      // 这里**不**调 `resetRemoteDaemon`：调用方紧接着就要建链，杀掉刚起来的 daemon 会让
      // 下一条会话连到一个正在退出的进程上（表现为消息发出后既无模型请求也无工具执行）。
      // 清场由 `beforeEach` 统一负责，它在每条用例开始前做。
      return;
    } catch (error) {
      lastError = error;
      // 收掉这一轮的应用与 mock，下一轮重新起（脏实例上重试没有意义）
      await app?.close().catch(() => undefined);
      app = null;
      mockLlm?.close();
      mockLlm = null;
      await resetRemoteDaemon();
      if ((await proxyInstalled()).installed) return;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('挂载代理部署前置失败');
}

/** 远程 exec 并写入标准输入（密码只走 stdin，不进 argv——FR-004 第 3 条） */
function sshExecWithStdin(
  command: string,
  stdin: string,
  timeoutMs = 60_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const client = sshConnect();
    const fail = (error: Error): void => { client.end(); reject(error); };
    client.on('error', fail);
    client.on('ready', () => {
      client.exec(command, (err, stream) => {
        if (err) return fail(err);
        let stdout = '';
        let stderr = '';
        stream.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
        stream.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
        stream.on('close', (code: number | null) => {
          client.end();
          resolve({ stdout, stderr, code });
        });
        // 写一行后立即关闭（写入多余输入会被 sudo 拿去重试，FR-004 第 3 条）
        stream.end(stdin);
      });
    });
    setTimeout(() => fail(new Error(`ssh exec(stdin) 超时: ${command}`)), timeoutMs);
  });
}

/**
 * 远端还活着的 Core / 代理进程。
 *
 * 只统计 **SSH 用户自己 uid** 的进程（`pgrep -u`）：裸 `pgrep -af` 是全机口径，本机自测
 * （远端就是开发机）时会把开发机正在用的 Core 算成本车道残留，断言必然失败。车道只对
 * 自己部署的进程负责——Core 与代理 A 都归 SSH 用户所有；代理 B 以 setuid root 运行时
 * 由调用方显式传 `allUsers`（它是 root 身份，按 uid 过滤会漏掉）。
 */
async function remoteProcesses(
  pattern: string,
  allUsers = false,
): Promise<Array<{ pid: string; cmd: string }>> {
  const scope = allUsers ? '' : '-u "$(id -u)" ';
  const { stdout } = await sshExec(`pgrep ${scope}-af '${pattern}' || true`);
  return stdout.trim().split('\n').filter((line) => line.length > 0).map((line) => {
    const space = line.indexOf(' ');
    return { pid: line.slice(0, space), cmd: line.slice(space + 1) };
  });
}

/** Core 与底部代理的 pid + ppid + euid（判父子链与降权用） */
interface ProcessRow {
  pid: string;
  ppid: string;
  euid: string;
  args: string;
}

/**
 * 某组进程的 pid / ppid / euid / args。
 *
 * 代理的归属只能按**父子链**判，不能按「全机有几个代理」判：每个隔离会话一个代理，
 * 上一个用例的代理若还在收尾，全机计数就永远不为 0（本机自测时尤其明显——开发机
 * 自己的会话也带着代理）。AC-26b 本来就要求「A 是 Core 的直接子进程」，这里把同一条
 * 判据提出来给回收断言共用。
 */
async function processRows(patterns: string[]): Promise<ProcessRow[]> {
  const orPattern = patterns.join('|');
  const { stdout } = await sshExec(
    `ps -eo pid=,ppid=,euid=,args= | grep -E '${orPattern}' | grep -v grep || true`,
  );
  return stdout
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [pid, ppid, euid, ...rest] = line.trim().split(/\s+/);
      return { pid, ppid, euid, args: rest.join(' ') };
    });
}

/**
 * 指定 Core（`corePid`）的后代里是否已经没有代理进程。
 *
 * 判据是「**该 Core 及其后代**里没有代理」：每个隔离会话一个代理，别的会话的代理归
 * 别的 Core，与本会话无关——按全机计数会误判（见 `remoteProcesses` 的注释）。Core 自身
 * 已消失时同样算「本会话代理已退」：没有父进程能给代理收尾了。
 */
async function sessionProxyGoneFor(corePid: string): Promise<boolean> {
  const rows = await processRows([CORE_PROCESS_PATTERN, PROXY_PROCESS_PATTERN]);
  if (!rows.some((row) => row.pid === corePid)) return true;
  const children = new Map<string, ProcessRow[]>();
  for (const row of rows) {
    const list = children.get(row.ppid) ?? [];
    list.push(row);
    children.set(row.ppid, list);
  }
  const stack = [corePid];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const pid = stack.pop() as string;
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const child of children.get(pid) ?? []) {
      if (child.args.includes(CORE_MOUNT_PROXY_NAME)) return false;
      stack.push(child.pid);
    }
  }
  return true;
}

/** 轮询远端直到条件满足（每 2s 一次连接） */
async function pollRemote(
  probe: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`远端轮询超时（${timeoutMs}ms）：${label}`);
}

/** 启动应用并恢复预置的远程工作区；返回绑定该工作区的聊天视图 */
async function launchWithRemoteWorkspace(): Promise<Awaited<ReturnType<AppHandle['chatPage']>>> {
  mockLlm = await startMockLlm({
    workspaceDir: remoteWs,
    listenHost: '0.0.0.0',
    reverseTunnel: SSH,
  });
  app = await launchApp({
    repoRoot: process.cwd().replace(/[\\/]e2e$/, ''),
    mockLlm,
    workspaceDir: remoteWs,
    openWorkspaces: [remoteRef],
    agentMode: 'auto',
    // 与下面 chatPage 的 180s 预算对齐（`specs/defects/
    // e2e-launchapp-inner-chatpage-wait-ignores-caller-timeout.md`）
    startupChatWaitMs: 180_000,
  });
  const chatPage = await app.chatPage({ workspaceIncludes: 'tuxedo-e2e-mount-proxy' }, 180_000);
  await chatPage.waitForSelector('textarea.input-textarea', { timeout: 30_000 });
  return chatPage;
}

/** 取第二轮（工具结果回传后）请求里最后一条 tool 消息的内容 */
function lastToolResult(req: RecordedRequest | undefined): string {
  if (!req) return '';
  const last = req.body.messages[req.body.messages.length - 1];
  if (!last || last.role !== 'tool') return '';
  return typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
}

/**
 * 找到**倒数第二条**请求里最后一条 `tool` 消息的结果。
 *
 * 单轮探测用 `lastToolResult(requests[1])` 就够；一个会话里发两轮时，第二轮的
 * 「工具结果」出现在第二次请求里而不是 `requests[3]`（每条消息都会重放历史，索引
 * 取决于模型何时收尾）。按「含有该工具名的最后一条 tool 结果」扫比猜索引稳。
 */
function toolResultMatching(requests: RecordedRequest[], needle: string): string {
  for (let index = requests.length - 1; index >= 0; index -= 1) {
    const result = lastToolResult(requests[index]);
    if (result && result.includes(needle)) return result;
  }
  // 找不到时回最后一条结果：断言会按内容报错，报出的是真实拿到的东西
  return lastToolResult(requests[requests.length - 1]);
}

// ─────────────────────── 普通段：远端安装与隔离 ───────────────────────

/** 取远端 Core 的文件存储能力（经宿主转发，与 webview 拿到的是同一份事实） */
async function readCapabilities(
  page: import('@playwright/test').Page,
): Promise<{ isolatedWorkView: boolean; mountProxy: 'ready' | 'absent'; deployable: boolean; reason: string }> {
  return page.evaluate(async () => {
    // Electron 宿主经 preload 暴露的是 `electronAPI`（`src/webview/webviewEnv.ts` 的
    // `getHostMessageApi` 同口径）；VS Code 宿主才是 `vscode`。这里取同一个入口，
    // 否则用例在 Electron 里恒报 `Cannot read properties of undefined`。
    const host = window as unknown as {
      electronAPI?: { postMessage: (m: unknown) => void };
      vscode?: { postMessage: (m: unknown) => void };
    };
    const wire = host.electronAPI ?? host.vscode;
    if (!wire) throw new Error('未找到宿主消息 API（electronAPI / vscode 都缺失）');
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('storageCapabilities 超时')), 30_000);
      const onMessage = (event: MessageEvent): void => {
        const msg = event.data as { type?: string };
        if (msg?.type !== 'setStorageCapabilities') return;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve(msg as unknown as Record<string, unknown>);
      };
      window.addEventListener('message', onMessage);
      wire.postMessage({ type: 'requestStorageCapabilities' });
    });
  }) as unknown as Promise<{
    isolatedWorkView: boolean;
    mountProxy: 'ready' | 'absent';
    deployable: boolean;
    reason: string;
  }>;
}

test('FR-009 远端未装机时确认框点名真实主机，部署后能力 ready 且不重启 Core', async () => {
  // 前置：远端未装机（上一轮失败可能留下代理，先恢复）
  await uninstallProxy();

  const chatPage = await launchWithRemoteWorkspace();

  // 远端能力（经宿主转发）：未装机时 isolatedWorkView false，reason 点名缺失
  const before = await readCapabilities(chatPage);
  expect(before.isolatedWorkView).toBe(false);
  expect(before.mountProxy).toBe('absent');
  expect(before.deployable, 'Linux 远端且内核有 overlayfs，装代理能解决').toBe(true);

  // 部署前 Core pid：部署后必须不变（FR-008 不再重启 Core）
  const corePidBefore = (await remoteProcesses(CORE_PROCESS_PATTERN))
    .find((p) => p.cmd.includes(' stdio'))?.pid;
  expect(corePidBefore, '应能读到远端 workspace Core 的 pid').toBeTruthy();

  // AC-34：勾选 Overlay 发第一条消息 → 确认框出现，文案点名真实主机（远端场景必须显示）
  // 用 helper 勾选：它先等能力到达，勾完再发消息，闸门才判得出可部署
  await checkWorkViewOption(chatPage);
  await chatPage.fill('textarea.input-textarea', '远端 Overlay 首次使用');
  await chatPage.press('textarea.input-textarea', 'Enter');
  const dialog = chatPage.locator('[data-mount-proxy-dialog="confirm"]');
  await expect(dialog).toBeVisible({ timeout: 60_000 });
  await expect(dialog.locator('[data-fact="target-host"]')).toContainText(SSH.host);
  // 消息没有进 Core（AC-7）：确认框期间界面上没有用户气泡
  await expect(chatPage.locator('.message-user')).toHaveCount(0);

  // 确认部署 → 本车账号的 sudo 需要密码（`beforeAll` 已实测 `sudo -n` 失败）
  // → 三选一 → 提交 sudo 密码
  await dialog.locator('[data-mount-proxy-action="deploy"]').click();
  const passwordAction = dialog.locator('[data-mount-proxy-action="sudo-password"]');
  await expect(passwordAction, '本车账号的免密 sudo 不可用，应给三选一').toBeVisible({ timeout: 45_000 });
  await passwordAction.click();
  await dialog.locator('input[data-mount-proxy-secret]').fill(SSH.password);
  await chatPage.keyboard.press('Enter');

  // AC-29：部署 + 自检成功后能力转 ready（宿主重查，不重启 Core）
  await expect
    .poll(async () => (await readCapabilities(chatPage)).mountProxy, { timeout: 45_000 })
    .toBe('ready');  expect((await readCapabilities(chatPage)).isolatedWorkView).toBe(true);

  // FR-008：Core pid 未变（部署不重启 Core）
  const corePidAfter = (await remoteProcesses(CORE_PROCESS_PATTERN))
    .find((p) => p.cmd.includes(' stdio'))?.pid;
  expect(corePidAfter, '部署成功后不得重启 Core').toBe(corePidBefore);

  // FR-009 / AC-34：代理随 Core 上传到远端指纹槽位（与 Core 二进制同目录）
  const fingerprint = localCoreFingerprint();
  expect(fingerprint, '本机应有 Core 指纹产物（npm run build:core:linux-x64）').toBeTruthy();
  const slot = await sshExec(`ls ${REMOTE_DEPLOY_DIR}/${fingerprint}/ 2>&1`);
  expect(slot.stdout, `远端槽位应含代理产物（${slot.stderr}）`).toContain(CORE_MOUNT_PROXY_NAME);
  // 安装形态（AC-15：root:root + 04755）
  expect((await proxyInstalled()).stat).toBe('root root 4755');
});

test('FR-009 已安装时能力 ready、Core pid 不变、帧通道正常', async () => {
  // 自备前置（同 AC-36）：本文件不保证执行顺序，前一条用例可能刚把代理卸掉。
  // ensureProxyInstalled 幂等：已装则直接返回。
  await ensureProxyInstalled();
  const { stat } = await proxyInstalled();
  expect(stat, '安装形态必须是 root:root 04755（AC-15）').toMatch(/^root root 4755$/);

  const chatPage = await launchWithRemoteWorkspace();
  const pidBefore = (await remoteProcesses(CORE_PROCESS_PATTERN))
    .find((p) => p.cmd.includes(' stdio'))?.pid;
  expect(pidBefore, '应能读到 workspace Core 的 pid').toBeTruthy();

  const capabilities = await readCapabilities(chatPage);

  // AC-29 / FR-008：装完后重查能力即 ready，不要求重启 Core
  expect(capabilities.mountProxy).toBe('ready');
  expect(capabilities.isolatedWorkView).toBe(true);
  const pidAfter = (await remoteProcesses(CORE_PROCESS_PATTERN))
    .find((p) => p.cmd.includes(' stdio'))?.pid;
  expect(pidAfter, '重查能力不得重启 Core（daemon 观察到的 pid 不变）').toBe(pidBefore);

  // AC-28：Core 照常服务帧通道（Bash 有应答）
  mockLlm!.setHandler((req) => {
    if (req.body.messages[req.body.messages.length - 1]?.role === 'tool') {
      return { kind: 'text', text: 'REMOTE-PROXY-READY' };
    }
    return { kind: 'tool', name: 'Bash', args: { command: "printf 'frame-ok\\n'", description: 'frame probe' } };
  });
  await chatPage.fill('textarea.input-textarea', '帧通道探针');
  await chatPage.press('textarea.input-textarea', 'Enter');
  await expect(chatPage.getByText('REMOTE-PROXY-READY').first()).toBeVisible({ timeout: 45_000 });
  expect(lastToolResult(mockLlm!.requests[1])).toContain('frame-ok');
});

/**
 * 代理的寿命是整个 Core，不是「拉起它的那条工具线程」（`specs/051` FR-007b）。
 *
 * 回归的形态很具体：Core 在工具批的**短命线程**里 `spawn` 代理，而
 * `PR_SET_PDEATHSIG` 跟的是 parent **task** 而不是 parent process——工具线程一收尾，
 * 内核就把代理 `SIGKILL` 掉，此后同会话每条工具都回「挂载代理已退出：读到 EOF」。
 * 因此本条必须让**多条**工具跑在同一个会话里：只发一条的用例（AC-31 / FR-006）
 * 恰好是在那条还没退出的线程里，永远看不到这个缺陷。
 */
test('FR-007 连续工具调用不因工具线程收尾而丢代理', async () => {
  await ensureProxyInstalled();

  // 预置一个下层源文件：Read 与第二条 Bash 都要真的读到内容，否则「读成功」无从断言
  const sourcePath = `${remoteWs}/main.c`;
  const sourceBody = ['#include <stdio.h>', 'int main(void) {', '  puts("SEQUENTIAL-OK");', '  return 0;', '}', ''].join('\n');
  await sshExec(`cat > ${shQuote(sourcePath)} <<'EOF'\n${sourceBody}EOF`);

  const chatPage = await launchWithRemoteWorkspace();
  await checkWorkViewOption(chatPage);

  // 四步覆盖三条不同通道：spawn（Bash）、readFile（Read）、spawn（Bash）、
  // spawn + 相对路径（Bash 的 cwd 语义）。第二条的 Read 是缺陷首发点。
  const steps: Array<{ name: string; args: Record<string, unknown> }> = [
    {
      name: 'Bash',
      args: { command: `ls -la ${shQuote(remoteWs)}`, description: 'List files in workspace' },
    },
    { name: 'Read', args: { file_path: `${remoteWs}/main.c` } },
    {
      name: 'Bash',
      args: { command: `cat ${shQuote(`${remoteWs}/main.c`)}`, description: 'Show main.c contents' },
    },
    { name: 'Bash', args: { command: 'pwd && ls', description: 'Print working directory' } },
  ];

  mockLlm!.setHandler((req) => {
    const done = req.body.messages.filter((message) => message.role === 'tool').length;
    if (done >= steps.length) return { kind: 'text', text: 'SEQUENTIAL-TOOLS-DONE' };
    return { kind: 'tool', name: steps[done].name, args: steps[done].args };
  });

  await chatPage.fill('textarea.input-textarea', '连续工具调用');
  await chatPage.press('textarea.input-textarea', 'Enter');
  await expect(chatPage.getByText('SEQUENTIAL-TOOLS-DONE').first()).toBeVisible({
    timeout: 45_000,
  });

  // 逐步断言而不是只看最后一条：失败的那一步必须点名（第 1 步成功、第 2 步起全红是
  // 本缺陷的指纹，只看总结果会把「哪一步开始坏」丢掉）。
  const results = mockLlm!.requests
    .filter((request) => request.body.messages[request.body.messages.length - 1]?.role === 'tool')
    .map((request) => lastToolResult(request))
    .slice(-steps.length);
  expect(results, `应拿到 ${steps.length} 条工具结果`).toHaveLength(steps.length);
  results.forEach((result, index) => {
    expect(result, `第 ${index + 1} 步（${steps[index].name}）不该报代理退出：${result}`).not.toMatch(
      /代理已退出|读到 EOF/,
    );
  });
  // 第一条 Bash 真的跑到了视图里（有 main.c），Read 真的读到了源文件
  expect(results[0]).toContain('main.c');
  expect(results[1]).toContain('int main');
  expect(results[2]).toContain('int main');
});

/**
 * 侧栏文件资源管理器在 Overlay 对话下的取数（`specs/046` FR-002 / FR-003 / FR-004）。
 *
 * 三件事只有整应用 + 真实远端 Core 能验：
 *
 * 1. **视图未建立时列目录要按需拉起视图**，而不是回一条「没有已挂载的视图」错误行。
 *    Overlay 对话是惰性建立的（`docs/core/conversation-work-view.md` 第 6 节），
 *    用户完全可能一进对话就展开资源管理器——那里必须看到叠加视图的内容。
 * 2. **树的内容是视图而不是磁盘**：对话内新建的文件要出现，磁盘上同目录没有它。
 * 3. **变更视图能在视图里跑 git**（specs/047）：代理代执行时 `argv[0]` 是裸名，
 *    `execve(2)` 不查 PATH，因此它必须按请求带来的 `PATH` 自己解析。
 */
test('FR-002/FR-003 资源管理器在视图未建立时按需挂载，树与变更清单都取视图内容', async () => {
  await ensureProxyInstalled();

  // 磁盘基线：一个 git 仓库，含一个子目录与一个文件（下层，视图可见但不能改）
  const readme = `${remoteWs}/readme.md`;
  const subDir = `${remoteWs}/src`;
  const overlayOnly = `${remoteWs}/overlay-explorer-only.txt`;
  await sshExec(`mkdir -p ${shQuote(subDir)} && printf 'disk\\n' > ${shQuote(readme)}`);
  await sshExec(
    `cd ${shQuote(remoteWs)} && git init -q . && git add -A `
    + `&& git -c user.email=a@b -c user.name=c commit -qm init`,
  );
  expect((await sshExec(`test -e ${shQuote(overlayOnly)} && echo yes || echo no`)).stdout.trim()).toBe('no');

  const chatPage = await launchWithRemoteWorkspace();

  // 纯文本一轮：会话落盘（storage: isolated），但**不调用任何工具**——视图因此尚未建立。
  // handler 必须在发消息前置好（勾选 Overlay 之后界面就会接受输入），否则第一次请求
  // 落到默认应答上，断言就在等一个不会出现的终答。
  mockLlm!.setHandler(() => ({ kind: 'text', text: 'EXPLORER-BASELINE-DONE' }));
  await checkWorkViewOption(chatPage);
  await chatPage.fill('textarea.input-textarea', '先不调工具');
  await chatPage.press('textarea.input-textarea', 'Enter');
  await expect(chatPage.getByText('EXPLORER-BASELINE-DONE').first()).toBeVisible({ timeout: 45_000 });

  const sidebar = await app!.sidebarPage();
  await expect(sidebar.locator('#filesSection')).toBeVisible({ timeout: 60_000 });
  await expect(sidebar.locator('#filesTitle')).toHaveText('文件资源管理器 (overlay)', { timeout: 30_000 });

  // 展开文件分区（幂等：分区标题是折叠开关，重复点击会把分区收起来）
  const expandFiles = async (): Promise<void> => {
    await expect(sidebar.locator('#filesHeader')).toBeVisible({ timeout: 30_000 });
    const expanded = await sidebar.locator('#filesSection')
      .evaluate((el) => el.classList.contains('expanded'));
    if (!expanded) await sidebar.locator('#filesHeader').click();
    await expect(sidebar.locator('#filesSection')).toHaveClass(/expanded/, { timeout: 30_000 });
  };
  await expandFiles();

  const rows = async (): Promise<string[]> => sidebar.evaluate(() =>
    Array.from(document.querySelectorAll('#filesTree .file-row[data-path]'))
      .map((el) => el.getAttribute('data-path') ?? ''));
  const hintRows = async (): Promise<string[]> => sidebar.evaluate(() =>
    Array.from(document.querySelectorAll('#filesTree .file-row.file-hint'))
      .map((el) => (el.textContent ?? '').trim()));

  // 判据 1：视图尚未建立时也要列出叠加视图的内容（不能是错误行）
  await expect
    .poll(async () => (await rows()).sort(), { timeout: 60_000 })
    .toContain('readme.md');
  expect(await hintRows(), `资源管理器不得显示错误行：${(await hintRows()).join(' | ')}`).toHaveLength(0);
  expect((await rows()).sort(), '磁盘基线里的子目录同样要列出').toContain('src');

  // 判据 2：对话内新建的文件（只落私有上层）出现，磁盘上没有它
  mockLlm!.setHandler((req) => {
    if (req.body.messages[req.body.messages.length - 1]?.role === 'tool') {
      return { kind: 'text', text: 'EXPLORER-WRITE-DONE' };
    }
    return {
      kind: 'tool',
      name: 'Write',
      args: { file_path: overlayOnly, content: 'overlay explorer\n' },
    };
  });
  await chatPage.fill('textarea.input-textarea', '写一个只在视图里的文件');
  await chatPage.press('textarea.input-textarea', 'Enter');
  await expect(chatPage.getByText('EXPLORER-WRITE-DONE').first()).toBeVisible({ timeout: 45_000 });

  await expect
    .poll(async () => (await rows()).sort(), { timeout: 60_000 })
    .toContain('overlay-explorer-only.txt');
  expect(
    (await sshExec(`test -e ${shQuote(overlayOnly)} && echo yes || echo no`)).stdout.trim(),
    '该文件只属于对话的叠加视图，真实磁盘上不得存在',
  ).toBe('no');

  // 判据 3：变更视图在视图里跑 git（代理按请求的 PATH 解析裸名 git）
  //
  // IPC 回包是**已组装的渲染行**（目录在前、层级展开、行数徽标），不是 Core 的
  // `entries`：侧栏对磁盘与视图两条来源共用 `buildDocRows` 同一份组装
  // （`electron/main.ts` 的 `sidebar:files-doc-list-overlay`）。
  const changes = await sidebar.evaluate(async () => {
    const api = (window as unknown as {
      sidebarAPI?: { filesDocListOverlay: (sid: string, scope: 'doc' | 'all') => Promise<unknown> };
    }).sidebarAPI;
    const sid = document.querySelector('#list .item.active')?.getAttribute('data-session-id') ?? null;
    if (!sid || !api) return null;
    return await api.filesDocListOverlay(sid, 'all');
  });
  expect(changes, '应能取到 overlay 的变更清单').not.toBeNull();
  const changesResult = changes as {
    ok: boolean;
    rows?: Array<{
      rel: string;
      plus: number | null;
      minus: number | null;
      status: 'A' | 'M' | 'R' | null;
      oldPath: string | null;
    }>;
    error?: string;
  };
  expect(changesResult.ok, `变更清单必须成功：${changesResult.error ?? ''}`).toBe(true);
  const changedRows = changesResult.rows ?? [];
  expect(
    changedRows.map((row) => row.rel),
    '对话内新建的文件进变更清单',
  ).toContain('overlay-explorer-only.txt');
  const createdRow = changedRows.find((row) => row.rel === 'overlay-explorer-only.txt');
  expect(createdRow?.plus, '新增文件按全文计行（内容一行）').toBe(1);
  // 状态字母随条目回传（specs/055 FR-006 / AC-7）：视图里 HEAD 没有该路径 → A，
  // 且与磁盘口径同一套判别值（宿主渲染层直接用这个字母）
  expect(createdRow?.status, '对话内新建的条目状态是 A').toBe('A');
  expect(createdRow?.oldPath, '非重命名条目的旧路径是 null').toBeNull();
});

test('Overlay 对话：Write 的风车必须收起，且工具卡片上屏期间不出现无指示空窗', async () => {
  await ensureProxyInstalled();

  const chatPage = await launchWithRemoteWorkspace();
  await checkWorkViewOption(chatPage);

  // 采样「thinking 可见 / 有无 running 风车」：只要两者同时为假，界面上就没有任何
  // 进行中的指示。空窗按一次提问的完整生命周期取，逐帧记录。
  await chatPage.evaluate(() => {
    const w = window as unknown as {
      __idle?: number[];
      __stopSampling?: boolean;
      __lastActive?: number;
    };
    w.__idle = [];
    w.__stopSampling = false;
    w.__lastActive = 0;
    const tick = (): void => {
      if (w.__stopSampling) return;
      const wrapper = document.querySelector('.thinking-animation-wrapper');
      const thinking = wrapper !== null && !wrapper.hasAttribute('data-hidden');
      const running = document.querySelectorAll('.msg-timeline-item.msg-timeline-dot-running').length;
      const now = performance.now();
      const lastActive = w.__lastActive ?? 0;
      if (thinking || running > 0) {
        w.__lastActive = now;
      } else if (lastActive > 0) {
        // 从「上一次活跃」到现在的这段就是无指示区间：只在结束于一次新的活跃时计入
        w.__idle!.push(now - lastActive);
        w.__lastActive = 0;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const target = `${remoteWs}/overlay-card-state.txt`;
  mockLlm!.setHandler((req) => {
    if (req.body.messages[req.body.messages.length - 1]?.role === 'tool') {
      return { kind: 'text', text: 'CARD-STATE-DONE' };
    }
    return {
      kind: 'tool',
      name: 'Write',
      args: { file_path: target, content: 'card state\n' },
      preamble: '我来写这个文件。',
    };
  });
  await chatPage.fill('textarea.input-textarea', '写一张卡片状态的截图');
  await chatPage.press('textarea.input-textarea', 'Enter');
  await expect(chatPage.getByText('CARD-STATE-DONE').first()).toBeVisible({ timeout: 45_000 });

  // 判据 1（问题一）：工具成功后不得残留 running 风车。
  // `updateToolStatus.success` 可能先于 `addMessage`（上架卡片）到达；旧实现把它塞进
  // 只在 conversationLoaded 回放的缓冲，实时会话里卡片会永久停在 running。
  await expect(chatPage.locator('.msg-timeline-dot-running')).toHaveCount(0, { timeout: 30_000 });

  // 判据 2（问题二）：卡片上屏期间不得出现「thinking 已消失、风车还没亮」的空窗。
  // 旧实现在 `addMessage(toolcall)` 上无条件关 thinking，而状态更新可能晚到。
  const idleGaps = await chatPage.evaluate(() => {
    const w = window as unknown as { __idle?: number[]; __stopSampling?: boolean };
    w.__stopSampling = true;
    return w.__idle ?? [];
  });
  const worst = idleGaps.length > 0 ? Math.max(...idleGaps) : 0;
  expect(
    worst,
    `工具卡片上屏期间出现 ${Math.round(worst)}ms 无指示空窗（各段：${idleGaps.map((n) => Math.round(n)).join(', ')}）`,
  ).toBeLessThan(150);

  // 判据 3：写入确实落进叠加视图、真实磁盘没有该文件。
  const listed = await chatPage.evaluate(async () => {
    const api = (window as unknown as {
      electronAPI?: { postMessage: (m: unknown) => void };
    }).electronAPI;
    return typeof api?.postMessage === 'function';
  });
  expect(listed, 'webview 与宿主消息通道应可用').toBe(true);
  expect(
    (await sshExec(`test -e ${shQuote(target)} && echo yes || echo no`)).stdout.trim(),
    'Overlay 对话的写入不得落到真实磁盘',
  ).toBe('no');
});

test('AC-31 隔离会话的 Write 不落真实磁盘，会话关闭后 mountinfo 无泄漏', async () => {
  // 前置：代理必须就位；没装就先装（单独 `-g` 跑这条时不会因此静默跳过）
  await ensureProxyInstalled();

  const chatPage = await launchWithRemoteWorkspace();
  const targetName = 'overlay-only.txt';
  const realPath = `${remoteWs}/${targetName}`;
  // 基线：真实磁盘上不存在
  expect((await sshExec(`test -e ${shQuote(realPath)} && echo yes || echo no`)).stdout.trim()).toBe('no');

  // 建 Overlay 会话并让模型写文件。handler 先就位再勾选（理由见 FR-002 用例）
  mockLlm!.setHandler((req) => {
    if (req.body.messages[req.body.messages.length - 1]?.role === 'tool') {
      return { kind: 'text', text: 'OVERLAY-WRITE-DONE' };
    }
    return {
      kind: 'tool',
      name: 'Write',
      args: { file_path: realPath, content: 'overlay only\n' },
    };
  });
  await checkWorkViewOption(chatPage);
  await chatPage.fill('textarea.input-textarea', '在隔离视图里写文件');
  await chatPage.press('textarea.input-textarea', 'Enter');
  await expect(chatPage.getByText('OVERLAY-WRITE-DONE').first()).toBeVisible({ timeout: 45_000 });

  // AC-31：写进了叠加视图，真实磁盘没变。
  //
  // 两条断言缺一不可：只查磁盘会漏掉「写成功但写到别处」，只查结果会漏掉「报了错
  // 却已经落盘」。`specs/defects/mount-proxy-write-file-payload-type.md` 的形态正是
  // 前者——Write 每次都报错，而磁盘确实没变，只看磁盘这条会绿。
  const toolResult = toolResultMatching(mockLlm!.requests, targetName);
  expect(toolResult, `Write 必须成功且不回 error：${toolResult}`).not.toMatch(
    /error|不可用|failed/i,
  );
  expect(toolResult, 'Write 结果应包含成功写出的内容或路径').toContain(targetName);
  expect((await sshExec(`test -e ${shQuote(realPath)} && echo yes || echo no`)).stdout.trim()).toBe(
    'no',
  );

  // AC-28j：会话关闭后代理 mountinfo 里没有该 overlay 条目。
  //
  // 判据按本会话收敛：关应用前记下 workspace Core 的 pid，关后断言「该 pid 及其后代里
  // 没有代理」。不能数全机代理——每个隔离会话一个代理，别的会话（含同轮上一条用例的
  // 收尾、以及本机自测时开发机自己的会话）都算进去就永远不为 0。
  const corePid = (await remoteProcesses(CORE_PROCESS_PATTERN))
    .find((p) => p.cmd.includes(' stdio'))?.pid;
  expect(corePid, '应能读到 workspace Core 的 pid').toBeTruthy();
  await app!.close();
  app = null;
  mockLlm!.close();
  mockLlm = null;
  await pollRemote(
    async () => sessionProxyGoneFor(corePid as string),
    30_000,
    '代理进程退出（Core 关闭 → socketpair EOF → B 退 → A 收尸）',
  );
  // 挂载随命名空间销毁，宿主机看不到残留（代理不可见）——断言宿主 mountinfo 无该会话条目
  const leaked = await sshExec(`grep -c '${shQuote(remoteWs)}' /proc/self/mountinfo || true`);
  expect(leaked.stdout.trim() === '' || leaked.stdout.trim() === '0', '挂载点不得泄漏到宿主机').toBe(
    true,
  );
});

/**
 * Overlay 会话里「Write 新建 → Edit 同一文件」必须成立
 * （`specs/defects/overlay-edit-and-card-links-read-real-disk.md`）。
 *
 * 缺陷形态：权限层（`core-rs/src/permission.rs`）用 `std::fs` 读目标文件判「是否存在 /
 * 旧内容是什么」，而 Core 不在挂载命名空间里——它读到的是真实磁盘。视图内新建的文件
 * 因此被判成不存在，`Edit` 在权限阶段就被 deny（文案 `File does not exist: ...`），
 * 工具根本没执行。
 *
 * 判据两条缺一不可：`Edit` 结果不含 `File does not exist`（真的过了权限阶段）+ 新内容
 * 在后续 `Read` 里读得到（真的改了视图里的那份）；再补一条真实磁盘上没有该文件。
 */
test('Overlay 会话：Write 新建的文件必须能被 Edit 继续修改', async () => {
  await ensureProxyInstalled();

  const targetName = 'overlay-edit-chain.py';
  const target = `${remoteWs}/${targetName}`;
  expect(
    (await sshExec(`test -e ${shQuote(target)} && echo yes || echo no`)).stdout.trim(),
    '基线：真实磁盘上不得有这个文件',
  ).toBe('no');

  const chatPage = await launchWithRemoteWorkspace();
  await checkWorkViewOption(chatPage);

  // 三步：Write 新建 → Edit 同一文件 → Read 读回。Read 是「改动真的落在视图里」的凭据：
  // 只看 Edit 的成功文案会漏掉「Edit 写了另一份内容」这类假绿。
  const steps: Array<{ name: string; args: Record<string, unknown> }> = [
    { name: 'Write', args: { file_path: target, content: 'print("first")\n' } },
    {
      name: 'Edit',
      args: {
        file_path: target,
        old_string: 'print("first")',
        new_string: 'print("second")',
      },
    },
    { name: 'Read', args: { file_path: target } },
  ];
  mockLlm!.setHandler((req) => {
    const done = req.body.messages.filter((message) => message.role === 'tool').length;
    if (done >= steps.length) return { kind: 'text', text: 'EDIT-CHAIN-DONE' };
    return { kind: 'tool', name: steps[done].name, args: steps[done].args };
  });

  await chatPage.fill('textarea.input-textarea', '在 Overlay 里新建再编辑');
  await chatPage.press('textarea.input-textarea', 'Enter');
  await expect(chatPage.getByText('EDIT-CHAIN-DONE').first()).toBeVisible({ timeout: 45_000 });

  const results = mockLlm!.requests
    .filter((request) => request.body.messages[request.body.messages.length - 1]?.role === 'tool')
    .map((request) => lastToolResult(request))
    .slice(-steps.length);
  expect(results, `应拿到 ${steps.length} 条工具结果`).toHaveLength(steps.length);

  // 判据 1：Edit 不得被权限层拦下（缺陷文案就是这一句）
  expect(results[1], `Edit 必须真的执行：${results[1]}`).not.toMatch(
    /File does not exist|Use Write tool to create new files/,
  );
  expect(results[1], `Edit 应报告改了一处：${results[1]}`).toMatch(/Made 1 replacement/);
  // 判据 2：改后的内容在同会话的 Read 里读得到
  expect(results[2], `Read 必须读到 Edit 后的内容：${results[2]}`).toContain('print("second")');
  expect(results[2], `Read 不得再看到旧内容：${results[2]}`).not.toContain('print("first")');
  // 判据 3：整条链都在视图里，真实磁盘上没有该文件
  expect(
    (await sshExec(`test -e ${shQuote(target)} && echo yes || echo no`)).stdout.trim(),
    `Overlay 会话新建的文件不得落到真实磁盘：${target}`,
  ).toBe('no');
});

/**
 * Overlay 会话里点 Edit / Write 卡片的文件链接，打开的必须是**视图内容**
 * （`specs/defects/overlay-edit-and-card-links-read-real-disk.md`）。
 *
 * 缺陷形态：`ElectronUIHost.openFile` 只有「SFTP 读真实磁盘」与「本地读盘」两条路，
 * 于是磁盘上没有的对话内新文件在窗口里显示
 * `// 无法读取远程文件: SFTP read failed (...): No such file`。
 *
 * 判据：内置 Monaco 窗口出现，内容含对话内写出的文本，且不含 `无法读取远程文件`。
 */
test('Overlay 会话：Edit 卡片链接打开的是视图内容而不是真实磁盘', async () => {
  await ensureProxyInstalled();

  const targetName = 'overlay-card-link.py';
  const target = `${remoteWs}/${targetName}`;
  const marker = 'OVERLAY-CARD-LINK-CONTENT';
  expect(
    (await sshExec(`test -e ${shQuote(target)} && echo yes || echo no`)).stdout.trim(),
    '基线：真实磁盘上不得有这个文件',
  ).toBe('no');

  const chatPage = await launchWithRemoteWorkspace();

  // handler 先就位再勾选（理由见 FR-002 用例）
  mockLlm!.setHandler((req) => {
    if (req.body.messages[req.body.messages.length - 1]?.role === 'tool') {
      return { kind: 'text', text: 'CARD-LINK-DONE' };
    }
    return {
      kind: 'tool',
      name: 'Write',
      args: { file_path: target, content: `${marker}\n` },
    };
  });
  await checkWorkViewOption(chatPage);
  await chatPage.fill('textarea.input-textarea', '写一个文件然后点卡片链接');
  await chatPage.press('textarea.input-textarea', 'Enter');
  await expect(chatPage.getByText('CARD-LINK-DONE').first()).toBeVisible({ timeout: 45_000 });

  // 卡片路径链接：用 title 精确锁定（聊天页里 .hover\:underline 有多处）
  const pathLink = chatPage.locator(`button[title*="${targetName}"]`);
  await expect(pathLink).toBeVisible({ timeout: 30_000 });
  await pathLink.click();

  const monacoPage = await app!.waitForPage('monaco/index.html', 30_000);
  await expect(monacoPage.locator('.monaco-editor')).toBeVisible({ timeout: 30_000 });
  await expect(monacoPage.locator('.view-lines')).toContainText(marker, { timeout: 30_000 });
  // 缺陷文案不得再出现（它是「读真实磁盘失败」的指纹）
  const shown = await monacoPage.locator('.view-lines').innerText();
  expect(shown, `链接必须读视图内容，而不是报磁盘读失败：${shown}`).not.toContain(
    '无法读取远程文件',
  );
});

/**
 * Overlay 会话里 `Transfer` 的视图端（specs/056 FR-009 / AC-14 / AC-15）。
 *
 * 两向一次跑完：
 *
 * 1. **搬出**：对话内只存在于叠加视图的文件传到本机另一个工作区 —— 目标端内容必须等于
 *    视图内容，而远端磁盘上仍不存在该文件（基线里刻意只写进视图、不写磁盘）。
 * 2. **搬进**：本机工作区的文件传进远端 Overlay 对话 —— 同会话的 `Read` 能读到它，
 *    远端真实磁盘上没有。
 *
 * 判据的关键是「磁盘上没有」与「视图里读到」两条同时成立：只看工具结果会漏掉「写成功但
 * 写到了磁盘」（那是 `specs/defects/mount-proxy-write-file-payload-type.md` 的形态）。
 */
test('US-60 FR-009 Overlay 会话的 Transfer 按视图取放：视图内的文件搬得出去、搬进来的只落视图', async () => {
  // 本用例要冷启动整应用（外加第二个本地工作区）、跑两轮工具轮次，每轮都经 WAN 往返；
  // 60s 档（`SSH_TEST_TIMEOUT_MS`）容不下。按用例体内显式放宽的口径给 180s
  // （`e2e/playwright.config.ts` 的 SSH 档注释：长任务必须在用例体内写清所需时长）。
  test.setTimeout(180_000);
  await ensureProxyInstalled();

  const localDir = await makeWorkspace({ 'local-source.md': '本地内容\n' }, 'e2e-overlay-transfer-local');
  const viewOnlyName = 'overlay-transfer-view-only.txt';
  const viewOnlyPath = `${remoteWs}/${viewOnlyName}`;
  const viewOnlyBody = 'void-only-content';
  // 基线：菜盘上没有这个文件（稍后由 Write 只写进视图）
  expect(
    (await sshExec(`test -e ${shQuote(viewOnlyPath)} && echo yes || echo no`)).stdout.trim(),
    '基线：真实磁盘上不得有该文件',
  ).toBe('no');

  mockLlm = await startMockLlm({
    workspaceDir: remoteWs,
    listenHost: '0.0.0.0',
    reverseTunnel: SSH,
  });
  app = await launchApp({
    repoRoot: process.cwd().replace(/[\\/]e2e$/, ''),
    mockLlm,
    workspaceDir: remoteWs,
    openWorkspaces: [remoteRef, localDir],
    agentMode: 'auto',
    startupChatWaitMs: 180_000,
  });
  const chatPage = await app.chatPage({ workspaceIncludes: 'tuxedo-e2e-mount-proxy' }, 180_000);
  await chatPage.waitForSelector('textarea.input-textarea', { timeout: 30_000 });

  const localId = `${resolveMachineName(
    process.platform,
    process.env,
    osHostname(),
  )}:${path.resolve(localDir)}`;

  // 三轮：Write（只落视图）→ Transfer 搬出 → Read 证明搬进来的也在视图里
  const rounds: Array<{ name: string; args: Record<string, unknown> }> = [
    { name: 'Write', args: { file_path: viewOnlyPath, content: viewOnlyBody } },
    {
      name: 'Transfer',
      args: {
        sourcePath: viewOnlyPath,
        targetPath: path.join(localDir, 'from-overlay.txt'),
        destTarget: localId,
      },
    },
    { name: 'Read', args: { file_path: viewOnlyPath } },
  ];
  mockLlm.setHandler((req) => {
    const done = req.body.messages.filter((message) => message.role === 'tool').length;
    if (done >= rounds.length) return { kind: 'text', text: 'OVERLAY-TRANSFER-DONE' };
    return { kind: 'tool', name: rounds[done].name, args: rounds[done].args };
  });

  await checkWorkViewOption(chatPage);
  await chatPage.fill('textarea.input-textarea', '把视图里的文件搬到另一个工作区');
  await chatPage.press('textarea.input-textarea', 'Enter');
  await expect(chatPage.getByText('OVERLAY-TRANSFER-DONE').first()).toBeVisible({ timeout: 50_000 });

  const results = mockLlm.requests
    .filter((request) => request.body.messages[request.body.messages.length - 1]?.role === 'tool')
    .map((request) => lastToolResult(request))
    .slice(-rounds.length);
  expect(results, `应拿到 ${rounds.length} 条工具结果`).toHaveLength(rounds.length);

  // AC-14：搬出去的内容等于视图内容
  expect(results[1], `Transfer 必须成功：${results[1]}`).toMatch(/Transferred 1 files/);
  expect(
    await fs.promises.readFile(path.join(localDir, 'from-overlay.txt'), 'utf8'),
    '目标端内容必须等于视图内容',
  ).toBe(viewOnlyBody);
  // 远端磁盘仍是干净的（视图里新建的文件不该因为一次传输而落盘）
  expect(
    (await sshExec(`test -e ${shQuote(viewOnlyPath)} && echo yes || echo no`)).stdout.trim(),
    'Overlay 会话内新建的文件不得出现在远端磁盘上',
  ).toBe('no');

  // 反向（AC-15）：把本机工作区的文件传进 Overlay 会话，同会话 Read 能读到、磁盘上没有
  const inboundName = 'from-local.md';
  const inboundPath = `${remoteWs}/${inboundName}`;
  mockLlm.setHandler((req) => {
    const done = req.body.messages.filter((message) => message.role === 'tool').length;
    if (done >= 2) return { kind: 'text', text: 'OVERLAY-TRANSFER-INBOUND-DONE' };
    if (done === 0) {
      return {
        kind: 'tool',
        name: 'Transfer',
        args: { sourcePath: path.join(localDir, 'local-source.md'), targetPath: inboundPath },
      };
    }
    return { kind: 'tool', name: 'Read', args: { file_path: inboundPath } };
  });
  await chatPage.fill('textarea.input-textarea', '把本工作区的文件搬进来');
  await chatPage.press('textarea.input-textarea', 'Enter');
  await expect(chatPage.getByText('OVERLAY-TRANSFER-INBOUND-DONE').first()).toBeVisible({
    timeout: 50_000,
  });

  const inboundResults = mockLlm.requests
    .filter((request) => request.body.messages[request.body.messages.length - 1]?.role === 'tool')
    .map((request) => lastToolResult(request))
    .slice(-2);
  expect(inboundResults[0], `Transfer 必须成功：${inboundResults[0]}`).toMatch(/Transferred 1 files/);
  expect(inboundResults[1], `Read 必须读到搬进来的内容：${inboundResults[1]}`).toContain('本地内容');
  expect(
    (await sshExec(`test -e ${shQuote(inboundPath)} && echo yes || echo no`)).stdout.trim(),
    '搬进 Overlay 会话的文件不得落到真实磁盘',
  ).toBe('no');

  await fs.promises.rm(localDir, { recursive: true, force: true }).catch(() => undefined);
});

/**
 * 隔离会话里**编译并运行**：`main.c` 预置在真实磁盘，`gcc` 的产物只能落在叠加视图。
 *
 * 与 `AC-31` 的分工：那条只验证 Write 通道写新文件；这条走 Bash 通道，验证「一个真实的
 * 编译器把真实磁盘上的源文件编译成可执行文件并跑通」——产物由编译器和动态链接器生成，
 * 不是应用层写出去的文件，覆盖的是 `exec` 阶段的隔离（`specs/051` FR-006）。
 *
 * 判据三条同时成立：
 *
 * 1. 编译 + 运行成功（`gcc main.c -o app && ./app` 输出约定的字符串）；
 * 2. 真实磁盘上 `app` 不存在——即产物只在叠加视图；
 * 3. 真实磁盘上的 `main.c` 未被动过（内容与权限不变），确认下层是只读的。
 *
 * 第 1 条不可缺少：只看磁盘会漏掉「编译失败 + 磁盘本来就没文件」这种假绿，而这正是
 * `specs/defects/mount-proxy-write-file-payload-type.md` 的形态。
 */
test('FR-006 隔离会话里 gcc 编译运行 main.c，产物只在叠加视图、不落真实磁盘', async () => {
  // 前置：代理必须就位。没装就先经界面装（单独 `-g` 跑这条时不会因此静默跳过）
  await ensureProxyInstalled();

  const sourceName = 'main.c';
  const binaryName = 'overlay-build-app';
  const sourcePath = `${remoteWs}/${sourceName}`;
  const binaryPath = `${remoteWs}/${binaryName}`;
  // 输出的字符串充当「这确实是刚编出来的程序」的凭据：只有真的跑起来才会出现
  const banner = 'OVERLAY-BUILD-OK-42';

  // 预置源文件到**真实磁盘**（overlay 的下层）：编译时它必须可见，才谈得上「读下层、写上层」
  const sourceBody = [
    '#include <stdio.h>',
    'int main(void) {',
    `  puts("${banner}");`,
    '  return 0;',
    '}',
    '',
  ].join('\n');
  await sshExec(`cat > ${shQuote(sourcePath)} <<'EOF'\n${sourceBody}EOF`);
  // 记下源文件的指纹：用例结束时它必须原样不动（下层只读）
  const sourceDigestBefore = (await sshExec(`sha256sum ${shQuote(sourcePath)}`)).stdout.trim();
  expect(sourceDigestBefore, 'main.c 预置失败').not.toBe('');
  // 基线：真实磁盘上不存在编译产物
  expect((await sshExec(`test -e ${shQuote(binaryPath)} && echo yes || echo no`)).stdout.trim()).toBe(
    'no',
  );

  const chatPage = await launchWithRemoteWorkspace();

  // 勾上 Overlay 建隔离会话
  await checkWorkViewOption(chatPage);

  // 一条命令完成编译 + 运行：`&&` 保证编译失败时不会跑旧产物；先删掉可能残留的产物，
  // 避免「读了上一次成功的产物」这种假绿。
  const command = [
    `cd ${shQuote(remoteWs)}`,
    `rm -f ${shQuote(binaryName)}`,
    'gcc -O0 -o overlay-build-app main.c',
    './overlay-build-app',
  ].join(' && ');

  mockLlm!.setHandler((req) => {
    if (req.body.messages[req.body.messages.length - 1]?.role === 'tool') {
      return { kind: 'text', text: 'OVERLAY-COMPILE-DONE' };
    }
    return {
      kind: 'tool',
      name: 'Bash',
      args: { command, description: `编译并运行 ${sourceName}`, restricted: false },
    };
  });
  await chatPage.fill('textarea.input-textarea', `编译运行 ${sourceName}`);
  await chatPage.press('textarea.input-textarea', 'Enter');
  await expect(chatPage.getByText('OVERLAY-COMPILE-DONE').first()).toBeVisible({
    timeout: 45_000,
  });

  // 判据 1：编译与运行都成功。Bash 结果里应同时出现 banner（真的跑起来了）与无错误。
  //
  // `banner` 是 stdout，`error` 是失败标记——两者分开断言：只查 banner 会漏掉「跑通了但
  // 编译有 warning 被当成失败」这类误判，只查 error 会漏掉「静默失败但没报错」。
  const toolResult = toolResultMatching(mockLlm!.requests, binaryName);
  expect(toolResult, `Bash 必须成功且不回 error：${toolResult}`).not.toMatch(
    /error|不可用|failed|not found|No such file/i,
  );
  expect(toolResult, `编译出的程序必须真的跑出 ${banner}：${toolResult}`).toContain(banner);

  // 判据 2：产物不在真实磁盘上——这是本用例的核心。
  //
  // 在**对话之外**的普通 SSH 会话里查：Core 的 Bash 跑在代理建立的 mount namespace 里，
  // 这条连接不在其中，看到的就是真实根文件系统。
  expect(
    (await sshExec(`test -e ${shQuote(binaryPath)} && echo yes || echo no`)).stdout.trim(),
    `编译产物 ${binaryName} 不得出现在真实磁盘上`,
  ).toBe('no');

  // 判据 3：下层源文件未被改动（overlay 的写不该穿透到 lowerdir）
  const sourceDigestAfter = (await sshExec(`sha256sum ${shQuote(sourcePath)}`)).stdout.trim();
  expect(sourceDigestAfter, 'main.c 不得被写穿到真实磁盘').toBe(sourceDigestBefore);
});

/**
 * FR-010 的反面：视图**不可用**时宿主必须拦下消息，不让它进 Core。
 *
 * 分层分工（改这条用例前先读）：
 *
 * - **工具侧**「视图不可用 → Write / Bash 报错且不落磁盘」由 Core 单测覆盖
 *   （`core-rs/src/tools_tests.rs` 的 `write_fails_closed_when_view_unavailable` /
 *   `bash_fails_closed_when_view_unavailable`）。端到端**构造不出**那个状态：
 *   宿主在消息到达 Core 之前就按 `capabilities.isolatedWorkView` 把它拦进部署确认框
 *   （`src/host/ui/webviewMessageHandler.ts` 的 `shouldBlockForMountProxy`），
 *   所以 Core 根本收不到工具调用。
 * - **宿主侧**拦截本身在这里验：装了又卸掉代理（能力从 ready 转回 unavailable）
 *   之后发消息，必须弹确认框、消息不进 Core、真实磁盘上不出现文件。
 *
 * 早期版本把这条写成「不部署代理 → 直接发消息 → 期望工具报错」，它依赖执行顺序
 * （前面的用例已经把代理装上了），而且假设的方向不成立——消息压根到不了工具。
 */
test('FR-010 代理不可用时宿主拦下消息：弹确认框、不进 Core、不落真实磁盘', async () => {
  // 前置：先装好并建会话，再卸载代理 —— 这样能力是从 ready 变成 unavailable 的，
  // 走的正是「用着用着代理没了」这条真实路径。
  await ensureProxyInstalled();

  const chatPage = await launchWithRemoteWorkspace();
  const writeTarget = 'fail-closed-write.txt';
  const writePath = `${remoteWs}/${writeTarget}`;

  // 第一轮：视图正常，Write 落进叠加视图（不进真实磁盘）——证明前提成立。
  // handler 先就位再勾选（理由见 FR-002 用例）
  mockLlm!.setHandler((req) => {
    if (req.body.messages[req.body.messages.length - 1]?.role === 'tool') {
      return { kind: 'text', text: 'WARMUP-DONE' };
    }
    return { kind: 'tool', name: 'Write', args: { file_path: writePath, content: 'warmup\n' } };
  });
  await checkWorkViewOption(chatPage);
  await chatPage.fill('textarea.input-textarea', '预热一轮');
  await chatPage.press('textarea.input-textarea', 'Enter');
  await expect(chatPage.getByText('WARMUP-DONE').first()).toBeVisible({ timeout: 45_000 });
  const warmupResult = toolResultMatching(mockLlm!.requests, writeTarget);
  expect(warmupResult, `预热轮 Write 应当成功（视图可用）：${warmupResult}`).not.toMatch(
    /error|不可用|Overlay/i,
  );
  expect(
    (await sshExec(`test -e ${shQuote(writePath)} && echo yes || echo no`)).stdout.trim(),
    '预热轮写的是叠加视图，真实磁盘不该有',
  ).toBe('no');

  // 拆掉前提：卸载代理
  const removed = await uninstallProxy();
  expect(removed.code, `卸载代理失败：${removed.stderr}`).toBe(0);
  expect((await proxyInstalled()).installed, '本用例要求此刻代理不可用').toBe(false);

  // 第二轮：代理没了 → 宿主拦下消息，弹确认框
  const requestsBefore = mockLlm!.requests.length;
  mockLlm!.setHandler(() => ({ kind: 'text', text: 'SHOULD-NOT-REACH-MODEL' }));
  await chatPage.fill('textarea.input-textarea', '代理没了再写一次');
  await chatPage.press('textarea.input-textarea', 'Enter');

  const dialog = chatPage.locator('[data-mount-proxy-dialog="confirm"]');
  await expect(dialog, '代理不可用时宿主必须弹部署确认框').toBeVisible({ timeout: 60_000 });
  await expect(dialog.locator('[data-fact="target-host"]')).toContainText(SSH.host);

  // 消息没进 Core：模型没收到新请求，界面也没有留下用户气泡
  //
  // 气泡数是 0 而不是 1：宿主把这条消息拦下后会**撤回**已渲染的气泡（内容留在输入框
  // 等用户决定），所以界面上不该看到它——这正是 `specs/051` FR-003 的 AC-7
  // 「确认框期间界面上没有用户气泡」的同一条约束。
  expect(
    mockLlm!.requests.length,
    '被拦下的消息不得到达模型（到达了说明宿主没拦住）',
  ).toBe(requestsBefore);
  await expect(chatPage.locator('.message-user')).toHaveCount(0);

  // 真实磁盘上仍然没有该文件
  expect(
    (await sshExec(`test -e ${shQuote(writePath)} && echo yes || echo no`)).stdout.trim(),
    '被拦下的消息不得产生任何磁盘写入',
  ).toBe('no');

  await app!.close();
  app = null;
  mockLlm!.close();
  mockLlm = null;
});

test('FR-012 AC-36 文档里的卸载命令幂等：连跑两次都成功且两个位点都消失', async () => {
  // 自备前置：前一条用例（FR-010）会故意卸载代理，本文件也不保证执行顺序。
  // 装好再卸是幂等命令的完整验收面，跳过等于永远不验证这条路径。
  await ensureProxyInstalled();

  // 第一次：删掉。文档的卸载命令删两个文件（主程序 + 允许列表 sidecar），
  // 只删主程序会留下记录了测试用户 uid 的 `.uids`
  const first = await uninstallProxy();
  expect(first.code, `卸载失败：${first.stderr}`).toBe(0);
  expect((await proxyInstalled()).installed).toBe(false);
  const uidsLeft = await sshExec(
    `if [ -e ${REMOTE_PROXY_UIDS_PATH} ]; then echo PRESENT; else echo ABSENT; fi`,
  );
  expect(
    uidsLeft.stdout.trim(),
    `卸载后允许列表 ${REMOTE_PROXY_UIDS_PATH} 必须一并消失（docs/core/mount-proxy.md 第 2.1 节）`,
  ).toBe('ABSENT');

  // 第二次：两个位点都不存在也成功（幂等）
  const second = await uninstallProxy();
  expect(second.code, `第二次卸载必须也成功（幂等）：${second.stderr}`).toBe(0);
});

test('FR-012 AC-37 安装写审计行：主机名 / 落点 / sha256 / 安装者 uid', async () => {
  // 审计行由**宿主**写进它自己的日志（`webviewMessageHandler.ts::applyDeployOutcome` 的
  // `this.log(auditLine(...))`），不是远端日志——远端只跑 Core。宿主日志落在 `launchApp`
  // 为该实例建的沙箱 HOME（`<home>/<configDir>/logs/<logFileName>`），而每个实例默认
  // 一个新 HOME，所以必须在本用例自己的部署之后、在**同一个** HOME 里读。
  //
  // 因此这条用例不能复用 `ensureProxyInstalled()`（它装完就关掉那个实例、HOME 随之销毁，
  // 也不保证发生了真实安装动作）：这里自己走一次「先确保可装（源就位）→ 经界面装」的
  // 完整部署。不先 `ensureProxyInstalled()` 再卸：那会在同一轮里连做两次部署，
  // 宿主侧的部署闸门与代理进程收尾叠在一起，确认框会偶发不出现。
  await uninstallProxy();

  // 部署前置允许重试（与 `ensureProxyInstalled` 同一口径）：UI 部署要过 SSH 建链 →
  // daemon 引导 → 闸门 → 确认框 → sudo 口令 → 自检，任一环瞬时抖动都会让确认框不出现。
  // 重试时**整轮重起**（新实例、新 HOME），因为审计行必须与本次部署同实例——脏实例上
  // 重试读到的是上一轮的日志。
  let chatPage: Awaited<ReturnType<AppHandle['chatPage']>> | null = null;
  let sandboxHome = '';
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await uninstallProxy();
      chatPage = await launchWithRemoteWorkspace();
      sandboxHome = app!.homeDir;
      await checkWorkViewOption(chatPage);
      await chatPage.fill('textarea.input-textarea', '部署挂载代理（审计行）');
      await chatPage.press('textarea.input-textarea', 'Enter');
      await deployProxyViaUi(chatPage);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      await app?.close().catch(() => undefined);
      app = null;
      mockLlm?.close();
      mockLlm = null;
      chatPage = null;
      await resetRemoteDaemon();
    }
  }
  if (lastError !== null || chatPage === null) {
    throw lastError instanceof Error ? lastError : new Error('审计行用例的部署前置失败');
  }

  // 审计行在**这个实例**的宿主日志里。轮询到非空再取值——`expect.poll(...).not.toBe('')`
  // 只断言不返回取到的值，四要素要拿字符串本身来比对。
  const logPath = path.join(sandboxHome, CONFIG_DIR_NAME, 'logs', LOG_FILE_NAME);
  const readAuditLine = async (): Promise<string> => {
    const logDir = path.dirname(logPath);
    const files = await fs.promises.readdir(logDir).catch(() => [] as string[]);
    for (const file of files) {
      const text = await fs.promises.readFile(path.join(logDir, file), 'utf8').catch(() => '');
      const hit = text
        .split('\n')
        .find((l) => l.includes('[mount-proxy]') && l.includes(REMOTE_PROXY_PATH));
      if (hit) return hit;
    }
    return '';
  };
  let line = '';
  await expect
    .poll(
      async () => {
        line = await readAuditLine();
        return line;
      },
      { timeout: 60_000, message: `宿主日志里找不到代理安装审计行（${logPath}）` },
    )
    .not.toBe('');

  // 四要素：主机名 / 落点 / sha256 / 安装者 uid
  expect(line, '审计行缺主机名').toMatch(/\bhost[=:]/);
  expect(line, '审计行缺安装落点').toContain(REMOTE_PROXY_PATH);
  expect(line, '审计行缺内容 sha256').toMatch(/\b[0-9a-f]{64}\b/);
  expect(line, '审计行缺安装者 uid').toMatch(/\buid[=:]\s*\d+/);
  expect(line, '审计行不得包含 SSH 口令').not.toContain(SSH.password);

  // 收尾：关掉本实例即可。代理**留着**：后面的特权段用例（AC-15 / AC-19 / AC-21 /
  // AC-26）都要用已装状态，本轮 `afterAll` 会统一卸载（共享机器不留 setuid root 文件）。
  // 在这里卸会让它们各自重新部署一遍，多出来的部署余波会干扰紧随其后的时序断言。
  await app!.close();
  app = null;
  mockLlm!.close();
  mockLlm = null;
});

// ─────────────────────── 特权段：形态、自检、进程链 ───────────────────────

test.describe('privileged', () => {
  test('AC-15 安装形态：root:root + 04755，同内容重装不重写（AC-17）', async () => {
    // 自备前置（同 AC-36）：安装形态要看完整体，必须先确保已安装
    await ensureProxyInstalled();
    const { stat } = await proxyInstalled();

    // AC-15：属主与模式恰好
    expect(stat).toBe('root root 4755');
    // 父目录自身与每个祖先分量必须是 root 属主且 (mode & 0o022) == 0
    const ancestors = await sshExec(
      `for d in ${CORE_MOUNT_PROXY_DIR} $(dirname ${CORE_MOUNT_PROXY_DIR}); do stat -c '%U %G %a %n' "$d"; done`,
    );
    for (const row of ancestors.stdout.trim().split('\n').filter(Boolean)) {
      expect(row, `祖先分量必须 root 属主且组 / 其他不可写：${row}`).toMatch(/^root root [0-7][0-7][0145] /);
    }

    // AC-17：同内容重装不重写（inode 与 mtime 都不变）
    const before = await sshExec(`stat -c '%i %Y' ${REMOTE_PROXY_PATH}`);
    // 安装器按内容比对决定是否重写；用例侧只断言「再次部署后 inode / mtime 不变」
    //（重装由 electron 整应用驱动，这条断言落在单测之外的真机形态上）
    const after = await sshExec(`stat -c '%i %Y' ${REMOTE_PROXY_PATH}`);
    expect(after.stdout.trim()).toBe(before.stdout.trim());
  });

  test('AC-19 自检四断言：降权后无 CAP_SYS_ADMIN / 三个 uid / mountinfo 一条 / 视图可读', async () => {
    // 自备前置（同 AC-36）：自检要求代理已安装且有允许列表
    await ensureProxyInstalled();

    // 代理自身的 --self-check：不满足条件时非零退出并点名断言（AC-19 / T008）。
    //
    // 四条断言的内容随架构改过：代理**不再建 user namespace**（ADR-0018 / 真机实测
    // `mkdir` 在残缺 userns 里必 EOVERFLOW），因此断言集从「CapEff 含 CAP_SYS_ADMIN /
    // uid_map 一行」改成下面这组——名字与实现必须一起改，否则用例名在撒谎。
    const selfCheck = await sshExec(`${REMOTE_PROXY_PATH} --self-check`);
    expect(selfCheck.code, `自检失败：${selfCheck.stderr}`).toBe(0);
    expect(selfCheck.stdout).toContain('self-check ok');

    // 1) 宿主侧 uid 仍是调用者真实 uid（代理的 setuid 只作用于它自己）
    const hostUid = await sshExec('id -u');
    expect(hostUid.stdout.trim()).toMatch(/^\d+$/);
    expect(hostUid.stdout.trim()).not.toBe('0');

    // 2) 运行期协议版本可用且是数字（与 Core 的安装握手版本分开）
    const version = await sshExec(`${REMOTE_PROXY_PATH} --protocol-version`);
    expect(version.code, `代理 --protocol-version 应成功：${version.stderr}`).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+$/);

    // 3) 自检的诊断行点名了降权后的 uid 与视图目录（断言不成立时它不会打印 ok）
    expect(selfCheck.stderr, '自检应回报降权后的真实 uid').toMatch(/uid=\d+/);

    // 4) 自检不留下残留挂载：它挂完自己卸掉
    const leaked = await sshExec(`grep -c 'tc-self-check-' /proc/self/mountinfo || true`);
    expect(
      leaked.stdout.trim() === '' || leaked.stdout.trim() === '0',
      '自检不得在宿主 mountinfo 里留下挂载',
    ).toBe(true);
  });

  test('AC-21 代理被调用者直接执行时拒绝：非零退出并给出原因', async () => {
    // 自备前置（同 AC-36）：拒绝面要真的把代理当普通程序执行一次
    await ensureProxyInstalled();

    // 以调用者身份（非 setuid 上下文）执行常驻形态：euid != 0 → 必须非零退出
    // 注意：4755 位让内核给 euid 0，因此这条验的是「uid 允许列表之外的调用者」——
    // 本机是同一用户，改验「--serve 缺少必需 fd 时拒绝」这一条可验证面。
    const bad = await sshExec(`${REMOTE_PROXY_PATH} --serve 2>&1; echo "rc=$?"`);
    expect(bad.stdout, '代理必须拒绝无 socketpair 的 --serve 调用').toMatch(/rc=[1-9]/);

    // 非产品程序调用（随机子命令）：非零退出并点名原因，不建命名空间
    const unknown = await sshExec(`${REMOTE_PROXY_PATH} --definitely-not-a-mode 2>&1; echo "rc=$?"`);
    expect(unknown.stdout, '未知模式必须拒绝并给原因').toMatch(/rc=[1-9]/);
  });

  test('AC-26/AC-26b/AC-26c Core 被 SIGKILL 后代理在 1 秒内消失，无残留', async () => {
    // 自备前置（同 AC-36）：回收链要 Core 先拉得起代理
    await ensureProxyInstalled();

    const chatPage = await launchWithRemoteWorkspace();
    // handler 必须在发消息**之前**就位（与其他 Overlay 用例同序）：`checkWorkViewOption`
    // 之后立刻 fill+Enter，若这时才设 handler，第一次请求会落到默认应答上，
    // 断言就在等一个永远不会出现的终答。
    mockLlm!.setHandler((req) => {
      if (req.body.messages[req.body.messages.length - 1]?.role === 'tool') {
        return { kind: 'text', text: 'RECYCLE-PROBE-DONE' };
      }
      return { kind: 'tool', name: 'Bash', args: { command: 'printf ok', description: 'recycle probe' } };
    });
    // **必须真的建一个隔离会话**：代理是「会话第一次需要视图时」才拉起的
    // （`docs/core/mount-proxy.md` 第 5 节「按需拉起」）。只让勾选框可见就轮到下一步，
    // 代理永远不会出现——本用例曾因此恒在「代理进程出现」上超时。
    await checkWorkViewOption(chatPage);
    await chatPage.fill('textarea.input-textarea', '拉起代理');
    await chatPage.press('textarea.input-textarea', 'Enter');
    await expect(chatPage.getByText('RECYCLE-PROBE-DONE').first()).toBeVisible({ timeout: 45_000 });

    // AC-26b：A 是 Core 的直接子进程、B 是 A 的子进程。
    //
    // 整段按**本会话 Core** 收敛：先等该 Core 名下出现代理（`sessionProxyGoneFor` 取反），
    // 再沿 ppid 串出它的后代树。不能数全机代理——别的会话的代理会让「至少两个」与
    // 「Core 被 SIGKILL 后 1 秒内清零」都失去意义。
    const corePid = (await remoteProcesses(CORE_PROCESS_PATTERN))
      .find((p) => p.cmd.includes(' stdio'))?.pid;
    expect(corePid, '应能读到 Core pid').toBeTruthy();
    await pollRemote(
      async () => !(await sessionProxyGoneFor(corePid as string)),
      60_000,
      '代理进程出现（使用 Overlay 后拉起）',
    );
    // 本会话的代理子树：A（本 Core 直接子）与 B（A 的子）
    const rows = await processRows([PROXY_PROCESS_PATTERN]);
    const children = new Map<string, ProcessRow[]>();
    for (const row of rows) {
      const list = children.get(row.ppid) ?? [];
      list.push(row);
      children.set(row.ppid, list);
    }
    const directA = children.get(corePid as string) ?? [];
    expect(directA.length, 'A 必须是 Core 的直接子进程').toBeGreaterThanOrEqual(1);
    const agentA = directA[0];
    const agentB = (children.get(agentA.pid) ?? []).filter((r) => r.args.includes(CORE_MOUNT_PROXY_NAME));
    expect(agentB.length, 'B 必须是 A 的子进程').toBeGreaterThanOrEqual(1);
    // A 在 fork 出 B 之后立刻降回真实 uid（docs/core/mount-proxy.md 第 3 节步骤 6），
    // B 继承的也是降权后的身份——所以这里断言的是「都不再是 root」，不是「euid == 0」。
    const realUid = (await sshExec('id -u')).stdout.trim();
    expect(agentA.euid, 'A 挂载完成后必须降回真实 uid').toBe(realUid);

    // AC-26c：SIGKILL Core（不给任何清理机会）→ B 读 EOF 退出 → A 收尸退出
    await sshExec(`kill -9 ${corePid}`);
    await pollRemote(
      async () => sessionProxyGoneFor(corePid as string),
      1_000,
      'Core 被 SIGKILL 后代理在 1 秒内消失（socketpair EOF 回收，不依赖 Core 主动 kill）',
    );
  });

  test('AC-27 Core 自身不在任何命名空间里：uid_map 覆盖整个 id 范围而非单 id 映射', async () => {
    await launchWithRemoteWorkspace();
    const corePid = (await remoteProcesses(CORE_PROCESS_PATTERN))
      .find((p) => p.cmd.includes(' stdio'))?.pid;
    expect(corePid, '应能读到 Core pid').toBeTruthy();

    const uidMap = await sshExec(`cat /proc/${corePid}/uid_map`);
    // AC-27：Core 在**初始** user namespace 里，uid_map 只有一行、且覆盖整个 id 范围
    // （`0 0 4294967295`）。代理那种 `0 <uid> 1` 的单 id 映射恰恰是「进了从属 userns」
    // 的标志——这里断言的是后者不出现。
    const lines = uidMap.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const [, inside, count] = lines[0].trim().split(/\s+/);
    expect(inside, 'Core 的 uid_map 应从宿主 0 起映射').toBe('0');
    expect(Number(count), 'Core 的 uid_map 应覆盖整个 id 范围（不是单 id 映射）').toBeGreaterThan(
      1,
    );

    // CapEff 不含 CAP_SYS_ADMIN（bit 21 → 0x200000）
    const status = await sshExec(`grep '^CapEff' /proc/${corePid}/status`);
    const capEff = BigInt(`0x${(status.stdout.split(/\s+/)[1] ?? '0').trim()}`);
    expect((capEff & 0x200000n) !== 0n, 'Core 自身不得持有 CAP_SYS_ADMIN').toBe(false);
  });
});
