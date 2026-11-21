/**
 * 工具批次完成 → 下一轮 `aiBegin` 之间的「进行中指示」（docs/hosts/webview-ui.md 第 6 节）。
 *
 * 缺陷形态：一次查询里工具跑完（卡片从 running → success、风车熄灭）之后，到下一轮
 * `aiBegin` 点亮 thinking 动画之前，消息区**没有任何进行中的指示**。这段窗口的耗时
 * 全在 core 侧与宿主侧（工具结果落盘 → 全量重读 JSONL 刷 messageCount → 对话列表
 * 整目录重读 → 下一轮提示词组装与上下文估算 → 自动压缩 → 才发 `aiBegin`），
 * 远程 SSH 且多会话并行时被放大到肉眼可见。
 *
 * 判定点全在宿主侧，不经过 React：
 * - `SessionUiState`：工具计数归零时该会话是否仍在查询中，决定阶段回 `thinking`
 *   （等待下一轮）还是 `idle`；
 * - `WebViewUI`：工具收尾 / 轮次收尾时是否重新点亮 thinking 动画，以及查询收尾后
 *   迟到的工具结果不得重新点亮。
 *
 * 运行方式：npm run test:unit -- toolCompletionThinking
 */

import type { SessionRuntimeState } from '../shared/AssistantEventBus';
import { resetGlobalEventBus, setGlobalEventBus } from '../shared/AssistantEventBus';
import type { ConversationMetadata } from '../shared/history/Conversation';
import { ConversationManager } from '../host/ConversationManager';
import { SessionUiState } from '../host/SessionUiState';
import type { SpinDesign } from '../host/SpinDesign';
import { WebViewUI } from '../host/WebViewUI';
import { UserChoiceManager } from '../host/ui/userChoice';
import { createTestHost } from './helpers/fixtures';
import { createChecker, runTests } from './helpers/harness';
import { createTestBus } from './helpers/testBus';

const SESSION = 'session_gap';

/** 只实现 ConversationManager 的抽象成员：本用例不涉及列表与状态流 */
class StubConversationManager extends ConversationManager {
  protected async dispatchList(
    _list: readonly ConversationMetadata[],
    _workspace: string | undefined,
  ): Promise<void> {
    /* 桩：不分发 */
  }

  protected dispatchStates(_states: readonly SessionRuntimeState[]): void {
    /* 桩：不分发 */
  }
}

const stubSpinDesign: SpinDesign = {
  open: async () => undefined,
  refresh: async () => undefined,
};

runTests('toolCompletionThinking', async () => {
  const { check, finish } = createChecker();

  // ── RT-1：活动阶段——工具计数归零时仍在查询中，阶段是「等待下一轮」而不是 idle ──
  {
    const ui = new SessionUiState();
    ui.beginQuery(SESSION);
    ui.markThinking(SESSION);
    ui.beginToolPhase(SESSION);
    ui.markToolPhase(SESSION);
    ui.endToolPhase(SESSION);
    check(
      '工具批次收尾后查询仍在进行 → 阶段为 thinking（等待下一轮）'
        + `（实际：${ui.getActivityPhase(SESSION)}）`,
      ui.getActivityPhase(SESSION) === 'thinking',
    );
    check(
      '同一时刻查询计数仍为活跃（isQueryActive）',
      ui.isQueryActive(SESSION) === true,
    );

    // 并发工具：最后一个结束才回到 thinking
    const parallel = new SessionUiState();
    parallel.beginQuery(SESSION);
    parallel.beginToolPhase(SESSION);
    parallel.beginToolPhase(SESSION);
    parallel.endToolPhase(SESSION);
    check(
      '并发工具还有一个在跑 → 阶段保持 tool'
        + `（实际：${parallel.getActivityPhase(SESSION)}）`,
      parallel.getActivityPhase(SESSION) === 'tool',
    );
    parallel.endToolPhase(SESSION);
    check(
      '并发工具全部结束 → 阶段回到 thinking'
        + `（实际：${parallel.getActivityPhase(SESSION)}）`,
      parallel.getActivityPhase(SESSION) === 'thinking',
    );

    // 没有活跃查询的工具（Spin 直连工具 / 授权拒绝后的收尾）仍须回到 idle：
    // 这些路径不会再有下一轮，亮 thinking 就是撒谎。
    const noQuery = new SessionUiState();
    noQuery.beginToolPhase(SESSION);
    noQuery.endToolPhase(SESSION);
    check(
      '没有活跃查询时工具收尾 → 阶段仍是 idle'
        + `（实际：${noQuery.getActivityPhase(SESSION)}）`,
      noQuery.getActivityPhase(SESSION) === 'idle',
    );
  }

  // ── RT-2：宿主投递——工具收尾与轮次收尾都必须让 thinking 保持点亮 ──
  const bus = Object.assign(createTestBus(), {
    // CrossWorkspaceRouter：本用例不涉及跨工作区路由，命中即报错（不做静默兜底）
    connectionForSession: () => {
      throw new Error('connectionForSession is not exercised by this test');
    },
    connectionForWorkspace: () => undefined,
    assignSession: () => {
      throw new Error('assignSession is not exercised by this test');
    },
  });
  setGlobalEventBus(bus);
  const host = createTestHost();

  const ui = WebViewUI.create(
    host,
    bus as never,
    stubSpinDesign,
    new StubConversationManager(host),
    {
      createUserChoiceManager: (post, closePreview, uiPort) =>
        new UserChoiceManager({
          outputChannel: undefined,
          postToWebview: post,
          closePreview,
          isSessionOpenInternal: (sessionId) => uiPort.isSessionOpen(sessionId),
        }),
      log: () => undefined,
    },
  );

  /** 本会话收到的 `showThinkingAnimation` 帧（只取 show 值，按到达顺序） */
  const thinkingFrames = (from = 0): boolean[] => host.sent
    .slice(from)
    .filter((message) => (message as { type?: string }).type === 'showThinkingAnimation')
    .filter((message) => (message as { sessionId?: string }).sessionId === SESSION)
    .map((message) => (message as { show?: boolean }).show === true);

  try {
    // 一次真实查询：queryBegin → 本轮 aiBegin → 工具卡片 → 工具成功 → 本轮 aiEnd → 下一轮 aiBegin
    ui.onQueryBegin(SESSION);
    ui.onAIBegin(SESSION);
    // 卡片上屏时 webview 自己让出 thinking（`shouldKeepThinkingForToolCard`），宿主不参与
    await ui.requestToolPermission(
      SESSION, 'tool_1', 'Bash', { behavior: 'allow' }, { command: 'ls' }, 'auto',
    );
    ui.onToolCall(SESSION, 'tool_1', 'Bash', 'uuid_tool_1');

    // 工具成功收尾：卡片风车熄灭，后续还有落盘 / 列表刷新 / 下一轮组装。此刻必须重新点亮。
    const beforeToolResult = host.sent.length;
    ui.onToolResult(SESSION, 'tool_1', 'Bash', 'out', 'success');
    const afterToolResult = thinkingFrames(beforeToolResult);
    check(
      '工具成功收尾后立刻发出 thinking 点亮帧（不依赖下一轮 aiBegin）'
        + `（本次新增帧：${JSON.stringify(afterToolResult)}）`,
      afterToolResult.length === 1 && afterToolResult[0] === true,
    );
    check(
      '工具收尾后活动阶段是 thinking'
        + `（实际：${ui.getActivityPhase(SESSION)}）`,
      ui.getActivityPhase(SESSION) === 'thinking',
    );

    // 本轮的 aiEnd：下一轮立即开始（`aiBegin` 前还有落盘与提示词组装），不得熄灭
    const beforeAIEnd = host.sent.length;
    ui.onAIEnd(SESSION);
    const afterAIEnd = thinkingFrames(beforeAIEnd);
    check(
      '本轮 aiEnd 时查询仍在进行 → 不发 thinking 关闭帧'
        + `（本次新增帧：${JSON.stringify(afterAIEnd)}）`,
      afterAIEnd.length === 0,
    );
    check(
      '本轮 aiEnd 后阶段仍是 thinking（下一轮还没到）'
        + `（实际：${ui.getActivityPhase(SESSION)}）`,
      ui.getActivityPhase(SESSION) === 'thinking',
    );

    // 下一轮开始
    ui.onAIBegin(SESSION);
    check(
      '下一轮 aiBegin 后 thinking 处于显示态'
        + `（最近帧：${JSON.stringify(thinkingFrames())}）`,
      thinkingFrames().at(-1) === true,
    );

    // 整轮查询收尾：这是唯一允许熄灭 thinking 的位置
    ui.onQueryEnd(SESSION);
    check(
      'queryEnd 收尾后 thinking 关闭'
        + `（最近帧：${JSON.stringify(thinkingFrames())}）`,
      thinkingFrames().at(-1) === false,
    );
    check(
      '查询收尾后活动阶段回到 idle'
        + `（实际：${ui.getActivityPhase(SESSION)}）`,
      ui.getActivityPhase(SESSION) === 'idle',
    );

    // 查询结束后迟到的工具收尾（abort 后的取消结果）：不得把 thinking 重新点亮
    const beforeLateTool = host.sent.length;
    ui.onToolResult(SESSION, 'tool_2', 'Bash', 'canceled', 'error');
    check(
      '查询已收尾时迟到的工具结果不点亮 thinking'
        + `（本次新增帧：${JSON.stringify(thinkingFrames(beforeLateTool))}）`,
      thinkingFrames(beforeLateTool).length === 0,
    );
  } finally {
    resetGlobalEventBus();
  }

  finish();
});
