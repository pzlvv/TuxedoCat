/**
 * 对等测试：显式改标题（用户重命名 / 智能命名 / spin 改名）的落盘口径。
 *
 * Embedded（`updateConversationMetadataTitle`）的口径：
 * - meta.json 缺失时**建档**（标题 + messageCount 从已落盘 .jsonl 数出 + 补空 .jsonl）：
 *   显式改标题必须落到磁盘，否则 UI 收到的 titleChanged 与磁盘不一致——
 *   重启 / 刷新列表后标题回到「未命名」；
 * - 已有 meta.json 时只改 title，不 touch updatedAt（保持「最后消息时间」语义）；
 * - 显式标题不被首条用户消息的推导标题覆盖（`updateMetadataForNewMessage` 只在
 *   meta.json 尚无标题时才用首条消息生成标题）。
 *
 * Standalone 侧同一行为由 `core-rs/src/engine_tests.rs`
 * （`rename_without_a_metadata_file_creates_it_and_broadcasts_title_changed`）与
 * `core-rs/src/spin_host_tests.rs`
 * （`ready_design_creates_missing_metadata_and_broadcasts_the_list_refresh`）覆盖。
 *
 * 运行方式：npm run test:all -- conversation-rename-parity
 */

import * as fs from 'fs';
import * as path from 'path';
import { createEventBus } from '../host/EventBus';
import { setGlobalEventBus, resetGlobalEventBus } from '../core/AssistantEventBus';
import { createChecker, runTests } from './helpers/harness';
import { createRecordingCoreEventHandlers, makeTempDir } from './helpers/fixtures';
import { setSessionWorkspace, getProjectConversationDir } from '../core/history/Config';
import { appendMessage, updateConversationMetadataTitle } from '../core/history/Conversation';

function metaPathOf(projectRoot: string, sessionId: string): string {
  return path.join(getProjectConversationDir(projectRoot), `${sessionId}.meta.json`);
}

function jsonlPathOf(projectRoot: string, sessionId: string): string {
  return path.join(getProjectConversationDir(projectRoot), `${sessionId}.jsonl`);
}

function readMeta(projectRoot: string, sessionId: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(metaPathOf(projectRoot, sessionId), 'utf8')) as Record<string, unknown>;
}

async function appendUserMessage(projectRoot: string, sessionId: string, text: string): Promise<void> {
  await appendMessage({
    type: 'user',
    message: { role: 'user', content: text },
  } as never, sessionId);
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  const bus = createEventBus();
  bus.onCoreEvents(createRecordingCoreEventHandlers().handlers);
  setGlobalEventBus(bus);
  const root = makeTempDir('conversation-rename-parity');

  // ===== 缺失 meta.json：建档 =====
  setSessionWorkspace('r1', root);
  await updateConversationMetadataTitle('r1', 'Spin Design');
  const created = readMeta(root, 'r1');
  check('缺失 meta.json 时建档并写入标题', created.title === 'Spin Design');
  check('建档的 sessionId 正确', created.sessionId === 'r1');
  check('无消息时 messageCount 为 0', created.messageCount === 0);
  check('建档补空 .jsonl', fs.existsSync(jsonlPathOf(root, 'r1')));

  // ===== 显式标题不被首条用户消息覆盖 =====
  await appendUserMessage(root, 'r1', '[1/100] Starting: Task 1 - 做点什么');
  check(
    '显式标题不被首条消息的推导标题覆盖',
    readMeta(root, 'r1').title === 'Spin Design',
  );
  check('建档后消息计数正常递增', readMeta(root, 'r1').messageCount === 1);

  // ===== 已有 meta.json：只改 title，不 touch updatedAt =====
  setSessionWorkspace('r2', root);
  await appendUserMessage(root, 'r2', '第一句');
  const beforeRename = readMeta(root, 'r2');
  check('对照：无显式标题时首条消息推导标题', beforeRename.title === '第一句');
  await new Promise(resolve => setTimeout(resolve, 5));
  await updateConversationMetadataTitle('r2', '手动改名');
  const afterRename = readMeta(root, 'r2');
  check('已有 meta.json 时更新标题', afterRename.title === '手动改名');
  check('改名不 touch updatedAt', afterRename.updatedAt === beforeRename.updatedAt);

  // ===== meta.json 缺失但 .jsonl 已有消息：messageCount 按已落盘消息数 =====
  setSessionWorkspace('r3', root);
  await appendUserMessage(root, 'r3', '消息一');
  await appendUserMessage(root, 'r3', '消息二');
  // 追加一条 tool_use_update 记录（顶层 type、无 message 包装）：不是消息，不计数
  fs.appendFileSync(
    jsonlPathOf(root, 'r3'),
    JSON.stringify({ type: 'tool_use_update', toolUseId: 'tu-1', timestamp: 1 }) + '\n',
  );
  fs.unlinkSync(metaPathOf(root, 'r3'));
  await updateConversationMetadataTitle('r3', '重建标题');
  check('meta 缺失但 .jsonl 有消息时按实数建档', readMeta(root, 'r3').messageCount === 2);

  resetGlobalEventBus();
  finish();
}

runTests('conversation-rename-parity', run);
