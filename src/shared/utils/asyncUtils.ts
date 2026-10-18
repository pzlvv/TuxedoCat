/**
 * 异步工具（全仓共享的纯函数，core / host / webview / electron 都可直接使用）。
 *
 * 收敛两类各处手写、语义微差的模式（此前至少各有三份实现）：
 * - 按 key 共享 in-flight promise：并发首调去重，settle（成功或失败）即删，
 *   之后的调用各自走常规路径；
 * - 给 promise 套超时：超时只让**当前调用者**放弃，底层 promise 继续走
 *   （in-flight 去重下，别的等待者与后续调用仍会拿到它的结果）。
 */

/** 按 key 共享 in-flight promise：进行中返回同一 promise，settle 后移除 */
export function sharedInFlight<T>(
  map: Map<string, Promise<T>>,
  key: string,
  factory: () => Promise<T>,
): Promise<T> {
  const inFlight = map.get(key);
  if (inFlight) return inFlight;
  const promise = factory().finally(() => {
    map.delete(key);
  });
  map.set(key, promise);
  return promise;
}

/** 给 promise 套超时；超时只放弃当前调用者，底层继续走（不 kill） */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    // Node 的 setTimeout 返回带 unref 的 Timeout，浏览器返回 number：
    // 按各自形态条件调用，宿主进程里不阻止退出、浏览器里是 no-op
    (timer as unknown as { unref?: () => void }).unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
