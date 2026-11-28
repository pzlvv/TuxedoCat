import { test, expect } from '@playwright/test';
import { Client } from 'ssh2';
import { startMockLlm } from '../helpers/mockLlmServer';
import { launchApp, waitForMessageBox, clickMessageBoxButton, messageBoxText } from '../helpers/electronApp';
import type { AppHandle } from '../helpers/electronApp';
import type { MockLlm } from '../helpers/mockLlmServer';
import type { SerializedWorkspaceRef } from '../../src/host/workspaceState';
import { CONFIG_DIR_NAME, CORE_DEPLOY_PREFIX } from '../../src/config/project';
import { coreProcessPattern, requireLocalCoreFingerprint } from '../helpers/remoteCoreProcess';

/** 远端部署目录 / 状态目录（口径同 remoteSshExecution.spec.ts） */
const REMOTE_DEPLOY_DIR = `~/.local/share/${CORE_DEPLOY_PREFIX}`;
const REMOTE_RUN_DIR = `~/${CONFIG_DIR_NAME}/run`;

/**
 * 本指纹的 Core 进程模式。
 *
 * 按**部署槽位的构建指纹**收敛而不是只按二进制名：远端是共享机器，同机上可能并存多个
 * 槽位的 Core（`e2e/helpers/remoteCoreProcess.ts` 记了后果），只按名字匹配会把别人的
 * Core 算成自己的残留、清场时还会误杀。
 */
function corePattern(): string {
  return coreProcessPattern(requireLocalCoreFingerprint());
}

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

import { requireSshEnvironment } from '../helpers/testEnvironment';

const SSH = requireSshEnvironment();

// 单用例上限由 project 给（`electron-ssh` = 60s，见 `e2e/playwright.config.ts`）。
// 本文件的三条用例要等 90s 的远端 sleep 任务跨孤儿期跑完，各自在用例体内放宽。

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
  await sshExec(`pkill -u "$(id -u)" -f '${corePattern()}' || true`).catch(() => undefined);
  // 等进程真的消失而不是等固定时长：pkill 只负责发信号，SIGTERM 到进程退出之间还有收尾
  // （Core 写盘），负载高时 1s 不够——半死的 daemon 会让下一条用例建链挂住
  //（e2e/README.md 已知坑 11）。本组用例的断言基数是「远端还剩几个 Core」，基线本身
  // 必须是真的零。SIGTERM 等不干净就升级 SIGKILL 再等；清场是前置条件，最终仍不干净
  // 直接抛错（不吞）——带着残留进程进用例，只会把「基数不为零」伪装成产品断言失败，
  // 让 AC-4 这类「远端没有 stdio Core」的判据替上一条用例的收尾背锅。
  const settled = await pollRemote(
    async () => (await remoteCoreProcesses()).length === 0,
    15_000,
    '清场：残留 Core / daemon 全部退出',
  ).then(() => true, () => false);
  if (!settled) {
    await sshExec(`pkill -9 -u "$(id -u)" -f '${corePattern()}' || true`).catch(() => undefined);
    await pollRemote(
      async () => (await remoteCoreProcesses()).length === 0,
      10_000,
      '清场（SIGKILL 升级后）：残留 Core / daemon 全部退出',
    );
  }
  await sshExec(
    `rm -rf ${REMOTE_RUN_DIR}/core-daemon-${fingerprint}.json`
      + ` && cd ~/${CONFIG_DIR_NAME}/conversations 2>/dev/null && rm -rf *tuxedo-e2e-survival* ; true`,
  );
});

test.afterAll(async () => {
  if (remoteWs) await sshExec(`rm -rf ${remoteWs}`).catch(() => undefined);
  await sshExec(`pkill -u "$(id -u)" -f '${corePattern()}' || true`).catch(() => undefined);
});

/** 远端还活着的本指纹 Core 进程（daemon 与 workspace Core 都算） */
function remoteCoreProcesses(): Promise<Array<{ pid: string; cmd: string }>> {
  // 两道收敛：`-u` 按 SSH 用户自己的 uid（裸 pgrep 是全机口径，会把别的用户正在用的
  // Core 算成本车道残留），模式里的部署槽位指纹再收一次（同一 uid 下并存的多个构建）。
  return sshExec(`pgrep -u "$(id -u)" -af '${corePattern()}' || true`).then(({ stdout }) =>
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
  return requireLocalCoreFingerprint();
}

/**
 * 「等孤儿 Core 收尾」超时时把现场摊开（与 overlayMountProxyRemote 的
 * `describeToolResultStall` 同口径）。同一个「stdio 仍活着」至少有三种互不相同的成因，
 * 光看超时与进程列表读不出来（run 45885611474 的 AC-4 即如此）：
 *
 * 1. 任务没跑完——Bash sleep 还没到点（工具没起 / 进程树残留）；
 * 2. 任务跑完但终轮 LLM 往返卡住——远端到 mock 的反向隧道抖动，终轮请求没到 mock，
 *    Core 保持 running（首字节超时 300s 远大于本用例窗口，见 core-rs/src/llm.rs）；
 * 3. 任务与终答都完成（Core 已 idle）但 daemon 没收尾——忙闲旗标或清扫循环问题。
 *
 * 模型请求条数与角色序列分辨 1/2（终轮是否到达 mock）；daemon 日志末段（Core stderr +
 * daemon 决策）分辨 2/3。诊断本身不能再抛错盖掉原失败：读不到就照实说。
 */
async function describeOrphanStall(mockLlm: MockLlm): Promise<string> {
  const requests = mockLlm.requests;
  const shapes = requests.map((request) =>
    request.body.messages.map((message) => message.role).join('>'),
  );
  const lines = [
    requests.length > 0
      ? `模型请求 ${requests.length} 条：${shapes.join(' | ')}`
      : '模型请求 0 条：终轮没有到达 mock（隧道抖动 / Core 卡在工具执行）',
  ];
  try {
    const { stdout } = await sshExec(
      `tail -n 60 ~/${CONFIG_DIR_NAME}/logs/core-daemon-${localFingerprint()}.log 2>/dev/null || true`,
    );
    lines.push(`daemon 日志（末 60 行）：\n${stdout.trim() || '（空）'}`);
  } catch (error) {
    lines.push(`daemon 日志：读取失败（${String(error)}）`);
  }
  return lines.join('\n');
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
    // 与下面 chatPage 的预算对齐（`specs/defects/
    // e2e-launchapp-inner-chatpage-wait-ignores-caller-timeout.md`）。
    // 60s 覆盖「Electron 冷启动 + SSH 建链 + 恢复远程工作区」：真实远端实测 5.8s，
    // 留约 10 倍余量吸收 CI 慢机
    startupChatWaitMs: 60_000,
  });
  const chatPage = await app.chatPage({ workspaceIncludes: 'tuxedo-e2e-survival' }, 60_000);
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
    // 长任务只起一次：按「助手自己那条 tool_use 是否已进历史」判（与
    // subagentConcurrency 的 issued 同口径，不数轮次、不依赖通知文案）。
    //
    // 为什么不能对任意非 tool 轮次都回 sleep：前台 Bash 死线 = max(60s, sleep 总和)
    // = 90s，与 sleep 90 本身几乎相等（printf 先跑，shell 比死线晚几毫秒退出），
    // 30ms 的收尾轮询偶尔落在「死线已过、shell 未退」的窗口里——按产品口径超时
    // **不杀进程、转入后台继续跑**（core-rs/src/tools.rs 的 auto_background_command）。
    // 后台任务跑完经 enqueue_bash_notification 注入一条 origin=bash 的用户消息、
    // 拉起新一轮，这一轮最后一条不是 tool；若仍回 sleep 90 就再起一个 90s 任务，
    // 孤儿忙期叠到约 210s，撞穿 AC-4 的 180s 收尾窗口（run 45885611474，本机 WAN
    // 远端可复现：daemon 日志出现两条 Bash resolve_permission）。通知轮给终答收尾，
    // 孤儿在首个任务完成后照常转 idle 被收尾——产品行为不变，只是不再脚本无限长任务。
    const issued = JSON.stringify(req.body.messages).includes('sleep 90');
    if (issued) {
      return { kind: 'text', text: 'SURVIVAL-DONE' };
    }
    return {
      kind: 'tool',
      name: 'Bash',
      // 时长由「要覆盖的最长等待」推导，不按超时口径定值。本组每条用例都要任务
      // **跨越整条交互链仍然在跑**：detach → 强杀宿主 → 重开认领 → 侧栏/快照断言，
      // 实测整链约 40–50s（单次重开 5.8s，但链上还有 SSH 建链、认领重放、两轮断言），
      // 90s 留约 2 倍余量；再往下（试过 60s）任务会在终答回来之前就跑完，
      // 「在跑任务继续执行直至完成」这条断言就会拿到空结果。
      //
      // 注意前台超时口径（`core-rs/src/tools.rs` 的 `default_bash_timeout_ms`）：默认
      // 60s，含 `sleep` 的命令取 `max(60s, sleep 时长总和)`——sleep 只把死线后移、
      // 不注销死线，因此**不会**有「超时先收口出工具结果」这种捷径可依赖。
      //
      // `restricted` 缺省为真时闸门会拒绝含 `sleep` 的命令
      // （docs/features/background-bash.md FR-005），起不出长任务，显式关掉。
      args: { command: 'printf probe; sleep 90 && printf orphan-survival-ok', description: 'background survival probe', restricted: false },
    };
  });
}

test('US-64 关闭在跑任务的远程工作区：三选弹框（默认取消）、后台运行后远端 Core 存活', async () => {
  // 起一个 90s 的远端 sleep 任务并跨「标签页关闭 → 重开认领」窗口：实测整轮 108s
  test.setTimeout(180_000);
  const mockLlm = await startMockLlm({ workspaceDir: remoteWs, listenHost: '0.0.0.0', reverseTunnel: SSH });
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
  // 等 daemon 真的察觉断链，不用固定时长：判据是「业务 Core 已孤儿化」——断链前它是
  // 连接内的 Core，断链后 daemon 把它移进孤儿表，两种状态在远端进程表上不可区分，
  // 因此以「孤儿期仍保留 stdio 形态且 daemon 存活」作为可观测条件反复确认
  await pollRemote(
    async () => {
      const procs = await remoteCoreProcesses();
      return procs.some((p) => p.cmd.includes(' start-daemon'))
        && procs.some((p) => p.cmd.includes(' stdio'));
    },
    20_000,
    '宿主断链后 daemon 存活且孤儿 Core 未被收尾',
  );
  const afterCrash = await remoteCoreProcesses();
  expect(afterCrash.some((p) => p.cmd.includes(' start-daemon')), 'daemon 应在跑').toBeTruthy();
  expect(afterCrash.some((p) => p.cmd.includes(' stdio')), '孤儿 Core 应存活').toBeTruthy();
  // 这里必须等满 idle-exit 窗口（30s）再加余量，不能改条件等待：本条验的就是
  // 「非 idle 孤儿在跑时 daemon 不得提前空退」（AC-17）——提前结束等待会把「还没到宽限
  // 到期」误当成「已经跨过窗口」，断言就失去了意义。条件是「时间过去了多久」本身。
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
  // 孤儿期要跑满远端 sleep（90s）后等终答，中途含一次重开认领：实测整轮约 140s
  test.setTimeout(180_000);
  const mockLlm = await startMockLlm({ workspaceDir: remoteWs, listenHost: '0.0.0.0', reverseTunnel: SSH });
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
  // `closeApp()` 返回即宿主进程已退出（它内部等 child 的 close 事件），不需要再等固定
  // 时长；这里要确认的是「宿主死了孤儿还活着」，用 pid 轮询表达：同一个 pid 在远端
  // 仍存活即为事实，条件满足立刻继续
  await pollRemote(
    async () => (await remoteCoreProcesses()).some((p) => p.pid === orphanCore?.pid),
    15_000,
    '宿主退出后孤儿 Core 仍以原 pid 存活',
  );
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
  // 认领重放的全量运行时快照（FR-006）要照亮三个消费者：侧栏行灯、标签页灯、
  // webview 的 abort 按钮。任务（sleep）仍在跑，运行灯应亮（蓝）；此时对话还没
  // 打开过——快照先于对话列表到达，正落在「推送早于索引/视图就绪」最坏的时序上。
  await expect(sidebar.locator(SIDEBAR_ITEM).first().locator('.running-bar')).toBeVisible({ timeout: 30_000 });
  const titlebar = await app!.titlebarPage();
  await expect(titlebar.locator('#workspaceTabs [role="tab"]').first()).toHaveClass(/activity-running/, { timeout: 30_000 });
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
  // webview 读同一份运行时快照（abort 按钮三态，docs/features/abort-button.md）：
  // 任务在跑 → 终止按钮可用；若快照在认领后丢失，这里会退回灰色不可点
  await expect(loadedPage.locator('button[title="终止"]')).toBeEnabled({ timeout: 30_000 });

  // 在跑任务继续执行直至完成：sleep 到点 → 工具结果回传 → 终答（AC-7 消息流恢复）。
  // 预算覆盖「剩余 sleep + 终答往返」：任务总长 60s，此处从认领后起算，留 3 倍余量
  await expect(loadedPage.getByText('SURVIVAL-DONE').first()).toBeVisible({ timeout: 120_000 });
  mockLlm.close();
});

test('US-65 离场完成：孤儿期跑完、daemon 空退，重开后亮绿色未读完成灯（AC-4）', async () => {
  // 最坏路径 = sleep 90s（自然跑完，超时不会更早收口）+ 30s 孤儿空闲宽限
  // + 两次重开（各约 6s，真实远端探针实测）+ 断言窗口，实测整轮约 190s
  test.setTimeout(300_000);
  const mockLlm = await startMockLlm({ workspaceDir: remoteWs, listenHost: '0.0.0.0', reverseTunnel: SSH });
  armSleepTaskHandler(mockLlm);
  const chatPage = await launch(mockLlm);
  await startLongTask(chatPage);

  // 关标签页选「后台运行」：任务在孤儿期继续执行，宿主不在场——孤儿帧不进任何
  // 连接，宿主差分永远看不到完成迁移；mock LLM 必须活着等孤儿期终答
  const tabs = (await app!.titlebarPage()).locator('#workspaceTabs [role="tab"]');
  await tabs.first().hover();
  await tabs.first().locator('.ws-tab-close').click();
  const box = await waitForMessageBox(app!);
  await clickMessageBoxButton(box, 0);
  await expect(tabs).toHaveCount(0, { timeout: 20_000 });

  // 等任务在孤儿期跑完：daemon 检出 running → idle 迁移，经控制帧让 core 把
  // 未读完成记进 meta.json；随后孤儿转 idle，满 30s 宽限被 daemon 收尾。
  // 窗口 = sleep 90s + 30s 宽限 + 远端抖动余量。最坏路径 120s，留 60s（50%）余量：
  // 原先 260s 是对着 sleep 180 定的，最坏路径 210s 只剩 50s（24%），CI 上因此偶发超时
  //
  // 超时要能读出断在哪一环：run 45885611474 这条判据红时残留只有本指纹的 daemon + stdio，
  // 进程列表分辨不了「任务没跑完 / 终轮卡住 / daemon 没收尾」——请求形态与 daemon 日志
  // 末段一并摊进失败信息（`describeOrphanStall`，与 AC-31 的 describeToolResultStall 同口径）。
  try {
    await pollRemote(
      async () => !(await remoteCoreProcesses()).some((p) => p.cmd.includes(' stdio')),
      180_000,
      '孤儿 Core 在任务完成 + 30s 空闲宽限后收尾',
    );
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${await describeOrphanStall(mockLlm)}`);
  }

  // 关闭应用（断开最后一条控制链路），daemon 无连接且无孤儿 → 空退并清状态文件：
  // 重开拉起的是全新 Core，绿灯证据只剩 meta.json（缺陷报告的场景）
  await closeApp();
  await pollRemote(
    async () => (await remoteCoreProcesses()).length === 0,
    60_000,
    'daemon 空退（无连接且无孤儿）',
  );

  // 重开工作区：全新 Core，对话行应亮绿色未读完成灯（AC-4）
  await launch(mockLlm);
  const sidebar = await app!.sidebarPage();
  const item = sidebar.locator(SIDEBAR_ITEM).first();
  await expect(item).toHaveCount(1, { timeout: 60_000 });
  await expect(item.locator('.running-bar--completed')).toBeVisible({ timeout: 15_000 });

  // 打开对话即阅读：绿灯熄灭
  await item.click();
  await expect(item.locator('.running-bar--completed')).toHaveCount(0, { timeout: 15_000 });
  mockLlm.close();
});

test('US-64 立即关闭：远端 Core 终止（现行关闭路径）', async () => {
  const mockLlm = await startMockLlm({ workspaceDir: remoteWs, listenHost: '0.0.0.0', reverseTunnel: SSH });
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
  const mockLlm = await startMockLlm({ workspaceDir: remoteWs, listenHost: '0.0.0.0', reverseTunnel: SSH });
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
