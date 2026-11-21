/**
 * 「收尾时 thinking 是否熄灭」的纯判定（docs/hosts/webview-ui.md 第 6 节）。
 *
 * 一次查询由多个 LLM 轮次组成，轮次之间夹着工具批次与压缩。这几处收尾如果各自写
 * 「无条件熄灭」，工具卡片风车熄灭之后到下一轮 `aiBegin` 之间就会出现没有任何进行中
 * 指示的窗口——远程 SSH 多会话并行时这段窗口被放大，看起来就是「命令跑完了、界面
 * 卡住了」。
 *
 * 判定放在这里而不是各 handler 里：它是纯函数（不碰 React、不碰宿主），可以被单测
 * 直接驱动，也让「什么时候熄灭」这类表现规则只有一份。与
 * `src/webview/toolCardStatus.ts` 同一分工（那边管工具卡片何时让出 thinking，
 * 这边管收尾时是否熄灭）。
 */

/**
 * 压缩收尾（`complete` / `error`）后是否继续显示 thinking。
 *
 * 自动压缩由 Core 在**本轮 `aiBegin` 之前**触发（[docs/features/compaction.md](../features/compaction.md#fr-001触发与阈值)），
 * 压缩完成时查询仍在进行，紧接着就是下一轮请求，因此不能熄灭。手动压缩在压缩前没有
 * 活跃查询时收尾必须熄灭，否则界面会凭空亮着动画等一个不会来的轮次。
 *
 * 判据因此就是「压缩前的活跃查询状态」（`preCompressHasActiveQuery` 的恢复值）：
 * 压缩把这段时间的「进行中」接管了，压缩结束后由它决定交还给了谁。
 */
export function shouldShowThinkingAfterCompact(restoredActiveQuery: boolean): boolean {
  return restoredActiveQuery;
}
