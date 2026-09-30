/**
 * 崩溃恢复补出的 tool_result 落盘对等测试（Embedded ↔ Standalone）。
 *
 * 场景：assistant 的 `tool_use` 已落盘、tool_result 未生成（进程崩溃），下次加载时
 * 两侧都会补一条「会话中断」的取消结果。Embedded 的 `ensureToolResults` 只把它加进
 * 内存，随后 `QueryEngine.persistUnpersistedMessages` 在下一次持久化时机按序补写，
 * 且使用消息自带的 `parentUuid`（指向包含该 tool_use 的 assistant），避免自引用节点
 * 让 BFS 建链把后续消息整条孤立。
 *
 * 断言口径：
 * - `loadConversation` 返回的恢复消息带 `parentUuid = assistant.uuid`；
 * - 下一条消息落盘前，恢复消息先写进 jsonl（磁盘顺序：assistant → 恢复结果 → 新消息）；
 * - 新消息的 `parentUuid` 接在恢复消息之后；
 * - 恢复消息计入 `meta.json` 的 `messageCount`。
 *
 * Standalone 侧同一行为由 `core-rs/src/engine_tests.rs::
 * crash_recovered_tool_results_are_persisted_before_the_next_user_message`
 * 与 `core-rs/src/history_tests.rs` 的链重建用例覆盖。
 * 运行方式：npm run test:all -- history-crash-recovery-parity
 */

import * as fs from 'fs';
import * as path from 'path';
import { createEventBus } from '../host/EventBus';
import { setGlobalEventBus } from '../core/AssistantEventBus';
import { createChecker, runTests } from './helpers/harness';
import { createRecordingCoreEventHandlers, makeTempDir } from './helpers/fixtures';
import { setSessionWorkspace, getProjectConversationDir } from '../core/history/Config';
import { loadConversation } from '../core/history/Conversation';
import { QueryEngine } from '../core/QueryEngine';

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  const recording = createRecordingCoreEventHandlers();
  const bus = createEventBus();
  bus.onCoreEvents(recording.handlers);
  setGlobalEventBus(bus);

  const root = makeTempDir('history-crash-recovery-parity');
  const conversationDir = getProjectConversationDir(root);
  fs.mkdirSync(conversationDir, { recursive: true });

  const sessionId = 'crash-1';
  setSessionWorkspace(sessionId, root);
  const assistant = {
    uuid: 'a1',
    parentUuid: null,
    timestamp: 1,
    message: {
      type: 'assistant',
      uuid: 'a1',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_orphan', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    },
  };
  fs.writeFileSync(
    path.join(conversationDir, `${sessionId}.jsonl`),
    `${JSON.stringify(assistant)}\n`,
  );
  fs.writeFileSync(
    path.join(conversationDir, `${sessionId}.meta.json`),
    JSON.stringify({ sessionId, project: root, title: 'crash', messageCount: 1 }),
  );

  // 第一次加载：补出恢复消息（内存）
  const conversation = await loadConversation(sessionId);
  const recovered = conversation.messages.find(
    (message) => typeof (message as { uuid?: unknown }).uuid === 'string'
      && String((message as { uuid: string }).uuid).startsWith('tool_recovered_'),
  ) as { uuid: string; parentUuid?: string | null; message: { content: Array<{ is_canceled?: boolean }> } } | undefined;
  check('恢复消息已补出', !!recovered);
  check('恢复消息 parentUuid 指向 assistant', recovered?.parentUuid === 'a1');
  check('恢复消息标记 is_canceled', recovered?.message.content?.[0]?.is_canceled === true);

  // 下一次持久化时机（reminder 轮次）：恢复消息应先落盘，再写新消息
  const engine = new QueryEngine(sessionId, {
    cwd: root,
    tools: [],
    getAppState: () => ({}),
    setAppState: () => {},
    initialMessages: conversation.messages,
  });
  engine.appendReminder('<reminder>hello</reminder>');
  const flushed = engine.flushQueuedMessagesIntoContext();
  check('reminder 被 flush', flushed === 1);
  await engine.flush();
  // 对齐 `Conversation.appendMessage`：每落盘一条消息各发一次列表变化——
  // 恢复结果 + reminder = 2 次。
  check(
    '恢复结果也各发一次 conversationListChanged',
    recording.received('conversationListChanged').length === 2,
  );

  const lines = fs
    .readFileSync(path.join(conversationDir, `${sessionId}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { uuid: string; parentUuid?: string | null });
  check('磁盘顺序：assistant → 恢复结果 → 新消息', lines.length === 3);
  check('第 1 条是 assistant', lines[0]?.uuid === 'a1');
  check('第 2 条是恢复结果', lines[1]?.uuid === recovered?.uuid);
  check('恢复结果 parentUuid = a1', lines[1]?.parentUuid === 'a1');
  check('新消息 parentUuid 接在恢复结果之后', lines[2]?.parentUuid === recovered?.uuid);

  const metadata = JSON.parse(
    fs.readFileSync(path.join(conversationDir, `${sessionId}.meta.json`), 'utf8'),
  ) as { messageCount?: number };
  check('恢复结果计入 messageCount', metadata.messageCount === 3);

  finish();
}

void runTests('history-crash-recovery-parity', run);
