/**
 * 目录项：侧栏文件树的一行。
 *
 * 本地读盘（`electron/sidebarFiles.ts::listDirectory`）、远程 SFTP
 * （`src/host/standalone/sshClient.ts::listDirectory`）与 Core 的 Overlay 视图列举
 * （`UiRequest.workViewFilesRequested`）三处共用这一个形态——侧栏渲染层不区分来源。
 *
 * 放在 `src/shared/` 的原因：它出现在总线契约（`AssistantEventBus` 的
 * `WorkViewFilesResult`）里，而 `src/shared/` 不能 import `src/host/` 的实现。
 */
export interface DirectoryEntry {
  name: string;
  kind: 'file' | 'directory';
  /**
   * 修改时间（毫秒时间戳；SFTP attrs 的秒级 mtime × 1000，specs/030 FR-002）。
   * 「取不到」用 null（本地 stat 失败的条目同形），不用可选成员。
   */
  mtimeMs: number | null;
}
