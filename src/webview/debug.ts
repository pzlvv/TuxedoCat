/**
 * 诊断日志门控。
 *
 * 默认关闭，避免热路径（流式消息、token 统计、渲染分段等）中的
 * console.log 拖慢渲染；需要排查时在 DevTools 执行
 * `window.__debugEnabled = true` 即可恢复输出。
 */
export function profileLog(...args: unknown[]): void {
  if (window.__debugEnabled === true) {
    console.log(...args);
  }
}
