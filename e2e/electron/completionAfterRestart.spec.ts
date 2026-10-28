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

  // 第二段：重开同一沙箱——对话行亮绿色完成灯（呼吸一次后常亮）
  app = await launchApp({ repoRoot, mockLlm, workspaceDir, reuseHomeDir: homeDir, agentMode: 'auto' });
  const sidebar = await app.sidebarPage();
  const item = sidebar.locator(SIDEBAR_ITEM).first();
  await expect(item).toHaveCount(1, { timeout: 30_000 });
  await expect(item.locator('.running-bar--completed')).toBeVisible({ timeout: 15_000 });

  // 打开对话即阅读：灯条熄灭，core 把计数清零（conversationLoadRequested 落盘）
  await item.click();
  await expect(item.locator('.running-bar--completed')).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(async () => {
    const current = JSON.parse(await fs.promises.readFile(metaPath, 'utf8')) as { unreadCompletions?: number };
    return current.unreadCompletions ?? 0;
  }, { timeout: 15_000 }).toBe(0);

  await fs.promises.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
});
