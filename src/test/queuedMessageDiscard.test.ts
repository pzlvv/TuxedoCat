/**
 * 排队消息撤回单测（Embedded，`docs/user-message-pipeline.md` 第 5.2 节）：
 *
 * webview 排队项的「编辑 / 删除」经 `UiEvent.queuedMessageDiscarded` 到达
 * `QueryEngine.discardPendingUserMessage`：
 * - uuid 配对的排队消息被丢弃（pendingUserMessage / pendingUserMsgData /
 *   pendingSkillInjection 一并清除）；
 * - uuid 不匹配（已被消费 / 被更新的排队消息替换）时不动；
 * - 不置 abortRequested：撤回排队项不打断正在运行的查询。
 *
 * Standalone 侧同一行为由 `core-rs/src/engine.rs` 的 `on_queued_message_discarded`
 * 实现，对应用例 `core-rs/src/engine_tests.rs::queued_message_is_discarded_by_uuid`
 * 与 `::queued_message_discard_is_a_noop_on_uuid_mismatch`。
 *
 * 运行方式：npm run test:all -- queued-message-discard
 */

import { createEventBus } from '../host/EventBus';
import { setGlobalEventBus, resetGlobalEventBus } from '../core/AssistantEventBus';
import { createChecker, runTests } from './helpers/harness';
import { createRecordingCoreEventHandlers, makeTempDir } from './helpers/fixtures';
import { setSessionWorkspace } from '../core/history/Config';
import { QueryEngine } from '../core/QueryEngine';

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  const recording = createRecordingCoreEventHandlers();
  const bus = createEventBus();
  bus.onCoreEvents(recording.handlers);
  setGlobalEventBus(bus);

  const root = makeTempDir('queued-message-discard');
  setSessionWorkspace('s1', root);
  try {
    const engine = new QueryEngine('s1', {
      cwd: root,
      tools: [],
      getAppState: () => ({}),
      setAppState: () => {},
    });

    const internals = engine as unknown as {
      pendingUserMessage: string | null;
      pendingUserMsgUuid: string | null;
      pendingUserMsgData: { uuid?: string; _needsUINotification?: boolean } | null;
      pendingSkillInjection: unknown;
      abortRequested: boolean;
    };

    // 排队中间态：宿主入口走 userMsgData（uuid 随数据携带），同 abort 的第 1.5 步只认
    // _needsUINotification（deferEcho）的消息——排队项只在这类消息上登记。
    internals.pendingUserMessage = '排队消息';
    internals.pendingUserMsgUuid = null;
    internals.pendingUserMsgData = { uuid: 'u1', _needsUINotification: true };
    internals.pendingSkillInjection = { skillName: 'spin', skillArgs: '' };

    // uuid 不匹配：已被消费 / 被更新的排队消息替换 → 不动
    engine.discardPendingUserMessage('u-other');
    check('uuid 不匹配时保留排队消息', internals.pendingUserMessage === '排队消息');
    check('uuid 不匹配时保留 Skill 待注入', internals.pendingSkillInjection !== null);

    // uuid 配对：丢弃排队消息，连带清除 uuid / data / Skill 注入
    engine.discardPendingUserMessage('u1');
    check('uuid 配对时丢弃排队消息', internals.pendingUserMessage === null);
    check('pendingUserMsgData 一并清除', internals.pendingUserMsgData === null);
    check('pendingUserMsgUuid 一并清除', internals.pendingUserMsgUuid === null);
    check('pendingSkillInjection 一并清除', internals.pendingSkillInjection === null);

    // 引擎队列已空（消息已被消费）：幂等不动
    engine.discardPendingUserMessage('u1');
    check('队列已空时幂等', internals.pendingUserMessage === null);

    // 撤回排队项不打断正在运行的查询（abortRequested 不被置位）
    check('不置 abortRequested', internals.abortRequested === false);
  } finally {
    resetGlobalEventBus();
  }

  finish();
}

runTests('queued-message-discard', run);
