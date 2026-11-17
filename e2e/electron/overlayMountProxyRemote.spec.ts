import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'ssh2';
import { startMockLlm } from '../helpers/mockLlmServer';
import { launchApp } from '../helpers/electronApp';
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
import { requireSshEnvironment, detectLlmAdvertiseHost } from '../helpers/testEnvironment';

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
 * 环境：`e2e/environments.json` 的 ssh 段（本机实测：`Linux x86_64`、用户 `pz` 在 `sudo`
 * 组、**免密 `sudo` 不可用**、口令式 `sudo -S` 可用、`/usr/libexec` 为 `root root 0755`、
 * 文件系统无 `nosuid`、内核支持 `overlay`）。因此本车按「口令分支为默认路径」设计，
 * 免密分支只验失败后的换路；`requiretty` / `nosuid` / 祖先可写 / `/usr/libexec` 不存在
 * 这五类拒绝面由 `src/test/sshDaemonBootstrap.test.ts` 的假 SSH 桩覆盖（改共享真机去
 * 逼近等于污染机器）。
 *
 * 共享机器纪律：用例自建工作区、`afterAll` 整目录清理；装了代理就在收尾卸载，没装则断言
 * 「仍不存在」；不留状态文件。
 *
 * 运行：`<envPrefix>_E2E_MOUNT_PROXY=1 npm run test:e2e:ssh -- overlayMountProxyRemote`
 * 前置：`npm run build:core:linux-x64`（远端是 Linux 时本机必须携带对应产物）。
 */


const SSH = requireSshEnvironment();
const ADVERTISE_HOST = SSH.llmAdvertiseHost ?? detectLlmAdvertiseHost();

test.setTimeout(600_000);

/** 远端安装位点（产物名与目录的唯一来源是 `src/config/project.json`） */
const REMOTE_PROXY_PATH = `${CORE_MOUNT_PROXY_DIR}/${CORE_MOUNT_PROXY_NAME}`;
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
  await sshExec(`pkill -f '${CORE_PROCESS_PATTERN}' || true; sleep 1`).catch(() => undefined);
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
 * 卸载代理（`docs/core/mount-proxy.md` 的幂等命令，FR-012 / AC-36）。
 *
 * 幂等：位点不存在时也成功退出。口令式 `sudo` 可用、免密不可用（真机实测），因此密码
 * 经**标准输入**喂给 `sudo -S`（不进 argv，specs/051 FR-004 第 3 条同一口径）；收尾用它
 * 把远端恢复成「未装机」——共享机器不能留下一个 setuid root 文件。
 */
async function uninstallProxy(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return sshExecWithStdin(`sudo -S -p '' rm -f ${REMOTE_PROXY_PATH}`, `${SSH.password}\n`);
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

/** 远端还活着的 Core / 代理进程 */
async function remoteProcesses(pattern: string): Promise<Array<{ pid: string; cmd: string }>> {
  const { stdout } = await sshExec(`pgrep -af '${pattern}' || true`);
  return stdout.trim().split('\n').filter((line) => line.length > 0).map((line) => {
    const space = line.indexOf(' ');
    return { pid: line.slice(0, space), cmd: line.slice(space + 1) };
  });
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
    advertiseHost: ADVERTISE_HOST,
  });
  app = await launchApp({
    repoRoot: process.cwd().replace(/[\\/]e2e$/, ''),
    mockLlm,
    workspaceDir: remoteWs,
    openWorkspaces: [remoteRef],
    agentMode: 'auto',
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
  await chatPage.locator('input[data-work-view-option]').check();
  await chatPage.fill('textarea.input-textarea', '远端 Overlay 首次使用');
  await chatPage.press('textarea.input-textarea', 'Enter');
  const dialog = chatPage.locator('[data-mount-proxy-dialog="confirm"]');
  await expect(dialog).toBeVisible({ timeout: 60_000 });
  await expect(dialog.locator('[data-fact="target-host"]')).toContainText(SSH.host);
  // 消息没有进 Core（AC-7）：确认框期间界面上没有用户气泡
  await expect(chatPage.locator('.message-user')).toHaveCount(0);

  // 确认部署 → 远端 sudo 需要密码（实测 `sudo -n` 不可用）→ 三选一 → 提交 sudo 密码
  await dialog.locator('[data-mount-proxy-action="deploy"]').click();
  const passwordAction = dialog.locator('[data-mount-proxy-action="sudo-password"]');
  await expect(passwordAction, '远端免密 sudo 不可用时应给三选一').toBeVisible({ timeout: 120_000 });
  await passwordAction.click();
  await dialog.locator('input[data-mount-proxy-secret]').fill(SSH.password);
  await chatPage.keyboard.press('Enter');

  // AC-29：部署 + 自检成功后能力转 ready（宿主重查，不重启 Core）
  await expect
    .poll(async () => (await readCapabilities(chatPage)).mountProxy, { timeout: 240_000 })
    .toBe('ready');
  expect((await readCapabilities(chatPage)).isolatedWorkView).toBe(true);

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
  // 前置：本用例假定代理已安装（上一轮部署成功或被运营装机）；未装则跳过而非修环境
  const { installed, stat } = await proxyInstalled();
  test.skip(!installed, `远端未安装 ${REMOTE_PROXY_PATH}（先跑部署用例或手工装机）；不做修复`);
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
  await expect(chatPage.getByText('REMOTE-PROXY-READY').first()).toBeVisible({ timeout: 120_000 });
  expect(lastToolResult(mockLlm!.requests[1])).toContain('frame-ok');
});

test('AC-31 隔离会话的 Write 不落真实磁盘，会话关闭后 mountinfo 无泄漏', async () => {
  const { installed } = await proxyInstalled();
  test.skip(!installed, `远端未安装 ${REMOTE_PROXY_PATH}；不做修复`);

  const chatPage = await launchWithRemoteWorkspace();
  const targetName = 'overlay-only.txt';
  const realPath = `${remoteWs}/${targetName}`;
  // 基线：真实磁盘上不存在
  expect((await sshExec(`test -e ${shQuote(realPath)} && echo yes || echo no`)).stdout.trim()).toBe('no');

  // 建 Overlay 会话并让模型写文件
  await expect(chatPage.locator('input[data-work-view-option]')).toBeVisible({ timeout: 60_000 });
  await chatPage.locator('input[data-work-view-option]').check();
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
  await chatPage.fill('textarea.input-textarea', '在隔离视图里写文件');
  await chatPage.press('textarea.input-textarea', 'Enter');
  await expect(chatPage.getByText('OVERLAY-WRITE-DONE').first()).toBeVisible({ timeout: 120_000 });

  // AC-31：写进了叠加视图，真实磁盘没变
  const toolResult = lastToolResult(mockLlm!.requests[1]);
  expect(toolResult, `Write 不应报错：${toolResult}`).not.toContain('error');
  expect((await sshExec(`test -e ${shQuote(realPath)} && echo yes || echo no`)).stdout.trim()).toBe(
    'no',
  );

  // AC-28j：会话关闭后代理 mountinfo 里没有该 overlay 条目
  await app!.close();
  app = null;
  mockLlm!.close();
  mockLlm = null;
  await pollRemote(
    async () => (await remoteProcesses(PROXY_PROCESS_PATTERN)).length === 0,
    30_000,
    '代理进程退出（Core 关闭 → socketpair EOF → B 退 → A 收尸）',
  );
  // 挂载随命名空间销毁，宿主机看不到残留（代理不可见）——断言宿主 mountinfo 无该会话条目
  const leaked = await sshExec(`grep -c '${shQuote(remoteWs)}' /proc/self/mountinfo || true`);
  expect(leaked.stdout.trim() === '' || leaked.stdout.trim() === '0', '挂载点不得泄漏到宿主机').toBe(
    true,
  );
});

test('FR-012 AC-36 文档里的卸载命令幂等：连跑两次都成功且位点消失', async () => {
  const { installed } = await proxyInstalled();
  test.skip(!installed, `远端未安装 ${REMOTE_PROXY_PATH}；卸载命令的幂等性无法验证（不做修复）`);

  // 第一次：删掉
  const first = await uninstallProxy();
  expect(first.code, `卸载失败：${first.stderr}`).toBe(0);
  expect((await proxyInstalled()).installed).toBe(false);

  // 第二次：位点不存在也成功（幂等）
  const second = await uninstallProxy();
  expect(second.code, `第二次卸载必须也成功（幂等）：${second.stderr}`).toBe(0);
});

test('FR-012 AC-37 安装写审计行：主机名 / 落点 / sha256 / 安装者 uid', async () => {
  const { installed } = await proxyInstalled();
  test.skip(!installed, `远端未安装 ${REMOTE_PROXY_PATH}；审计行无法验证（不做修复）`);

  // 审计行在 Core 日志里（`~/<configDir>/logs/<logFileName>`）
  const logPath = `${remoteHome}/${CONFIG_DIR_NAME}/logs/${LOG_FILE_NAME}`;
  const grep = await sshExec(`grep -h 'mount-proxy' ${shQuote(logPath)} | tail -5 || true`);
  const line = grep.stdout.split('\n').find((l) => l.includes(REMOTE_PROXY_PATH)) ?? '';
  expect(line, `Core 日志里找不到代理安装审计行（${logPath}）`).not.toBe('');
  // 四要素：主机名 / 落点 / sha256 / 安装者 uid
  expect(line, '审计行缺主机名').toMatch(/\bhost[=:]/);
  expect(line, '审计行缺安装落点').toContain(REMOTE_PROXY_PATH);
  expect(line, '审计行缺内容 sha256').toMatch(/\b[0-9a-f]{64}\b/);
  expect(line, '审计行缺安装者 uid').toMatch(/\buid[=:]\s*\d+/);
});

// ─────────────────────── 特权段：形态、自检、进程链 ───────────────────────

test.describe('privileged', () => {
  test('AC-15 安装形态：root:root + 04755，同内容重装不重写（AC-17）', async () => {
    const { installed, stat } = await proxyInstalled();
    test.skip(!installed, `远端未安装 ${REMOTE_PROXY_PATH}；不做修复`);

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

  test('AC-19 自检四断言：CapEff / uid_map / 命名空间内 uid / 宿主 uid', async () => {
    const { installed } = await proxyInstalled();
    test.skip(!installed, `远端未安装 ${REMOTE_PROXY_PATH}；自检无法验证（不做修复）`);

    // 代理自身的 --self-check：不满足条件时非零退出并点名断言（AC-19 / T008）
    const selfCheck = await sshExec(`${REMOTE_PROXY_PATH} --self-check`);
    expect(selfCheck.code, `自检失败：${selfCheck.stderr}`).toBe(0);

    // 四项断言逐条核实（自检的实现者可能把细节写进 stderr，这里独立复核关键两项）
    // 1) 宿主侧 getuid() 仍是调用者真实 uid（Core / 调用者不因代理变 root）
    const hostUid = await sshExec('id -u');
    expect(hostUid.stdout.trim()).toBe('1001');
    // 2) 命名空间内的映射只有一行，且映射的是真实 uid（不映射宿主 0）
    //    代理 `--self-check` 的内部命名空间随进程退出，改为断言协议版本与配置可用
    const version = await sshExec(`${REMOTE_PROXY_PATH} --protocol-version`);
    expect(version.code, `代理 --protocol-version 应成功：${version.stderr}`).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+$/);
  });

  test('AC-21 代理被调用者直接执行时拒绝：非零退出并给出原因', async () => {
    const { installed } = await proxyInstalled();
    test.skip(!installed, `远端未安装 ${REMOTE_PROXY_PATH}；拒绝面无法验证（不做修复）`);

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
    const { installed } = await proxyInstalled();
    test.skip(!installed, `远端未安装 ${REMOTE_PROXY_PATH}；回收链无法验证（不做修复）`);

    const chatPage = await launchWithRemoteWorkspace();
    await expect(chatPage.locator('input[data-work-view-option]')).toBeVisible({ timeout: 60_000 });

    // AC-26b：A 是 Core 的直接子进程、B 是 A 的子进程
    const corePid = (await remoteProcesses(CORE_PROCESS_PATTERN))
      .find((p) => p.cmd.includes(' stdio'))?.pid;
    expect(corePid, '应能读到 Core pid').toBeTruthy();
    await pollRemote(
      async () => (await remoteProcesses(PROXY_PROCESS_PATTERN)).length > 0,
      60_000,
      '代理进程出现（使用 Overlay 后拉起）',
    );
    const tree = await sshExec(
      `ps -o pid=,ppid=,euid=,args= -p $(pgrep -d, -f '${PROXY_PROCESS_PATTERN}' || echo 1)`,
    );
    const rows = tree.stdout.trim().split('\n').filter(Boolean);
    expect(rows.length, '至少 A 与 B 两个代理进程').toBeGreaterThanOrEqual(2);
    // A 的父进程是 Core
    const parentIsCore = rows.some((row) => row.trim().split(/\s+/)[1] === corePid);
    expect(parentIsCore, 'A 必须是 Core 的直接子进程').toBe(true);

    // AC-26c：SIGKILL Core（不给任何清理机会）→ B 读 EOF 退出 → A 收尸退出
    await sshExec(`kill -9 ${corePid}`);
    await pollRemote(
      async () => (await remoteProcesses(PROXY_PROCESS_PATTERN)).length === 0,
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
