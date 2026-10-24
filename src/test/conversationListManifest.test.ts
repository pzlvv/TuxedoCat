/**
 * 回归测试：对话列表的两个 e2e 实证缺陷（原 e2e/README.md「已知产品问题」）。
 *
 * 1. 工作区清单 `workspace.meta.json` 不是会话：`loadConversationList` /
 *    `readProjectConversationMetadata` 列出它会渲染成「(未命名对话) NaN/NaN/NaN」
 *    的幽灵条目，两处都必须排除。
 * 2. 删除会话后列表缓存必须同步移除：`deleteConversation` 之后
 *    `loadConversationList` 不能命中含已删会话的脏缓存（宿主
 *    conversationListChanged → refresh() 读的就是这份缓存，脏缓存 = 侧栏条目残留）。
 *
 * 运行方式：npm run test:all -- conversationListManifest
 */

import * as fs from 'fs';
import * as path from 'path';
import { createChecker, runTests } from './helpers/harness';
import { makeTempDir, makeTestBus } from './helpers/fixtures';
import { setGlobalEventBus } from '../shared/AssistantEventBus';
import { getConversationDir, setSessionWorkspace } from '../shared/history/Config';
import {
  deleteConversation,
  loadConversationList,
  readProjectConversationMetadata,
} from '../shared/history/Conversation';

const home = makeTempDir('conversation-list-manifest-home');
process.env.USERPROFILE = home;
process.env.HOME = home;

function writeSession(dir: string, sessionId: string, creator: unknown = { kind: 'user' }): void {
  fs.writeFileSync(
    path.join(dir, `${sessionId}.meta.json`),
    JSON.stringify({ sessionId, title: sessionId, createdAt: 1, updatedAt: 1, messageCount: 2, creator }),
  );
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), '{"uuid":"u1"}\n');
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  const project = path.join(home, 'ws');
  const dir = path.join(getConversationDir(), encodeURIComponent(project));
  fs.mkdirSync(dir, { recursive: true });
  // 工作区清单：真实产品里由 ensureProjectConversationDir 写入（记录完整 workspacePath）
  fs.writeFileSync(path.join(dir, 'workspace.meta.json'), JSON.stringify({ workspacePath: project }));
  writeSession(dir, 'session_keep');
  writeSession(dir, 'session_del');
  // creator 缺失 / 形态不对的 meta 是数据异常（specs/025 FR-002）：读取侧报错跳过该条目
  // （无 creator 的 meta 要绕过 writeSession 的默认参数直写，undefined 会命中默认值）
  fs.writeFileSync(
    path.join(dir, 'session_nocreator.meta.json'),
    JSON.stringify({ sessionId: 'session_nocreator', title: 'session_nocreator', createdAt: 1, updatedAt: 1, messageCount: 2 }),
  );
  fs.writeFileSync(path.join(dir, 'session_nocreator.jsonl'), '{"uuid":"u1"}\n');
  writeSession(dir, 'session_badcreator', { kind: 'robot' });
  setSessionWorkspace('session_keep', project);
  setSessionWorkspace('session_del', project);
  // 删除链路内部可能触达引擎 / 运行时清理，注册一个只记录的总线兜底
  setGlobalEventBus(makeTestBus().bus);

  // ── 缺陷 1：清单不是会话，两处读取都要排除 ──
  const list = await loadConversationList(project);
  check(
    'loadConversationList 不列工作区清单',
    list.length === 2 && list.every((m) => m.sessionId.startsWith('session_')),
  );
  check(
    'creator 缺失 / 形态不对的条目被报错跳过（specs/025 FR-002）',
    !list.some((m) => m.sessionId === 'session_nocreator' || m.sessionId === 'session_badcreator'),
  );
  const metadataAll = await readProjectConversationMetadata(project);
  check(
    'readProjectConversationMetadata 不读工作区清单',
    metadataAll.length === 2 && metadataAll.every((m) => m.sessionId.startsWith('session_')),
  );

  // ── 缺陷 2：删除后缓存同步移除 ──
  // 第一次 loadConversationList 已暖缓存；删除后再读同一目录，
  // 必须拿到不含已删会话的列表（修复前命中脏缓存，条目残留）
  await deleteConversation('session_del');
  const afterDelete = await loadConversationList(project);
  check(
    '删除后列表缓存同步移除（不命中脏缓存）',
    afterDelete.length === 1 && afterDelete[0]?.sessionId === 'session_keep',
  );
  check('删除后磁盘元数据已移除', !fs.existsSync(path.join(dir, 'session_del.meta.json')));

  finish();
}

runTests('conversationListManifest', run);
