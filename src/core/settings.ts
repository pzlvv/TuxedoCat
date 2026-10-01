/**
 * Core 侧的配置快照入口（**唯一入口**）。
 *
 * 写入只有一处：`applySettingsSnapshot`，由 `UiEvent.hostEnvironmentProvided` 的处理器
 * 调用一次；读取只有 `getSettings()` 与 `getMcpServerDefinitions()`。Core 侧其它模块
 * 一律从这里取值，不得出现 `settings.json` / `mcp.json` 的路径与文件读取
 * （`docs/core-ui-separation.md` 第 4.4 节）。
 *
 * 快照未到达时读取入口抛错，与 `getExtensionPath()` 同一口径：接线缺失必须在启动期
 * 暴露，不做静默回落。Core 不提供默认值——默认值与规范化在 UI 侧的纯函数里执行
 * （`settingsSnapshot.ts` 的 `resolveSettingsSnapshot`）。
 */

import type { McpServerDefinition, SettingsSnapshot } from './settingsSnapshot.js';

let snapshot: SettingsSnapshot | null = null;
let mcpServers: readonly McpServerDefinition[] = [];

/**
 * 写入配置快照（唯一写入入口）。
 *
 * 由 `hostEnvironmentProvided` 的处理器调用；重复调用视为「重新同步」，
 * 整体替换而不是合并——快照是完整的，没有增量语义。
 */
export function applySettingsSnapshot(
  next: SettingsSnapshot,
  servers: readonly McpServerDefinition[],
): void {
  snapshot = next;
  mcpServers = servers;
}

/** 快照是否已到达（就绪判据的一部分，见 `docs/core-ui-separation.md` 第 7 节） */
export function hasSettingsSnapshot(): boolean {
  return snapshot !== null;
}

/** 读取配置快照；未到达时抛错 */
export function getSettings(): SettingsSnapshot {
  if (!snapshot) {
    throw new Error(
      'Settings snapshot is not available. ' +
      'It is written by UiEvent.hostEnvironmentProvided; ' +
      'getSettings() is called before that event arrived.'
    );
  }
  return snapshot;
}

/** 读取 MCP 服务器定义（来自 `mcp.json`，经快照下发）；未到达时抛错 */
export function getMcpServerDefinitions(): readonly McpServerDefinition[] {
  if (!snapshot) {
    throw new Error(
      'MCP server definitions are not available. ' +
      'They are written by UiEvent.hostEnvironmentProvided; ' +
      'getMcpServerDefinitions() is called before that event arrived.'
    );
  }
  return mcpServers;
}

/**
 * 清空快照。
 *
 * 仅用于测试与「连接重建」：Core 重启后必须重新收到一次快照才算就绪。
 */
export function resetSettingsSnapshot(): void {
  snapshot = null;
  mcpServers = [];
}
