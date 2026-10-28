import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'ssh2';
import { startMockLlm } from '../helpers/mockLlmServer';
import { launchApp, waitForMessageBox, clickMessageBoxButton, messageBoxText } from '../helpers/electronApp';
import type { AppHandle } from '../helpers/electronApp';
import type { MockLlm } from '../helpers/mockLlmServer';
import type { SerializedWorkspaceRef } from '../../src/host/workspaceState';
import { CONFIG_DIR_NAME, CORE_BINARY_NAME, CORE_DEPLOY_PREFIX } from '../../src/config/project';

/** 远端部署目录 / 状态目录 / 进程匹配模式（口径同 remoteSshExecution.spec.ts） */
const REMOTE_DEPLOY_DIR = `~/.local/share/${CORE_DEPLOY_PREFIX}`;
const REMOTE_RUN_DIR = `~/${CONFIG_DIR_NAME}/run`;
const CORE_PROCESS_PATTERN = `[${CORE_BINARY_NAME[0]}]${CORE_BINARY_NAME.slice(1)}`;

const SIDEBAR_ITEM = '#list .item[data-session-id]';

/**
 * US-64 / US-65：远程任务后台运行与认领重连（specs/031）。
 *
 * 与 `remoteSshExecution.spec.ts` 同一套真实 SSH 脚手架，聚焦生命周期：
 * - 关闭在跑任务的远程工作区标签页弹三选（后台运行 / 立即关闭 / 取消，默认取消）；
 * - 「后台运行」走 detach——远端 Core 进程留在 daemon 孤儿表继续执行，宿主强杀
 *   （崩溃口径）后任务照跑，daemon 不因无连接空退；
 * - 重开工作区认领原 Core 进程（远端不出现第二个 Core），孤儿期间的会话内容
 *   可见，在跑任务继续执行直至完成；
 * - 「立即关闭」走现行关闭路径，Core 终止。
 *
 * 环境：`e2e/environments.json`（同 remoteSshExecution），前置
 * `npm run build:core:linux-x64`。运行：`npm run test:e2e:ssh -- remoteTaskSurvival`。
 */

import { requireSshEnvironment, detectLlmAdvertiseHost } from '../helpers/testEnvironment';

const SSH = requireSshEnvironment();
const ADVERTISE_HOST = SSH.llmAdvertiseHost ?? detectLlmAdvertiseHost();

test.setTimeout(300_000);

function sshConnect(): Client {
  const client = new Client();
  client.connect({ host: SSH.host, port: SSH.port, username: SSH.user, password: SSH.password, readyTimeout: 20_000 });
  return client;
}

/** 在远端执行一条命令（一次性连接，测试脚手架用） */
function sshExec(command: string, timeoutMs = 30_000): Promise<{ stdout: string; stderr: string; code: number | null }> {
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
      });
    });
    setTimeout(() => fail(new Error(`ssh exec 超时: ${command}`)), timeoutMs);
  });
}

let remoteHome = '';
let remoteWs = '';
let remoteRef: SerializedWorkspaceRef;

test.beforeAll(async () => {
  const home = await sshExec('pwd');
  if (home.code !== 0) throw new Error(`远端 pwd 失败: ${home.stderr}`);
  remoteHome = home.stdout.trim();
  remoteWs = `${remoteHome}/tuxedo-e2e-survival-${process.pid}`;
  await sshExec(`mkdir -p ${remoteWs}`);
  remoteRef = {
    scheme: 'ssh',
    path: remoteWs,
    endpoint: { host: SSH.host, port: SSH.port, user: SSH.user, auth: { kind: 'sshPassword', password: SSH.password } },
  };
});

test.beforeEach(async () => {
  const probe = await sshExec('uname -sm');
  if (probe.code !== 0) {
    throw new Error(
      `SSH 测试环境无效（${SSH.user}@${SSH.host}:${SSH.port}）：uname 失败（exit=${probe.code}）。`
      + '不做修复，请先恢复环境或修正 e2e/environments.json。',
    );
  }
  const [system] = probe.stdout.trim().split(/\s+/);
  if (system !== 'Linux') {
    throw new Error(`SSH 测试环境无效：远端平台 "${system ?? 'unknown'}" 不被支持。不做修复。`);
  }
  // 每个用例从干净远端开始：杀残留 daemon / Core、清状态文件、清本组会话目录
  //（前一个用例的会话落盘会混进下一条断言的侧栏计数）
  const fingerprint = localFingerprint();
  await sshExec(
    `pkill -f '${CORE_PROCESS_PATTERN}' || true; sleep 1`
      + ` && rm -rf ${REMOTE_RUN_DIR}/core-daemon-${fingerprint}.json`
      + ` && cd ~/${CONFIG_DIR_NAME}/conversations 2>/dev/null && rm -rf *tuxedo-e2e-survival* ; true`,
  );
});

test.afterAll(async () => {
  if (remoteWs) await sshExec(`rm -rf ${remoteWs}`).catch(() => undefined);
  await sshExec(`pkill -f '${CORE_PROCESS_PATTERN}' || true`).catch(() => undefined);
});

/** 远端还活着的 Core 进程（daemon 与 workspace Core 都算） */
function remoteCoreProcesses(): Promise<Array<{ pid: string; cmd: string }>> {
  return sshExec(`pgrep -af '${CORE_PROCESS_PATTERN}' || true`).then(({ stdout }) =>
    stdout.trim().split('\n').filter((line) => line.length > 0).map((line) => {
      const space = line.indexOf(' ');
      return { pid: line.slice(0, space), cmd: line.slice(space + 1) };
    }),
  );
}

/** 轮询远端直到条件满足（每 2s 一次 SSH 连接） */
async function pollRemote(
  probe: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (await probe()) return;
    if (Date.now() - startedAt > timeoutMs) {
      const procs = await remoteCoreProcesses();
      throw new Error(`等待远端条件超时（${label}）。远端残留进程：${JSON.stringify(procs)}`);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

/** 本机携带产物的指纹（与远端部署槽位同名） */
function localFingerprint(): string {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  return fs.readFileSync(
    path.join(repoRoot, 'dist', 'resources', 'core', 'x64-linux', 'fingerprint'),
    'utf8',
  ).trim();
}

let app: AppHandle | null = null;

async function closeApp(): Promise<void> {
  if (app) {
    await app.close();
    app = null;
  }
}

test.afterEach(async () => {
  await closeApp();
});

/** 启动应用并打开远程工作区（mock LLM 由调用方持有，便于跨实例复用） */
async function launch(mockLlm: MockLlm): Promise<Awaited<ReturnType<AppHandle['chatPage']>>> {
  app = await launchApp({
    repoRoot: process.cwd().replace(/[\\/]e2e$/, ''),
    mockLlm,
    workspaceDir: remoteWs,
    openWorkspaces: [remoteRef],
    agentMode: 'auto',
  });
  const chatPage = await app.chatPage({ workspaceIncludes: 'tuxedo-e2e-survival' }, 180_000);
  await chatPage.waitForSelector('textarea.input-textarea', { timeout: 30_000 });
  return chatPage;
}

/** 发起一个跨孤儿期的远端任务：Bash sleep（约 45s，断言窗口内不会自然结束） */
async function startLongTask(chatPage: Awaited<ReturnType<AppHandle['chatPage']>>): Promise<void> {
  await chatPage.fill('textarea.input-textarea', '后台存活探针');
  await chatPage.press('textarea.input-textarea', 'Enter');
  // 查询进入运行态（终止按钮可用 = core 侧 queryRunning）
  await expect(chatPage.locator('button[title="终止"]')).toBeEnabled({ timeout: 60_000 });
}

/** 等侧栏列表停止变化再交互（与 sessions.spec 的同名助手同语义） */
async function waitForSidebarQuiet(sb: import('@playwright/test').Page, quietMs = 600, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  let changedAt = Date.now();
  while (Date.now() < deadline) {
    const html = await sb.evaluate(() => document.querySelector('#list')?.innerHTML ?? '');
    if (html !== last) {
      last = html;
      changedAt = Date.now();
    } else if (Date.now() - changedAt >= quietMs) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('侧栏列表持续变化，等不到平静窗口');
}

/** mock：首轮起一个远端 sleep 任务，工具结果回传后给终答 */
function armSleepTaskHandler(mockLlm: MockLlm): void {
  mockLlm.setHandler((req) => {
    if (req.body.messages[req.body.messages.length - 1]?.role === 'tool') {
      return { kind: 'text', text: 'SURVIVAL-DONE' };
    }
    return {
      kind: 'tool',
      name: 'Bash',
      args: { command: 'sleep 90 && printf orphan-survival-ok', description: 'background survival probe' },
    };
  });
}

test('US-64 关闭在跑任务的远程工作区：三选弹框（默认取消）、后台运行后远端 Core 存活', async () => {
  const mockLlm = await startMockLlm({ workspaceDir: remoteWs, listenHost: '0.0.0.0', advertiseHost: ADVERTISE_HOST });
  armSleepTaskHandler(mockLlm);
  const chatPage = await launch(mockLlm);
  await startLongTask(chatPage);

  // 标签页 ×：忙碌远程工作区弹三选（AC-1），默认焦点在取消
  const tabs = (await app!.titlebarPage()).locator('#workspaceTabs [role="tab"]');
  await expect(tabs.first()).toHaveClass(/activity-running/, { timeout: 30_000 });
  await tabs.first().hover();
  await tabs.first().locator('.ws-tab-close').click();
  const box = await waitForMessageBox(app!);
  const boxText = await messageBoxText(box);
  expect(boxText.buttons).toContain('后台运行');
  expect(boxText.buttons).toContain('立即关闭');
  expect(boxText.buttons).toContain('取消');

  // 取消（按钮 2）：标签页保留、任务继续（AC-1 默认落点即它，防误关）
  await clickMessageBoxButton(box, 2);
  await expect(tabs).toHaveCount(1);
  await expect(chatPage.locator('button[title="终止"]')).toBeEnabled({ timeout: 30_000 });

  // 后台运行（按钮 0）：标签页移除，远端 Core 不退（AC-4）
  await tabs.first().hover();
  await tabs.first().locator('.ws-tab-close').click();
  const box2 = await waitForMessageBox(app!);
  await clickMessageBoxButton(box2, 0);
  await expect(tabs).toHaveCount(0, { timeout: 20_000 });
  const during = await remoteCoreProcesses();
  expect(during.some((p) => p.cmd.includes(' stdio')), 'detach 后远端 Core 仍在').toBeTruthy();

  // 宿主强杀（崩溃口径）：daemon 断链后非 idle Core 孤儿化存活（AC-5），
  // 且超过 idle-exit（30s）窗口 daemon 也不空退（AC-17）
  await closeApp();
  mockLlm.close();
  await new Promise((r) => setTimeout(r, 5_000));
  const afterCrash = await remoteCoreProcesses();
  expect(afterCrash.some((p) => p.cmd.includes(' start-daemon')), 'daemon 应在跑').toBeTruthy();
  expect(afterCrash.some((p) => p.cmd.includes(' stdio')), '孤儿 Core 应存活').toBeTruthy();
  await new Promise((r) => setTimeout(r, 35_000));
  const pastIdleWindow = await remoteCoreProcesses();
  expect(
    pastIdleWindow.some((p) => p.cmd.includes(' start-daemon')),
    '非 idle 孤儿在跑，daemon 不得空退（AC-17）',
  ).toBeTruthy();
  expect(
    pastIdleWindow.some((p) => p.cmd.includes(' stdio')),
    '孤儿任务跨过 idle 窗口仍在执行',
  ).toBeTruthy();
});

test('US-65 后台运行后重开：认领原 Core、孤儿期间内容可见、任务继续完成', async () => {
  const mockLlm = await startMockLlm({ workspaceDir: remoteWs, listenHost: '0.0.0.0', advertiseHost: ADVERTISE_HOST });
  armSleepTaskHandler(mockLlm);
  const chatPage = await launch(mockLlm);
  await startLongTask(chatPage);

  // 关标签页选「后台运行」，随后强杀宿主（崩溃口径）
  const tabs = (await app!.titlebarPage()).locator('#workspaceTabs [role="tab"]');
  await tabs.first().hover();
  await tabs.first().locator('.ws-tab-close').click();
  const box = await waitForMessageBox(app!);
  await clickMessageBoxButton(box, 0);
  await expect(tabs).toHaveCount(0, { timeout: 20_000 });
  const orphanCore = (await remoteCoreProcesses()).find((p) => p.cmd.includes(' stdio'));
  expect(orphanCore, '孤儿 Core 应存活').toBeTruthy();
  await closeApp();
  await new Promise((r) => setTimeout(r, 8_000));
  // 同一个 Core 进程还在（记录 pid，认领后比对）
  const surviving = (await remoteCoreProcesses()).find((p) => p.cmd.includes(' stdio'));
  expect(surviving?.pid, '孤儿 Core 跨宿主死亡存活').toBe(orphanCore?.pid);

  // 重开同一工作区：认领原 Core（pid 不变、远端不出现第二个 Core，AC-7）
  const chatPage2 = await launch(mockLlm);
  const claimed = (await remoteCoreProcesses()).filter((p) => p.cmd.includes(' stdio'));
  expect(claimed).toHaveLength(1);
  expect(claimed[0].pid, '认领的是原 Core 进程').toBe(orphanCore?.pid);

  // 孤儿期间的会话在列表里，打开后孤儿期间的消息可见（AC-8）。
// 点击前等列表平静窗口：认领重放的快照推送触发 innerHTML 全量重建，重建撞上
// hover→click 之间点击会落空（与 sessions.spec 的 waitForSidebarQuiet 同一坑）
  const sidebar = await app!.sidebarPage();
  await expect(sidebar.locator(SIDEBAR_ITEM)).toHaveCount(1, { timeout: 60_000 });
  await waitForSidebarQuiet(sidebar);
  const sessionId = await sidebar
    .locator(SIDEBAR_ITEM)
    .first()
    .getAttribute('data-session-id');
  expect(sessionId, '侧栏条目应携带会话 id').toBeTruthy();
  await sidebar.locator(SIDEBAR_ITEM).first().click();
  // 预加载的「新建对话」备用视图与目标视图并存：按会话 id 重新解析（helpers 同款规则）
  const loadedPage = await app!.chatPage(
    { workspaceIncludes: 'tuxedo-e2e-survival', sessionIncludes: sessionId! },
    60_000,
  );
  await expect(loadedPage.getByText('后台存活探针').first()).toBeVisible({ timeout: 60_000 });

  // 在跑任务继续执行直至完成：sleep 到点 → 工具结果回传 → 终答（AC-7 消息流恢复）
  await expect(loadedPage.getByText('SURVIVAL-DONE').first()).toBeVisible({ timeout: 180_000 });
  mockLlm.close();
});

test('US-64 立即关闭：远端 Core 终止（现行关闭路径）', async () => {
  const mockLlm = await startMockLlm({ workspaceDir: remoteWs, listenHost: '0.0.0.0', advertiseHost: ADVERTISE_HOST });
  armSleepTaskHandler(mockLlm);
  const chatPage = await launch(mockLlm);
  await startLongTask(chatPage);

  const tabs = (await app!.titlebarPage()).locator('#workspaceTabs [role="tab"]');
  await tabs.first().hover();
  await tabs.first().locator('.ws-tab-close').click();
  const box = await waitForMessageBox(app!);
  // 立即关闭（按钮 1）：daemon 收 closeWorkspace，Core 终止（AC-15）
  await clickMessageBoxButton(box, 1);
  await expect(tabs).toHaveCount(0, { timeout: 20_000 });
  await pollRemote(
    async () => !(await remoteCoreProcesses()).some((p) => p.cmd.includes(' stdio')),
    25_000,
    '立即关闭后的 Core 终止',
  );
  mockLlm.close();
});

test('US-64 退出确认链：取消中止整个退出，应用与任务都继续（AC-12）', async () => {
  const mockLlm = await startMockLlm({ workspaceDir: remoteWs, listenHost: '0.0.0.0', advertiseHost: ADVERTISE_HOST });
  armSleepTaskHandler(mockLlm);
  const chatPage = await launch(mockLlm);
  await startLongTask(chatPage);

  // 标题栏窗口关闭按钮触发退出确认链：忙碌远程工作区弹三选，取消 → 退出中止
  const titlebar = await app!.titlebarPage();
  await titlebar.click('#btnClose');
  const box = await waitForMessageBox(app!);
  expect((await messageBoxText(box)).buttons).toContain('取消');
  await clickMessageBoxButton(box, 2);

  // 应用继续运行：标题栏还在、任务还在跑（AC-12）
  const titlebar2 = await app!.titlebarPage();
  await expect(titlebar2.locator('#workspaceTabs [role="tab"]')).toHaveCount(1);
  await expect(chatPage.locator('button[title="终止"]')).toBeEnabled({ timeout: 30_000 });
  mockLlm.close();
});
