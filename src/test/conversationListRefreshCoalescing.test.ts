/**
 * 对话列表重读的合并（docs/hosts/webview-ui.md 第 6 节）。
 *
 * `conversationListChanged` 的粒度是「每条消息落盘各一次」，并行会话同时跑工具批次时
 * 这些事件会堆成一串；重读走 `UiRequest.conversationListRequested`，在 Core 的帧循环
 * 上同步执行，串行重读会把其他会话的下一轮 `aiBegin` 压在后面（工具卡片风车已熄灭、
 * thinking 又还没点亮的那段窗口因此被拉长）。
 *
 * 验收：
 * - 同一时刻只有一次重读在途（并发 N 次只发起 1 次读盘）；
 * - 在途期间的请求不被丢弃——结束后补读一次（期间有落盘就要再读）；
 * - 无重叠时行为不变（每次调用各读一次）。
 *
 * 运行方式：npm run test:unit -- conversationListRefreshCoalescing
 */

import type { ConversationMetadata } from '../shared/history/Conversation';
import { ConversationManager } from '../host/ConversationManager';
import type { UIHost } from '../host/UIHost';
import { createChecker, runTests } from './helpers/harness';

function makeHost(workspace: string | undefined): UIHost {
  return { getWorkspacePath: () => workspace, log: () => undefined } as unknown as UIHost;
}

function meta(sessionId: string, messageCount: number): ConversationMetadata {
  return {
    sessionId,
    project: 'C:/ws',
    title: sessionId,
    createdAt: 1,
    updatedAt: 1,
    messageCount,
    creator: { kind: 'user' },
  };
}

/** 可挂起读盘、记录调用次数的实现 */
class TestConversationManager extends ConversationManager {
  loadCalls = 0;
  dispatched: readonly ConversationMetadata[][] = [];
  private pending: Array<(list: ConversationMetadata[]) => void> = [];

  protected override loadFor(): Promise<ConversationMetadata[]> {
    this.loadCalls += 1;
    return new Promise((resolve) => {
      this.pending.push(resolve);
    });
  }

  protected override async dispatchList(
    list: readonly ConversationMetadata[],
    _workspace: string | undefined,
  ): Promise<void> {
    (this.dispatched as ConversationMetadata[][]).push([...list]);
  }

  protected override dispatchStates(): void {
    /* 本用例不涉及状态流 */
  }

  /** 结束最早一次挂起的读盘 */
  resolveNext(list: ConversationMetadata[]): void {
    const resolve = this.pending.shift();
    resolve?.(list);
  }

  get pendingReads(): number {
    return this.pending.length;
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

runTests('conversationListRefreshCoalescing', async () => {
  const { check, finish } = createChecker();

  // ── RT-1：并发 N 次只发起 1 次读盘 ──
  {
    const manager = new TestConversationManager(makeHost('C:/ws'));
    const first = manager.refresh();
    const second = manager.refresh();
    const third = manager.refresh();
    check(
      `并发 3 次 refresh 只发起 1 次读盘（实际 ${manager.loadCalls} 次）`,
      manager.loadCalls === 1,
    );

    // 在途期间的请求不被丢弃：结束后补读一次
    manager.resolveNext([meta('session_a', 1)]);
    await flush();
    check(
      `在途结束后补读一次（实际 ${manager.loadCalls} 次）`,
      manager.loadCalls === 2,
    );
    manager.resolveNext([meta('session_a', 3)]);
    await Promise.all([first, second, third]);
    check(
      '最终分发的是补读到的列表',
      manager.dispatched.at(-1)?.[0]?.messageCount === 3,
    );
    check(
      '全部调用完成后没有挂起的读盘',
      manager.pendingReads === 0,
    );
  }

  // ── RT-2：无重叠时行为不变（每次调用各读一次） ──
  {
    const manager = new TestConversationManager(makeHost('C:/ws'));
    const first = manager.refresh();
    manager.resolveNext([meta('session_b', 1)]);
    await first;
    check('第一次读盘完成', manager.loadCalls === 1);

    const second = manager.refresh();
    manager.resolveNext([meta('session_b', 2)]);
    await second;
    check(
      `无重叠时第二次照常读盘（实际 ${manager.loadCalls} 次）`,
      manager.loadCalls === 2,
    );
    check(
      '两次分发各一次',
      manager.dispatched.length === 2 && manager.dispatched[1]?.[0]?.messageCount === 2,
    );
  }

  finish();
});
