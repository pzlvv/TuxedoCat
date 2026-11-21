/**
 * 会话加载态的结束判据（`specs/defects/conversation-loading-times-out-before-large-session.md`）。
 *
 * 缺陷表现：打开一个大对话时，消息区先显示「新对话空态」一段时间，然后才渲染出内容。
 * 成因是加载态带了一个固定的兜底超时（15s），它到点就把 loading 撤掉；而消息在进入
 * loading 时已被清空，于是页面落到新对话空态。实测 8MB 会话经慢速 SSH 读盘要 24.9s，
 * 任何固定值都会在更慢的链路上复发。
 *
 * 判据抽成纯函数（`src/webview/conversationLoadingState.ts`）后在这里直接驱动，不经过 React：
 * - RT-1：加载态只在「本视图等待的那个会话的数据到达」时结束，不存在「等太久自己放弃」；
 * - RT-2：迟到的旧会话数据不能结束新会话的加载（否则同一症状从另一个入口复现）。
 *
 * 运行方式：npm run test:unit -- conversation-loading
 */

import { pendingAfterBegin, pendingAfterLoaded } from '../webview/conversationLoadingState';
import { createChecker, runTests } from './helpers/harness';

const BIG_SESSION = 'session_1795152705008_xl9ulb6';

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // ---------- RT-1：进入加载后一直保持到该会话的数据到达 ----------
  {
    check('RT-1 声明加载某个会话后进入加载态', pendingAfterBegin(BIG_SESSION) === BIG_SESSION);

    // 关键断言：判据只有「数据到达」这一个出口。这里显式走一遍「长时间没有消息」
    // 的状态查询——纯函数没有定时器，等待多久都不会变，所以大对话不会提前露出空态。
    const pending = pendingAfterBegin(BIG_SESSION);
    await new Promise((resolve) => setTimeout(resolve, 60));
    check(
      'RT-1 等待期间（含超过任何固定超时）加载态保持，不会自行放弃',
      pending === BIG_SESSION && pending !== null,
    );

    check(
      'RT-1 该会话的 conversationLoaded 到达才结束加载',
      pendingAfterLoaded(BIG_SESSION, BIG_SESSION) === null,
    );
    check(
      'RT-1 未指定 sessionId 时 时按当前等待的会话已到达处理',
      pendingAfterLoaded(BIG_SESSION, undefined) === null,
    );
  }

  // ---------- RT-2：迟到的旧会话数据不得结束新会话的加载 ----------
  {
    check(
      'RT-2 其它会话的数据不结束当前加载',
      pendingAfterLoaded(BIG_SESSION, 'session_other') === BIG_SESSION,
    );
    check(
      'RT-2 没有在等任何会话时保持 null',
      pendingAfterLoaded(null, BIG_SESSION) === null,
    );
  }

  // ---------- RT-3：没有待加载会话（新对话）不进加载态 ----------
  {
    check('RT-3 空 sessionId 归一成「没有待加载会话」', pendingAfterBegin(undefined) === null);
    check('RT-3 空串同样归一成 null（不留两种空态）', pendingAfterBegin('') === null);
  }

  finish();
}

runTests('conversation-loading', run);
