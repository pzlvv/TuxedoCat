/**
 * 事件粒度对等测试（Embedded ↔ Standalone）。
 *
 * 本文件断言 Embedded 侧（真值）的四条事件粒度口径，Standalone 侧在
 * `core-rs/src/engine.rs` 用同名用例断言同一行为：
 * - `Conversation.appendMessage` **每落盘一条消息**发一次 `conversationListChanged`
 *   （不是每轮只发一次）；对应用例
 *   `core-rs/src/engine_tests.rs::full_turn_with_a_tool_call_emits_events_and_persists_messages`。
 * - `sessionRuntime.pushIfChanged` 内部 diff：状态没变不发 `sessionRuntimeChanged`；
 *   有变化时按会话**插入序**推全量快照；对应用例
 *   `core-rs/src/engine_tests.rs::emit_runtime_is_silent_when_nothing_changed` /
 *   `session_runtime_states_follow_insertion_order`。
 * - `titleChanged` 只在 `conversationRenamed`（与 Spin 改名）时发出，新消息推导标题不发；
 *   对应用例 `core-rs/src/engine_tests.rs::title_changed_is_only_emitted_for_renames`。
 * - `queryBegin` / `queryEnd` 是**消费循环级**：Embedded `submitMessage` 启动 consumer 时
 *   发一次 queryBegin，`finalizeIdle` 在队列排空 / 中止时发一次 queryEnd；一轮用户消息
 *   内部的多个 LLM 轮次（reminder 追问、排队消息并入）同属一次 consumer，只发一对。
 *   对应用例 `core-rs/src/engine_tests.rs::assistant_reply_ending_with_a_colon_triggers_a_silent_reminder_follow_up`
 *   与端到端 `src/test/standaloneCoreEngine.test.ts` 的「reminder 追问只有一对 queryBegin/queryEnd」。
 *
 * 运行方式：npm run test:all -- event-granularity-parity
 */

import * as assert from 'assert';
import { createEventBus } from '../host/EventBus';
import { setGlobalEventBus, resetGlobalEventBus } from '../core/AssistantEventBus';
import { createChecker, runTests } from './helpers/harness';
import { createRecordingCoreEventHandlers, makeTempDir, provideHostEnvironment } from './helpers/fixtures';
import { setSessionWorkspace } from '../core/history/Config';
import { appendMessage } from '../core/history/Conversation';
import {
  markQueryRunning,
  markSessionWaiting,
  resetSessionRuntime,
} from '../core/sessionRuntime';
import { initializeCoreEvents } from '../core/initializeCoreEvents';

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  const recording = createRecordingCoreEventHandlers();
  const bus = createEventBus();
  bus.onCoreEvents(recording.handlers);
  setGlobalEventBus(bus);

  const root = makeTempDir('event-granularity-parity');
  setSessionWorkspace('s1', root);
  try {
    // ===== 1. appendMessage 每条消息各发一次 conversationListChanged =====
    const sessionId = 's1';
    for (const [uuid, type] of [
      ['u1', 'user'],
      ['a1', 'assistant'],
      ['t1', 'user'],
      ['a2', 'assistant'],
    ] as const) {
      await appendMessage(
        {
          type,
          message: {
            role: type,
            content: type === 'assistant' ? [{ type: 'text', text: 'ok' }] : 'hi',
          },
          uuid,
        } as never,
        sessionId,
      );
    }
    check(
      'appendMessage 每条消息各发一次 conversationListChanged',
      recording.count('conversationListChanged') === 4,
    );
    check('appendMessage 不发 titleChanged', recording.count('titleChanged') === 0);

    // ===== 2. sessionRuntime 的 diff 与插入序 =====
    resetSessionRuntime();
    recording.received('sessionRuntimeChanged').length = 0;

    markQueryRunning('s-b', true);
    markQueryRunning('s-a', true);
    markQueryRunning('s-c', true);
    // 每新增一个会话都是变化，各发一次
    check('新增会话各发一次 sessionRuntimeChanged', recording.count('sessionRuntimeChanged') === 3);
    const first = recording.last('sessionRuntimeChanged');
    assert.ok(first);
    check(
      'states 按会话插入序输出',
      first.states.map((state) => state.sessionId).join(',') === 's-b,s-a,s-c',
    );

    // 幂等：重复标记同一状态不再发
    markQueryRunning('s-b', true);
    markQueryRunning('s-a', true);
    check(
      '状态未变时不重发 sessionRuntimeChanged',
      recording.count('sessionRuntimeChanged') === 3,
    );

    markSessionWaiting('s-a', true);
    check('状态变化后重发 sessionRuntimeChanged', recording.count('sessionRuntimeChanged') === 4);
    const second = recording.last('sessionRuntimeChanged');
    assert.ok(second);
    check(
      'waiting 变化反映到快照',
      second.states.find((state) => state.sessionId === 's-a')?.waiting === true,
    );

    // ===== 3. conversationRenamed 才发 titleChanged =====
    initializeCoreEvents(bus);
    // `registerHistoryUiEvents` 是异步注册（内部 `await import`），等处理器就位
    await new Promise((resolve) => setTimeout(resolve, 300));
    // 宿主连接：就绪前只接受 hostEnvironmentProvided（docs/architecture/core-ui-separation.md 第 7 节）
    provideHostEnvironment(bus);
    recording.received('titleChanged').length = 0;
    recording.received('conversationListChanged').length = 0;
    bus.emitToCore({ type: 'conversationRenamed', sessionId, title: '手动标题' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    check('改名发 titleChanged', recording.count('titleChanged') === 1);
    check('改名同时发 conversationListChanged', recording.count('conversationListChanged') === 1);
  } finally {
    resetSessionRuntime();
    resetGlobalEventBus();
  }

  finish();
}

runTests('eventGranularityParity', run);
