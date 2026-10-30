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
  // 二 / 三级弹层都带 1px 主题边框 + 6px 圆角（与一级面板同形态，见 index.css 的
  // .ant-dropdown-menu-submenu-popup .ant-dropdown-menu-sub 规则）
  const popups = page.locator('.model-list-submenu:visible');
  await expect(popups).toHaveCount(2);
  for (const popup of await popups.all()) {
    const list = popup.locator('ul.ant-dropdown-menu');
    await expect(list).toHaveCSS('border-top-width', '1px');
    await expect(list).toHaveCSS('border-top-style', 'solid');
    await expect(list).toHaveCSS('border-top-left-radius', '6px');
  }
  // 菜单滚动条：面板底色必须盖住滚动条槽位（background-clip: border-box，否则槽位
  // 透出面板背后的内容），且 thumb 不透明（rgba 会带 alpha）——见 index.css
  const scrollers = [menu, ...(await popups.all()).map((p) => p.locator('ul.ant-dropdown-menu'))];
  for (const scroller of scrollers) {
    await expect(scroller).toHaveCSS('background-clip', 'border-box');
    expect(await scroller.evaluate((el) => getComputedStyle(el).scrollbarColor))
      .toMatch(/^rgb\(.+\) rgba\(0, 0, 0, 0\)$/);
  }
  await modelItem.click({ force: true });

  const setModel = await host.waitForSentWhere('setModel', (m) => m.model === 'mock-model-pro');
  expect(setModel.provider).toBe('mock-provider');
});

test('US-8 模型列表展开时当前选中项滚动到列表中间', async () => {
  const { page, host } = handle;
  // 造一个长列表，当前模型（mock-model）放在中间
  const models = Array.from({ length: 40 }, (_, i) => `model-${String(i).padStart(2, '0')}`);
  models[20] = 'mock-model';
  await host.send({ type: 'setModels', providers: [{ key: 'mock-provider', models }], activeProvider: 'mock-provider' });

  await page.locator('button[title="功能开关"]').click();
  const menu = page.locator('ul.agent-mode-menu');
  await menu.getByText('模型', { exact: true }).click();
  // 在可见的二级弹层里找 provider 行（页面别处还有隐藏测量层渲染的 provider 名）
  const providerItem = page.locator('.model-list-submenu:visible').first().getByText('mock-provider', { exact: true }).first();
  await expect(providerItem).toBeVisible({ timeout: 10_000 });
  await providerItem.hover();
  await expect(page.locator('.model-list-submenu [data-selected-model="true"]')).toBeVisible({ timeout: 10_000 });

  // 选中项中心与滚动容器中心的偏移接近 0（滚动到中间）
  await expect.poll(async () => page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('.model-list-submenu [data-selected-model="true"]'));
    for (const label of labels) {
      const list = label.closest('.ant-dropdown-menu');
      if (!list || list.clientHeight === 0) continue;
      const lr = list.getBoundingClientRect();
      const ir = label.getBoundingClientRect();
      return Math.abs((ir.top + ir.height / 2) - (lr.top + lr.height / 2));
    }
    return 9999;
  })).toBeLessThan(8);
});

test('US-8 右侧放不下但能左翻时仍用弹出子菜单（不内联）', async () => {
  const { page } = handle;
  // 700px：主面板右侧放不下二级弹层，但弹层能翻到主面板左侧完整显示 → 不内联
  await page.setViewportSize({ width: 700, height: 800 });
  await page.locator('button[title="功能开关"]').click();
  const menu = page.locator('ul.agent-mode-menu');
  await expect(menu).toBeVisible();

  await menu.getByText('模型', { exact: true }).click({ force: true });
  // provider 出现在飞出弹层里（不在菜单面板内）
  const providerPopup = page.locator('.model-list-submenu:visible').first();
  await expect(providerPopup).toBeVisible();
  await expect(providerPopup.getByText('mock-provider', { exact: true }).first()).toBeVisible();
});

test('US-8 极窄视口下模型子菜单内联展开，避免弹层越出左缘', async () => {
  const { page } = handle;
  // 360px：二级弹层左翻后仍越出 webview 左缘 → 切内联展开
  await page.setViewportSize({ width: 360, height: 800 });
  await page.locator('button[title="功能开关"]').click();
  const menu = page.locator('ul.agent-mode-menu');
  await expect(menu).toBeVisible();

  // 点击「模型」分组：provider 直接出现在菜单面板内，没有飞出弹层
  await menu.getByText('模型', { exact: true }).click({ force: true });
  // HoverScrollText 渲染了省略号 + 两份滚动副本，取第一个（可见的省略号）
  await expect(menu.getByText('mock-provider', { exact: true }).first()).toBeVisible();
  // 内联展开不挂飞出弹层
  expect(await page.locator('.model-list-submenu').count()).toBe(0);

  // 展开 provider：模型行也在面板内（不飞出弹层）
  await menu.getByText('mock-provider', { exact: true }).first().click({ force: true });
  await expect(menu.getByText('mock-model-pro', { exact: true })).toHaveCount(3);
  expect(await page.locator('.model-list-submenu').count()).toBe(0);

  // 内联态「模型」标题与其它一级项左对齐（历史回归：标题行内边距小一号，整体偏左 6px）
  const modelLabel = await menu.getByText('模型', { exact: true }).first().boundingBox();
  const settingsLabel = await menu.getByText('设置', { exact: true }).first().boundingBox();
  expect(Math.abs(modelLabel!.x - settingsLabel!.x)).toBeLessThan(1);
});

test('US-8 极窄视口下 MCP 分组保持飞出弹层（不随模型分组切内联）', async () => {
  const { page, host } = handle;
  await host.setMcpState({ servers: ['fs-tools'] });
  await host.waitForSent('startNewConversation', 15_000);
  await host.send({
    type: 'setMcpServers', sessionId: null,
    servers: [
      {
        name: 'fs-tools', type: 'local', command: ['fake-mcp'], environment: {}, url: '', headers: {},
        enabled: true, running: true, toolCount: 0, error: null,
      },
    ],
  });
  // 360px：内联判定命中（模型分组切内联），但 MCP 恒为飞出弹层
  await page.setViewportSize({ width: 360, height: 800 });
  await page.locator('button[title="功能开关"]').click();
  const menu = page.locator('ul.agent-mode-menu');
  await expect(menu).toBeVisible();

  await menu.getByText('MCP', { exact: true }).click({ force: true });
  // 服务器行可见，但不在主菜单面板里（主面板内出现即为内联展开）
  await expect(page.getByText('fs-tools', { exact: true }).last()).toBeVisible({ timeout: 10_000 });
  expect(await menu.getByText('fs-tools', { exact: true }).count()).toBe(0);
  // MCP 的二级弹层同样带边框：它没挂 popupClassName=model-list-submenu，边框规则
  // 必须按 antd 的弹层类写（见 index.css）
  const mcpPopup = page.locator('.ant-dropdown-menu-submenu-popup:visible');
  await expect(mcpPopup).toHaveCount(1);
  await expect(mcpPopup.locator('ul.ant-dropdown-menu')).toHaveCSS('border-top-width', '1px');
});

test('US-8 主面板宽 + 服务商名长：二级弹层两侧都放不下 → 内联（不被右缘裁掉）', async () => {
  const { page, host } = handle;
  // 会话建立后把当前模型设成长名字，撑宽主面板；服务商名也换成较长的
  const sessionId = (await host.waitForSent('startNewConversation', 15_000)).sessionId;
  await page.evaluate(({ sessionId }) => {
    window.postMessage({
      type: 'setModels',
      providers: [
        { key: 'opencode.ai', models: ['deepseek-flash', 'deepseek-chat'] },
        { key: 'api.deepseek.com', models: ['deepseek-reasoner'] },
        { key: 'open.bigmodel.cn', models: ['glm-4-plus'] },
      ],
      activeProvider: 'opencode.ai',
    }, '*');
    window.postMessage({
      type: 'setModel',
      model: 'deepseek-flash-2025-extremely-long-model-name',
      provider: 'opencode.ai',
      sessionId,
    }, '*');
  }, { sessionId });
  await page.waitForTimeout(300);

  // 515px：主面板右缘到右缘放不下二级弹层，左翻又越出左缘 → 内联，而不是被右缘裁掉
  await page.setViewportSize({ width: 515, height: 800 });
  await page.waitForTimeout(150);
  await page.locator('button[title="功能开关"]').click();
  const menu = page.locator('ul.agent-mode-menu');
  await menu.getByText('模型', { exact: true }).click({ force: true });
  await expect(menu.getByText('opencode.ai', { exact: true }).first()).toBeVisible();
  expect(await page.locator('.model-list-submenu').count()).toBe(0);
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

test('US-9 待压缩时用量文本显示准备压缩且不可重复点击', async () => {
  const { page, host } = handle;
  const started = await host.waitForSent('startNewConversation', 15_000);
  const sessionId = started.sessionId as string;
  // 启动期会补拉一次运行时快照（空快照会把注入的 pending 覆盖掉）：等它先落定
  await host.waitForSent('requestSessionRuntimeStates', 15_000);
  // 先等用量条渲染（上下文上限到达），再注入待压缩快照
  await expect(page.locator('[title="点击压缩"] button')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(300);
  const currentSessionId = await page.evaluate(() => (window as any).__currentSessionId);
  expect(currentSessionId).toBe(sessionId);

  // 非空闲 + 已登记待压缩：文本换成「准备压缩」，不再渲染可点按钮
  await host.send({
    type: 'sessionRuntimeStates',
    states: [{
      sessionId, idle: false, waiting: false,
      queryRunning: true, compacting: false, pendingCompact: true,
      backgroundRunning: false, subAgentRunning: false,
    }],
  });
  const pending = page.locator('[title="准备压缩"] > span').first();
  await expect(pending).toHaveText('准备压缩', { timeout: 10_000 });
  await expect(page.locator('[title="点击压缩"] button')).toHaveCount(0);

  // 点击文本不产生重复压缩请求
  const before = (await host.sentAll()).filter((m) => m.type === 'requestCompress').length;
  await pending.click();
  await page.waitForTimeout(200);
  const after = (await host.sentAll()).filter((m) => m.type === 'requestCompress').length;
  expect(after).toBe(before);

  // 实际开始压缩：用量文本还原为 used/total (K)
  await host.send({
    type: 'sessionRuntimeStates',
    states: [{
      sessionId, idle: false, waiting: false,
      queryRunning: false, compacting: true, pendingCompact: false,
      backgroundRunning: false, subAgentRunning: false,
    }],
  });
  await expect(page.locator('[title="点击压缩"]')).toContainText('(K)', { timeout: 10_000 });
});

test('US-9 压缩完成后用量条按新值刷新，不被随后的整批替换归零', async () => {
  const { page, host } = handle;
  const started = await host.waitForSent('startNewConversation', 15_000);
  const sessionId = started.sessionId as string;
  await expect(page.locator('[title="点击压缩"] button')).toBeVisible({ timeout: 10_000 });

  // wire 顺序与真实压缩一致（compaction.md 第 3.1 节）：compactEnd(complete，core 重算的
  // 压缩后占用) 先到，messagesReplaced（整批替换消息）后到。
  // 30720/1024 = 30K，分母 128000/1024 = 125K。
  // 回归 specs/defects/compact-context-facts-stale-across-views：修复前 messagesReplaced
  // 会把用量归零，直到下一轮真实 usage 才恢复（US-9 验收 2 被推翻）。
  await host.send({ type: 'compressProgress', sessionId, status: 'complete', postCompactTokenCount: 30_720 });
  await host.send({ type: 'messagesReplaced', sessionId, messages: [{ role: 'user', content: '压缩后的历史' }] });
  await expect(page.getByText('压缩后的历史')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[title="点击压缩"]')).toContainText('30/125', { timeout: 10_000 });
});

test('US-29 MCP 分组逐服务器开关，切换上报 setMcpEnabled 并刷新状态', async () => {
  const { page, host } = handle;
  await host.setMcpState({ servers: ['fs-tools', 'git-tools'], sessionEnabled: ['fs-tools'] });
  // webview 只在启动/激活时请求 MCP 列表，这里直接推送当前会话的服务器状态
  await host.waitForSent('startNewConversation', 15_000);
  await host.send({
    type: 'setMcpServers', sessionId: null,
    servers: [
      {
        name: 'fs-tools', type: 'local', command: ['fake-mcp'], environment: {}, url: '', headers: {},
        enabled: true, running: true, toolCount: 0, error: null,
      },
      {
        name: 'git-tools', type: 'local', command: ['fake-mcp'], environment: {}, url: '', headers: {},
        enabled: false, running: false, toolCount: 0, error: null,
      },
    ],
  });

  await page.locator('button[title="功能开关"]').click();
  const menu = page.locator('ul.agent-mode-menu');
  await expect(menu.getByText('MCP', { exact: true })).toBeVisible();

  // 展开 MCP 分组：飞出弹层列出 mcp.json 的服务器，启用的带工具数状态小字
  await menu.getByText('MCP', { exact: true }).click({ force: true });
  const fsRow = page.getByText('fs-tools', { exact: true }).last();
  await expect(fsRow).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('0 个工具').last()).toBeVisible();

  // 勾掉启用的 fs-tools：宿主收到 setMcpEnabled(name, enabled=false)
  await fsRow.click({ force: true });
  const off = await host.waitForSentWhere('setMcpEnabled', (m) => m.name === 'fs-tools');
  expect(off.enabled).toBe(false);

  // 勾上未启用的 git-tools：enabled=true
  const gitRow = page.getByText('git-tools', { exact: true }).last();
  await gitRow.click({ force: true });
  const on = await host.waitForSentWhere('setMcpEnabled', (m) => m.name === 'git-tools');
  expect(on.enabled).toBe(true);
});
