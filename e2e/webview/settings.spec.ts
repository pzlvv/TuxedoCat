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
