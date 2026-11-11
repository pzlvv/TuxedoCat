/**
 * 压缩归档的逐层展开（`docs/features/compaction.md` FR-005，specs/047）。
 *
 * 三个纯函数把「展开到第几层」变成可单测的判定：
 * `compactGenerations` 数代次、`compactVisibleMessages` 取该层的可见集合、
 * `canExpandCompact` 决定「展开压缩的对话历史」按钮还在不在。
 *
 * 事实只有一份：Core 的 `compact_archive_display` 给出完整序列与每代起始下标；
 * 这里只做切片，不参与合并 / 去重。
 */

/**
 * 一次展开拿到的完整数据（宿主按 `generationStarts` 分段转换后的形态）。
 *
 * `messages` 是「全部代次 + 当前保留区」的完整显示序列；`generationStarts[i]` 是第
 * `i+1` 代在其中的起始下标（升序、单调不减）。
 */
export interface CompactArchiveView {
  messages: readonly unknown[];
  generationStarts: readonly number[];
}

/** 归档代次数（= 还能展开几层）。数据缺失 / 空载荷时为 0。 */
export function compactGenerations(view: CompactArchiveView | null): number {
  if (!view || view.messages.length === 0) return 0;
  return view.generationStarts.length;
}

/**
 * 展开到第 `depth` 层时的可见消息。
 *
 * - `depth` 是「已展开几代」：`1` = 只有最新一代，`2` 再多一代更早的原文……
 * - 层级必须落在 `1..=代次数`（`0` 是压缩后形态，由调用方自己铺）；
 *   超界或数据缺失返回 `null`，调用方据此不改任何状态。
 */
export function compactVisibleMessages<T>(view: CompactArchiveView | null, depth: number): T[] | null {
  const generations = compactGenerations(view);
  if (!view || generations === 0) return null;
  if (!Number.isInteger(depth) || depth < 1 || depth > generations) return null;

  // depth = 1 取最新一代（从 generationStarts[末] 起），每加深一层左移一格
  const start = view.generationStarts[generations - depth];
  if (start === undefined || start < 0 || start >= view.messages.length) return null;
  return view.messages.slice(start) as T[];
}

/**
 * 「展开压缩的对话历史」按钮是否可见。
 *
 * 还需要同时满足：会话有归档、视图内还有没展开的代次。数据尚未取到时
 * （`hasArchive` 为真但 `view` 为 null）按钮照常显示——点它会去取数据。
 */
export function canExpandCompact(
  hasArchive: boolean,
  depth: number,
  view: CompactArchiveView | null,
): boolean {
  if (!hasArchive) return false;
  const generations = compactGenerations(view);
  // 还没取过归档数据：按「至少还能展开一次」显示（取不到时 handler 会保持原状）
  if (generations === 0) return depth === 0;
  return depth < generations;
}
