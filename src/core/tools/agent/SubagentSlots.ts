/**
 * SubagentSlots - 子代理并发槽位（specs/005）
 *
 * 每个创建者会话一个桶：`{ active, FIFO waiters }`。`Agent` 工具在建子代理前取槽位，
 * 取不到就在工具调用内等待；子代理后台任务的唯一退出点释放槽位并唤醒队头（FIFO）。
 *
 * 活跃数的事实 owner 是本模块：注册表（SubAgentRegistry）管登记与递归中止可达性，
 * 不参与计数——避免同一事实两个写入点。上限常量与 `core-rs/src/subagent.rs` 的
 * `SUBAGENT_CONCURRENCY_LIMIT` 同值同语义，由 parity 测试锁定
 * （docs/core/core-parity.md 3.18 子代理条目）。
 */

/** 同一创建者会话并行子代理上限（Rust 侧同值，parity 锁定） */
export const SUBAGENT_CONCURRENCY_LIMIT = 4;

interface SlotBucket {
  /** 当前被持有的槽位数（acquire 成功到 release 之间） */
  active: number;
  /** FIFO 等待队列；元素返回 true 表示它接管了槽位，false 表示已取消、槽位继续下传 */
  waiters: Array<() => boolean>;
}

const buckets = new Map<string, SlotBucket>();

function bucketOf(creatorSessionId: string): SlotBucket {
  let bucket = buckets.get(creatorSessionId);
  if (!bucket) {
    bucket = { active: 0, waiters: [] };
    buckets.set(creatorSessionId, bucket);
  }
  return bucket;
}

/**
 * 取一个槽位：有空位且无排队者时立即返回 true（无排队者才直取，保证 FIFO 公平）；
 * 否则入队等待，直到被 `releaseSlot` 唤醒（true）或取消信号先到（false）。
 * 取消与唤醒并发时取消优先——被授予后仍先查信号，取消则把授予顺延给下一个排队者。
 * 返回 true 的调用方必须以 `releaseSlot` 配对，否则槽位泄露。
 */
export async function acquireSlot(
  creatorSessionId: string,
  signal?: AbortSignal | null,
): Promise<boolean> {
  const bucket = bucketOf(creatorSessionId);
  // 入队前先查取消：取消与空位并发时取消优先
  if (signal?.aborted) {
    return false;
  }
  if (bucket.active < SUBAGENT_CONCURRENCY_LIMIT && bucket.waiters.length === 0) {
    bucket.active += 1;
    return true;
  }
  return new Promise<boolean>((resolve) => {
    const waiter = (): boolean => {
      cleanup();
      // 被唤醒后再查一次：唤醒与取消并发时取消优先
      if (signal?.aborted) {
        resolve(false);
        return false;
      }
      bucket.active += 1;
      resolve(true);
      return true;
    };
    const onAbort = (): void => {
      const index = bucket.waiters.indexOf(waiter);
      if (index >= 0) {
        bucket.waiters.splice(index, 1);
      }
      cleanup();
      resolve(false);
    };
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort);
    };
    bucket.waiters.push(waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 释放一个槽位并按 FIFO 唤醒最早的排队者（授予在唤醒时转移，active 不变）；
 * 无排队者时真正归还（active 减一）。与 `acquireSlot` 成对使用，
 * 配对被破坏（未持有却释放）直接抛错，不静默降级。
 */
export function releaseSlot(creatorSessionId: string): void {
  const bucket = buckets.get(creatorSessionId);
  if (!bucket || bucket.active <= 0) {
    throw new Error(
      `releaseSlot: creator ${creatorSessionId} 没有在握的槽位（acquire/release 配对被破坏）`,
    );
  }
  bucket.active -= 1;
  // 逐个跳过已取消的 waiter，把空位交给第一个仍有效的排队者
  while (bucket.waiters.length > 0) {
    const waiter = bucket.waiters.shift();
    if (waiter && waiter()) {
      return;
    }
  }
}

/** 只读投影：该创建者当前被持有的槽位数（测试与诊断用） */
export function heldSlots(creatorSessionId: string): number {
  return buckets.get(creatorSessionId)?.active ?? 0;
}

/** 只读投影：该创建者当前排队中的调用数（测试与诊断用） */
export function queuedSlots(creatorSessionId: string): number {
  return buckets.get(creatorSessionId)?.waiters.length ?? 0;
}

/** 清空全部槽位状态（仅测试用） */
export function resetForTest(): void {
  buckets.clear();
}
