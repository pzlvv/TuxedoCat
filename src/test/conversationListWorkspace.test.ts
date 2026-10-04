/**
 * 单测：对话列表快照与活动工作目录绑定。
 *
 * 背景（多工作目录）：`ConversationManager` 的列表快照是「按目录」的（每目录一份）。
 * 读盘期间用户可能切换活动工作目录，旧目录的列表既不能进快照、也不能推给界面，
 * 否则侧栏/子对话树会显示上一个目录的对话（切换越快越容易撞上）。
 *
 * 验证：
 * - 读盘期间活动目录变化 → 过期结果丢弃（不 commit、不 dispatch）；
 * - 同一目录刷新 → 快照命中、列表推送；
 * - 每个目录各留一份快照：切到没刷新过的目录 → getCachedList() 返回 null；
 *   切回刷新过的目录 → 快照仍可用（Electron 切标签页不再每次完整读盘）；
 * - onConversationListChanged()：活动目录重读，**已有快照**的其它目录标脏；
 *   脏快照仍可命中（stale-while-revalidate：调用方先返回快照、后台补读）；
 * - invalidateCachedList(目录) 只丢该目录的快照。
 *
 * 运行方式：npm run test:all -- conversationListWorkspace
 */

import type { ConversationMetadata } from '../core/history/Conversation';
import { ConversationManager } from '../host/ConversationManager';
import type { UIHost } from '../host/UIHost';
import { createChecker, runTests } from './helpers/harness';

/** 只实现 ConversationManager 用到的宿主能力：活动工作目录 */
function makeHost(getWorkspacePath: () => string | undefined): UIHost {
  return { getWorkspacePath, log: () => undefined } as unknown as UIHost;
}

function meta(sessionId: string, project: string): ConversationMetadata {
  return { sessionId, project, title: sessionId, createdAt: 1, updatedAt: 1, messageCount: 1 };
}

/** 可注入 load 行为、记录 dispatch 的测试用实现 */
class TestConversationManager extends ConversationManager {
  dispatched: ConversationMetadata[][] = [];
  loadImpl: () => Promise<ConversationMetadata[]> = async () => [];

  protected async load(): Promise<ConversationMetadata[]> {
    return this.loadImpl();
  }

  protected async dispatchList(list: readonly ConversationMetadata[]): Promise<void> {
    this.dispatched.push([...list]);
  }

  protected dispatchStates(): void {
    /* 本测试不涉及状态流 */
  }
}

runTests('conversationListWorkspace', async () => {
  const { check, finish } = createChecker();

  let workspace: string | undefined = 'C:/ws-a';
  const manager = new TestConversationManager(makeHost(() => workspace));

  // 读盘期间切换活动目录：过期结果必须丢弃
  let resolveLoad: ((list: ConversationMetadata[]) => void) | undefined;
  manager.loadImpl = () =>
    new Promise<ConversationMetadata[]>((resolve) => {
      resolveLoad = resolve;
    });
  const inflight = manager.refresh();
  workspace = 'C:/ws-b';
  resolveLoad?.([meta('session_a', 'C:/ws-a')]);
  await inflight;

  check('切换目录后过期列表不进快照', manager.getCachedList() === null);
  check('切换目录后过期列表不推送', manager.dispatched.length === 0);

  // 同一目录刷新：命中快照并推送
  workspace = 'C:/ws-b';
  manager.loadImpl = async () => [meta('session_b', 'C:/ws-b')];
  await manager.refresh();
  const cached = manager.getCachedList();
  check('同一目录刷新后快照命中', cached?.length === 1 && cached[0].sessionId === 'session_b');
  check('刷新会推送列表', manager.dispatched.length === 1);
  check('干净快照不过期', manager.isCachedListStale() === false);

  // ws-a 也刷一次，让两个目录各有一份快照
  workspace = 'C:/ws-a';
  manager.loadImpl = async () => [meta('session_a', 'C:/ws-a')];
  await manager.refresh();

  // 切换目录命中各自的快照（Electron 切标签页不再每次完整读盘）
  workspace = 'C:/ws-b';
  check('切回 ws-b 快照仍可用', manager.getCachedList()?.[0].sessionId === 'session_b');
  workspace = 'C:/ws-a';
  check('切到 ws-a 命中自己的快照', manager.getCachedList()?.[0].sessionId === 'session_a');

  // onConversationListChanged：活动目录（ws-a）重读，其余目录（ws-b）标脏
  manager.loadImpl = async () => [meta('session_a2', 'C:/ws-a')];
  await manager.onConversationListChanged();
  check('事件触发活动目录重读并推送', manager.dispatched.length === 3 && manager.getCachedList()?.[0].sessionId === 'session_a2');
  workspace = 'C:/ws-b';
  check('非活动目录的快照被标脏', manager.isCachedListStale() === true);
  check('脏快照仍可命中（先返回快照、后台补读）', manager.getCachedList()?.length === 1);

  // 脏目录刷新后解除脏标记
  manager.loadImpl = async () => [meta('session_b2', 'C:/ws-b')];
  await manager.refresh();
  check('刷新后脏标记解除', manager.isCachedListStale() === false && manager.getCachedList()?.[0].sessionId === 'session_b2');

  // 显式失效：只丢指定目录
  manager.invalidateCachedList('C:/ws-b');
  check('invalidateCachedList 后该目录快照失效', manager.getCachedList() === null);
  workspace = 'C:/ws-a';
  check('其它目录的快照不受影响', manager.getCachedList()?.length === 1);

  // 无活动目录（空态）：快照按 '' 键存取，与有目录的互不影响；
  // 事件在空态触发时，其余目录同样标脏
  workspace = undefined;
  check('无活动目录时无快照', manager.getCachedList() === null);
  manager.loadImpl = async () => [meta('session_empty', 'C:/ws-b')];
  await manager.refresh();
  check('空态目录刷新后快照命中', manager.getCachedList()?.length === 1);
  await manager.onConversationListChanged();
  workspace = 'C:/ws-a';
  check('空态期间其它目录同样标脏', manager.isCachedListStale() === true);

  finish();
});
