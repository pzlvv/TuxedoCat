/**
 * 变更视图的两侧原文组装（specs/040 FR-001 / AC-2）：主进程侧纯逻辑。
 *
 * diff 的渲染方只有查看器窗口内的 Monaco `DiffEditor`
 * （[docs/architecture/principles.md 第 5 节](../docs/architecture/principles.md#5-预览只有一份渲染实现)），webview 工具卡片的 diff 不受影响、`ElectronUIHost.showDiff` 仍是空实现。
 * 本模块只负责「拿哪两份文本」与「是不是空态」这两件可测的事：差异的渲染交给 Monaco，
 * 不做第二份 diff 计算。
 *
 * 刻意不 import electron：单测直接驱动（`src/test/monacoDiff.test.ts`）。
 */

/** diff 的两侧原文：`before` 为 HEAD 版本（无则空串），`after` 为磁盘当前内容 */
export interface DiffPayload {
  before: string;
  after: string;
}

/** 页面的 diff 应答（判别联合）：`empty` 是「相对 HEAD 没有改动」这一事实，不是错误 */
export type DiffResult =
  | { kind: 'diff'; payload: DiffPayload }
  | { kind: 'empty' }
  | { kind: 'error'; message: string };

/**
 * 组装 diff 应答。
 *
 * - `head` 为 null（无 HEAD 版本 = 新增文件）：仍然在变更视图里展示「空 → 全文」，
 *   这是用户从变更视图看一眼新增内容的真实语义（打开时的初始视图另有判定，
 *   见 `fileOpen.ts::resolveInitialView`）。
 * - 两侧相同 = 没有改动：返回 `empty`，页面渲染「没有改动」提示而不是空白编辑器（AC-2）。
 */
export function buildDiffResult(head: string | null, current: string): DiffResult {
  const before = head ?? '';
  if (before === current) return { kind: 'empty' };
  return { kind: 'diff', payload: { before, after: current } };
}

/**
 * 页面对 diff 应答的渲染分支（页内纯函数，供单测与页面共用同一份判定）。
 *
 * `requested` 为 false（按钮未渲染 / 虚拟文档）时恒不进入变更视图。
 */
export function resolveDiffView(requested: boolean, result: DiffResult): 'view' | 'diff' | 'empty' | 'error' {
  if (!requested) return 'view';
  if (result.kind === 'diff') return 'diff';
  if (result.kind === 'empty') return 'empty';
  return 'error';
}
