import { test, expect } from '@playwright/test';
import { openWebviewView } from '../helpers/webviewHarness';
import type { WebviewHandle } from '../helpers/webviewHarness';

/**
 * US-5 输入历史与斜杠命令补全 / US-8 功能开关菜单 / US-9 上下文用量与手动压缩
 */

let handle: WebviewHandle;

test.beforeEach(async ({ browser }) => {
  handle = await openWebviewView(browser, process.cwd().replace(/[\\/]e2e$/, ''));
});

test.afterEach(async () => {
  await handle.close();
});

test('US-8 功能菜单：切换询问模式 / 思考强度 / 提示词模式', async () => {
  const { page, host } = handle;
  await page.locator('button[title="功能开关"]').click();
  const menu = page.locator('ul.agent-mode-menu');
  await expect(menu).toBeVisible();

  // 菜单项齐全（US-8 验收 1）
  await expect(menu.getByText('设置', { exact: true })).toBeVisible();
  await expect(menu.getByText('Spin 设计')).toBeVisible();
  await expect(menu.getByText('联网搜索')).toBeVisible();
  await expect(menu.getByText('模型', { exact: true })).toBeVisible();
  await expect(menu.getByText('提示词模式')).toBeVisible();
  await expect(menu.getByText('询问模式')).toBeVisible();
  await expect(menu.getByText('思考强度')).toBeVisible();

  // 询问模式：总是（manual）。antd 菜单项整项 disabled（交互交给内部控件），force 点击
  await menu.getByRole('button', { name: '总是', exact: true }).click({ force: true });
  const agentMode = await host.waitForSentWhere('setAgentMode', (m) => m.mode === 'manual');
  expect(agentMode.sessionId).toBeTruthy();

  // 思考强度：最高（max）
  await menu.getByRole('button', { name: '最高', exact: true }).click({ force: true });
  const thinking = await host.waitForSentWhere('setThinkingMode', (m) => m.mode === 'max');
  expect(thinking.mode).toBe('max');

  // 提示词模式：极简（minimal）
  await menu.getByRole('button', { name: '极简', exact: true }).click({ force: true });
  const promptMode = await host.waitForSentWhere('setPromptMode', (m) => m.mode === 'minimal');
  expect(promptMode.mode).toBe('minimal');
});

test('US-8 模型三级子菜单切换模型（setModel 携带 provider + model）', async () => {
  const { page, host } = handle;
  await page.locator('button[title="功能开关"]').click();
  const menu = page.locator('ul.agent-mode-menu');

  // 展开模型分组（宽视口下为飞出子菜单）
  await menu.getByText('模型', { exact: true }).click();
  const providerItem = page.getByText('mock-provider', { exact: true }).last();
  await expect(providerItem).toBeVisible({ timeout: 10_000 });
  await providerItem.hover();
  const modelItem = page.getByText('mock-model-pro', { exact: true }).last();
  await expect(modelItem).toBeVisible();
  await modelItem.click({ force: true });

  const setModel = await host.waitForSentWhere('setModel', (m) => m.model === 'mock-model-pro');
  expect(setModel.provider).toBe('mock-provider');
});

test('US-8 联网搜索开关切换', async () => {
  const { page, host } = handle;
  await page.locator('button[title="功能开关"]').click();
  const menu = page.locator('ul.agent-mode-menu');
  await expect(menu).toBeVisible();

  await menu.getByText('联网搜索').click({ force: true });
  const toggled = await host.waitForSent('setWebSearch');
  expect(typeof toggled.webSearch).toBe('boolean');
  expect(toggled.sessionId).toBeTruthy();
});

test('US-5 斜杠命令补全：输入 / 弹出技能列表并选中', async () => {
  const { page } = handle;
  const input = page.locator('textarea.input-textarea');
  await input.fill('/');
  // 斜杠弹窗出现在输入框上方，列出技能
  await expect(page.getByText('演示技能：做点什么')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Create a git commit from staged changes')).toBeVisible();

  // 键盘选择：↑/↓ 移动 + Enter 选中
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(input).toHaveValue(/^\/\S+\s/);
});

test('US-5 输入历史：空输入框按 ↑ 翻阅已发送消息', async () => {
  const { page, host } = handle;
  await host.setTurn({ text: '回复。', chunkDelayMs: 10 });

  await page.fill('textarea.input-textarea', '第一条历史');
  await page.press('textarea.input-textarea', 'Enter');
  await host.waitForSent('sendMessage');
  await expect(page.getByText('回复。').first()).toBeVisible({ timeout: 15_000 });

  await page.fill('textarea.input-textarea', '第二条历史');
  await page.press('textarea.input-textarea', 'Enter');
  await expect(
    (await host.sentAll()).filter((m) => m.type === 'sendMessage'),
  ).toHaveLength(2);

  // 清空后按 ↑：先回到第二条，再按一次回到第一条；↓ 退到底恢复草稿
  const input = page.locator('textarea.input-textarea');
  await input.fill('');
  await input.press('ArrowUp');
  await expect(input).toHaveValue('第二条历史');
  await input.press('ArrowUp');
  await expect(input).toHaveValue('第一条历史');
});

test('US-9 上下文用量条显示并可点击触发压缩', async () => {
  const { page, host } = handle;
  // 压缩请求携带 sessionId：先等会话建立（启动 500ms 延迟创建）
  await host.waitForSent('startNewConversation', 15_000);
  // 用量条外层是 span[title]，内层才是可点按钮
  const usage = page.locator('[title="点击压缩"] button');
  await expect(usage).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[title="点击压缩"]')).toContainText('(K)');
  await usage.click();
  await host.waitForSent('requestCompress');
});
