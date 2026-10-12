import { test, expect } from '@playwright/test';
import { openWebviewView } from '../helpers/webviewHarness';
import type { WebviewHandle } from '../helpers/webviewHarness';

/**
 * US-19 对话历史与切换 / US-20 新建 / US-21 重命名 / US-22 删除
 *
 * 会话树由假宿主的 conversationsData 应答供给；切换走单视图 loadConversation 通路。
 */

let handle: WebviewHandle;

test.beforeEach(async ({ browser }) => {
  handle = await openWebviewView(browser, process.cwd().replace(/[\\/]e2e$/, ''));
});

test.afterEach(async () => {
  await handle.close();
});

const DAY = 24 * 60 * 60 * 1000;

function seedConversations(): Promise<void> {
  return handle.host.setConversations([
    {
      sessionId: 'sess-alpha', title: '调研笔记', createdAt: Date.now() - 3 * DAY,
      updatedAt: Date.now() - 2 * DAY, messageCount: 6,
      messages: [
        { type: 'user', uuid: 'u1', parentUuid: null, timestamp: Date.now() - 3 * DAY, message: { role: 'user', content: '帮我做点调研' } },
        { type: 'assistant', uuid: 'u2', parentUuid: 'u1', timestamp: Date.now() - 3 * DAY + 1000, message: { role: 'assistant', content: [{ type: 'text', text: '这是历史会话里的回复。' }] } },
      ],
    },
    {
      sessionId: 'sess-beta', title: '部署记录', createdAt: Date.now() - DAY,
      updatedAt: Date.now() - DAY, messageCount: 2,
      messages: [
        { type: 'user', uuid: 'u3', parentUuid: null, timestamp: Date.now() - DAY, message: { role: 'user', content: '子会话内容' } },
      ],
    },
  ]);
}

test('US-19 打开历史列表，切换会话并加载历史消息', async () => {
  const { page, host } = handle;
  await seedConversations();

  await page.locator('button[title="对话历史"]').click();
  const dropdown = page.locator('.conversation-dropdown');
  await expect(dropdown).toBeVisible();
  await expect(dropdown.getByText('调研笔记')).toBeVisible();
  await expect(dropdown.getByText('部署记录')).toBeVisible();
  // 消息数
  await expect(dropdown.getByText('6 条消息')).toBeVisible();

  // 点击切换：宿主收到 loadConversation
  await dropdown.getByText('调研笔记').click();
  const loaded = await host.waitForSent('loadConversation');
  expect(loaded.sessionId).toBe('sess-alpha');

  // 历史消息渲染出来，标题更新
  await expect(page.getByText('这是历史会话里的回复。').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('heading', { name: '调研笔记' })).toBeVisible();
});

test('US-20 新建对话：草稿暂存后进入新会话', async () => {
  const { page, host } = handle;
  await page.fill('textarea.input-textarea', '新话题草稿');
  await page.locator('button[title="新对话"]').click();

  const started = await host.waitForSent('startNewConversation');
  expect(started.sessionId).toBeTruthy();
  // 草稿被暂存到新会话的输入框
  await expect(page.locator('textarea.input-textarea')).toHaveValue('新话题草稿');
});

test('US-21 重命名会话（行内编辑，Enter 提交）', async () => {
  const { page, host } = handle;
  await seedConversations();
  await page.locator('button[title="对话历史"]').click();
  const dropdown = page.locator('.conversation-dropdown');
  await expect(dropdown.getByText('调研笔记')).toBeVisible();

  // 操作按钮 hover 才显示：先悬停条目
  await page.waitForTimeout(400);
  // 操作按钮按行作用域：列表里每条根会话都有同名按钮
  const alphaRow = dropdown.locator('.group', { hasText: '调研笔记' }).first();
  await alphaRow.hover();
  const renameButton = alphaRow.locator('button[title="重命名"]');
  await expect(renameButton).toBeVisible({ timeout: 5_000 });
  await renameButton.click();
  const input = dropdown.locator('input[type="text"]');
  await expect(input).toBeVisible();
  await input.fill('调研笔记 V2');
  await input.press('Enter');

  const renamed = await host.waitForSent('renameConversation');
  expect(renamed.sessionId).toBe('sess-alpha');
  expect(renamed.title).toBe('调研笔记 V2');
});

test('US-21 发起重命名请求（智能命名由宿主执行）', async () => {
  const { page, host } = handle;
  await seedConversations();
  await page.locator('button[title="对话历史"]').click();
  const dropdown = page.locator('.conversation-dropdown');
  await expect(dropdown.getByText('调研笔记')).toBeVisible();

  await page.waitForTimeout(400);
  const alphaRow2 = dropdown.locator('.group', { hasText: '调研笔记' }).first();
  await alphaRow2.hover();
  const smartButton = alphaRow2.locator('button[title="智能命名"]');
  await expect(smartButton).toBeVisible({ timeout: 5_000 });
  await smartButton.click();
  const requested = await host.waitForSent('requestSmartNaming');
  expect(requested.sessionId).toBe('sess-alpha');

  // 命名结束：smartNamingResult 只清「命名中」标记，不携带标题；标题刷新走
  // 磁盘事实驱动的 conversationsData（core 落盘后 conversationListChanged →
  // ConversationManager.refresh() 的推送）
  await host.send({ type: 'smartNamingResult', sessionId: 'sess-alpha' });
  await host.send({
    type: 'conversationsData',
    conversations: [
      { sessionId: 'sess-alpha', title: '智能起的新名字', createdAt: Date.now() - 3 * DAY, updatedAt: Date.now(), messageCount: 6 },
      { sessionId: 'sess-beta', title: '部署记录', createdAt: Date.now() - DAY, updatedAt: Date.now() - DAY, messageCount: 2 },
    ],
  });
  await expect(dropdown.getByText('智能起的新名字')).toBeVisible({ timeout: 10_000 });
});

test('US-22 删除会话需要二次确认', async () => {
  const { page, host } = handle;
  await seedConversations();
  await page.locator('button[title="对话历史"]').click();
  const dropdown = page.locator('.conversation-dropdown');
  await expect(dropdown.getByText('调研笔记')).toBeVisible();

  await page.waitForTimeout(400);
  const alphaRow3 = dropdown.locator('.group', { hasText: '调研笔记' }).first();
  await alphaRow3.hover();
  const deleteButton = alphaRow3.locator('button[title="删除此对话"]');
  await expect(deleteButton).toBeVisible({ timeout: 5_000 });
  await deleteButton.click();
  await expect(page.getByText('确定要删除 "调研笔记" 吗？')).toBeVisible();

  // 先取消：不发删除
  await page.getByRole('button', { name: '取消' }).click();
  await expect(page.getByText('确定要删除 "调研笔记" 吗？')).toBeHidden();
  const deletes1 = (await host.sentAll()).filter((m) => m.type === 'deleteConversation');
  expect(deletes1).toHaveLength(0);

  // 再确认删除
  await page.waitForTimeout(400);
  const alphaRow4 = dropdown.locator('.group', { hasText: '调研笔记' }).first();
  await alphaRow4.hover();
  const deleteButtonAgain = alphaRow4.locator('button[title="删除此对话"]');
  await expect(deleteButtonAgain).toBeVisible({ timeout: 5_000 });
  await deleteButtonAgain.click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  const deleted = await host.waitForSent('deleteConversation');
  expect(deleted.sessionId).toBe('sess-alpha');
});

test('US-19 运行中的会话在列表里显示流水灯', async () => {
  const { page, host } = handle;
  await seedConversations();
  // sess-beta 运行中
  await host.setRuntimeStates([{ sessionId: 'sess-beta', idle: false, waiting: false }]);
  // 触发一次状态推送（runtimeStates 只在变化时推；这里直接再发一次）
  await host.send({ type: 'sessionRuntimeStates', states: [{ sessionId: 'sess-beta', idle: false, waiting: false }] });

  await page.locator('button[title="对话历史"]').click();
  const dropdown = page.locator('.conversation-dropdown');
  await expect(dropdown.getByText('部署记录')).toBeVisible({ timeout: 10_000 });
  await expect(dropdown.locator('.running-bar').first()).toBeVisible();
});

/**
 * specs/006 FR-003：选中对话的子代理默认展开上限。
 *
 * 直接子会话数达到 5 时不自动展开（批量委派的对话不把列表撑满），4 个及以下仍
 * 默认展开。阈值是单一来源（`src/host/ui/conversationTreeDefaults.ts`），webview
 * 与 Electron 侧栏共用。同时锁定「列表数据刷新不再改写选中对话自身的展开状态」——
 * 祖先链自动展开只写祖先，选中项自身交给默认规则与用户显式状态。
 */
test('US-19 选中对话的子代理默认展开上限（>=5 不自动展开）', async () => {
  const { page, host } = handle;
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const seed = (childCount: number) => [
    { sessionId: 'sess-parent', title: '批量委派', createdAt: now - 2 * DAY_MS, updatedAt: now, messageCount: 12 },
    ...Array.from({ length: childCount }, (_, i) => ({
      sessionId: `sess-sub-${i + 1}`,
      title: `子代理 ${i + 1}`,
      parentSessionId: 'sess-parent',
      createdAt: now - DAY_MS,
      updatedAt: now - DAY_MS,
      messageCount: 1,
    })),
  ];

  // 5 个子代理：选中该对话后默认折叠
  await host.setConversations(seed(5));
  await page.locator('button[title="对话历史"]').click();
  const dropdown = page.locator('.conversation-dropdown');
  await dropdown.getByText('批量委派').click();
  await host.waitForSent('loadConversation');
  await page.locator('button[title="对话历史"]').click();
  await expect(dropdown.getByText('批量委派')).toBeVisible({ timeout: 10_000 });
  await expect(dropdown.getByText('子代理 1')).toHaveCount(0);

  // 列表数据刷新（同一选中对话）：保持折叠，不因自动展开规则改写
  await host.send({ type: 'conversationsData', conversations: seed(5) });
  await expect(dropdown.getByText('子代理 1')).toHaveCount(0);

  // 4 个子代理：默认展开
  await host.send({ type: 'conversationsData', conversations: seed(4) });
  await expect(dropdown.getByText('子代理 1')).toBeVisible({ timeout: 10_000 });
});

test('SCRATCH input height', async ({ page }) => {
  const ta = page.locator('textarea');
  await expect(ta).toHaveCount(1, { timeout: 30_000 });
  const m = async (tag: string) => {
    const v = await ta.evaluate((el: HTMLTextAreaElement) => {
      const cs = getComputedStyle(el);
      return {
        value: JSON.stringify(el.value),
        rect: Math.round(el.getBoundingClientRect().height * 100) / 100,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        inlineHeight: el.style.height,
        lineHeight: cs.lineHeight,
        fontSize: cs.fontSize,
        overflowY: cs.overflowY,
        maxHeight: cs.maxHeight,
        whiteSpace: cs.whiteSpace,
      };
    });
    console.log(tag, JSON.stringify(v));
  };
  await ta.click();
  await m('empty');
  await page.keyboard.insertText('第一行');
  await m('one');
  await page.keyboard.insertText('\n第二行');
  await m('two');
  await page.keyboard.insertText('\n第三行');
  await m('three');
  await ta.fill('');
  await page.keyboard.insertText('a\nb');
  await m('paste2');
  expect(true).toBe(true);
});
