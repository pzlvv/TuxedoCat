import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { startMockLlm } from '../helpers/mockLlmServer';
import { launchApp, makeWorkspace, stubMainMessageBox } from '../helpers/electronApp';
import type { AppHandle } from '../helpers/electronApp';
import type { MockLlm } from '../helpers/mockLlmServer';
import type { SerializedWorkspaceRef } from '../../src/host/workspaceState';

/**
 * US-30 完整模式与悬浮窗切换 / US-35 多工作区标签页（打开集合恢复 / 切换 / 关闭）
 * / US-36 远程工作区启动探测失败自动标红
 */

let mockLlm: MockLlm;
let app: AppHandle | null = null;
let workspaceDir: string;

test.beforeEach(async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  workspaceDir = await makeWorkspace({ 'ws-a.md': 'A' });
  mockLlm = await startMockLlm({ workspaceDir });
});

test.afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  mockLlm.close();
  await fs.promises.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
});

test('US-30 完整模式 ↔ 悬浮窗：侧栏隐藏，对话列表移交 webview 顶栏', async () => {
  app = await launchApp({ repoRoot: process.cwd().replace(/[\\/]e2e$/, ''), mockLlm, workspaceDir });
  const chatPage = await app.chatPage();
  const sidebarPage = await app.sidebarPage();
  const titlebarPage = await app.titlebarPage();

  // 完整模式：侧栏可见；对话列表归宿主渲染（webview 顶栏无历史按钮）
  await expect(sidebarPage.locator('#searchInput')).toBeVisible();
  await expect(chatPage.locator('button[title="对话历史"]')).toHaveCount(0);

  // 切到悬浮窗：对话列表渲染方切换为 webview（US-30 验收 2）
  await titlebarPage.locator('#btnMode').click();
  await expect(chatPage.locator('button[title="对话历史"]')).toBeVisible({ timeout: 15_000 });

  // 切回完整模式：webview 顶栏列表收回，侧栏恢复
  await titlebarPage.locator('#btnMode').click();
  await expect(chatPage.locator('button[title="对话历史"]')).toHaveCount(0, { timeout: 15_000 });
  await expect((await app.sidebarPage()).locator('#searchInput')).toBeVisible({ timeout: 15_000 });
});

test('US-35 多工作区标签页：恢复打开集合、切换活动工作区、会话按目录隔离', async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  const aDir = await makeWorkspace({ 'a.md': 'A' }, 'e2e-ws-alpha');
  const bDir = await makeWorkspace({ 'b.md': 'B' }, 'e2e-ws-beta');
  app = await launchApp({
    repoRoot, mockLlm, workspaceDir: aDir,
    openWorkspaces: [aDir, bDir],
    activeWorkspace: aDir,
  });

  const titlebarPage = await app.titlebarPage();
  const tabs = titlebarPage.locator('#workspaceTabs [role="tab"]');
  await expect(tabs).toHaveCount(2, { timeout: 20_000 });
  await expect(tabs.first()).toContainText('e2e-ws-alpha');
  await expect(tabs.nth(1)).toContainText('e2e-ws-beta');
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');

  // 点击第二个标签页：活动项切换，聊天区切到该工作区（按绑定工作区解析视图）
  await tabs.nth(1).click();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
  const betaChat = await app.chatPage({ workspaceIncludes: 'e2e-ws-beta' });
  await expect(betaChat.locator('textarea.input-textarea')).toBeEnabled({ timeout: 30_000 });

  // 工作区 B 里发消息，会话落盘归属 B 的会话目录（US-35 验收 3：独立对话上下文）
  await betaChat.fill('textarea.input-textarea', '工作区 B 的消息');
  await betaChat.press('textarea.input-textarea', 'Enter');
  await expect(betaChat.getByText(/收到：工作区 B/).first()).toBeVisible({ timeout: 30_000 });

  const conversationsRoot = path.join(app.homeDir, '.tuxedo-cat', 'conversations');
  const projectDirs = fs.readdirSync(conversationsRoot);
  expect(projectDirs.length).toBe(1);
  const dirName = projectDirs[0];
  expect(decodeURIComponent(dirName)).toContain('e2e-ws-beta');

  await fs.promises.rm(aDir, { recursive: true, force: true }).catch(() => undefined);
  await fs.promises.rm(bDir, { recursive: true, force: true }).catch(() => undefined);
});

test('US-35 关闭工作区标签页：集合移除、活动权移交相邻项', async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  const aDir = await makeWorkspace({}, 'e2e-ws-close-a');
  const bDir = await makeWorkspace({}, 'e2e-ws-close-b');
  app = await launchApp({
    repoRoot, mockLlm, workspaceDir: aDir,
    openWorkspaces: [aDir, bDir],
    activeWorkspace: aDir,
  });

  const tabs = (await app.titlebarPage()).locator('#workspaceTabs [role="tab"]');
  await expect(tabs).toHaveCount(2, { timeout: 20_000 });

  // 关闭当前活动标签（A）：剩一个标签且活动权移交 B，聊天区仍可用
  await tabs.first().hover();
  await tabs.first().locator('.ws-tab-close').click();
  await expect(tabs).toHaveCount(1, { timeout: 20_000 });
  await expect(tabs.first()).toContainText('e2e-ws-close-b');
  await expect((await app.chatPage()).locator('textarea.input-textarea')).toBeEnabled({ timeout: 30_000 });

  await fs.promises.rm(aDir, { recursive: true, force: true }).catch(() => undefined);
  await fs.promises.rm(bDir, { recursive: true, force: true }).catch(() => undefined);
});

test('US-35 鼠标中键关闭工作区标签页', async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  const aDir = await makeWorkspace({}, 'e2e-ws-mid-a');
  const bDir = await makeWorkspace({}, 'e2e-ws-mid-b');
  app = await launchApp({
    repoRoot, mockLlm, workspaceDir: aDir,
    openWorkspaces: [aDir, bDir],
    activeWorkspace: aDir,
  });

  const tabs = (await app.titlebarPage()).locator('#workspaceTabs [role="tab"]');
  await expect(tabs).toHaveCount(2, { timeout: 20_000 });

  // 中键点非活动标签 B：只关它，活动项仍是 A（聊天区不跟着切）
  await tabs.nth(1).click({ button: 'middle' });
  await expect(tabs).toHaveCount(1, { timeout: 20_000 });
  await expect(tabs.first()).toContainText('e2e-ws-mid-a');
  await expect(tabs.first()).toHaveClass(/active/);
  await expect((await app.chatPage()).locator('textarea.input-textarea')).toBeEnabled({ timeout: 30_000 });

  await fs.promises.rm(aDir, { recursive: true, force: true }).catch(() => undefined);
  await fs.promises.rm(bDir, { recursive: true, force: true }).catch(() => undefined);
});

test('US-35 标签页流水灯：按工作目录归并会话运行时状态（运行蓝 / 等待黄 / 空闲不点亮）', async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  const aDir = await makeWorkspace({}, 'e2e-ws-light-a');
  const bDir = await makeWorkspace({}, 'e2e-ws-light-b');
  app = await launchApp({
    repoRoot, mockLlm, workspaceDir: aDir,
    openWorkspaces: [aDir, bDir],
    activeWorkspace: aDir,
  });

  const tabs = (await app.titlebarPage()).locator('#workspaceTabs [role="tab"]');
  await expect(tabs).toHaveCount(2, { timeout: 20_000 });
  const tabA = tabs.filter({ hasText: 'e2e-ws-light-a' });
  const tabB = tabs.filter({ hasText: 'e2e-ws-light-b' });

  // 空闲：两张标签都不点亮——流水灯读的是会话运行时状态，不是「这个目录有会话」
  await expect(tabA).not.toHaveClass(/activity-running|activity-waiting/);
  await expect(tabB).not.toHaveClass(/activity-running|activity-waiting/);

  const chatPage = await app.chatPage();

  // 等待用户（黄）：manual 询问模式下的写操作弹权限确认，该会话转为「等待用户操作」，
  // 它所属的标签转黄。B 目录没有会话参与，不受影响。
  await chatPage.fill('textarea.input-textarea', '写入文件 light.md');
  await chatPage.press('textarea.input-textarea', 'Enter');
  const overlay = chatPage.locator('.user-choice-overlay');
  await expect(overlay).toBeVisible({ timeout: 30_000 });
  await expect(tabA).toHaveClass(/activity-waiting/, { timeout: 30_000 });
  await expect(tabB).not.toHaveClass(/activity-running|activity-waiting/);

  // 放行 → 工具执行 → 终轮收尾：等待态结束，标签回到不点亮
  await overlay.getByRole('button', { name: /允许/ }).first().click();
  await expect(chatPage.getByText('这是最终答复').first()).toBeVisible({ timeout: 30_000 });
  await expect(tabA).not.toHaveClass(/activity-running|activity-waiting/, { timeout: 30_000 });

  // 运行中（蓝）：慢速查询让该目录进入非 idle，只有 A 亮蓝灯——状态按会话归属的
  // 工作目录归并（core 只报 sessionId），归属错了这里就会两张一起亮。
  await chatPage.fill('textarea.input-textarea', '慢速回答一段长内容');
  await chatPage.press('textarea.input-textarea', 'Enter');
  const abortButton = chatPage.locator('button[title="终止"]');
  await expect(abortButton).toBeEnabled({ timeout: 30_000 });
  await expect(tabA).toHaveClass(/activity-running/, { timeout: 30_000 });
  await expect(tabB).not.toHaveClass(/activity-running|activity-waiting/);

  // 中止回到空闲：蓝灯熄灭（状态流回推 idle 后就地摘 class，不重建标签页）
  await expect(chatPage.getByText(/慢速流式输出/).first()).toBeVisible();
  await abortButton.click();
  await expect(abortButton).toBeDisabled({ timeout: 30_000 });
  await expect(tabA).not.toHaveClass(/activity-running|activity-waiting/, { timeout: 30_000 });

  await fs.promises.rm(aDir, { recursive: true, force: true }).catch(() => undefined);
  await fs.promises.rm(bDir, { recursive: true, force: true }).catch(() => undefined);
});

test('US-35 标签页内有对话非 idle 时关闭标签页需二次确认', async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  const aDir = await makeWorkspace({}, 'e2e-ws-busy-a');
  const bDir = await makeWorkspace({}, 'e2e-ws-busy-b');
  app = await launchApp({
    repoRoot, mockLlm, workspaceDir: aDir,
    openWorkspaces: [aDir, bDir],
    activeWorkspace: aDir,
  });

  // A 里跑一个慢速查询：该标签页进入非 idle（流水灯亮、查询未结束）
  const chatPage = await app.chatPage();
  await chatPage.fill('textarea.input-textarea', '慢速回答一段长内容');
  await chatPage.press('textarea.input-textarea', 'Enter');
  await expect(chatPage.locator('button[title="终止"]')).toBeEnabled({ timeout: 30_000 });

  const messageBox = await stubMainMessageBox(app);
  const tabs = (await app.titlebarPage()).locator('#workspaceTabs [role="tab"]');
  await expect(tabs).toHaveCount(2, { timeout: 20_000 });
  // 标签页流水灯亮 = 该目录下确实有非 idle 对话（与宿主的关闭前判定同一份事实）
  await expect(tabs.first()).toHaveClass(/activity-running/, { timeout: 20_000 });

  // 取消（默认返回下标 1）：标签页保留，查询继续跑
  await tabs.first().hover();
  await tabs.first().locator('.ws-tab-close').click();
  await expect.poll(() => messageBox.calls()).toHaveLength(1);
  expect((await messageBox.calls())[0].message).toContain('e2e-ws-busy-a');
  await expect(tabs).toHaveCount(2);
  await expect(chatPage.locator('button[title="终止"]')).toBeEnabled();

  // 确认：标签页关闭，运行中的查询随视图销毁中止
  await messageBox.setResponse(0);
  await tabs.first().hover();
  await tabs.first().locator('.ws-tab-close').click();
  await expect.poll(() => messageBox.calls()).toHaveLength(2);
  await expect(tabs).toHaveCount(1, { timeout: 20_000 });

  await fs.promises.rm(aDir, { recursive: true, force: true }).catch(() => undefined);
  await fs.promises.rm(bDir, { recursive: true, force: true }).catch(() => undefined);
});

// 注：electron 场景测试统一跑 standalone core（产品真实形态；embedded 的单一
// Connection 没有 lost 信号与严格 session 路由，覆盖不了远程工作区的失败链路）。

test('US-36 standalone core：活动项落在连不上的远程工作区，探测标红不受 lost 信号竞态影响', async () => {
  // Standalone（Rust core + daemon + 真实 SSH 传输）：远程工作区的 Connection 会发出
  // lost 信号（建链失败 → fatal）——与可达性探测构成两条到达顺序不定的失败信号。
  // 黑洞端口贴近真实「网络时延后失败」：探测 3 秒超时先标红；SSH 建链 20 秒
  // readyTimeout 后 lost 晚到，不得把状态拉回黄。
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  const aDir = await makeWorkspace({ 'a.md': 'A' }, 'e2e-ws-sa-local');
  const blackhole = net.createServer((socket) => {
    socket.on('error', () => undefined);
  });
  const blackholePort = await new Promise<number>((resolve, reject) => {
    blackhole.listen(0, '127.0.0.1', () => resolve((blackhole.address() as net.AddressInfo).port));
    blackhole.on('error', reject);
  });
  const remoteRef: SerializedWorkspaceRef = {
    scheme: 'ssh',
    path: '/home/e2e/sa-unreachable',
    endpoint: {
      host: '127.0.0.1',
      port: blackholePort,
      user: 'e2e',
      auth: { kind: 'sshPassword', password: 'e2e-not-used' },
    },
  };
  app = await launchApp({
    repoRoot, mockLlm, workspaceDir: aDir,
    openWorkspaces: [aDir, remoteRef],
    activeWorkspace: remoteRef,
  });

  try {
    const titlebarPage = await app.titlebarPage();
    const tabs = titlebarPage.locator('#workspaceTabs [role="tab"]');
    await expect(tabs).toHaveCount(2, { timeout: 30_000 });
    const remoteTab = tabs.filter({ hasText: 'sa-unreachable' });
    await expect(remoteTab).toHaveCount(1);

    // 探测落定（3 秒超时 + 裕量）后不做任何交互：红点出现且黄点消失
    await expect(remoteTab.locator('.ws-tab-dot')).toBeVisible({ timeout: 20_000 });
    await expect(remoteTab.locator('.ws-tab-loading')).toHaveCount(0);

    // 活动项落在远程工作区：占位页切到「无法连接远程主机」（不再停留「正在连接」）
    const placeholder = await app.waitForPage('data:text/html');
    await expect(placeholder.getByText('无法连接远程主机')).toBeVisible({ timeout: 15_000 });
    await expect(placeholder.getByText('正在连接')).toHaveCount(0);

    // SSH 建链超时（20 秒 readyTimeout）后 lost 信号晚到：状态保持红点不被拉回
    await expect(remoteTab.locator('.ws-tab-dot')).toBeVisible({ timeout: 15_000 });
    await expect(placeholder.getByText('无法连接远程主机')).toBeVisible();
  } finally {
    blackhole.close();
  }
});

test('US-36 标红推送不被预加载视图清理失败吞掉：非活动远程探测落定后自动变红', async () => {
  // 精确复刻用户环境的三要素（缺一不复现）：
  // 1. standalone core：多 Connection 下 Client 的 session 路由严格（无「唯一连接」退路）；
  // 2. 非活动的远程工作区：启动时它仍是「可用」→ 被预加载一个对话视图（new-* 临时 key）；
  // 3. 探测失败标红时同步销毁该预加载视图：其会话释放（closeConversation →
  //    conversationClosed）对无归属的 new-* key 抛「No Connection owns session」——
  //    抛错点在标红推送之前，把推送整段吞掉：标签页黄点挂到用户点击才刷新。
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  const aDir = await makeWorkspace({ 'a.md': 'A' }, 'e2e-ws-multi-a');
  const bDir = await makeWorkspace({ 'b.md': 'B' }, 'e2e-ws-multi-b');
  const blackhole = net.createServer((socket) => {
    socket.on('error', () => undefined);
  });
  const blackholePort = await new Promise<number>((resolve, reject) => {
    blackhole.listen(0, '127.0.0.1', () => resolve((blackhole.address() as net.AddressInfo).port));
    blackhole.on('error', reject);
  });
  const remoteRef: SerializedWorkspaceRef = {
    scheme: 'ssh',
    path: '/home/e2e/inactive-unreachable',
    endpoint: {
      host: '127.0.0.1',
      port: blackholePort,
      user: 'e2e',
      auth: { kind: 'sshPassword', password: 'e2e-not-used' },
    },
  };
  app = await launchApp({
    repoRoot, mockLlm, workspaceDir: aDir,
    openWorkspaces: [aDir, bDir, remoteRef],
    activeWorkspace: aDir,
  });

  try {
    const titlebarPage = await app.titlebarPage();
    const tabs = titlebarPage.locator('#workspaceTabs [role="tab"]');
    await expect(tabs).toHaveCount(3, { timeout: 30_000 });
    const remoteTab = tabs.filter({ hasText: 'inactive-unreachable' });
    await expect(remoteTab).toHaveCount(1);

    // 探测落定（3 秒超时 + 裕量）后不做任何交互：黄点必须转红点
    await expect(remoteTab.locator('.ws-tab-dot')).toBeVisible({ timeout: 20_000 });
    await expect(remoteTab.locator('.ws-tab-loading')).toHaveCount(0);

    // 点击不可用标签页：活动项不变回退，聊天区显示占位页（无法连接 + 重新连接按钮）
    await remoteTab.click();
    const placeholder = await app.waitForPage('data:text/html');
    await expect(placeholder.getByText('无法连接远程主机')).toBeVisible();
    await expect(placeholder.locator('#reconnectBtn')).toBeVisible();
  } finally {
    blackhole.close();
  }
});

test('US-35 标签页文本降部完整可见（line-height 不裁 g/p/y）', async () => {
  const repoRoot = process.cwd().replace(/[\/]e2e$/, '');
  const dir = await makeWorkspace({}, 'graphics-playground');
  app = await launchApp({ repoRoot, mockLlm, workspaceDir: dir });

  const titlebarPage = await app.titlebarPage();
  await expect(titlebarPage.locator('.ws-tab-label')).toHaveText('graphics-playground', { timeout: 20_000 });

  // 文本 ink 盒（按字体度量）不得超出 label 的 overflow:hidden 裁剪盒：
  // 回归即行高被压回 1，g / p / y 的降部会伸出行框被裁掉下半截
  const probe = await titlebarPage.evaluate(() => {
    const label = document.querySelector<HTMLElement>('.ws-tab-label')!;
    const range = document.createRange();
    range.selectNodeContents(label);
    const textRect = range.getBoundingClientRect();
    const labelRect = label.getBoundingClientRect();
    return {
      bottom: textRect.bottom - labelRect.bottom,
      top: labelRect.top - textRect.top,
    };
  });
  expect(probe.bottom).toBeLessThanOrEqual(0.5);
  expect(probe.top).toBeLessThanOrEqual(0.5);
});
