/**
 * MCP 配置的宿主侧部分。
 *
 * `mcp.json` 与 `settings.json` 同目录（`~/<CONFIG_DIR_NAME>/mcp.json`），属于宿主资源：
 * **读与写都在宿主**，Core 只消费经配置快照下发的规范化结果
 * （`docs/architecture/core-ui-separation.md` 第 4 节）。
 *
 * 本文件因此只保留两块，都不触碰会话数据：
 *
 * - **全局默认启用列表的修改器**（`mcpDefaultsMutator`）：设置面板一次性保存多个
 *   勾选项时，交给 `SettingsStore.updateSettings` 做串行化的读-改-写；
 * - **mcp.json 的纯解析 / 判定转发**（`isRemoteServer` / `isRemoteType`）。
 *
 * 会话级启用名单（`meta.json` 的 `context.mcpEnabled`）归 Core：宿主经 webview 消息
 * 翻译成 `UiEvent.mcpEnabledChanged` / `mcpEnabledListChanged`，由 Core 落盘
 * （specs/defects/host-appends-session-jsonl.md）。
 */

import { isPlainObject } from './parse.js';

// 纯解析与判定住在 `parse.ts`：UI 侧读盘后调同一个解析器，Core 侧从配置快照读结果。
export { isRemoteServer, isRemoteType } from './parse.js';

/**
 * 构造「把全局默认启用列表覆盖为 names」的 settings.json 修改器
 * （设置面板一次性保存多个勾选项时用）。
 *
 * core 只描述**怎么改**，**写盘由宿主承担**（`UIHost.updateSettingsJson`，
 * 见 [docs/architecture/layering.md 第 2 节](../../docs/architecture/layering.md#2-规则清单)规则 9）。
 */
export function mcpDefaultsMutator(names: readonly string[]): (cfg: Record<string, any>) => void {
  const normalized = Array.from(new Set(names.filter((n): n is string => typeof n === 'string' && !!n)));
  return (cfg) => {
    if (!isPlainObject(cfg.mcp)) cfg.mcp = {};
    cfg.mcp.enabled = normalized;
  };
}
