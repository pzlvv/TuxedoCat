import { test, expect } from '@playwright/test';
import { openWebviewView } from '../helpers/webviewHarness';
import type { WebviewHandle } from '../helpers/webviewHarness';

/**
 * US-1 发送消息并获得流式回复 / US-2 中止 / US-3 排队 / US-4 thinking 与统计 / US-12 代码块复制
 *
 * 场景级：以真实用户操作（输入、Enter、点击）驱动构建后的 webview bundle，
 * 宿主侧由假宿主按 wire 协议应答（`e2e/helpers/fakeHost.ts`）。
 */

let handle: WebviewHandle;

test.beforeEach(async ({ browser }) => {
  handle = await openWebviewView(browser, process.cwd().replace(/[\\/]e2e$/, ''));
});

test.afterEach(async () => {
  await handle.close();
});

/**
 * 填输入框并等到「发送按钮可用」。
 *
 * 为什么不能直接 `fill` + `press`：页面挂载后紧接着有配置握手（`settingsDefaults` /
 * `setNewConversationDefaults`）引起的重渲染，早于它落地的输入会被受控 textarea 按
 * state 回写清空——表现是框里看着有字、发送按钮却一直 disabled，`press` 的 Enter
 * 闭包里 `input` 是空串，发送被 `hasContent` 挡掉，整条用例只会超时。
 * 这里以「发送按钮 enabled」作为输入已落到 React 状态的判据（它是 `hasContent` 的
 * 投影），若仍被回写就再填一次。
 */
async function fillInput(text: string): Promise<void> {
  const { page } = handle;
  const textarea = page.locator('textarea.input-textarea');
  const sendButton = page.locator('button:has(.ti-send)').last();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await textarea.fill(text);
    const enabled = await sendButton
      .isEnabled({ timeout: 3_000 })
      .catch(() => false);
    if (enabled) return;
  }
  // 三次都没生效说明不是时序问题而是接线坏了：让断言以原始形态失败
  await expect(sendButton).toBeEnabled();
}

test('US-1 发送消息：用户消息上屏，助手回复流式渲染为 Markdown', async () => {
  const { page, host } = handle;
  await host.setTurn({
    text: '## 标题\n\n正文第一段。\n\n```ts\nconst answer = 42;\n```\n',
    chunkDelayMs: 30,
  });

  await fillInput('你好，帮我写个示例');
  await page.press('textarea.input-textarea', 'Enter');

  // 上行：sendMessage 携带原文与会话
  const sent = await host.waitForSent('sendMessage');
  expect(sent.content).toBe('你好，帮我写个示例');
  expect(sent.sessionId).toBeTruthy();

  // 用户消息回显
  await expect(page.getByText('你好，帮我写个示例').first()).toBeVisible();

  // 流式结束后：Markdown 标题 + 代码块渲染出来
  await expect(page.getByRole('heading', { name: '标题' })).toBeVisible({ timeout: 15_000 });
  const codeBlock = page.locator('pre code', { hasText: 'const answer = 42;' }).first();
  await expect(codeBlock).toBeVisible();

  // 空内容不可发送：清空后发送按钮不可用
  const sendButton = page.locator('button:has(.ti-send)').last();
  await expect(sendButton).toBeDisabled();
});

test('US-1 点击发送按钮同样可以发送', async () => {
  const { page, host } = handle;
  await host.setTurn({ text: '好的。', chunkDelayMs: 10 });
  await fillInput('点按钮发送');
  await page.locator('button:has(.ti-send)').last().click();
  const sent = await host.waitForSent('sendMessage');
  expect(sent.content).toBe('点按钮发送');
  await expect(page.getByText('好的。').first()).toBeVisible({ timeout: 15_000 });
});

test('US-4 thinking 内容折叠展示并带流式统计', async () => {
  const { page, host } = handle;
  await host.setTurn({
    thinking: '用户在测试思考链路，我应该正常回复。',
    text: '思考完毕，给出答案。',
    chunkDelayMs: 25,
  });
  await fillInput('想一想再回答');
  await page.press('textarea.input-textarea', 'Enter');

  // thinking 折叠块（summary 固定含 "thinking" 字样），流式统计含 Decode
  const summary = page.locator('summary', { hasText: 'thinking' });
  await expect(summary).toBeVisible({ timeout: 15_000 });
  await expect(summary.getByText(/Decode:/)).toBeVisible();

  // 正文在折叠块之外正常出现
  await expect(page.getByText('思考完毕，给出答案。').first()).toBeVisible();
});

test('US-4 展开的 thinking 内容限高并在框内滚动', async () => {
  const { page, host } = handle;
  // 长思考：宽度足够大时也会折行到超过限高，确保框内一定出现滚动条
  const thinking = '思考过程需要成段展开，这里是第若干句推理。'.repeat(400);
  await host.setTurn({
    thinking,
    text: '思考完毕，给出答案。',
    chunkDelayMs: 5,
  });
  await fillInput('写一段很长的思考');
  await page.press('textarea.input-textarea', 'Enter');

  const summary = page.locator('summary', { hasText: 'thinking' });
  await expect(summary).toBeVisible({ timeout: 15_000 });
  // 统计从 chars 切到 tok 即思考流结束（docs/features/user-stories/dialog-core.md 的 US-4），
  // 此时内容长度才稳定，测到的是完整思考文本
  await expect(summary.getByText(/tok/)).toBeVisible({ timeout: 15_000 });

  // 默认收起：内容不可见
  const content = page.locator('.thinking-content');
  await expect(content).toBeHidden();

  // 展开后限高（约 3 个 Bash 输出框的量级），内容超出即在框内滚动
  await summary.click();
  await expect(content).toBeVisible();
  await expect
    .poll(async () =>
      content.evaluate((el) => el.scrollHeight > el.clientHeight),
    )
    .toBe(true);
  const metrics = await content.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      overflowY: style.overflowY,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      // 内层滚动条走 legacy 伪元素（`.inner-scrollbar`）：标准属性必须复位成 auto，
      // 否则 Chromium 会整体忽略 ::-webkit-scrollbar，宽度与颜色都改不动
      scrollbarWidth: style.scrollbarWidth,
      thumbBg: getComputedStyle(el, '::-webkit-scrollbar-thumb').backgroundColor,
      scrollbarWidthPx: getComputedStyle(el, '::-webkit-scrollbar').width,
    };
  });
  expect(metrics.overflowY).toBe('auto');
  // 限高值落在「两个 Bash 输出框之上、三个的量级」这一带：比单框高一截，
  // 又不会把整段思考全放出来
  expect(metrics.clientHeight).toBeGreaterThan(231);
  expect(metrics.clientHeight).toBeLessThanOrEqual(346);
  // 长内容确实超出限高，出现框内滚动条
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  // 框内滚动条：3px、中性灰（不是主题 harness 色）
  expect(metrics.scrollbarWidth).toBe('auto');
  expect(metrics.scrollbarWidthPx).toBe('3px');
  expect(metrics.thumbBg).toMatch(/^rgba?\(128, 128, 128/);
});

test('US-2 中止进行中的流式回复', async () => {
  const { page, host } = handle;
  await host.setTurn({
    text: '这段回复非常长'.repeat(40),
    chunkDelayMs: 200,
  });
  await fillInput('慢速回答');
  await page.press('textarea.input-textarea', 'Enter');

  // 流式中：终止按钮出现并可点
  const abortButton = page.locator('button[title="终止"]');
  await expect(abortButton).toBeVisible({ timeout: 15_000 });
  await abortButton.click();

  // 宿主收到 abort（带会话），随后 queryEnd 把界面收回空闲态
  const abort = await host.waitForSent('abort');
  expect(abort.sessionId).toBeTruthy();
  // 中止后按钮回到禁用态（按钮常驻，仅按会话状态切换可用性）
  await expect(abortButton).toBeDisabled({ timeout: 10_000 });
});

test('abort 按钮三态：红（前台在跑）→ 黄（只剩后台）→ 灰（空闲）', async () => {
  const { page, host } = handle;
  await host.setTurn({ text: '这段回复非常长'.repeat(60), chunkDelayMs: 150 });
  await fillInput('长任务');
  await page.press('textarea.input-textarea', 'Enter');

  const sent = await host.waitForSent('sendMessage');
  const sid = sent.sessionId as string;
  const abortButton = page.locator('button[data-abort-state]');

  // 1) 前台查询在跑：红色可点
  await expect(abortButton).toHaveAttribute('data-abort-state', 'query', { timeout: 15_000 });
  await expect(abortButton).toBeEnabled();

  // 2) 第一次点击只中止前台：宿主回推「前台停下、后台任务仍在跑」→ 黄色可点
  await host.setAbortRuntimeStates([{
    sessionId: sid, idle: false, waiting: false,
    queryRunning: false, compacting: false, pendingCompact: false, backgroundRunning: true, subAgentRunning: false,
  }]);
  await abortButton.click();
  await expect(abortButton).toHaveAttribute('data-abort-state', 'background', { timeout: 10_000 });
  await expect(abortButton).toBeEnabled();

  // 3) 第二次点击中止后台：宿主回推空闲 → 灰色不可点
  await host.setAbortRuntimeStates([{
    sessionId: sid, idle: true, waiting: false,
    queryRunning: false, compacting: false, pendingCompact: false, backgroundRunning: false, subAgentRunning: false,
  }]);
  await abortButton.click();
  await expect(abortButton).toHaveAttribute('data-abort-state', 'none', { timeout: 10_000 });
  await expect(abortButton).toBeDisabled();

  // 4) spin 模式没有 query engine：快照里的 queryRunning 只是 SpinLoop，按钮仍为黄色可点
  await host.send({ type: 'setWorkMode', sessionId: sid, workMode: 'spin' });
  await host.send({
    type: 'sessionRuntimeStates',
    states: [{
      sessionId: sid, idle: false, waiting: false,
      queryRunning: true, compacting: false, pendingCompact: false, backgroundRunning: false, subAgentRunning: true,
    }],
  });
  await expect(abortButton).toHaveAttribute('data-abort-state', 'background', { timeout: 10_000 });
  await expect(abortButton).toBeEnabled();

  // 切到 normal（常规会话）后回到空闲 → 灰色不可点
  await host.send({ type: 'setWorkMode', sessionId: sid, workMode: 'normal' });
  await host.send({
    type: 'sessionRuntimeStates',
    states: [{
      sessionId: sid, idle: true, waiting: false,
      queryRunning: false, compacting: false, pendingCompact: false, backgroundRunning: false, subAgentRunning: false,
    }],
  });
  await expect(abortButton).toHaveAttribute('data-abort-state', 'none', { timeout: 10_000 });
  await expect(abortButton).toBeDisabled();

  // 两次点击各发一条 abort（都带当前会话）
  const aborts = (await host.sentAll()).filter((m) => m.type === 'abort');
  expect(aborts).toHaveLength(2);
  expect(aborts.every((m) => m.sessionId === sid)).toBe(true);
});

test('US-3 引擎忙碌时消息排队，轮末自动重发；中止后回填输入框', async () => {
  const { page, host } = handle;
  await host.setTurn({ text: '第一轮回答。', chunkDelayMs: 150 });

  await fillInput('第一条消息');
  await page.press('textarea.input-textarea', 'Enter');
  await expect(page.locator('button[title="终止"]')).toBeVisible({ timeout: 15_000 });

  // 忙碌中再发一条 → 排队横幅出现
  await fillInput('排队消息');
  await page.press('textarea.input-textarea', 'Enter');
  await expect(page.getByText(/等待中/).first()).toBeVisible();

  // 第一轮结束后：webview 自动重发排队消息（US-3 验收 2）
  const sendMessages = async (): Promise<any[]> =>
    (await host.sentAll()).filter((m) => m.type === 'sendMessage');
  await expect.poll(async () => (await sendMessages()).length, { timeout: 20_000 }).toBe(2);
  expect((await sendMessages())[1].content).toBe('排队消息');
  // 横幅消失
  await expect(page.getByText(/等待中/).first()).toBeHidden({ timeout: 10_000 });

  // 中止路径：再排一条后中止，排队内容回填输入框
  await host.setTurn({ text: '第二轮回答。'.repeat(20), chunkDelayMs: 250 });
  await fillInput('第二条消息');
  await page.press('textarea.input-textarea', 'Enter');
  await expect(page.locator('button[title="终止"]')).toBeVisible({ timeout: 15_000 });
  await fillInput('会被回填的消息');
  await page.press('textarea.input-textarea', 'Enter');
  await expect(page.getByText(/等待中/).first()).toBeVisible();
  await page.locator('button[title="终止"]').click();
  await expect(
    page.locator('textarea.input-textarea'),
  ).toHaveValue(/会被回填的消息/, { timeout: 10_000 });
});

test('US-3 排队项编辑撤回到输入框 / 删除；排队时禁止发送', async () => {
  const { page, host } = handle;
  const sendMessageCount = async (): Promise<number> =>
    (await host.sentAll()).filter((m) => m.type === 'sendMessage').length;

  // ── 编辑：排队消息撤回到输入框，引擎不再消费它 ──
  // 首轮拉到 ~12s：排队阶段的全部断言都要落在「仍在排队」的窗口内——
  // fillInput 等「发送可用」的语义在排队期是反的（按钮恰好合法地禁用），
  // 重试循环会把窗口烧穿，轮末自动重发一来计数断言就变成竞态
  await host.setTurn({ text: '第一轮回答。'.repeat(30), chunkDelayMs: 2_000 });
  await fillInput('第一条消息');
  await page.press('textarea.input-textarea', 'Enter');
  await expect(page.locator('button[title="终止"]')).toBeVisible({ timeout: 15_000 });

  await fillInput('要编辑的消息');
  await page.press('textarea.input-textarea', 'Enter');
  const banner = page.getByText(/等待中/).first();
  await expect(banner).toBeVisible();

  // 排队期间发送被禁用：按钮置灰，Enter 也不再触发上行。
  // 直接填入（不经 fillInput），Enter 后计数必须维持原值——轮次仍在跑，
  // 轮末自动重发还没到，这个计数是稳定的
  const sendButton = page.locator('button:has(.ti-send)').last();
  await expect(sendButton).toBeDisabled();
  await page.locator('textarea.input-textarea').fill('排队中不能再发');
  await page.press('textarea.input-textarea', 'Enter');
  expect(await sendMessageCount()).toBe(2);

  // 编辑：横幅消失、内容撤回到输入框，宿主收到 discardQueuedMessage
  await page.locator('button[title*="编辑排队消息"]').click();
  await expect(banner).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('textarea.input-textarea')).toHaveValue(/要编辑的消息/, { timeout: 10_000 });
  expect((await host.sentAll()).filter((m) => m.type === 'discardQueuedMessage')).toHaveLength(1);

  // 本轮结束后不自动重发（撤回即取消）
  await expect(page.locator('button[title="终止"]')).toBeDisabled({ timeout: 30_000 });
  expect(await sendMessageCount()).toBe(2);

  // ── 删除：排队消息直接丢弃，不回填输入框 ──
  await host.setTurn({ text: '第二轮回答。'.repeat(30), chunkDelayMs: 1_000 });
  await fillInput('第二条消息');
  await page.press('textarea.input-textarea', 'Enter');
  await expect(page.locator('button[title="终止"]')).toBeEnabled({ timeout: 15_000 });

  await fillInput('要删除的消息');
  await page.press('textarea.input-textarea', 'Enter');
  await expect(page.getByText(/等待中/).first()).toBeVisible();
  await page.locator('button[title*="删除排队消息"]').click();
  await expect(page.getByText(/等待中/).first()).toBeHidden({ timeout: 10_000 });
  expect((await host.sentAll()).filter((m) => m.type === 'discardQueuedMessage')).toHaveLength(2);
});

test('US-12 代码块一键复制并反馈「已复制」', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', '剪贴板断言仅在 Chromium 下执行');
  const { page, host } = handle;
  await host.setTurn({ text: '```js\nconsole.log("copy-me");\n```\n', chunkDelayMs: 10 });
  await fillInput('给段代码');
  await page.press('textarea.input-textarea', 'Enter');

  const copyButton = page.locator('button[title="复制代码"]');
  await expect(copyButton).toBeVisible({ timeout: 15_000 });
  await copyButton.click();
  await expect(page.getByText('已复制').first()).toBeVisible();

  // 剪贴板拿到代码内容（context 已授予 clipboard 权限）
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('console.log("copy-me");');
});

test('US-1 输入法合成期间的 Enter 不发送（模拟 composition）', async () => {
  const { page, host } = handle;
  await fillInput('中文输入');
  // 触发 compositionstart → Enter → compositionend：这期间 Enter 不应发送
  await page.evaluate(() => {
    const el = document.querySelector('textarea.input-textarea')!;
    el.dispatchEvent(new CompositionEvent('compositionstart', { data: '中' }));
    // isComposing=true 等价真实输入法合成期的 keydown（InputArea 按 nativeEvent.isComposing 拦截）
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
    el.dispatchEvent(new CompositionEvent('compositionend', { data: '中文输入' }));
  });
  await page.waitForTimeout(600);
  const sends = (await host.sentAll()).filter((m) => m.type === 'sendMessage');
  expect(sends).toHaveLength(0);
});

test('US-52 specs/019 abort 黄色态悬停 1s 显示运行明细浮层：任务 / 子代理清单，只读，移出即隐', async () => {
  const { page, host } = handle;
  // 建会话：黄色态判定读当前会话的快照条目（与三态用例同一驱动方式）
  await host.setTurn({ text: 'ok' });
  await fillInput('起个会话');
  await page.press('textarea.input-textarea', 'Enter');
  const sent = await host.waitForSent('sendMessage');
  const sid = sent.sessionId as string;
  const abortButton = page.locator('button[data-abort-state]');
  const abortTip = page.locator('[data-abort-tip]');

  // 等轮次彻底结束（按钮回灰）：假宿主在轮末推 idle 快照，会覆盖此前注入的
  // 任意中间态——必须在其后注入黄色态，否则悬停守卫看到的是灰色
  await expect(abortButton).toHaveAttribute('data-abort-state', 'none', { timeout: 10_000 });

  // 黄色态 + 明细：2 个后台任务（其一 command == description）+ 一对子代理（一跑一完）
  await host.send({
    type: 'sessionRuntimeStates',
    states: [
      {
        sessionId: sid, idle: false, waiting: false, queryRunning: false, compacting: false,
        pendingCompact: false, backgroundRunning: true, subAgentRunning: true,
        backgroundTasks: [
          { taskId: 'bg-1', description: '打包日志', command: 'tar -czf log.tgz logs' },
          { taskId: 'bg-2', description: '压测脚本', command: '压测脚本' },
        ],
        subAgentDescription: null, parentSessionId: null,
      },
      {
        sessionId: `${sid}-sub1`, idle: false, waiting: false, queryRunning: true, compacting: false,
        pendingCompact: false, backgroundRunning: false, subAgentRunning: false, backgroundTasks: [],
        subAgentDescription: '浏览文件找规格', parentSessionId: sid,
      },
      {
        sessionId: `${sid}-sub2`, idle: true, waiting: false, queryRunning: false, compacting: false,
        pendingCompact: false, backgroundRunning: false, subAgentRunning: false, backgroundTasks: [],
        subAgentDescription: '已完成的子代理', parentSessionId: sid,
      },
    ],
  });
  await expect(abortButton).toHaveAttribute('data-abort-state', 'background', { timeout: 10_000 });

  // AC-3：悬停未满 1s 不出现
  await abortButton.hover();
  await expect(abortTip).toBeHidden();

  // AC-1 / AC-2：满 1s 浮层出现——任务描述 + 与描述不同的命令；运行中子代理列出、
  // 已完成子代理跳过（AC-2 的 idle 口径）
  await expect(abortTip).toBeVisible({ timeout: 3_000 });
  await expect(abortTip).toContainText('后台任务');
  await expect(abortTip).toContainText('打包日志');
  await expect(abortTip).toContainText('tar -czf log.tgz logs');
  await expect(abortTip).toContainText('压测脚本');
  await expect(abortTip).toContainText('子代理');
  await expect(abortTip).toContainText('浏览文件找规格');
  await expect(abortTip).not.toContainText('已完成的子代理');

  // AC-10（FR-003）：浮层只读——点击浮层区域不产生 abort 上行（pointer-events 穿透）
  const box = await abortTip.boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  const aborts = (await host.sentAll()).filter((m) => m.type === 'abort');
  expect(aborts).toHaveLength(0);

  // AC-4：移出立即隐藏
  await page.mouse.move(10, 10);
  await expect(abortTip).toBeHidden();

  // AC-11：显示期间快照刷新跟随（任务 2→1），两组皆空浮层关闭
  await abortButton.hover();
  await expect(abortTip).toBeVisible({ timeout: 3_000 });
  await host.send({
    type: 'sessionRuntimeStates',
    states: [
      {
        sessionId: sid, idle: false, waiting: false, queryRunning: false, compacting: false,
        pendingCompact: false, backgroundRunning: true, subAgentRunning: false,
        backgroundTasks: [{ taskId: 'bg-1', description: '打包日志', command: 'tar -czf log.tgz logs' }],
        subAgentDescription: null, parentSessionId: null,
      },
    ],
  });
  await expect(abortTip).toContainText('打包日志');
  await expect(abortTip).not.toContainText('压测脚本');
  await host.send({
    type: 'sessionRuntimeStates',
    states: [
      {
        sessionId: sid, idle: true, waiting: false, queryRunning: false, compacting: false,
        pendingCompact: false, backgroundRunning: false, subAgentRunning: false,
        backgroundTasks: [], subAgentDescription: null, parentSessionId: null,
      },
    ],
  });
  await expect(abortTip).toBeHidden();

  // AC-5：红色态（前台查询在跑）悬停超过 1s 无浮层
  await host.send({
    type: 'sessionRuntimeStates',
    states: [
      {
        sessionId: sid, idle: false, waiting: false, queryRunning: true, compacting: false,
        pendingCompact: false, backgroundRunning: false, subAgentRunning: false,
        backgroundTasks: [], subAgentDescription: null, parentSessionId: null,
      },
    ],
  });
  await expect(abortButton).toHaveAttribute('data-abort-state', 'query', { timeout: 10_000 });
  await abortButton.hover();
  await page.waitForTimeout(1500);
  await expect(abortTip).toHaveCount(0);

  // AC-5（续）：灰色态（空闲）同样无浮层——同一守卫，补全另一分支
  await host.send({
    type: 'sessionRuntimeStates',
    states: [
      {
        sessionId: sid, idle: true, waiting: false, queryRunning: false, compacting: false,
        pendingCompact: false, backgroundRunning: false, subAgentRunning: false,
        backgroundTasks: [], subAgentDescription: null, parentSessionId: null,
      },
    ],
  });
  await expect(abortButton).toHaveAttribute('data-abort-state', 'none', { timeout: 10_000 });
  await abortButton.hover();
  await page.waitForTimeout(1500);
  await expect(abortTip).toHaveCount(0);
});
