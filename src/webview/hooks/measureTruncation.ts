import { flushSync } from 'react-dom';

/**
 * 批量截断测量：把「每条消息各自在 useLayoutEffect 里读 scrollHeight」这种
 * read/write 交错的模式，合并成「一次批量读 + 一次批量写」。
 *
 * 背景（实测 539 条消息的真实会话）：
 *   原实现每条消息在 layout effect 里读 contentRef.scrollHeight，然后 setIsTruncated。
 *   React 提交完 DOM 后布局是脏的，第一次读就强制整棵树重排；紧接着 setIsTruncated
 *   触发重渲染又把 DOM 改脏，下一条消息再读又重排一次 —— 251 次读累计 137ms，
 *   该 effect 自身的 self-time 达 201ms，是除 V8 编译外最大的 JS 热点。
 *
 * 做法：所有消息只把「元素 + 回写函数」登记进队列，由一次微任务统一执行：
 *   1. 只读阶段：连续读完所有元素，中间不做任何 DOM 写入 → 只触发 1 次强制布局
 *   2. 只写阶段：再用 flushSync 一次性回写，保证在浏览器绘制前完成重渲染
 *      （若用普通 setState，更新会落到后续宏任务，长消息会先以完整高度绘制一帧
 *        再折叠，即原注释里要避免的“发送后再折叠”闪烁）
 *
 * 微任务在 React 提交（同一个任务）之后、浏览器绘制之前执行，因此仍然是
 * 「绘制前完成测量与折叠」的语义，与原 useLayoutEffect 等价。
 */

interface Job {
  el: HTMLElement;
  apply: (truncated: boolean) => void;
}

let queue: Job[] = [];
let scheduled = false;

function flush(): void {
  scheduled = false;
  if (queue.length === 0) return;
  const jobs = queue;
  queue = [];

  // ── 只读阶段 ──
  // 连续读取，中间不写 DOM，浏览器只需重排一次
  const results: boolean[] = new Array(jobs.length);
  for (let i = 0; i < jobs.length; i++) {
    const el = jobs[i].el;
    // 元素可能已被卸载（消息列表变化），跳过
    if (!el.isConnected) {
      results[i] = false;
      continue;
    }
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight || '20');
    results[i] = el.scrollHeight > lineHeight * 15;
  }

  // ── 只写阶段 ──
  // flushSync 保证这批状态更新在本次绘制前同步完成，避免折叠闪烁
  flushSync(() => {
    for (let i = 0; i < jobs.length; i++) {
      jobs[i].apply(results[i]);
    }
  });
}

/** 登记一次截断测量；同一批（同一微任务内）的登记会合并成一次强制布局 */
export function measureTruncation(el: HTMLElement, apply: (truncated: boolean) => void): void {
  queue.push({ el, apply });
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(flush);
}

/** 仅供测试/诊断：当前待处理的测量数 */
export function pendingMeasureCount(): number {
  return queue.length;
}
