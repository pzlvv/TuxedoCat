import { test, expect } from '@playwright/test';
import { openWebviewView } from '../helpers/webviewHarness';
import type { WebviewHandle } from '../helpers/webviewHarness';

/**
 * US-7 未配置引导 / US-23 服务商与模型管理 / US-24 默认设置与语言 / US-26 未保存关闭确认
 */

let handle: WebviewHandle;

test.beforeEach(async ({ browser }) => {
  handle = await openWebviewView(browser, process.cwd().replace(/[\\/]e2e$/, ''));
});

test.afterEach(async () => {
  await handle.close();
});

/** 打开设置面板（菜单 → 设置） */
async function openSettings(page: import('@playwright/test').Page): Promise<import('@playwright/test').Locator> {
  await page.locator('button[title="功能开关"]').click();
  const menu = page.locator('ul.agent-mode-menu');
  await expect(menu).toBeVisible();
  await menu.getByText('设置', { exact: true }).click({ force: true });
  const panel = page.locator('h1', { hasText: '设置' }).locator('..');
  await expect(page.locator('h1', { hasText: '设置' })).toBeVisible();
  return panel;
}

test('US-23 修改服务商地址与模型并保存，宿主收到 saveLLMConfig', async () => {
  const { page, host } = handle;
  await openSettings(page);

  // 修改 API 服务地址
  const baseUrlInput = page.getByPlaceholder('请输入 API 服务地址');
  await expect(baseUrlInput).toBeVisible();
  await baseUrlInput.fill('http://beta.local:6006/v1');

  // 修改模型名
  const modelInput = page.locator('input[placeholder="model-id"]').first();
  await modelInput.fill('mock-model-v2');

  await page.getByRole('button', { name: '保存', exact: true }).click();

  const saved = await host.waitForSent('saveLLMConfig', 15_000);
  expect(saved.providers).toBeTruthy();
  const provider = saved.providers[0];
  // key 随新地址主机名推导
  expect(provider.key).toBe('beta.local');
  expect(provider.baseURL).toBe('http://beta.local:6006/v1');
  expect(provider.models).toContain('mock-model-v2');
});

test('US-23 新增模型行与新增服务商', async () => {
  const { page, host } = handle;
  await openSettings(page);

  await page.getByRole('button', { name: '添加模型' }).click();
  const modelInputs = page.locator('input[placeholder="model-id"]');
  await expect(modelInputs).toHaveCount(2);
  await modelInputs.nth(1).fill('extra-model');

  // 新增一个服务商标签页（空 tab：需补地址、Key 与至少一个模型，缺 Key 不入保存载荷）
  await page.getByText('+ 新增').click();
  await page.getByPlaceholder('请输入 API 服务地址').fill('http://gamma.local:6007/v1');
  await page.locator('input[placeholder="sk-"]').fill('sk-second');
  await page.getByRole('button', { name: '添加模型' }).click();
  await page.locator('input[placeholder="model-id"]').nth(0).fill('second-provider-model');

  await page.getByRole('button', { name: '保存', exact: true }).click();
  const saved = await host.waitForSent('saveLLMConfig', 15_000);
  expect(saved.providers.length).toBe(2);
  expect(saved.providers.map((p: any) => p.baseURL)).toContain('http://gamma.local:6007/v1');
});

test('US-23 API Key 支持明文 / 掩码切换', async () => {
  const { page } = handle;
  await openSettings(page);

  const apiKey = page.locator('input[placeholder="sk-"]');
  await expect(apiKey).toHaveAttribute('type', 'password');

  // 显示：明文
  await page.getByRole('button', { name: '显示 API Key' }).click();
  await expect(apiKey).toHaveAttribute('type', 'text');

  // 隐藏：恢复掩码
  await page.getByRole('button', { name: '隐藏 API Key' }).click();
  await expect(apiKey).toHaveAttribute('type', 'password');
});

test('US-24 默认设置与界面语言随保存提交', async () => {
  const { page, host } = handle;
  await openSettings(page);

  // 默认思考强度切到「最高」
  await page.getByText('默认思考强度').locator('..').getByRole('button', { name: '最高' }).click();
  // 界面语言切 English
  await page.getByText('界面语言').locator('..').getByRole('button', { name: 'English' }).click();

  await page.getByRole('button', { name: '保存', exact: true }).click();
  const saved = await host.waitForSent('saveLLMConfig', 15_000);
  expect(saved.thinkingEffort).toBe('max');
  expect(saved.language).toBe('en');
});

test('US-24 默认配置变化且与当前对话不一致时询问是否应用', async () => {
  const { page, host } = handle;
  await openSettings(page);

  // 默认思考强度从 high 切到 max（当前对话是 high）
  await page.getByText('默认思考强度').locator('..').getByRole('button', { name: '最高' }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await host.waitForSent('saveLLMConfig', 15_000);

  // 弹出确认对话框，逐条列出「变更前 → 变更后」
  const dialog = page.getByText('默认配置已修改').locator('..');
  await expect(page.getByText('默认配置已修改')).toBeVisible();
  await expect(dialog.getByText('Thinking effort')).toBeVisible();
  await expect(dialog.getByText('高', { exact: true })).toBeVisible();
  await expect(dialog.getByText('最高', { exact: true })).toBeVisible();

  // 应用到当前对话：对话框关闭，输入区菜单里的选中项切到「最高」
  await page.getByRole('button', { name: '应用到当前对话' }).click();
  await expect(page.getByText('默认配置已修改')).toHaveCount(0);
  await page.locator('button[title="功能开关"]').click();
  const menu = page.locator('ul.agent-mode-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('button', { name: '最高' })).toHaveCSS('font-weight', '600');
});

test('US-24 默认配置变化时可选「暂不应用」，当前对话保持不变', async () => {
  const { page, host } = handle;
  await openSettings(page);

  await page.getByText('默认思考强度').locator('..').getByRole('button', { name: '最高' }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await host.waitForSent('saveLLMConfig', 15_000);

  await expect(page.getByText('默认配置已修改')).toBeVisible();
  await page.getByRole('button', { name: '暂不应用' }).click();
  await expect(page.getByText('默认配置已修改')).toHaveCount(0);

  // 当前对话仍是 high：输入区菜单里「高」保持选中
  await page.locator('button[title="功能开关"]').click();
  const menu = page.locator('ul.agent-mode-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('button', { name: '高', exact: true })).toHaveCSS('font-weight', '600');
});

test('US-24 MCP 默认启用列表变化且与当前对话不一致时询问是否应用', async () => {
  const { page, host } = handle;
  // mcp.json 声明两个 server；全局默认只启用 srv-a，当前对话生效列表也是 srv-a
  await host.setMcpState({ servers: ['srv-a', 'srv-b'], defaults: ['srv-a'], sessionEnabled: ['srv-a'] });
  await openSettings(page);

  // 默认配置里勾上 srv-b 并保存
  await page.getByRole('checkbox', { name: 'srv-b' }).check();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const saved = await host.waitForSent('saveLLMConfig', 15_000);
  expect(saved.mcpServers).toEqual(['srv-a', 'srv-b']);

  // 弹出确认对话框，列出 MCP 启用列表的变更
  await expect(page.getByText('默认配置已修改')).toBeVisible();
  const dialog = page.getByText('默认配置已修改').locator('..');
  await expect(dialog.getByText('MCP 启用列表')).toBeVisible();
  await expect(dialog.getByText('srv-a → srv-a, srv-b')).toBeVisible();

  // 应用到当前对话：整表覆盖该会话的启用列表
  await page.getByRole('button', { name: '应用到当前对话' }).click();
  await expect(page.getByText('默认配置已修改')).toHaveCount(0);
  const applied = await host.waitForSent('setMcpEnabledList', 15_000);
  expect(applied.names).toEqual(['srv-a', 'srv-b']);
});

test('US-24 MCP 默认启用列表变化时可选「暂不应用」，当前对话不写覆盖', async () => {
  const { page, host } = handle;
  await host.setMcpState({ servers: ['srv-a', 'srv-b'], defaults: ['srv-a'], sessionEnabled: ['srv-a'] });
  await openSettings(page);

  await page.getByRole('checkbox', { name: 'srv-b' }).check();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await host.waitForSent('saveLLMConfig', 15_000);

  await expect(page.getByText('默认配置已修改')).toBeVisible();
  await page.getByRole('button', { name: '暂不应用' }).click();
  await expect(page.getByText('默认配置已修改')).toHaveCount(0);

  // 取消不改当前对话：不发 setMcpEnabledList（当前对话的启用列表仍是 srv-a）
  const sent = await host.sentAll();
  expect(sent.some((m: any) => m.type === 'setMcpEnabledList')).toBe(false);
});

test('US-24 MCP 钉住失败不阻断保存，界面给出提示且不弹确认框', async () => {
  const { page, host } = handle;
  await host.setMcpState({
    servers: ['srv-a', 'srv-b'], defaults: ['srv-a'], sessionEnabled: ['srv-a'], pinFailed: true,
  });
  await openSettings(page);

  await page.getByRole('checkbox', { name: 'srv-b' }).check();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const saved = await host.waitForSent('saveLLMConfig', 15_000);
  expect(saved.mcpServers).toEqual(['srv-a', 'srv-b']);

  // 保存照常成功：不弹「是否应用到当前对话」，改为一条提示
  await expect(page.getByRole('status').getByText('当前对话的 MCP 启用状态未能固定')).toBeVisible();
  await expect(page.getByText('默认配置已修改')).toHaveCount(0);
});

test('US-24 界面字号档位随保存提交，宿主回传后即时生效', async () => {
  const { page, host } = handle;
  await openSettings(page);

  // 面板里切到「大」
  await page.getByText('界面字号').locator('..').getByRole('button', { name: '大', exact: true }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const saved = await host.waitForSent('saveLLMConfig', 15_000);
  expect(saved.fontSize).toBe('large');

  // 宿主保存成功回传后，根元素 CSS 变量即时切到「特大」档（+2px），字号由 CSS 变量统一驱动
  await host.send({ type: 'llmConfigSaved', fontSize: 'xlarge' });
  await expect.poll(() => page.evaluate(
    () => document.documentElement.style.getPropertyValue('--ui-font-offset'),
  )).toBe('2px');
});

test('US-26 有脏改动时关闭需确认，可选择继续编辑或放弃', async () => {
  const { page, host } = handle;
  await openSettings(page);

  // 未改动：直接关闭不弹确认
  await page.locator('button[title="关闭"]').click();
  await expect(page.getByText('放弃修改？')).toHaveCount(0);
  await expect(page.locator('h1', { hasText: '设置' })).toBeHidden();

  // 重新打开并制造脏改动
  await openSettings(page);
  await page.getByPlaceholder('请输入 API 服务地址').fill('http://127.0.0.1:6008/v1');
  await page.locator('button[title="关闭"]').click();

  await expect(page.getByText('放弃修改？')).toBeVisible();
  await page.getByRole('button', { name: '继续编辑' }).click();
  await expect(page.locator('h1', { hasText: '设置' })).toBeVisible();

  // 放弃修改：面板关闭且不落盘
  await page.locator('button[title="关闭"]').click();
  await page.getByRole('button', { name: '放弃修改' }).click();
  await expect(page.locator('h1', { hasText: '设置' })).toBeHidden();
  const saves = (await host.sentAll()).filter((m) => m.type === 'saveLLMConfig');
  expect(saves).toHaveLength(0);
});

test('US-7 未配置服务商时输入区禁用并引导打开设置', async () => {
  const { page, host } = handle;
  // 运行期模拟「未完成配置」（宿主重推 settingsDefaults）
  await host.send({
    type: 'settingsDefaults',
    model: '', provider: '', webSearch: false,
    thinkingMode: 'high', agentMode: 'risk', promptMode: 'normal',
    language: 'zh', providerConfigured: false,
  });

  // 输入框被禁用，覆盖引导层出现（点击设置打开配置面板）
  await expect(page.locator('textarea.input-textarea')).toBeDisabled({ timeout: 10_000 });
  const guide = page.locator('[title="请先配置模型服务，点击设置"]');
  await expect(guide).toBeVisible();
  await guide.click();
  await host.waitForSent('requestLLMConfig');
  await expect(page.locator('h1', { hasText: '设置' })).toBeVisible();
});

test('US-25 统计发现已删除目录时提示，可批量清除相关历史', async () => {
  const { page, host } = handle;
  await host.setConversationSpaces([
    { dirName: 'kept', projectPath: 'D:/kept-ws', sizeBytes: 10, fileCount: 1, conversationCount: 1, workspaceMissing: false },
    { dirName: 'gone-a', projectPath: 'D:/gone-a', sizeBytes: 2048, fileCount: 4, conversationCount: 2, workspaceMissing: true },
    { dirName: 'gone-b', projectPath: 'C:/gone-b', sizeBytes: 1, fileCount: 1, conversationCount: 1, workspaceMissing: true },
  ]);
  await openSettings(page);

  const missingTitle = page.getByText('以下目录已不存在，是否清除相关历史。');
  const missingModal = page.locator('div.fixed', { hasText: '以下目录已不存在' });

  // 统计：弹出提示，列出全部缺失路径（存在的目录不在列）
  await page.getByRole('button', { name: '统计', exact: true }).click();
  await expect(missingTitle).toBeVisible();
  await expect(missingModal.getByText('D:/gone-a')).toBeVisible();
  await expect(missingModal.getByText('C:/gone-b')).toBeVisible();

  // 取消：只关提示；再次统计仍会提示（用户主动统计才检查）
  await missingModal.getByRole('button', { name: '取消' }).click();
  await expect(missingTitle).toBeHidden();
  await page.getByRole('button', { name: '统计', exact: true }).click();
  await expect(missingTitle).toBeVisible();

  // 确认：逐个清除，回执后统计刷新——缺失空间消失，且不再重复弹提示
  await missingModal.getByRole('button', { name: '删除' }).click();
  // 直接删除：不再二次弹窗，按 remove 模式整目录移除
  await host.waitForSentWhere('clearConversationSpace', (m) => m.dirName === 'gone-a' && m.mode === 'remove');
  await host.waitForSentWhere('clearConversationSpace', (m) => m.dirName === 'gone-b' && m.mode === 'remove');
  await expect(missingTitle).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText('D:/kept-ws')).toBeVisible();
  await expect(page.getByText('D:/gone-a')).toHaveCount(0);
  await expect(page.getByText('C:/gone-b')).toHaveCount(0);
});

test('US-25 每个空间两个按钮：清除历史 / 移除，各自弹窗确认', async () => {
  const { page, host } = handle;
  await host.setConversationSpaces([
    { dirName: 'ws-a', projectPath: 'D:/ws-a', sizeBytes: 10, fileCount: 1, conversationCount: 1, workspaceMissing: false },
  ]);
  await openSettings(page);
  await page.getByRole('button', { name: '统计', exact: true }).click();
  await expect(page.getByText('以下目录已不存在，是否清除相关历史。')).toHaveCount(0);

  const row = page.locator('div', { hasText: 'D:/ws-a' }).last();

  // 清除历史：确认弹窗 → mode clear（按钮限定在弹窗容器内，避免命中面板 footer）
  const clearModal = () => page.getByText('清空对话空间？').locator('..');
  await page.getByRole('button', { name: '清除历史', exact: true }).click();
  await expect(clearModal()).toBeVisible();
  await clearModal().getByRole('button', { name: '取消' }).click();
  await expect(clearModal()).toBeHidden();
  await page.getByRole('button', { name: '清除历史', exact: true }).click();
  await clearModal().getByRole('button', { name: '删除' }).click();
  const cleared = await host.waitForSentWhere(
    'clearConversationSpace',
    (m) => m.dirName === 'ws-a' && m.mode === 'clear',
  );
  expect(cleared).toBeTruthy();

  // 回执后统计刷新（fake 宿主已把空间移出列表），行消失、可再次统计
  await host.send({ type: 'conversationSpacesData', spaces: [] });
  await expect(page.getByText('D:/ws-a')).toHaveCount(0);

  // 移除：确认弹窗告知不影响工作目录本身 → mode remove
  await host.setConversationSpaces([
    { dirName: 'ws-a', projectPath: 'D:/ws-a', sizeBytes: 10, fileCount: 1, conversationCount: 1, workspaceMissing: false },
  ]);
  await page.getByRole('button', { name: '统计', exact: true }).click();
  await expect(page.getByText('D:/ws-a')).toBeVisible();
  const removeModal = () => page.getByText('移除对话空间？').locator('..');
  await page.getByRole('button', { name: '移除', exact: true }).click();
  await expect(removeModal()).toBeVisible();
  await expect(removeModal().getByText(/不会影响工作目录本身/)).toBeVisible();
  await removeModal().getByRole('button', { name: '移除' }).click();
  const removed = await host.waitForSentWhere(
    'clearConversationSpace',
    (m) => m.dirName === 'ws-a' && m.mode === 'remove',
  );
  expect(removed).toBeTruthy();
});

test('US-25 缺失目录很多时列表滚动，按钮固定在滚动区外', async () => {
  const { page, host } = handle;
  const count = 30;
  await host.setConversationSpaces(
    Array.from({ length: count }, (_, i) => ({
      dirName: `gone-${i}`,
      projectPath: `D:/very/long/gone-path-${i}`,
      sizeBytes: 1, fileCount: 1, conversationCount: 1, workspaceMissing: true,
    })),
  );
  await openSettings(page);

  await page.getByRole('button', { name: '统计', exact: true }).click();
  const modal = page.locator('div.fixed', { hasText: '以下目录已不存在' });
  await expect(modal.getByText('D:/very/long/gone-path-0')).toBeVisible();

  // 列表限高滚动：内容高于可视区（.fixed 命中遮罩层，列表在它的子对话框里）
  const scrollInfo = await modal.evaluate((overlay) => {
    const dialog = overlay.firstElementChild as HTMLElement | null;
    if (!dialog) return null;
    for (const child of Array.from(dialog.children)) {
      const el = child as HTMLElement;
      if (el.style?.overflowY === 'auto') {
        return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
      }
    }
    return null;
  });
  expect(scrollInfo).not.toBeNull();
  expect(scrollInfo!.scrollHeight).toBeGreaterThan(scrollInfo!.clientHeight);

  // 按钮在滚动区外：列表未滚动时也直接可见可点
  await expect(modal.getByRole('button', { name: '取消' })).toBeVisible();
  await expect(modal.getByRole('button', { name: '删除' })).toBeVisible();

  // 弹窗宽度按内容自适应、不超过 webview 的 80%（.fixed 是遮罩层，量它的子对话框）
  const dialogWidth = await modal.evaluate((overlay) => {
    const dialog = overlay.firstElementChild as HTMLElement | null;
    return dialog ? dialog.getBoundingClientRect().width : null;
  });
  const viewport = page.viewportSize();
  expect(dialogWidth).not.toBeNull();
  expect(dialogWidth!).toBeLessThanOrEqual((viewport!.width * 0.8) + 1);
});
