import { test, expect } from '@playwright/test';
import { openWebviewView } from '../helpers/webviewHarness';
import type { WebviewHandle } from '../helpers/webviewHarness';

/**
 * 系统自动消息折叠为一行（`docs/hosts/webview-ui.md` 第 11 节「自动消息折叠行」）：
 * 后台 Bash 完成通知与子代理 From 消息都收成一行摘要，展开才看正文。
 *
 * 场景级：真实 webview bundle + 假宿主应答（`e2e/helpers/fakeHost.ts`）。
 */

let handle: WebviewHandle;

test.beforeEach(async ({ browser }) => {
  handle = await openWebviewView(browser, process.cwd().replace(/[\\/]e2e$/, ''));
});

test.afterEach(async () => {
  await handle.close();
});

/** 后台任务完成通知原文（core 的 `build_completion_notification` 产出形态） */
const COMPLETION = [
  'Background task completed',
  'Task: bg-1700000000000-abc',
  'Description: Background command "List files in current directory" completed (exit code 0)',
  'Duration: 1.5s',
].join('\n');

test('后台完成通知收成一行摘要，展开后显示原始通知全文', async () => {
  const { page, host } = handle;
  const sessionId = (await host.waitForSent('startNewConversation')).sessionId as string;

  await host.send({ type: 'addMessage', sessionId, role: 'user', content: COMPLETION, origin: 'bash' });

  // 一行摘要：标题 + description + 时长；正文（Task: / Output:）默认不渲染
  const head = page.getByRole('button', { name: /Background bash completed\./ });
  await expect(head).toBeVisible({ timeout: 10_000 });
  await expect(head).toContainText('(List files in current directory)');
  await expect(head).toContainText('1.5s');
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('Task: bg-1700000000000-abc')).toHaveCount(0);

  // 展开：原始通知全文回来（ANSI 正文照旧按行渲染）
  await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('Task: bg-1700000000000-abc')).toBeVisible();
  await expect(page.getByText(/Description: Background command/)).toBeVisible();

  // 再点收起
  await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('Task: bg-1700000000000-abc')).toHaveCount(0);
});

test('失败的后台任务只换标题文案，不标红、图标与成功态一致', async () => {
  const { page, host } = handle;
  const sessionId = (await host.waitForSent('startNewConversation')).sessionId as string;

  const failed = [
    'Background task completed',
    'Task: bg-1700000000001-def',
    'Description: Background command "Build the standalone core" failed with exit code 101',
    'Duration: 43.2s',
  ].join('\n');
  await host.send({ type: 'addMessage', sessionId, role: 'user', content: failed, origin: 'bash' });

  const failedHead = page.getByRole('button', { name: /Background bash failed\./ });
  await expect(failedHead).toBeVisible({ timeout: 10_000 });
  await expect(failedHead).toContainText('(Build the standalone core)');
  await expect(failedHead).toContainText('43.2s');

  // 标题用系统色（不标红），图标与成功态是同一个
  const colorOf = (locator: ReturnType<typeof page.locator>): Promise<string> =>
    locator.evaluate((el) => getComputedStyle(el).color);
  const failedTitle = failedHead.getByText('Background bash failed.');
  const successMessage = await colorOf(failedTitle);

  await host.send({ type: 'addMessage', sessionId, role: 'user', content: COMPLETION, origin: 'bash' });
  const okHead = page.getByRole('button', { name: /Background bash completed\./ });
  await expect(okHead).toBeVisible({ timeout: 10_000 });
  const okTitle = okHead.getByText('Background bash completed.');
  expect(await colorOf(okTitle)).toBe(successMessage);

  // 两个折叠行的图标类名一致（同一个 glyph），且都不是叉/叹号类图标
  const failedIcon = await failedHead.locator('span.ti').first().getAttribute('class');
  const okIcon = await okHead.locator('span.ti').first().getAttribute('class');
  expect(failedIcon).toContain('ti-message-square');
  expect(okIcon).toContain('ti-message-square');
});

test('认不出结论的通知用中性标题，不宣称成功或失败', async () => {
  const { page, host } = handle;
  const sessionId = (await host.waitForSent('startNewConversation')).sessionId as string;

  // core 文案改版 / 老通知：Description 行不是三种已知形态之一
  const legacy = [
    'Background task completed',
    'Task: bg-1700000009999-legacy',
    'Description: Background command "legacy form" finished somehow',
    'Duration: 900ms',
  ].join('\n');
  await host.send({ type: 'addMessage', sessionId, role: 'user', content: legacy, origin: 'bash' });

  const head = page.getByRole('button', { name: /Background bash\./ });
  await expect(head).toBeVisible({ timeout: 10_000 });
  await expect(head).toContainText('(Background command "legacy form" finished somehow)');
  await expect(head).toContainText('900ms');
  await expect(page.getByText(/Background bash completed\./)).toHaveCount(0);
  await expect(page.getByText(/Background bash failed\./)).toHaveCount(0);
});

test('子代理 From 消息收成一行：来源 + 正文首行摘要，展开后是完整 markdown', async () => {
  const { page, host } = handle;
  const sessionId = (await host.waitForSent('startNewConversation')).sessionId as string;

  const body = [
    '测试全部通过；顺手把超时配置从 30s 提到了 120s。',
    '',
    '要点：',
    '',
    '1. `src/config.ts` 的 `timeout` 默认值改为 `120_000`；',
    '2. 补了一条回归用例。',
  ].join('\n');
  await host.send({
    type: 'addMessage',
    sessionId,
    role: 'user',
    content: body,
    origin: 'agent',
    meta: { param: '#sub-a1b2c3d4', type: 'from' },
  });

  const head = page.getByRole('button', { name: /From:/ });
  await expect(head).toBeVisible({ timeout: 10_000 });
  // 会话号只显示末 8 位（与时间线里的 From 链接同一口径）
  await expect(head).toContainText('#a1b2c3d4');
  await expect(head).toContainText('测试全部通过；顺手把超时配置从 30s 提到了 120s。');
  // 摘要只取首行：后续段落不在折叠行里
  await expect(head).not.toContainText('回归用例');
  await expect(page.getByText('回归用例', { exact: false })).toHaveCount(0);

  await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  // 展开后才是完整正文（markdown → 列表）
  await expect(page.getByText(/补了一条回归用例/)).toBeVisible();
  // 展开态仍保留「打开子代理对话」入口
  await expect(page.getByText('打开子代理对话')).toBeVisible();
});
