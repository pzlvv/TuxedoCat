/**
 * 单测：Edit / Write 文件回滚的「漏接线」回归。
 *
 * 回滚链路：webview `rollbackEdit` 消息 → `WebviewMessageHandler` 翻译成
 * `UiEvent.editRolledBack` → `initializeCoreEvents` 订阅 → `history/rollback.rollbackEdit`。
 *
 * 关键点：UI 会在消息里带 `filePath` 作为兜底路径。provider 偶发把整个工具入参
 * double-encode 成字符串，磁盘上的 `tool_use.input` 不是对象，core 取不到
 * `input.file_path`，必须靠这条兜底路径才能定位要回滚的文件。此前该字段在
 * 「消息 → UiEvent → rollbackEdit」中被整条丢掉，导致回滚直接报「缺少文件路径」。
 *
 * 运行方式：npm run test:all -- edit-rollback
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { createEventBus } from '../host/EventBus';
import { setGlobalEventBus, resetGlobalEventBus } from '../core/AssistantEventBus';
import { setActiveWorkspace, setSessionWorkspace, getProjectConversationDir } from '../core/history/Config';
import { initializeCoreEvents } from '../core/initializeCoreEvents';
import { WebviewMessageHandler } from '../host/ui/webviewMessageHandler';
import { createChecker, runTests } from './helpers/harness';
import { makeTempDir } from './helpers/fixtures';

/** 写一条最小的、可被 loadConversation 还原的 Edit 会话（input 故意 double-encode 成字符串）。 */
async function writeEditConversation(
  projectRoot: string,
  sessionId: string,
  targetFile: string,
): Promise<void> {
  const convDir = getProjectConversationDir(projectRoot);
  await fs.mkdir(convDir, { recursive: true });

  const stored = [
    {
      uuid: 'a1',
      parentUuid: null,
      timestamp: 1,
      message: {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Edit',
              input: JSON.stringify({ file_path: targetFile, old_string: 'OLD', new_string: 'NEW' }),
              _meta: { beforeContent: 'OLD CONTENT\n', afterContent: 'NEW CONTENT\n' },
            },
          ],
        },
      },
    },
    {
      uuid: 'u1',
      parentUuid: 'a1',
      timestamp: 2,
      message: {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
      },
    },
  ];

  await fs.writeFile(
    path.join(convDir, `${sessionId}.jsonl`),
    stored.map((m) => JSON.stringify(m)).join('\n') + '\n',
    'utf-8',
  );
  await fs.writeFile(
    path.join(convDir, `${sessionId}.meta.json`),
    JSON.stringify({ sessionId, title: 'rollback-test', context: {} }),
    'utf-8',
  );
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  const tmpHome = makeTempDir('edit-rollback');
  const projectRoot = path.join(tmpHome, 'project');
  process.env.USERPROFILE = tmpHome;
  process.env.HOME = tmpHome;
  await fs.mkdir(projectRoot, { recursive: true });
  setActiveWorkspace(projectRoot);

  const sessionId = 'sess-rollback';
  const targetFile = path.join(projectRoot, 'target.txt');
  await fs.writeFile(targetFile, 'NEW CONTENT\n', 'utf-8');
  await writeEditConversation(projectRoot, sessionId, targetFile);

  const bus = createEventBus();
  setGlobalEventBus(bus);
  const emitted: Array<{ type: string; data?: { content?: string } }> = [];
  bus.onCoreEvents(new Proxy({}, { get: () => (e: any) => emitted.push(e) }) as any);

  initializeCoreEvents(bus);
  // core 侧订阅在异步 import 完成后才注册，等它就绪再发消息。
  await new Promise((r) => setTimeout(r, 800));

  // 1) 翻译层必须把 filePath 带进 UiEvent（漏接线的直接体现）
  let translated: any = null;
  bus.onUiEvent('editRolledBack', (e) => { translated = e; });

  const handler = new WebviewMessageHandler({
    host: { log: () => undefined } as any,
    postToWebview: () => undefined,
    postConversationLoaded: () => undefined,
    setTitle: () => undefined,
    userChoiceManager: { currentBeforeContent: undefined } as any,
  });
  await handler.handleWebviewMessage({
    type: 'rollbackEdit',
    sessionId,
    toolUseId: 'toolu_1',
    filePath: targetFile,
    direction: 'before',
  });

  check('rollbackEdit 消息把 filePath 翻译进 editRolledBack', translated?.filePath === targetFile);

  // 2) 端到端：input.file_path 缺失时靠兜底路径把文件回滚到 beforeContent
  await new Promise((r) => setTimeout(r, 800));
  const restored = await fs.readFile(targetFile, 'utf-8');
  check('兜底路径生效：文件回滚到修改前', restored === 'OLD CONTENT\n');
  check(
    '回滚结果以系统消息回传',
    emitted.some((e) => e.type === 'message' && typeof e.data?.content === 'string' && e.data.content.includes('已回滚')),
  );

  // 3) 多工作目录：相对路径必须以「会话自己的工作目录」为基准，而不是当前活动目录。
  //    会话属于 sessionRoot，但活动工作目录仍是 projectRoot；若回退到活动目录，
  //    会改到 projectRoot 下的同名文件。
  const sessionRoot = path.join(tmpHome, 'session-ws');
  await fs.mkdir(sessionRoot, { recursive: true });
  const sessionId2 = 'sess-rollback-ws';
  setSessionWorkspace(sessionId2, sessionRoot);
  await writeEditConversation(sessionRoot, sessionId2, 'relative.txt');
  await fs.writeFile(path.join(sessionRoot, 'relative.txt'), 'NEW CONTENT\n', 'utf-8');
  const decoyFile = path.join(projectRoot, 'relative.txt');
  await fs.writeFile(decoyFile, 'DECOY\n', 'utf-8');

  await handler.handleWebviewMessage({
    type: 'rollbackEdit',
    sessionId: sessionId2,
    toolUseId: 'toolu_1',
    filePath: 'relative.txt',
    direction: 'before',
  });
  await new Promise((r) => setTimeout(r, 800));

  check(
    '相对路径以会话自己的工作目录为基准（会话目录已回滚）',
    (await fs.readFile(path.join(sessionRoot, 'relative.txt'), 'utf-8')) === 'OLD CONTENT\n',
  );
  check(
    '相对路径不回退到活动工作目录（活动目录的同名文件未被改动）',
    (await fs.readFile(decoyFile, 'utf-8')) === 'DECOY\n',
  );

  resetGlobalEventBus();
  finish();
}

runTests('editRollback', run);
