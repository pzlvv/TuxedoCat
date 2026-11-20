/**
 * 「打开远程工作区」窗口与主进程之间的数据类型（`docs/core/core-remote.md` 第 2.8 节）。
 *
 * preload 与页面共用；目录条目的形状直接沿用 daemon 协议里的定义，不另立一套。
 */

import type {
  DirectoryEntry,
  DirectoryFailureReason,
  DirectoryListing,
} from '../../src/host/standalone/daemonProtocol.js';
import type { RemoteConnectRequest } from '../../src/host/remoteConnect.js';
import type { SshHistoryCandidate } from '../../src/host/sshHistory.js';

export type { DirectoryEntry, DirectoryFailureReason, DirectoryListing };
export type { SshHistoryCandidate };

/**
 * 连接结果（判别联合，成员全必选）。
 *
 * `needPassword` 是认证链耗尽后的正常分支：私钥 / agent / 保存的口令都走不通，页面据此
 * 弹出**模态口令浮层**；`error` 是终止性失败（不可达 / 超时 / 主机密钥变更），页面直接在
 * 表单上报错、不弹浮层（specs/053 FR-004 / FR-009）。
 *
 * 成功时带回远端主机（**不含任何凭证**，只用于标题展示）。
 */
export type RemoteConnectResult =
  | {
      ok: true;
      listing: DirectoryListing;
      /** 已连上的目标 */
      endpoint: { host: string; port: number; user: string | null };
    }
  | {
      ok: false;
      reason: 'needPassword';
      /** 需要口令的原因（认证链里最后一次失败的原文），浮层里回显 */
      error: string;
    }
  | { ok: false; reason: 'error'; error: string };

/**
 * 连接请求：SSH 表单（`docs/core/core-remote.md` 第 2.8 节）。
 *
 * 形状定义在 host 层（`src/host/remoteConnect.ts`）：主进程用同一份类型做校验，
 * 页面只负责收集输入，不自己解释格式。`password` 为 `null` 表示走认证链；
 * 非 `null` 表示用户刚在口令浮层里提交，只试这一条（specs/053 FR-002 / FR-004）。
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
  /**
   * 经 SSH 连远端 daemon，成功即返回主目录列表。
   *
   * `request.password` 为 `null` 时走认证链（私钥 → agent → 保存的口令）；非 `null` 表示
   * 用户刚在口令浮层里提交，只试这一条口令（specs/053 FR-002 / FR-004）。
   */
  connect(request: RemoteConnectRequest): Promise<RemoteConnectResult>;
  /**
   * 取 SSH 连接历史（最近连接在前）。候选**不含口令**：展示与筛选只要
   * host / 端口 / 用户；选定候选只回填这三项，口令由主进程在认证链里取用
   */
  sshHistory(): Promise<SshHistoryCandidate[]>;
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
