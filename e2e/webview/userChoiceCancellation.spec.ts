import { test, expect } from '@playwright/test';
import { openWebviewView } from '../helpers/webviewHarness';
import type { WebviewHandle } from '../helpers/webviewHarness';

/**
 * specs/050 用户选择请求的作废与收回。
 *
 * 覆盖失效链路的两条触发源（都走同一个收框落点）：
 * - core 的 `userChoiceCanceled` 宣告（回复超时 / 会话中止）；
 * - 发起工具的结果到达（按 `toolUseId` 匹配）。
 * 以及用户主动取消（按钮 / Esc）。
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

async function requestQuestion(sessionId: string): Promise<void> {
  await handle.host.send({
    type: 'requestUserChoice',
    sessionId,
    choiceId: 'choice-cancel-1',
    choiceRequestId: 'req-cancel-1',
    toolUseId: 'tool-cancel-1',
    toolName: 'AskUserQuestion',
    message: '',
    questions: [{
      id: 'q1',
      question: '这次要怎么做？',
      header: '方案',
      options: [{ label: '甲' }, { label: '乙' }],
      multi_select: false,
    }],
  });
}

test('AC-2 core 宣告作废后选择框消失、主输入框恢复', async () => {
  const { page, host } = handle;
  const sessionId = await currentSessionId();
  await requestQuestion(sessionId);

  const overlay = page.locator('.user-choice-overlay');
  await expect(overlay).toBeVisible({ timeout: 10_000 });

  // core 宣告这次请求作废（回复超时）
  await host.send({
    type: 'userChoiceCanceled',
    choiceRequestId: 'req-cancel-1',
  });

  await expect(overlay).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('textarea.input-textarea')).toBeVisible();
});

test('AC-5 发起工具收尾即收回选择框', async () => {
  const { page, host } = handle;
  const sessionId = await currentSessionId();
  await requestQuestion(sessionId);

  const overlay = page.locator('.user-choice-overlay');
  await expect(overlay).toBeVisible({ timeout: 10_000 });

  // 工具以失败收尾：成功与失败一视同仁
  await host.send({
    type: 'updateToolStatus',
    sessionId,
    toolCallId: 'tool-cancel-1',
    messageUuid: null,
    status: 'fail',
    output: 'boom',
  });

  await expect(overlay).toBeHidden({ timeout: 10_000 });
});

test('AC-7 作废后切走再切回，选择框不再出现', async () => {
  const { page, host } = handle;
  const sessionId = await currentSessionId();
  await requestQuestion(sessionId);

  const overlay = page.locator('.user-choice-overlay');
  await expect(overlay).toBeVisible({ timeout: 10_000 });

  await host.send({ type: 'userChoiceCanceled', choiceRequestId: 'req-cancel-1' });
  await expect(overlay).toBeHidden({ timeout: 10_000 });

  // 新开一个会话再切回：会话快照里的 stale 请求不应被读出来
  const other = await host.waitForSent('startNewConversation');
  await host.send({
    type: 'conversationLoaded',
    sessionId,
    conversation: {
      metadata: { sessionId, title: 'T', createdAt: 1, updatedAt: 1, messageCount: 0 },
      messages: [],
    },
    pendingToolUseIds: [],
  });
  void other;
  await expect(overlay).toBeHidden();
});

test('AC-8/AC-9 用户点取消：立即收起并回传 canceled，不产出answers', async () => {
  const { page, host } = handle;
  const sessionId = await currentSessionId();
  await requestQuestion(sessionId);

  const overlay = page.locator('.user-choice-overlay');
  await expect(overlay).toBeVisible({ timeout: 10_000 });

  await overlay.locator('.user-choice-cancel').first().click();

  const resp = await host.waitForSent('respondUserChoice');
  expect(resp.choiceId).toBe('choice-cancel-1');
  expect(resp.canceled).toBe(true);
  // 取消不产出部分答案
  expect(resp.answers).toBeUndefined();

  await expect(overlay).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('textarea.input-textarea')).toBeVisible();
});

test('AC-8 Esc 等效于取消', async () => {
  const { page, host } = handle;
  const sessionId = await currentSessionId();
  await requestQuestion(sessionId);

  const overlay = page.locator('.user-choice-overlay');
  await expect(overlay).toBeVisible({ timeout: 10_000 });

  await page.keyboard.press('Escape');

  const resp = await host.waitForSent('respondUserChoice');
  expect(resp.canceled).toBe(true);
  await expect(overlay).toBeHidden({ timeout: 10_000 });
});
