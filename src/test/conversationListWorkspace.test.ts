/**
 * 单测：对话列表快照与活动工作目录绑定。
 *
 * 背景（多工作目录）：`ConversationManager.cachedList` 是「按目录」的列表快照。
 * 读盘期间用户可能切换活动工作目录，旧目录的列表既不能进快照、也不能推给界面，
 * 否则侧栏/子对话树会显示上一个目录的对话（切换越快越容易撞上）。
 *
 * 验证：
 * - 读盘期间活动目录变化 → 过期结果丢弃（不 commit、不 dispatch）；
 * - 同一目录刷新 → 快照命中、列表推送；
 * - 活动目录与快照不一致 → getCachedList() 返回 null（调用方会重新读盘）；
 * - invalidateCachedList() 后快照失效。
 *
 * 运行方式：npm run test:all -- conversationListWorkspace
 */

import type { ConversationMetadata } from '../core/history/Conversation';
import { ConversationManager } from '../host/ConversationManager';
import type { UIHost } from '../host/UIHost';
import { createChecker, runTests } from './helpers/harness';

/** 只实现 ConversationManager 用到的宿主能力：活动工作目录 */
function makeHost(getWorkspacePath: () => string | undefined): UIHost {
  return { getWorkspacePath } as unknown as UIHost;
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

  // 活动目录变化后快照不再适用（等价于未缓存，调用方重新读盘）
  workspace = 'C:/ws-a';
  check('活动目录变化后快照不再适用', manager.getCachedList() === null);

  // 显式失效
  workspace = 'C:/ws-b';
  check('活动目录切回后快照仍可用', manager.getCachedList()?.length === 1);
  manager.invalidateCachedList();
  check('invalidateCachedList 后快照失效', manager.getCachedList() === null);

  // 无活动目录（空态）时快照同样不适用
  workspace = 'C:/ws-b';
  manager.loadImpl = async () => [meta('session_b', 'C:/ws-b')];
  await manager.refresh();
  workspace = undefined;
  check('无活动目录时快照不适用', manager.getCachedList() === null);

  finish();
});
