import { test, expect } from '@playwright/test';
import { openWebviewView } from '../helpers/webviewHarness';
import type { WebviewHandle } from '../helpers/webviewHarness';

/**
 * US-59 输入区任务进度按钮（`docs/features/todo-list.md` FR-002 / FR-003 / FR-004）
 *
 * 场景级：以真实用户操作（点开历史列表、悬停、点击、切会话）驱动构建后的 webview
 * bundle；Todo 清单由假宿主按 wire 协议应答（`sessionTodos`），与 core 的
 * `sessionTodosRequested` 应答 / `todosChanged` 推送同一形状。
 */

let handle: WebviewHandle;

test.beforeEach(async ({ browser }) => {
  handle = await openWebviewView(browser, process.cwd().replace(/[\\/]e2e$/, ''));
});

test.afterEach(async () => {
  await handle.close();
});

const TODO_FOUR = [
  { content: '改代码', status: 'completed' },
  { content: '跑测试', status: 'in_progress' },
  { content: '写文档', status: 'pending' },
  { content: '收敛', status: 'pending' },
];

const TODO_ONE = [{ content: '只剩一件', status: 'pending' }];

function seedConversations(): Promise<void> {
  return handle.host.setConversations([
    {
      sessionId: 'sess-todo-a',
      title: '带清单的对话',
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now() - 30_000,
      messageCount: 2,
      messages: [
        {
          type: 'user',
          uuid: 'ta-1',
          parentUuid: null,
          timestamp: Date.now() - 60_000,
          message: { role: 'user', content: '帮我做四件事' },
        },
      ],
    },
    {
      sessionId: 'sess-todo-b',
      title: '没有清单的对话',
      createdAt: Date.now() - 50_000,
      updatedAt: Date.now() - 20_000,
      messageCount: 1,
      messages: [
        {
          type: 'user',
          uuid: 'tb-1',
          parentUuid: null,
          timestamp: Date.now() - 50_000,
          message: { role: 'user', content: '随便聊聊' },
        },
      ],
    },
  ]);
}

/** 打开历史列表并切到指定会话（触发 conversationLoaded → requestSessionTodos） */
async function openConversation(title: string): Promise<void> {
  const { page } = handle;
  await page.locator('button[title="对话历史"]').click();
  await expect(page.locator('.conversation-dropdown')).toBeVisible();
  await page.locator('.conversation-dropdown').getByText(title).click();
}

const progressButton = () => handle.page.locator('[data-todo-progress]');
const progressTip = () => handle.page.locator('[data-todo-progress-tip]');

test('US-59 打开带清单的对话：按钮显示已完成 / 总数', async () => {
  const { host } = handle;
  await seedConversations();
  await host.setSessionTodos('sess-todo-a', TODO_FOUR);

  await openConversation('带清单的对话');

  await expect(progressButton()).toHaveText('任务进度: 1/4');
  await expect(progressButton()).toHaveAttribute('data-todo-progress-pinned', 'false');
});

test('US-59 没有清单的对话不渲染按钮', async () => {
  const { host } = handle;
  await seedConversations();
  await host.setSessionTodos('sess-todo-a', TODO_FOUR);
  await host.setSessionTodos('sess-todo-b', []);

  await openConversation('没有清单的对话');

  await expect(progressButton()).toHaveCount(0);
});

test('US-59 收到 todosChanged 推送即更新，不需要重新加载对话', async () => {
  const { page, host } = handle;
  await seedConversations();
  await host.setSessionTodos('sess-todo-a', TODO_FOUR);
  await openConversation('带清单的对话');
  await expect(progressButton()).toHaveText('任务进度: 1/4');

  // core 推送新清单（`CoreEvent.todosChanged` 的 wire 形态）
  await host.send({
    type: 'sessionTodos',
    sessionId: 'sess-todo-a',
    todos: [
      { content: '改代码', status: 'completed' },
      { content: '跑测试', status: 'completed' },
      { content: '写文档', status: 'pending' },
      { content: '收敛', status: 'pending' },
    ],
  });

  await expect(progressButton()).toHaveText('任务进度: 2/4');
  await page.locator('button[title="对话历史"]').click();
  await expect(progressButton()).toHaveText('任务进度: 2/4');
});

test('US-59 悬停满 100ms 才显示浮层', async () => {
  const { page, host } = handle;
  await seedConversations();
  await host.setSessionTodos('sess-todo-a', TODO_FOUR);
  await openConversation('带清单的对话');
  await expect(progressButton()).toHaveText('任务进度: 1/4');

  // 悬停满 100ms → 浮层出现，条目与清单一致 
  await progressButton().hover();
  await expect(progressTip()).toBeVisible();
  await expect(progressTip().getByText('改代码')).toBeVisible();
  await expect(progressTip().getByText('跑测试')).toBeVisible();

  // 移出立即隐藏
  await page.mouse.move(5, 5);
  await expect(progressTip()).toHaveCount(0);
});

test('US-59 浮层宽度随内容自适应，最宽不超过输入区宽度', async () => {
  const { page, host } = handle;
  const longContent = '这是一个很长的任务条目，用来撑开浮层宽度'.repeat(4);
  await seedConversations();
  await host.setSessionTodos('sess-todo-a', [
    { content: longContent, status: 'pending' },
  ]);
  await openConversation('带清单的对话');
  await expect(progressButton()).toHaveText('任务进度: 0/1');

  const inputBox = await page.locator('[data-input-area]').boundingBox();

  // 长条目：宽度扩到输入区宽度（不再固定在旧的 320px 上限）
  await progressButton().hover();
  await expect(progressTip()).toBeVisible();
  const longTipBox = await progressTip().boundingBox();
  expect(longTipBox!.width).toBeGreaterThan(320);
  expect(longTipBox!.width).toBeLessThanOrEqual(inputBox!.width);

  // 短条目：按内容收缩，不占满输入区
  await host.send({
    type: 'sessionTodos',
    sessionId: 'sess-todo-a',
    todos: [{ content: '短', status: 'pending' }],
  });
  await expect(progressTip().getByText('短')).toBeVisible();
  const shortTipBox = await progressTip().boundingBox();
  expect(shortTipBox!.width).toBeLessThan(longTipBox!.width);
  expect(shortTipBox!.width).toBeLessThan(inputBox!.width);
  await page.mouse.move(5, 5);
});

test('US-59 悬停不足 100ms 就移出：浮层不出现', async () => {
  const { page, host } = handle;
  await seedConversations();
  await host.setSessionTodos('sess-todo-a', TODO_FOUR);
  await openConversation('带清单的对话');
  await expect(progressButton()).toHaveText('任务进度: 1/4');

  const box = await progressButton().boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);

  await expect(progressTip()).toHaveCount(0);
});

test('US-59 点击固定浮层、再点取消固定', async () => {
  const { page, host } = handle;
  await seedConversations();
  await host.setSessionTodos('sess-todo-a', TODO_FOUR);
  await openConversation('带清单的对话');
  await expect(progressButton()).toHaveText('任务进度: 1/4');

  await progressButton().click();
  await expect(progressButton()).toHaveAttribute('data-todo-progress-pinned', 'true');
  // 固定后指针移出仍显示
  await page.mouse.move(5, 5);
  await expect(progressTip()).toBeVisible();

  // 再点一次取消固定：指针已不在按钮上，浮层隐藏
  await progressButton().click();
  await expect(progressButton()).toHaveAttribute('data-todo-progress-pinned', 'false');
  await page.mouse.move(5, 5);
  await expect(progressTip()).toHaveCount(0);
});

test('US-59 切换对话后固定态复位，按钮按新对话清单显示', async () => {
  const { page, host } = handle;
  await seedConversations();
  await host.setSessionTodos('sess-todo-a', TODO_FOUR);
  await host.setSessionTodos('sess-todo-b', TODO_ONE);
  await openConversation('带清单的对话');
  await expect(progressButton()).toHaveText('任务进度: 1/4');

  await progressButton().click();
  await expect(progressButton()).toHaveAttribute('data-todo-progress-pinned', 'true');

  await openConversation('没有清单的对话');
  await expect(progressButton()).toHaveText('任务进度: 0/1');
  await expect(progressButton()).toHaveAttribute('data-todo-progress-pinned', 'false');
  await expect(progressTip()).toHaveCount(0);
  await page.mouse.move(5, 5);
});

test('US-59 压缩（messagesReplaced）后按钮不消失、计数不变', async () => {
  const { page, host } = handle;
  await seedConversations();
  await host.setSessionTodos('sess-todo-a', TODO_FOUR);
  await openConversation('带清单的对话');
  await expect(progressButton()).toHaveText('任务进度: 1/4');

  // 压缩完成：消息被整批替换，但 Todo 事实在 core 的表里，不受影响
  await host.send({
    type: 'messagesReplaced',
    sessionId: 'sess-todo-a',
    messages: [{ role: 'user', content: '压缩后的保留区' }],
  });

  await expect(page.getByText('压缩后的保留区')).toBeVisible({ timeout: 10_000 });
  await expect(progressButton()).toHaveText('任务进度: 1/4');
});

test('US-59 dark / light 两种主题下都可读（取主题色，不写死色值）', async () => {
  const { page, host } = handle;
  await seedConversations();
  await host.setSessionTodos('sess-todo-a', TODO_FOUR);
  await openConversation('带清单的对话');
  await expect(progressButton()).toHaveText('任务进度: 1/4');

  const colorOf = () => progressButton().evaluate((el) => getComputedStyle(el).color);
  const darkColor = await colorOf();
  await host.send({ type: 'setTheme', theme: 'light' });
  // 等 React 提交主题变更：按钮文字色应换成 light 主题的 textSystem
  await expect.poll(colorOf).not.toBe(darkColor);
  const lightColor = await colorOf();

  expect(lightColor).not.toBe(darkColor);
  await expect(progressButton()).toHaveText('任务进度: 1/4');
});
