/**
 * /spin 命令共享逻辑。
 *
 * 设计器是否存在由 Core 的 `UiRequest.spinDesignRequested` 结果判定：宿主不再用
 * 本地 `fs` 探测 `spin.json`（远程工作区的设计在 Core 所在机器）。
 */
import type { SpinDesignReadResult } from '../AssistantEventBus.js';

/**
 * `/spin` 的 spin.json 存在性判断：无设计文件时应打开设计器（返回 true）。
 * 读取失败（`status: 'error'`）不当作「没有设计」。
 */
export function shouldOpenSpinDesign(result: SpinDesignReadResult): boolean {
  return result.status === 'ok' && result.data === null;
}
