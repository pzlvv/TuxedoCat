/**
 * 历史链重建对等测试（Embedded ↔ Standalone）。
 *
 * 两侧共用 `src/test/fixtures/historyChainParity.json`：同一组 jsonl 行经过
 * Embedded `loadConversation`（parentUuid → childrenMap → BFS）与 Standalone
 * `history::parse_messages` 后，消息顺序逐项一致。覆盖：
 * - 乱序行按链重排；
 * - 同层兄弟按 timestamp 稳定排序（BFS 而非文件序）；
 * - 父节点缺失退化为根节点、子树仍完整；
 * - 自引用 parentUuid 的恢复消息重新挂到含 tool_use 的 assistant；
 * - 重复 uuid 后写覆盖先写、保留首次位置；
 * - 损坏行 / 缺 uuid 的行被跳过。
 *
 * 对应用例：`core-rs/src/history_tests.rs::load_messages_matches_the_embedded_chain_fixture`
 * 及各单项用例。
 * 运行方式：npm run test:all -- history-chain-parity
 */

import * as fs from 'fs';
import * as path from 'path';
import { createEventBus } from '../host/EventBus';
import { setGlobalEventBus } from '../core/AssistantEventBus';
import { createChecker, runTests } from './helpers/harness';
import { createRecordingCoreEventHandlers, makeTempDir } from './helpers/fixtures';
import { setSessionWorkspace, getProjectConversationDir } from '../core/history/Config';
import { loadConversation } from '../core/history/Conversation';

interface ChainCase {
  name: string;
  lines: Array<Record<string, unknown> | string>;
  expected: string[];
}

function readFixture(): ChainCase[] {
  const fixturePath = path.resolve(__dirname, '../../../src/test/fixtures/historyChainParity.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as { cases: ChainCase[] };
  return fixture.cases;
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  const bus = createEventBus();
  bus.onCoreEvents(createRecordingCoreEventHandlers().handlers);
  setGlobalEventBus(bus);

  const root = makeTempDir('history-chain-parity');
  const conversationDir = getProjectConversationDir(root);
  fs.mkdirSync(conversationDir, { recursive: true });

  const cases = readFixture();
  check('对照表非空', cases.length > 0);

  for (let index = 0; index < cases.length; index++) {
    const item = cases[index];
    const sessionId = `chain-${index}`;
    // 会话工作目录按会话登记（core 按会话解析目录的唯一来源）
    setSessionWorkspace(sessionId, root);
    const jsonl = item.lines
      .map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
      .join('\n');
    fs.writeFileSync(path.join(conversationDir, `${sessionId}.jsonl`), `${jsonl}\n`);
    fs.writeFileSync(
      path.join(conversationDir, `${sessionId}.meta.json`),
      JSON.stringify({ sessionId, project: root, title: 'chain', messageCount: item.lines.length }),
    );

    const conversation = await loadConversation(sessionId);
    const markers = conversation.messages.map((message) => {
      const marker = (message as { marker?: unknown }).marker;
      return typeof marker === 'string' ? marker : '';
    });
    check(
      `${item.name} → [${item.expected.join(',')}]`,
      JSON.stringify(markers) === JSON.stringify(item.expected),
    );
  }

  finish();
}

void runTests('history-chain-parity', run);
