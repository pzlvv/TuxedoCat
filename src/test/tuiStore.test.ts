import { setHostLocale } from '../host/i18n';
import {
  activeSession,
  createTuiStore,
  initialTuiState,
  reduceTuiState,
  runtimeLabel,
  type TuiAction,
  type TuiState,
} from '../tui/store';
import { createChecker, runTests } from './helpers/harness';

/**
 * TUI store 纯 reducer（docs/tui.md 第 4 节：wire 协议是事实，store 是只读投影）。
 *
 * 覆盖：消息流（流式 / 定稿 / 去重 / token）、排队配对清除、工具卡片去重与状态
 * 不降级、会话配置确认回写、用户选择、通知（i18n 键翻译 / 未知键回显）、本地动作
 * （激活 / 切出 / 覆盖层 / 通知消散）、未知消息丢弃并记日志。
 *
 * 运行方式：npm run test:all -- tuiStore
 */

/** reducer 快捷封装：'unhandled' 直接判测试失败（表驱动里每个动作都应被认识） */
function step(state: TuiState, action: TuiAction): TuiState {
  const next = reduceTuiState(state, action);
  if (next === 'unhandled') throw new Error(`动作未被 reducer 认识：${action.type}`);
  return next;
}

runTests('tuiStore', async () => {
  const { check, finish } = createChecker();
  setHostLocale('zh-CN');

  const SID = 'session-1';

  // ── 消息流 ──
  let state = initialTuiState();
  state = step(state, { type: 'tui:activateSession', sessionId: SID });
  check('激活会话', state.activeSessionId === SID);

  state = step(state, { type: 'queuedMessage', sessionId: SID, uuid: 'u1', content: '排队内容' });
  check('排队消息进入会话投影', state.sessions[SID]!.queued?.uuid === 'u1');

  state = step(state, {
    type: 'addMessage', sessionId: SID, role: 'user', content: '排队内容', messageUuid: 'u1',
  })!;
  check('用户回显按 uuid 清除排队项', state.sessions[SID]!.queued === null);
  check('用户消息上屏', state.sessions[SID]!.messages.length === 1 && state.sessions[SID]!.messages[0].role === 'user');

  state = step(state, { type: 'streamMessage', sessionId: SID, role: 'assistant', delta: '你', accumulated: '你' });
  state = step(state, { type: 'streamMessage', sessionId: SID, role: 'assistant', delta: '好', accumulated: '你好' });
  check('流式缓冲取累积值', state.sessions[SID]!.stream?.text === '你好');

  state = step(state, {
    type: 'streamEnd', sessionId: SID, role: 'assistant', accumulated: '你好',
    usage: { input_tokens: 100, output_tokens: 20 },
  })!;
  const session = state.sessions[SID]!;
  check('streamEnd 定稿消息', session.messages.some((m) => m.role === 'assistant' && m.content === '你好'));
  check('streamEnd 清空流式缓冲', session.stream === null);
  check('token 用量 = input + output', session.contextTokens === 120);

  state = step(state, {
    type: 'addMessage', sessionId: SID, role: 'assistant', content: '你好',
  })!;
  check('定稿后同内容 addMessage 相邻去重（不双显）', state.sessions[SID]!.messages.filter((m) => m.content === '你好').length === 1);

  // ── 工具卡片 ──
  state = step(state, {
    type: 'addMessage', sessionId: SID, role: 'toolcall', content: 'ok', toolName: 'Bash', toolCallId: 't1', status: 'running',
  })!;
  state = step(state, {
    type: 'addMessage', sessionId: SID, role: 'toolcall', content: 'done', toolName: 'Bash', toolCallId: 't1', status: 'success',
  })!;
  const cards = state.sessions[SID]!.messages.filter((m) => m.toolCallId === 't1');
  check('工具卡片按 toolCallId 去重', cards.length === 1 && cards[0].status === 'success' && cards[0].content === 'done');

  state = step(state, { type: 'updateToolStatus', sessionId: SID, toolCallId: 't1', status: 'normal' });
  check('终态不回退', state.sessions[SID]!.messages.find((m) => m.toolCallId === 't1')?.status === 'success');

  // ── 会话配置确认（宿主广播的双向消息） ──
  state = step(state, { type: 'setModel', sessionId: SID, model: 'gpt-x', provider: 'p1' });
  state = step(state, { type: 'setAgentMode', sessionId: SID, mode: 'auto' });
  state = step(state, { type: 'setWebSearch', sessionId: SID, webSearch: true });
  check('setModel / setAgentMode / setWebSearch 回写会话', state.sessions[SID]!.model === 'gpt-x'
    && state.sessions[SID]!.provider === 'p1'
    && state.sessions[SID]!.agentMode === 'auto'
    && state.sessions[SID]!.webSearch === true);

  // ── 用户选择 / 权限确认 ──
  state = step(state, {
    type: 'requestUserChoice', sessionId: SID, choiceId: 'c1', toolName: 'Edit',
    message: '允许修改？', choices: [{ label: '允许' }, { label: '拒绝' }],
  })!;
  check('requestUserChoice 进 pendingChoice', state.pendingChoice?.choiceId === 'c1' && state.pendingChoice?.choices.length === 2);

  // ── 配置面事实 ──
  state = step(state, {
    type: 'settingsDefaults', model: 'm1', provider: 'p1', thinkingMode: 'low', agentMode: 'manual', webSearch: false,
  })!;
  check('settingsDefaults 保存', state.settingsDefaults?.model === 'm1' && state.settingsDefaults?.thinkingMode === 'low');
  state = step(state, {
    type: 'setModels', providers: [{ key: 'p1', models: ['m1', 'm2'] }], activeProvider: 'p1',
  })!;
  check('setModels 保存', state.models?.providers[0].models.length === 2 && state.models?.activeProvider === 'p1');
  state = step(state, { type: 'contextLimitUpdated', maxContextTokens: 200000 });
  check('上下文上限保存', state.maxContextTokens === 200000);
  state = step(state, {
    type: 'conversationsData',
    conversations: [{ sessionId: 's9', title: '旧会话', createdAt: 1, updatedAt: 2, messageCount: 3 }],
  })!;
  check('会话列表保存', state.conversations.length === 1 && state.conversations[0].sessionId === 's9');
  state = step(state, {
    type: 'sessionRuntimeStates',
    states: [{ sessionId: SID, idle: false, waiting: false, queryRunning: true, compacting: false, backgroundRunning: false, subAgentRunning: false }],
  })!;
  check('运行态投影与展示名', runtimeLabel(state.runtimeStates[0]) === 'running');

  // ── 通知 ──
  state = step(state, { type: 'notice', key: 'notice.spin.variableNoValueWithNames', params: { names: 'a、b' }, level: 'warn' });
  check('notice 键经字典翻译并替换参数', state.notices[state.notices.length - 1]?.text.includes('a、b'));
  state = step(state, { type: 'notice', key: 'notice.unknown.key', params: {}, level: 'info' });
  check('未知 notice 键回显键本身', state.notices[state.notices.length - 1]?.text === 'notice.unknown.key');
  const noticeId = state.notices[state.notices.length - 1]!.id;
  state = step(state, { type: 'tui:dismissNotice', id: noticeId });
  check('通知按 id 消散', !state.notices.some((n) => n.id === noticeId));

  // ── 覆盖层与 closeConversationView ──
  state = step(state, { type: 'tui:showOverlay', overlay: { kind: 'diff', title: 't', lines: [{ text: '+ x', color: 'green' }] } });
  check('覆盖层进入状态', state.overlay?.kind === 'diff');
  state = step(state, { type: 'tui:closeOverlay' });
  check('覆盖层关闭', state.overlay === null);
  state = step(state, { type: 'tui:closeConversationView', sessionId: '别的会话' });
  check('关闭非活动会话视图无显示变化', state.activeSessionId === SID);
  state = step(state, { type: 'tui:closeConversationView', sessionId: SID });
  check('关闭活动会话视图切出', state.activeSessionId === null);
  check('activeSession 选择器返回 null', activeSession(state) === null);

  // ── 未知消息：丢弃 + 记日志 ──
  const dropped: string[] = [];
  const store = createTuiStore((line) => dropped.push(line));
  const beforeUnknown = store.getState();
  store.dispatch({ type: 'not-a-real-message' } as unknown as TuiAction);
  check('未知 type 丢弃并记日志', dropped.length === 1 && dropped[0].includes('not-a-real-message'));
  check('未知 type 不改状态（同引用）', store.getState() === beforeUnknown);

  // ── conversationLoaded 历史映射 ──
  let loaded = initialTuiState();
  loaded = step(loaded, { type: 'tui:activateSession', sessionId: 'hist' });
  loaded = step(loaded, {
    type: 'conversationLoaded',
    sessionId: 'hist',
    conversation: {
      metadata: { title: '历史会话' },
      messages: [
        { role: 'user', content: '问' },
        { role: 'assistant', content: '答', contextLength: 10, outputTokens: 5 },
      ],
    },
    model: 'm2',
    agentMode: 'risk',
  })!;
  const hist = loaded.sessions['hist']!;
  check('历史消息映射', hist.messages.length === 2 && hist.messages[1].contextTokens === 15);
  check('历史元数据映射', hist.title === '历史会话' && hist.model === 'm2' && hist.agentMode === 'risk');

  finish();
});
