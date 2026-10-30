import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from '../helpers/mockLlmServer';
import { launchApp, makeWorkspace, type AppHandle } from '../helpers/electronApp';
import type { MockLlm } from '../helpers/mockLlmServer';
import { CONFIG_DIR_NAME } from '../../src/config/project';

/**
 * 离场完成的绿灯（specs/defects/orphan-completion-unread-light）：会话在宿主不在场时
 * 完成（后台运行 / 应用关闭期间），core 把次数记进 meta.json 的 `unreadCompletions`；
 * 重开后宿主装载对话列表按它补武装「任务完成」绿色呼吸灯，打开对话（装载）即阅读、
 * core 清零。
 *
 * daemon 孤儿路由的计数入口（后台运行的真正链路）由 SSH 车道 remoteTaskSurvival
 * 覆盖；本用例用「关应用 → 手工把计数写进 meta.json → 重开」模拟同一份磁盘事实，
 * 聚焦宿主侧的补武装 / 渲染 / 阅读清除三环——本地车道即可复现，不依赖远端。
 * 沙箱 home 经 `reuseHomeDir` 跨两次启动复用，会话落盘才对得上号。
 */

const SIDEBAR_ITEM = '#list .item[data-session-id]';

let mockLlm: MockLlm;
let app: AppHandle | null = null;

test.afterEach(async () => {
  await app?.close();
  app = null;
  mockLlm?.close();
});

/** 在沙箱 home 里定位唯一会话的 meta.json（工作区清单不是会话，排除） */
async function findConversationMeta(homeDir: string): Promise<string> {
  const conversationsDir = path.join(homeDir, CONFIG_DIR_NAME, 'conversations');
  for (const project of await fs.promises.readdir(conversationsDir)) {
    const projectDir = path.join(conversationsDir, project);
    if (!(await fs.promises.stat(projectDir)).isDirectory()) continue;
    const metaName = (await fs.promises.readdir(projectDir))
      .find((file) => file.endsWith('.meta.json') && file !== 'workspace.meta.json');
    if (metaName) return path.join(projectDir, metaName);
  }
  throw new Error(`沙箱里没有找到会话 meta.json（${conversationsDir}）`);
}

test('US-65 离场完成：重开后对话行亮绿色未读完成灯，打开即阅读清除', async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  const workspaceDir = await makeWorkspace({}, 'e2e-ws-away-done');
  mockLlm = await startMockLlm({ workspaceDir });
  mockLlm.setHandler(() => ({ kind: 'text', text: '离场完成探针回复' }));

  // 第一段：造一个已完成过的对话（消息落盘、未读计数为 0），然后关闭应用
  //（keepHomeOnClose：沙箱要留给第二段重开）
  app = await launchApp({ repoRoot, mockLlm, workspaceDir, agentMode: 'auto', keepHomeOnClose: true });
  const chatPage = await app.chatPage({ workspaceIncludes: 'e2e-ws-away-done', emptyState: true });
  await chatPage.fill('textarea.input-textarea', '离场完成探针');
  await chatPage.press('textarea.input-textarea', 'Enter');
  await expect(chatPage.getByText('离场完成探针回复').first()).toBeVisible({ timeout: 60_000 });
  const homeDir = app.homeDir;
  await app.close();
  app = null;

  // 宿主不在场的完成：把计数写进 meta.json（与 daemon 经控制帧让 core 递增的落点
  // 是同一份磁盘事实；应用已关闭，手工写无并发）
  const metaPath = await findConversationMeta(homeDir);
  const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8')) as {
    sessionId?: string;
    unreadCompletions?: number;
  };
  expect(meta.sessionId, '会话已建档').toBeTruthy();
  meta.unreadCompletions = 1;
  await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');

  // 第二段：重开同一沙箱——对话行亮绿色完成灯（呼吸一次后常亮），标签页同亮
  //（离场完成不适用「完成时未激活才武装标签页」的在线规则：完成时刻用户缺席）
  app = await launchApp({ repoRoot, mockLlm, workspaceDir, reuseHomeDir: homeDir, agentMode: 'auto' });
  const sidebar = await app.sidebarPage();
  const item = sidebar.locator(SIDEBAR_ITEM).first();
  await expect(item).toHaveCount(1, { timeout: 30_000 });
  await expect(item.locator('.running-bar--completed')).toBeVisible({ timeout: 30_000 });
  const titlebar = await app.titlebarPage();
  await expect(titlebar.locator('#workspaceTabs [role="tab"]').first()).toHaveClass(/activity-completed/, { timeout: 30_000 });

  // 打开对话即阅读：灯条熄灭，core 把计数清零（conversationLoadRequested 落盘）
  await item.click();
  await expect(item.locator('.running-bar--completed')).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(async () => {
    const current = JSON.parse(await fs.promises.readFile(metaPath, 'utf8')) as { unreadCompletions?: number };
    return current.unreadCompletions ?? 0;
  }, { timeout: 30_000 }).toBe(0);

  await fs.promises.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
});

test('US-65 离场完成：非当前标签页重开后标签页亮绿色未读完成灯，激活即已读', async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  // 双工作区：B 里离场完成的对话，重开后 B 不是活动标签页（specs/defects/
  // inactive-tab-completion-light-missing——列表只装载活动工作区，B 的补武装
  // 永不运行，标签页绿灯不亮）
  const aDir = await makeWorkspace({}, 'e2e-ws-away-idle');
  const bDir = await makeWorkspace({}, 'e2e-ws-away-done');
  mockLlm = await startMockLlm({ workspaceDir: bDir });
  mockLlm.setHandler(() => ({ kind: 'text', text: '离场完成探针回复' }));

  // 第一段：在 B（活动）里造一个已完成过的对话，关闭应用（沙箱留给第二段）
  app = await launchApp({
    repoRoot, mockLlm, workspaceDir: bDir,
    openWorkspaces: [aDir, bDir],
    activeWorkspace: bDir,
    agentMode: 'auto', keepHomeOnClose: true,
  });
  const chatPage = await app.chatPage({ workspaceIncludes: 'e2e-ws-away-done', emptyState: true });
  await chatPage.fill('textarea.input-textarea', '离场完成探针');
  await chatPage.press('textarea.input-textarea', 'Enter');
  await expect(chatPage.getByText('离场完成探针回复').first()).toBeVisible({ timeout: 60_000 });
  const homeDir = app.homeDir;
  await app.close();
  app = null;

  // 宿主不在场的完成：手工把计数写进 meta.json（与 completionAfterRestart 首用例
  // 同一份磁盘事实；应用已关闭，手工写无并发）
  const metaPath = await findConversationMeta(homeDir);
  const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8')) as {
    sessionId?: string;
    unreadCompletions?: number;
  };
  expect(meta.sessionId, '会话已建档').toBeTruthy();
  meta.unreadCompletions = 1;
  await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');

  // 第二段：重开同一沙箱，活动项是 A——B 以非当前标签页恢复。B 的标签页要**不点开**
  // 就亮绿色未读完成灯（列表在其建链就绪时装载、补武装沿既有出口运行、归属从到达
  // 的那份列表解析）
  app = await launchApp({
    repoRoot, mockLlm, workspaceDir: bDir,
    openWorkspaces: [aDir, bDir],
    activeWorkspace: aDir,
    reuseHomeDir: homeDir, agentMode: 'auto',
  });
  const tabs = (await app.titlebarPage()).locator('#workspaceTabs [role="tab"]');
  await expect(tabs).toHaveCount(2, { timeout: 30_000 });
  const tabB = tabs.nth(1);
  await expect(tabB).not.toHaveClass(/active/, { timeout: 10_000 });
  await expect(tabB).toHaveClass(/activity-completed/, { timeout: 60_000 });

  // 激活 B 即已读：标签页绿灯摘除（既有规则），对话行绿灯亮（补武装的行级事实）
  await tabB.click();
  await expect(tabB).not.toHaveClass(/activity-completed/, { timeout: 30_000 });
  const sidebar = await app.sidebarPage();
  const item = sidebar.locator(SIDEBAR_ITEM).first();
  await expect(item).toHaveCount(1, { timeout: 30_000 });
  await expect(item.locator('.running-bar--completed')).toBeVisible({ timeout: 30_000 });

  // 打开对话即阅读：行灯熄灭，盘上计数清零
  await item.click();
  await expect(item.locator('.running-bar--completed')).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(async () => {
    const current = JSON.parse(await fs.promises.readFile(metaPath, 'utf8')) as { unreadCompletions?: number };
    return current.unreadCompletions ?? 0;
  }, { timeout: 30_000 }).toBe(0);

  await fs.promises.rm(aDir, { recursive: true, force: true }).catch(() => undefined);
  await fs.promises.rm(bDir, { recursive: true, force: true }).catch(() => undefined);
});

test('US-65 已读之后旧计数到达不复亮标签页绿灯', async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  // 同一份离场完成场景，追加「已读之后的在途列表快照」：打开对话即阅读、core 清零要
  // 落盘，清零与下一次读盘之间存在在途窗口，窗口内到达的列表仍带旧计数
  //（specs/defects/completion-tab-light-relights-after-read）
  const aDir = await makeWorkspace({}, 'e2e-ws-read-idle');
  const bDir = await makeWorkspace({}, 'e2e-ws-read-done');
  mockLlm = await startMockLlm({ workspaceDir: bDir });
  mockLlm.setHandler(() => ({ kind: 'text', text: '离场完成探针回复' }));

  // 第一段：在 B（活动）里造一个已完成过的对话，关闭应用（沙箱留给第二段）
  app = await launchApp({
    repoRoot, mockLlm, workspaceDir: bDir,
    openWorkspaces: [aDir, bDir],
    activeWorkspace: bDir,
    agentMode: 'auto', keepHomeOnClose: true,
  });
  const chatPage = await app.chatPage({ workspaceIncludes: 'e2e-ws-read-done', emptyState: true });
  await chatPage.fill('textarea.input-textarea', '离场完成探针');
  await chatPage.press('textarea.input-textarea', 'Enter');
  await expect(chatPage.getByText('离场完成探针回复').first()).toBeVisible({ timeout: 60_000 });
  const homeDir = app.homeDir;
  await app.close();
  app = null;

  const metaPath = await findConversationMeta(homeDir);
  const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8')) as {
    sessionId?: string;
    unreadCompletions?: number;
  };
  expect(meta.sessionId, '会话已建档').toBeTruthy();
  meta.unreadCompletions = 1;
  await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');

  // 第二段：重开同一沙箱，活动项是 A——B 非当前标签页亮绿灯
  app = await launchApp({
    repoRoot, mockLlm, workspaceDir: bDir,
    openWorkspaces: [aDir, bDir],
    activeWorkspace: aDir,
    reuseHomeDir: homeDir, agentMode: 'auto',
  });
  const tabs = (await app.titlebarPage()).locator('#workspaceTabs [role="tab"]');
  await expect(tabs).toHaveCount(2, { timeout: 30_000 });
  const tabB = tabs.nth(1);
  await expect(tabB).not.toHaveClass(/active/, { timeout: 10_000 });
  await expect(tabB).toHaveClass(/activity-completed/, { timeout: 60_000 });

  // 激活 B（标签页绿灯灭）→ 打开该对话完成阅读（行灯灭、core 清零落盘）
  await tabB.click();
  await expect(tabB).not.toHaveClass(/activity-completed/, { timeout: 30_000 });
  const sidebar = await app.sidebarPage();
  const item = sidebar.locator(SIDEBAR_ITEM).first();
  await expect(item).toHaveCount(1, { timeout: 30_000 });
  await expect(item.locator('.running-bar--completed')).toBeVisible({ timeout: 30_000 });
  await item.click();
  await expect(item.locator('.running-bar--completed')).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(async () => {
    const current = JSON.parse(await fs.promises.readFile(metaPath, 'utf8')) as { unreadCompletions?: number };
    return current.unreadCompletions ?? 0;
  }, { timeout: 30_000 }).toBe(0);

  // 模拟「清零落盘前的在途列表快照」：把旧计数写回盘上，再改一次标题驱动列表重读
  //（rename → conversationListChanged → 宿主重新装载列表）。已读的会话不得复亮：
  // 标签页仍激活，绿灯一旦挂回就没有熄灯入口
  const stale = JSON.parse(await fs.promises.readFile(metaPath, 'utf8')) as {
    unreadCompletions?: number;
    title?: string;
  };
  stale.unreadCompletions = 1;
  await fs.promises.writeFile(metaPath, JSON.stringify(stale, null, 2), 'utf8');
  await item.hover();
  await item.locator('[data-action="rename"]').click();
  const renameInput = sidebar.locator('.rename-input');
  await expect(renameInput).toBeVisible();
  await renameInput.fill('已读之后不应复亮');
  await renameInput.press('Enter');
  await expect(item).toContainText('已读之后不应复亮', { timeout: 30_000 });

  // 给补武装 / 补挂重试留出跑完的时间，再断言两边都没有复亮
  await new Promise((r) => setTimeout(r, 3_000));
  await expect(tabB).not.toHaveClass(/activity-completed/, { timeout: 10_000 });
  await expect(tabB).toHaveClass(/active/, { timeout: 10_000 });
  await expect(item.locator('.running-bar--completed')).toHaveCount(0, { timeout: 10_000 });

  await fs.promises.rm(aDir, { recursive: true, force: true }).catch(() => undefined);
  await fs.promises.rm(bDir, { recursive: true, force: true }).catch(() => undefined);
});
