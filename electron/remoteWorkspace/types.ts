/**
 * 「打开远程工作区」窗口与主进程之间的数据类型（`docs/core/core-daemon.md` 第 12 节）。
 *
 * preload 与页面共用；目录条目的形状直接沿用 daemon 协议里的定义，不另立一套。
 */

import type {
  DirectoryEntry,
  DirectoryFailureReason,
  DirectoryListing,
} from '../../src/host/standalone/daemonProtocol.js';
import type { RemoteConnectRequest } from '../../src/host/remoteConnect.js';
import type { SshHistoryCandidate, SshHistoryEntry } from '../../src/host/sshHistory.js';

export type { DirectoryEntry, DirectoryFailureReason, DirectoryListing };
export type { SshHistoryCandidate, SshHistoryEntry };

/** 连接结果：成功时带回远端主机（**不含任何凭证**，只用于标题展示） */
export type RemoteConnectResult =
  | {
      ok: true;
      listing: DirectoryListing;
      /** 已连上的目标 */
      endpoint: { host: string; port: number; user: string | null };
    }
  | { ok: false; error: string };

/**
 * 连接请求：SSH 表单（`docs/core/core-daemon.md` 第 12 节）。
 *
 * 形状定义在 host 层（`src/host/remoteConnect.ts`）：主进程用同一份类型做校验，
 * 页面只负责收集输入，不自己解释格式。
 */
export type { RemoteConnectRequest };

/** 列目录结果 */
export type RemoteListResult =
  | { ok: true; listing: DirectoryListing }
  | { ok: false; error: string };

/** 新建目录结果 */
export type RemotePathResult = { ok: true; path: string } | { ok: false; error: string };

/** 打开选定目录的结果；成功时主进程随即关闭窗口 */
export type RemoteOpenResult = { ok: true } | { ok: false; error: string };

/**
 * 删除目录结果。失败时带上 `reason`：`notEmpty` 表示「非空且本次没要求递归」，
 * 页面据此升成「连同内容一起删除」的二次确认，而不是把它当普通错误显示。
 */
export type RemoteDeleteResult =
  | { ok: true; path: string }
  | { ok: false; error: string; reason: DirectoryFailureReason };

/** preload 暴露给页面的接口（`window.remoteWorkspaceAPI`） */
export interface RemoteWorkspaceAPI {
  /** 经 SSH 连远端 daemon，成功即返回主目录列表 */
  connect(request: RemoteConnectRequest): Promise<RemoteConnectResult>;
  /**
   * 取 SSH 连接历史（最近连接在前）。候选**不含口令**：展示与筛选只要
   * host / 端口 / 用户；口令按选定项经 `sshHistoryEntry` 单独取，不随整表常驻页面
   */
  sshHistory(): Promise<SshHistoryCandidate[]>;
  /** 按去重键取一条历史（含口令，回填表单用）；不存在返回 null */
  sshHistoryEntry(key: string): Promise<SshHistoryEntry | null>;
  /** 删除一条 SSH 连接历史（按 `sshHistoryKey` 的键），返回删除后的候选列表 */
  removeSshHistoryEntry(key: string): Promise<SshHistoryCandidate[]>;
  /** 列某个远端目录的子目录 */
  list(path: string): Promise<RemoteListResult>;
  /** 在远端新建目录（父目录不存在时一并创建） */
  create(path: string): Promise<RemotePathResult>;
  /** 重命名远端目录（只改同一父目录下的名字） */
  rename(path: string, name: string): Promise<RemotePathResult>;
  /** 删除远端目录；`recursive` 为 false 时非空目录会以 `reason: 'notEmpty'` 失败 */
  remove(path: string, recursive: boolean): Promise<RemoteDeleteResult>;
  /** 选定远端目录：主进程把它加为工作区并关闭窗口；失败时带回原因（窗口不关） */
  open(path: string): Promise<RemoteOpenResult>;
  /** 关闭窗口 */
  cancel(): void;
}
