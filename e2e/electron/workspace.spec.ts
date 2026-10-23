import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { startMockLlm } from '../helpers/mockLlmServer';
import { launchApp, makeWorkspace, waitForMessageBox, clickMessageBoxButton, messageBoxText } from '../helpers/electronApp';
import type { AppHandle } from '../helpers/electronApp';
import type { Page } from '@playwright/test';
import type { MockLlm } from '../helpers/mockLlmServer';
import type { SerializedWorkspaceRef } from '../../src/host/workspaceState';
import { CONFIG_DIR_NAME } from '../../src/config/project';

/**
 * US-30 完整模式与悬浮窗切换 / US-35 多工作区标签页（打开集合恢复 / 切换 / 关闭）
 * / US-36 远程工作区启动探测失败自动标红 / US-53 标签页快捷键（相邻切换 / 环绕 / 单标签不动作）
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

  const conversationsRoot = path.join(app.homeDir, CONFIG_DIR_NAME, 'conversations');
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

  const tabs = (await app.titlebarPage()).locator('#workspaceTabs [role="tab"]');
  await expect(tabs).toHaveCount(2, { timeout: 20_000 });
  // 标签页流水灯亮 = 该目录下确实有非 idle 对话（与宿主的关闭前判定同一份事实）
  await expect(tabs.first()).toHaveClass(/activity-running/, { timeout: 20_000 });

  // 取消（自绘确认框按钮 1）：标签页保留，查询继续跑
  await tabs.first().hover();
  await tabs.first().locator('.ws-tab-close').click();
  const box = await waitForMessageBox(app);
  expect((await messageBoxText(box)).message).toContain('e2e-ws-busy-a');
  await clickMessageBoxButton(box, 1);
  await expect(tabs).toHaveCount(2);
  await expect(chatPage.locator('button[title="终止"]')).toBeEnabled();

  // 确认（按钮 0「仍然关闭」）：标签页关闭，运行中的查询随视图销毁中止
  await tabs.first().hover();
  await tabs.first().locator('.ws-tab-close').click();
  const box2 = await waitForMessageBox(app);
  await clickMessageBoxButton(box2, 0);
  await expect(tabs).toHaveCount(1, { timeout: 20_000 });

  await fs.promises.rm(aDir, { recursive: true, force: true }).catch(() => undefined);
  await fs.promises.rm(bDir, { recursive: true, force: true }).catch(() => undefined);
});

// 注：electron 场景测试跑 standalone core（产品真实形态：多 Connection / daemon /
// SSH 链路，含远程工作区的失败链路）。

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

/** 等待助手：注入的组合键走 invokeMenuAction 的 250ms 窗口去重，连按之间必须隔开 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 向指定 URL 特征的 webContents 注入组合键（CDP 键盘不经过主进程 before-input-event，
 *  沿偏好设置录制用例的既有口径用 sendInputEvent 走同一输入管线；specs/021 的标签快捷键经菜单 accelerator
 *  兜底路径触发，挂接在标题栏 / 侧栏 / 聊天视图三处） */
function pressKeysOn(appHandle: AppHandle, urlPart: string, keyCode: string, modifiers: string[]): void {
  void appHandle.evaluateInMain(
    `(function(){try{const e=process.mainModule.require('electron');`
    + `e.webContents.getAllWebContents().forEach(wc=>{`
    + `if((wc.getURL()||'').includes('${urlPart}'))`
    + `wc.sendInputEvent({type:'keyDown',modifiers:${JSON.stringify(modifiers)},keyCode:'${keyCode}'});});`
    + `return true;}catch(err){return 'ERR '+err.message;}})()`,
  );
}

test('US-53 标签页快捷键：下一/上一按标签页顺序切换并环绕，重启用自定义组合', async () => {
  const repoRoot = process.cwd().replace(/[\/]e2e$/, '');
  const aDir = await makeWorkspace({}, 'e2e-ws-key-a');
  const bDir = await makeWorkspace({}, 'e2e-ws-key-b');
  const cDir = await makeWorkspace({}, 'e2e-ws-key-c');
  app = await launchApp({
    repoRoot, mockLlm, workspaceDir: aDir,
    openWorkspaces: [aDir, bDir, cDir],
    activeWorkspace: aDir,
  });

  const tabs = (await app.titlebarPage()).locator('#workspaceTabs [role="tab"]');
  await expect(tabs).toHaveCount(3, { timeout: 20_000 });
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');

  // 默认组合启动（状态文件无标签快捷键字段，AC-6）：Ctrl+Tab 经标题栏视图兜底
  // 连按三次 A→B→C→A（末项环绕回首项，AC-1）
  pressKeysOn(app, 'dist/titlebar', 'Tab', ['ctrl']);
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
  await sleep(300);
  pressKeysOn(app, 'dist/titlebar', 'Tab', ['ctrl']);
  await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
  await sleep(300);
  pressKeysOn(app, 'dist/titlebar', 'Tab', ['ctrl']);
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });

  // Ctrl+Shift+Tab 经侧栏视图兜底：首项向前环绕到末项（AC-2，AC-5 焦点换视图同效）
  // 菜单条目与快捷键同源（AC-12 的点击半边）：展开单一菜单点「下一标签」执行同一动作
  await sleep(300);
  await (await app.titlebarPage()).locator('#menubar .menu-btn').first().click();
  const menuPage = await (async (): Promise<Page> => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      for (const p of app!.context.pages()) {
        if (!p.url().startsWith('data:')) continue;
        try {
          if (await p.evaluate(() => document.querySelector('.item[data-id="main.nextWorkspaceTab"]') !== null)) return p;
        } catch { /* 页面正在初始化 */ }
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error('自绘菜单视图未出现');
  })();
  await menuPage.locator('.item[data-id="main.nextWorkspaceTab"]').click();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });

  // Ctrl+Shift+Tab 经侧栏视图兜底（AC-5 焦点换视图同效）：B→A
  await sleep(300);
  pressKeysOn(app, 'dist/sidebar', 'Tab', ['ctrl', 'shift']);
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });

  // 首项向前环绕到末项（AC-2）：A→C
  await sleep(300);
  pressKeysOn(app, 'dist/titlebar', 'Tab', ['ctrl', 'shift']);
  await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });

  // 切换走既有激活链（AC-4）：再按上一标签 C→B，聊天区切到 B 的视图
  const betaChat = await app.chatPage({ workspaceIncludes: 'e2e-ws-key-b' });
  await sleep(300);
  pressKeysOn(app, 'dist/titlebar', 'Tab', ['ctrl', 'shift']);
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
  await expect(betaChat.locator('textarea.input-textarea')).toBeEnabled({ timeout: 30_000 });

  await app.close();
  app = null;
  await fs.promises.rm(aDir, { recursive: true, force: true }).catch(() => undefined);
  await fs.promises.rm(bDir, { recursive: true, force: true }).catch(() => undefined);
  await fs.promises.rm(cDir, { recursive: true, force: true }).catch(() => undefined);
  // 重新启动（AC-8 的读回半边）：状态文件里的自定义组合生效、旧组合失效
  const a2 = await makeWorkspace({}, 'e2e-ws-key-a');
  const b2 = await makeWorkspace({}, 'e2e-ws-key-b');
  const c2 = await makeWorkspace({}, 'e2e-ws-key-c');
  app = await launchApp({
    repoRoot, mockLlm, workspaceDir: a2,
    openWorkspaces: [a2, b2, c2],
    activeWorkspace: a2,
    stateOverrides: { nextTabShortcut: 'Ctrl+J' },
  });
  const tabs2 = (await app.titlebarPage()).locator('#workspaceTabs [role="tab"]');
  await expect(tabs2).toHaveCount(3, { timeout: 20_000 });

  pressKeysOn(app, 'dist/titlebar', 'J', ['ctrl']);
  await expect(tabs2.nth(1)).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
  // 旧默认组合不再触发：连按 Ctrl+Tab 活动项仍在 B
  await sleep(300);
  pressKeysOn(app, 'dist/titlebar', 'Tab', ['ctrl']);
  await (await app.titlebarPage()).waitForTimeout(600);
  await expect(tabs2.nth(1)).toHaveAttribute('aria-selected', 'true');

  await fs.promises.rm(a2, { recursive: true, force: true }).catch(() => undefined);
  await fs.promises.rm(b2, { recursive: true, force: true }).catch(() => undefined);
  await fs.promises.rm(c2, { recursive: true, force: true }).catch(() => undefined);
});

test('US-53 标签页快捷键：单标签时无相邻项，组合键不动作', async () => {
  app = await launchApp({ repoRoot: process.cwd().replace(/[\/]e2e$/, ''), mockLlm, workspaceDir });
  const tabs = (await app.titlebarPage()).locator('#workspaceTabs [role="tab"]');
  await expect(tabs).toHaveCount(1, { timeout: 20_000 });
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');

  pressKeysOn(app, 'dist/titlebar', 'Tab', ['ctrl']);
  await sleep(300);
  pressKeysOn(app, 'dist/titlebar', 'Tab', ['ctrl', 'shift']);
  await sleep(600);
  await expect(tabs).toHaveCount(1);
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  await expect((await app.chatPage()).locator('textarea.input-textarea')).toBeEnabled({ timeout: 30_000 });
});

test('US-53 标签页快捷键：浮窗模式不动作，切回完整模式活动项不变', async () => {
  const repoRoot = process.cwd().replace(/[\/]e2e$/, '');
  const aDir = await makeWorkspace({}, 'e2e-ws-float-a');
  const bDir = await makeWorkspace({}, 'e2e-ws-float-b');
  app = await launchApp({
    repoRoot, mockLlm, workspaceDir: aDir,
    openWorkspaces: [aDir, bDir],
    activeWorkspace: aDir,
  });
  const titlebar = await app.titlebarPage();
  const tabs = titlebar.locator('#workspaceTabs [role="tab"]');
  await expect(tabs).toHaveCount(2, { timeout: 20_000 });

  // 完整模式下先切到 B 作为可观察起点
  pressKeysOn(app, 'dist/titlebar', 'Tab', ['ctrl']);
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });

  // 切到浮窗（侧栏移除、webview 顶栏接管对话列表，US-30 同款信号）：标签页区隐藏，
  // 此时 Ctrl+Tab 不动作（US-53 验收 1 的浮窗口径，docs/hosts/electron-multi-workspace.md 第 5 节）
  await titlebar.locator('#btnMode').click();
  const chatPage = await app.chatPage();
  await expect(chatPage.locator('button[title="对话历史"]')).toBeVisible({ timeout: 15_000 });
  await sleep(300);
  pressKeysOn(app, 'dist/webview', 'Tab', ['ctrl']);
  await sleep(600);

  // 切回完整模式：活动项仍是 B（浮窗期间的按键没有切换）
  await titlebar.locator('#btnMode').click();
  await expect(tabs).toHaveCount(2, { timeout: 20_000 });
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });

  await fs.promises.rm(aDir, { recursive: true, force: true }).catch(() => undefined);
  await fs.promises.rm(bDir, { recursive: true, force: true }).catch(() => undefined);
});
