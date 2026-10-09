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
 *
 * 尺寸变化重测：窗口 / 侧边栏宽度变化会让同一条消息的折行数改变，折叠高度下
 * 「是否溢出」的判定随之改变（例如拉宽后原本被截断的消息能完整放下）。
 * 因此每个被登记的元素都由一个**共享** ResizeObserver 观察，尺寸变化时用最近一次
 * 登记的回写函数重新测量。共享一个 observer 是因为窗口拖动时每个元素都会回调一次，
 * 逐元素新建 observer 只会多出同样数量的回调对象，没有收益。
 */

/**
 * 截断判定模式：
 * - 'lines'：按行数阈值（15 行）判定，用于子代理 From/To 消息（保持原有行为）；
 * - 'overflow'：元素已按折叠高度 clamp，直接看内容是否溢出（scrollHeight > clientHeight），
 *   用于真正的用户消息——折叠高度随消息区高度变化，必须按实际溢出判定。
 */
export type TruncationMode = 'lines' | 'overflow';

interface Job {
  el: HTMLElement;
  apply: (truncated: boolean) => void;
  mode: TruncationMode;
}

/** 元素最近一次登记的回写函数、判定模式与测量时的内容盒尺寸（用于过滤 ResizeObserver 的初始/重复回调） */
interface Registration {
  apply: (truncated: boolean) => void;
  mode: TruncationMode;
  /** 上次测量时元素的内容盒尺寸；初始回调与它一致时说明没有真实尺寸变化，跳过 */
  width: number;
  height: number;
}

let queue: Job[] = [];
let scheduled = false;
/** 已观察元素 → 最近一次登记（WeakMap：元素卸载后随之回收，不会阻止 GC） */
const registrations = new WeakMap<HTMLElement, Registration>();
let resizeObserver: ResizeObserver | null = null;

function enqueue(job: Job): void {
  queue.push(job);
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(flush);
}

/** 惰性创建共享 ResizeObserver；运行环境没有该 API 时返回 null（此时退化为只在内容变化时测量） */
function getResizeObserver(): ResizeObserver | null {
  if (typeof ResizeObserver === 'undefined') return null;
  if (!resizeObserver) {
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        const registration = registrations.get(el);
        if (!registration) continue;
        // 尺寸没变（含 observe 后的首次回调）→ 无需重测
        const rect = entry.contentRect;
        if (Math.abs(registration.width - rect.width) < 1 && Math.abs(registration.height - rect.height) < 1) continue;
        enqueue({ el, apply: registration.apply, mode: registration.mode });
      }
    });
  }
  return resizeObserver;
}

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
    // 记录本次测量时的内容盒尺寸，供 ResizeObserver 回调过滤「尺寸未变」的重复通知
    const registration = registrations.get(el);
    if (registration) {
      registration.width = el.clientWidth;
      registration.height = el.clientHeight;
    }
    if (jobs[i].mode === 'overflow') {
      // 已按折叠高度 clamp：内容比可见高度多 1px 以上即视为截断（+1 容忍取整误差）
      results[i] = el.scrollHeight > el.clientHeight + 1;
    } else {
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight || '20');
      results[i] = el.scrollHeight > lineHeight * 15;
    }
  }

  // ── 只写阶段 ──
  // flushSync 保证这批状态更新在本次绘制前同步完成，避免折叠闪烁
  flushSync(() => {
    for (let i = 0; i < jobs.length; i++) {
      jobs[i].apply(results[i]);
    }
  });
}

/**
 * 登记一次截断测量；同一批（同一微任务内）的登记会合并成一次强制布局。
 * 同时把元素交给共享 ResizeObserver 观察，尺寸变化（折行数改变）时自动重测。
 * 对同一元素重复调用只更新回写函数与模式，不会重复触发初始观察。
 */
export function measureTruncation(el: HTMLElement, apply: (truncated: boolean) => void, mode: TruncationMode = 'lines'): void {
  // 复用已有登记：只更新回写函数与模式，保留上次测得的内容盒尺寸。
  // 首次登记时尺寸未知，先置 NaN；本次测量（flush 只读阶段）会补上，
  // 因此 observe 之后的首次回调能据此判定「尺寸未变」而跳过。
  const existing = registrations.get(el);
  if (existing) {
    existing.apply = apply;
    existing.mode = mode;
  } else {
    registrations.set(el, { apply, mode, width: NaN, height: NaN });
  }
  getResizeObserver()?.observe(el);
  enqueue({ el, apply, mode });
}

/**
 * 停止观察并清除登记：元素卸载，或进入不应再按溢出判定的状态（如已展开）时调用。
 * ResizeObserver 会强引用被观察元素，卸载时不解除会阻止元素回收。
 */
export function releaseTruncation(el: HTMLElement): void {
  registrations.delete(el);
  resizeObserver?.unobserve(el);
}

/** 仅供测试/诊断：当前待处理的测量数 */
export function pendingMeasureCount(): number {
  return queue.length;
}
