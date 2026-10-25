import { test, expect } from '@playwright/test';
import { openWebviewView } from '../helpers/webviewHarness';
import type { WebviewHandle } from '../helpers/webviewHarness';

/**
 * US-58 一次提问多个问题并支持多选（AskUserQuestion 的逐页选择框）
 *
 * 假宿主直接下发带 `questions` 的 `requestUserChoice`（真实链路：core `ask_user` →
 * UserChoiceQueue → 宿主 wire），锁定 `src/webview/QuestionOverlay.tsx` 的渲染层验收：
 * 分页与进度条、单选自动翻页（末页不自动提交）、多选与「其他」并存、Enter / Shift+Enter /
 * 输入法合成中的回车、提交载荷 `answers` 的形状与未作答题的兜底。
 *
 * 深色主题下的进度条三色取 `src/webview/colors.ts`（harness `#6366f1` 已答 /
 * timelineStatusRunning `#eab308` 已跳过 / border `#9ca3af` 当前未答）。
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

interface Question {
  id: string;
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multi_select?: boolean;
}

/** 下发一条 AskUserQuestion 形态的请求（choices 为空 → webview 走逐页 UI） */
async function askQuestions(sessionId: string, questions: Question[]): Promise<void> {
  await handle.host.send({
    type: 'requestUserChoice',
    sessionId,
    choiceId: 'ask-e2e-1',
    toolName: 'AskUserQuestion',
    message: '',
    questions,
  });
}

const THREE_QUESTIONS: Question[] = [
  { id: 'q1', question: '第一题：选一个', header: '第一步', options: [{ label: 'A' }, { label: 'B' }] },
  { id: 'q2', question: '第二题：多选', header: '第二步', multi_select: true, options: [{ label: 'X' }, { label: 'Y' }] },
  { id: 'q3', question: '第三题：自由回复' },
];

/** 读进度条某一段的实际渲染色（`QuestionOverlay` 的 progressColor） */
async function progressColorAt(page: import('@playwright/test').Page, i: number): Promise<string> {
  return page.evaluate((idx) => {
    const bar = document.querySelector(`.user-choice-overlay button[aria-label="${idx + 1}"] span`);
    return bar ? getComputedStyle(bar).backgroundColor : '';
  }, i);
}

test('US-58 验收 1：多问题逐页呈现、底部显示进度、切页保留已选内容', async () => {
  const { page } = handle;
  const sessionId = await currentSessionId();
  await askQuestions(sessionId, THREE_QUESTIONS);

  const overlay = page.locator('.user-choice-overlay');
  await expect(overlay).toBeVisible({ timeout: 10_000 });
  // 一次只呈现一个问题，头部与题干都来自当前页
  await expect(overlay.getByText('第一步')).toBeVisible();
  await expect(overlay.getByText('第一题：选一个')).toBeVisible();
  await expect(overlay.getByText('第二题：多选')).toBeHidden();
  // 进度 1 / 3
  await expect(overlay.getByText('1 / 3')).toBeVisible();

  // 单选点普通选项 → 自动进入下一页（不提交）
  await overlay.locator('button.user-choice-button', { hasText: 'B' }).click();
  await expect(overlay.getByText('第二题：多选')).toBeVisible();
  await expect(overlay.getByText('2 / 3')).toBeVisible();
  expect((await handle.host.sentAll()).some((m) => m.type === 'respondUserChoice')).toBe(false);

  // 返回上一页：已选内容保留（B 仍处于选中态）
  await overlay.getByRole('button', { name: '上一页' }).click();
  await expect(overlay.getByText('第一题：选一个')).toBeVisible();
  const selectedB = overlay.locator('button.user-choice-button', { hasText: 'B' });
  const indicator = selectedB.locator('span[aria-hidden] > span').first();
  await expect(indicator).toBeVisible();

  // 进度条可点击跳页：直接跳到第三页
  await overlay.locator('button[aria-label="3"]').click();
  await expect(overlay.getByText('第三题：自由回复')).toBeVisible();
  await expect(overlay.getByText('3 / 3')).toBeVisible();
});

test('US-58 验收 2a：单选点击普通选项后自动翻页，最后一页不自动提交', async () => {
  const { page } = handle;
  const sessionId = await currentSessionId();
  await askQuestions(sessionId, [
    { id: 'q1', question: '最后一题：单选', options: [{ label: 'A' }, { label: 'B' }] },
  ]);

  const overlay = page.locator('.user-choice-overlay');
  await expect(overlay).toBeVisible({ timeout: 10_000 });
  await overlay.locator('button.user-choice-button', { hasText: 'A' }).click();
  // 末页点击普通选项只记录选择，不提交
  await page.waitForTimeout(300);
  expect((await handle.host.sentAll()).some((m) => m.type === 'respondUserChoice')).toBe(false);
  await expect(overlay).toBeVisible();
  await expect(overlay.getByText('1 / 1')).toBeVisible();
});

test('US-58 验收 2b：多选可勾选多个，「其他」与普通选项并存且锁定置灰', async () => {
  const { page } = handle;
  const sessionId = await currentSessionId();
  await askQuestions(sessionId, [
    { id: 'm1', question: '多选 + 其他', multi_select: true, options: [{ label: 'X' }, { label: 'Y' }] },
  ]);

  const overlay = page.locator('.user-choice-overlay');
  await expect(overlay).toBeVisible({ timeout: 10_000 });
  await overlay.locator('button.user-choice-button', { hasText: 'X' }).click();
  await overlay.locator('button.user-choice-button', { hasText: 'Y' }).click();
  // 聚焦「其他」输入框（单选会清空普通选项，多选保留）后输入文本
  const other = overlay.locator('div.user-choice-button textarea');
  await other.click();
  await other.fill('补充说明');
  // 多选勾选「其他」后整题锁定：普通选项按钮 disabled，已勾选保持
  await expect(overlay.locator('button.user-choice-button', { hasText: 'X' })).toBeDisabled();
  await expect(overlay.locator('button.user-choice-button', { hasText: 'Y' })).toBeDisabled();

  await overlay.getByRole('button', { name: '提交' }).click();
  const resp = await handle.host.waitForSent('respondUserChoice');
  expect(resp.choiceId).toBe('ask-e2e-1');
  expect(resp.answers).toEqual([{ id: 'm1', selected: ['X', 'Y'], custom: '补充说明' }]);
});

test('US-58 验收 3：聚焦输入框即代表「其他」，单选清空普通选项', async () => {
  const { page } = handle;
  const sessionId = await currentSessionId();
  await askQuestions(sessionId, [
    { id: 'q1', question: '单选 + 其他', options: [{ label: 'A' }, { label: 'B' }] },
  ]);

  const overlay = page.locator('.user-choice-overlay');
  await expect(overlay).toBeVisible({ timeout: 10_000 });
  await overlay.locator('button.user-choice-button', { hasText: 'A' }).click();
  // 用户主动聚焦输入框 → 勾选「其他」并清空普通选项
  const other = overlay.locator('div.user-choice-button textarea');
  await other.click();
  await other.fill('自己写的答案');
  await overlay.getByRole('button', { name: '提交' }).click();

  const resp = await handle.host.waitForSent('respondUserChoice');
  expect(resp.answers).toEqual([{ id: 'q1', selected: [], custom: '自己写的答案' }]);
});

test('US-58 验收 4：Enter 下一页 / Shift+Enter 换行 / 合成中的回车不触发', async () => {
  const { page } = handle;
  const sessionId = await currentSessionId();
  await askQuestions(sessionId, THREE_QUESTIONS);

  const overlay = page.locator('.user-choice-overlay');
  await expect(overlay).toBeVisible({ timeout: 10_000 });
  const input = overlay.locator('textarea');

  // Shift+Enter 换行不翻页
  await input.fill('第一页的补充');
  await input.press('Shift+Enter');
  await expect(overlay.getByText('1 / 3')).toBeVisible();
  await expect(input).toHaveValue('第一页的补充\n');

  // 中文输入法合成中的回车：确认候选字，不翻页
  await input.evaluate((el) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
  });
  await page.waitForTimeout(200);
  await expect(overlay.getByText('1 / 3')).toBeVisible();

  // 普通 Enter 进入下一页
  await input.press('Enter');
  await expect(overlay.getByText('2 / 3')).toBeVisible();
  await expect(overlay.getByText('第二题：多选')).toBeVisible();
});

test('US-58 验收 5/6：提交 answers 按题回传、未作答题按空选择兜底；进度条三色', async () => {
  const { page } = handle;
  const sessionId = await currentSessionId();
  await askQuestions(sessionId, THREE_QUESTIONS);

  const overlay = page.locator('.user-choice-overlay');
  await expect(overlay).toBeVisible({ timeout: 10_000 });

  // 第一题作答 → 已答（harness 蓝）
  await overlay.locator('button.user-choice-button', { hasText: 'A' }).click();
  await expect(overlay.getByText('2 / 3')).toBeVisible();
  expect(await progressColorAt(page, 0)).toBe('rgb(99, 102, 241)');

  // 从第二题直接跳到第三题：第二题记为「已跳过」（黄），当前页保持未答（border）
  await overlay.locator('button[aria-label="3"]').click();
  await expect(overlay.getByText('3 / 3')).toBeVisible();
  expect(await progressColorAt(page, 1)).toBe('rgb(234, 179, 8)');
  expect(await progressColorAt(page, 2)).toBe('rgb(156, 163, 175)');

  // 最后一页输入自由回复后 Enter 提交
  const input = overlay.locator('textarea');
  await input.fill('第三题答案');
  await input.press('Enter');

  const resp = await handle.host.waitForSent('respondUserChoice');
  expect(resp.choiceId).toBe('ask-e2e-1');
  // 每题按 id 回传：已答带 selected，未作答按 selected: [] 且不带 custom
  expect(resp.answers).toEqual([
    { id: 'q1', selected: ['A'] },
    { id: 'q2', selected: [] },
    { id: 'q3', selected: [], custom: '第三题答案' },
  ]);
  await expect(overlay).toBeHidden();
  // 提交后主输入框恢复
  await expect(page.locator('textarea.input-textarea')).toBeVisible();
});
