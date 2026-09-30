/**
 * 排队消息 flush 对等测试（Embedded ↔ Standalone）。
 *
 * 本文件断言 Embedded 侧（真值）`QueryEngine.flushQueuedMessagesIntoContext()` 的两条口径，
 * Standalone 侧在 `core-rs/src/engine.rs` 用同名用例断言同一行为：
 *
 * 1. 查询中途排队的用户消息，会在**下一次 LLM 请求前**并入上下文并落盘
 *    （`Query.ts` 阶段 0.5 每轮调用 `flushQueuedMessagesIntoContext()`），
 *    而不是等整轮结束再单独起一轮。对应用例
 *    `core-rs/src/engine_tests.rs::queued_message_is_flushed_before_the_next_llm_round`。
 * 2. Reminder 与普通用户消息一样落盘（`persistUnpersistedMessages`）：写进 jsonl、
 *    计入 `meta.json` 的 `messageCount`、每条各发一次 `conversationListChanged`；
 *    它仍是 `silent` / `origin=agent` 的自动消息。对应用例
 *    `core-rs/src/engine_tests.rs::assistant_reply_ending_with_a_colon_triggers_a_silent_reminder_follow_up`。
 *
 * 运行方式：npm run test:all -- queue-flush-parity
 */

import { createEventBus } from '../host/EventBus';
import { setGlobalEventBus, resetGlobalEventBus } from '../core/AssistantEventBus';
import { createChecker, runTests } from './helpers/harness';
import { createRecordingCoreEventHandlers, makeTempDir } from './helpers/fixtures';
import { setSessionWorkspace } from '../core/history/Config';
import { loadConversation } from '../core/history/Conversation';
import { QueryEngine } from '../core/QueryEngine';

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  const recording = createRecordingCoreEventHandlers();
  const bus = createEventBus();
  bus.onCoreEvents(recording.handlers);
  setGlobalEventBus(bus);

  const root = makeTempDir('queue-flush-parity');
  setSessionWorkspace('s1', root);
  try {
    const sessionId = 's1';
    const engine = new QueryEngine(sessionId, {
      cwd: root,
      tools: [],
      getAppState: () => ({}),
      setAppState: () => {},
    });

    // ===== 1. 查询中途排队的用户消息在下一次 LLM 请求前进入上下文 =====
    // 直接构造「consumer 正在跑、pendingUserMessage 已排队」的中间态，
    // 调用 query 循环每轮都会调用的 flush 入口。
    (engine as unknown as { pendingUserMessage: string | null }).pendingUserMessage = '排队消息';
    const flushed = engine.flushQueuedMessagesIntoContext();
    check('排队用户消息被 flush（返回 1）', flushed === 1);
    const mutable = (
      engine as unknown as { mutableMessages: Array<{ type?: string; message?: { content?: unknown } }> }
    ).mutableMessages;
    check(
      '排队消息进入 mutableMessages',
      mutable.some((m) => m.type === 'user' && m.message?.content === '排队消息'),
    );
    await engine.flush();

    // ===== 2. Reminder 与普通消息一样落盘 =====
    recording.received('conversationListChanged').length = 0;
    engine.appendReminder('<reminder>hello-reminder</reminder>');
    const flushedReminder = engine.flushQueuedMessagesIntoContext();
    check('reminder 被 flush（返回 1）', flushedReminder === 1);
    await engine.flush();

    const conversation = await loadConversation(sessionId);
    const contents = conversation.messages.map((m) => (m as { message?: { content?: unknown } })?.message?.content);
    check('排队消息已落盘', contents.includes('排队消息'));

    const reminder = conversation.messages.find(
      (m) =>
        typeof (m as { message?: { content?: unknown } })?.message?.content === 'string' &&
        ((m as { message: { content: string } }).message.content.startsWith('<reminder>')),
    ) as { silent?: boolean; origin?: string } | undefined;
    check('reminder 已落盘', !!reminder);
    check('reminder 带 silent', reminder?.silent === true);
    check('reminder 带 origin=agent', reminder?.origin === 'agent');
    check('reminder 计入 messageCount', conversation.metadata.messageCount === 2);
    check(
      'reminder 落盘发一次 conversationListChanged',
      recording.count('conversationListChanged') === 1,
    );
  } finally {
    resetGlobalEventBus();
  }

  finish();
}

runTests('queue-flush-parity', run);
