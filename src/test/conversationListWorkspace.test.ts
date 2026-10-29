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

import type { ConversationMetadata } from '../shared/history/Conversation';
import { ConversationManager } from '../host/ConversationManager';
import type { UIHost } from '../host/UIHost';
import { createChecker, runTests } from './helpers/harness';

/** 只实现 ConversationManager 用到的宿主能力：活动工作目录 */
function makeHost(getWorkspacePath: () => string | undefined): UIHost {
  return { getWorkspacePath, log: () => undefined } as unknown as UIHost;
}

function meta(sessionId: string, project: string): ConversationMetadata {
  return {
    sessionId,
    project,
    title: sessionId,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 1,
    creator: { kind: 'user' },
  };
}

/** 可注入 load 行为、记录 dispatch 的测试用实现 */
class TestConversationManager extends ConversationManager {
  dispatched: ConversationMetadata[][] = [];
  loadImpl: () => Promise<ConversationMetadata[]> = async () => [];

  protected override async loadFor(_workspace: string | undefined): Promise<ConversationMetadata[]> {
    return this.loadImpl();
  }

  protected override async dispatchList(
    list: readonly ConversationMetadata[],
    _workspace: string | undefined,
  ): Promise<void> {
    this.dispatched.push([...list]);
  }

  protected override dispatchStates(): void {
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

  // 定向装载非活动目录（specs/defects/inactive-tab-completion-light-missing）：
  // 列表只装载活动目录——重启恢复后非当前标签页的列表无人装载，离场完成的补武装
  // 永不运行（补武装唯一挂在列表到达出口）。契约：装载目标目录的列表，快照进它
  // 自己的键、分发链照跑（灯管线吃列表到达）；活动目录的快照与分发不受影响。
  // 装载的是「目标目录自己的内容」由 RT-1（e2e）端到端锁定：未读计数只存在于
  // 目标目录的 meta.json 里，行灯亮即证明读的是那份盘。
  workspace = 'C:/ws-a';
  manager.loadImpl = async () => [meta('session_b3', 'C:/ws-b')];
  const dispatchedBefore = manager.dispatched.length;
  await manager.refreshWorkspace('C:/ws-b');
  check('定向装载触发分发链（非活动目录也到达）', manager.dispatched.length === dispatchedBefore + 1);
  workspace = 'C:/ws-b';
  check('定向装载把快照存进目标目录', manager.getCachedList()?.[0].sessionId === 'session_b3');
  check('定向装载的快照是干净的', manager.isCachedListStale() === false);
  workspace = 'C:/ws-a';
  check(
    '活动目录的快照不受定向装载影响',
    manager.getCachedList()?.length === 1 && manager.getCachedList()?.[0].sessionId === 'session_a2',
  );

  finish();
});
