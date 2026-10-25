import { test, expect } from '@playwright/test';
import { openWebviewView } from '../helpers/webviewHarness';
import type { WebviewHandle } from '../helpers/webviewHarness';

/**
 * US-39 验收 3 的渲染层：spin 模式单向禁用主输入框
 *
 * 假宿主下发 `setWorkMode`（真实链路：core `workModeChanged` 的 webview 投影，或
 * `conversationLoaded` 载荷里的 `workMode` 恢复），锁定「禁用 + 换 placeholder + 停止按钮
 * 转黄 + 单向不退出」这一层表现（`src/webview/inputAreaState.ts` 与
 * `src/host/abortButtonState.ts` 的判定）。
 *
 * 不在本用例范围：`meta.json` 的 `workMode` 落盘与恢复（core-rs `engine_tests` 锁定）、
 * 真实 `/spin` 执行链（SpinLoop 与子代理编排由 core 侧用例锁定）。
 */

let handle: WebviewHandle;

test.beforeEach(async ({ browser }) => {
  handle = await openWebviewView(browser, process.cwd().replace(/[\\/]e2e$/, ''));
});

test.afterEach(async () => {
  await handle.close();
});

async function currentSessionId(): Promise<string> {
  const started = await handle.host.waitForSent('startNewConversation');
  return started.sessionId as string;
}

const SPIN_PLACEHOLDER = 'Spin 模式下不响应用户输入';

test('US-39 验收 3：spin 模式禁用主输入框、placeholder 换文案、停止按钮转黄', async () => {
  const { page } = handle;
  const sessionId = await currentSessionId();
  const input = page.locator('textarea.input-textarea');
  // 基线：普通会话可输入、停止按钮灰色不可点（防止「永远禁用」的假通过）
  await expect(input).toBeEnabled();
  await expect(page.locator('[data-abort-state="none"]')).toBeVisible();

  await handle.host.send({ type: 'setWorkMode', sessionId, workMode: 'spin' });
  // 停止按钮的三态读 core 的运行时快照（没有快照按空闲置灰），先给一条运行中的快照
  await handle.host.send({ type: 'sessionRuntimeStates', states: [{ sessionId, idle: false, waiting: false }] });

  await expect(input).toBeDisabled();
  await expect(input).toHaveAttribute('placeholder', SPIN_PLACEHOLDER);
  // 禁用不来自 provider 分支：没有「去配置」引导覆盖层
  await expect(page.getByText(/点击配置|Click to configure/)).toHaveCount(0);
  // 停止按钮：spin 没有 query engine → 黄色（background），不是红也不是灰
  const abort = page.locator('[data-abort-state="background"]');
  await expect(abort).toBeVisible();
  await expect(abort).toHaveCSS('background-color', 'rgb(245, 158, 11)');
});

test('US-39 验收 3：spin 单向不退出——快照回空闲、点击停止后仍保持禁用', async () => {
  const { page, host } = handle;
  const sessionId = await currentSessionId();
  const input = page.locator('textarea.input-textarea');
  await host.send({ type: 'setWorkMode', sessionId, workMode: 'spin' });
  await host.send({ type: 'sessionRuntimeStates', states: [{ sessionId, idle: false, waiting: false }] });
  await expect(input).toBeDisabled();

  // 运行结束：宿主推空闲快照（完成 / 中止 / 失败都不退出 spin）
  await host.send({ type: 'sessionRuntimeStates', states: [{ sessionId, idle: true, waiting: false }] });
  await page.waitForTimeout(300);
  await expect(input).toBeDisabled();
  await expect(input).toHaveAttribute('placeholder', SPIN_PLACEHOLDER);
  await expect(page.locator('[data-abort-state="background"]')).toBeVisible();

  // 空闲时点停止：上行照常（中止范围由 core 判定），模式与禁用态不变
  await page.locator('[data-abort-state="background"]').click();
  await host.waitForSent('abort');
  await expect(input).toBeDisabled();
  await expect(page.locator('[data-abort-state="background"]')).toBeVisible();
});

test('US-39 验收 3：非当前会话的 setWorkMode 不影响当前视图', async () => {
  const { page, host } = handle;
  const sessionId = await currentSessionId();
  await host.send({ type: 'setWorkMode', sessionId: `${sessionId}-other`, workMode: 'spin' });

  // 多视图宿主逐会话投递：别的会话进 spin 不该锁住当前会话的输入
  await expect(page.locator('textarea.input-textarea')).toBeEnabled();
  await expect(page.locator('textarea.input-textarea')).not.toHaveAttribute('placeholder', SPIN_PLACEHOLDER);
});
