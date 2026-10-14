/**
 * daemon 控制通道协议（`docs/core/core-daemon.md` 第 7 节）。
 *
 * 编码与内层帧通道同口径：UTF-8，换行分隔的 JSON，一行一帧。
 * 控制通道上只有一条连接；每个 Core 的帧通道是它上面的一条逻辑 channel。
 * daemon 不解读内层帧，只按 channel 转发。
 *
 * 本模块只做类型与校验，不含进程与业务逻辑，无宿主依赖。
 */

import type { WorkspaceRef } from '../workspaceRef.js';
import type { CoreToUiFrame, UiToCoreFrame } from './protocol.js';
import { stringifyJsonSafe } from '../../core/utils/stringUtils.js';

// ==================== 远端 daemon 状态文件 ====================

/**
 * 远端 daemon 的状态 / 日志文件名（`docs/core/core-remote.md` 第 2.3 节）。
 *
 * 文件名按**构建指纹**区分：`core-daemon-<指纹>.json` 等。一个指纹一个 daemon、
 * 一份落盘文件——多版本 Core 在同一台远端机器上并存时，各自的 `start` / `kill` /
 * 探测只作用于自己指纹的 daemon，互不踩踏（`docs/core/standalone-core.md` 第 4.4 节）。
 * 状态文件（+ 同名 `.lock`）在配置目录的 `run/` 子目录（daemon 的运行期事实，
 * `core-rs/src/remote.rs::daemon_state_path` 同口径，改动必须同步两侧），诊断日志
 * 在 `logs/` 子目录；Host 侧读取状态文件来拿到实际监听端口（SSH 接入时 daemon
 * 端口不对外映射，只能这样发现）。
 */
export function daemonStateFileName(fingerprint: string): string {
  return `core-daemon-${fingerprint}.json`;
}

/** 诊断日志文件名；`start` 拉起的 daemon 把 stderr/stdout 追加到配置目录 `logs/`
 * 子目录下的这个文件（`core-rs/src/remote.rs::daemon_log_path` 同口径，改动同步两侧） */
export function daemonLogFileName(fingerprint: string): string {
  return `core-daemon-${fingerprint}.log`;
}

/** 状态文件内容（字段与 `core-rs/src/remote.rs::DaemonState` 一一对应） */
export interface DaemonStateFile {
  /** 实际监听的 `IP:端口`（daemon 恒绑回环，端口由内核分配） */
  endpoint: string;
}

// ==================== 通道描述符 ====================
/** ChannelDescriptor（`docs/core/core-daemon.md` 第 4.1 节） */
export type ChannelDescriptor =
  /** 走当前控制通道的该 channel（本规格实现） */
  | { kind: 'multiplexed'; channel: number }
  /** 直连一个独立端点（预留，不实现） */
  | { kind: 'direct'; transport: string; address: string };

// ==================== 帧类型 ====================

/** Host → daemon */
export type HostToDaemonFrame =
  | { kind: 'openWorkspace'; id: number; workspaceRef: WorkspaceRef }
  | { kind: 'closeWorkspace'; channel: number }
  | { kind: 'frame'; channel: number; frame: UiToCoreFrame }
  | { kind: 'listDirectories'; id: number; path: string | null }
  | { kind: 'createDirectory'; id: number; path: string }
  | { kind: 'renameDirectory'; id: number; path: string; name: string }
  | { kind: 'deleteDirectory'; id: number; path: string; recursive: boolean }
  | { kind: 'shutdown' }
  /**
   * 链路心跳（`docs/core/core-remote.md` 第 2.5 节）：链路就绪后定期发送，daemon 回
   * `pong` 并以「最近一次收到控制帧」判定 Host 死活——Host 消失而 TCP 未断（断网 /
   * 休眠 / 进程冻结）时，daemon 的读线程永远等不到 EOF，沉默是它唯一的断开依据
   * （同步 accept 循环被死连接占住，后续接入全部饿死：探测「连得上」、auth 无应答）。
   */
  | { kind: 'ping' };

/** channel 关闭原因 */
export type WorkspaceCloseReason = 'closed' | 'crashed' | 'failed';

/** 目录列举的一项（只列子目录） */
export interface DirectoryEntry {
  /** 目录名（basename） */
  name: string;
  /** 目标机器上的绝对路径 */
  path: string;
}

/** 一次目录列举的结果 */
export interface DirectoryListing {
  /** 被列举的目录绝对路径 */
  path: string;
  /** 上级目录；已在文件系统根时为 null */
  parent: string | null;
  /** 子目录（按名字排序） */
  entries: DirectoryEntry[];
}

/** daemon → Host */
export type DaemonToHostFrame =
  /** 心跳应答：对 `ping` 的回应；Host 见首个 pong 武装沉默判定（`docs/core/core-remote.md` 第 2.5 节） */
  | { kind: 'pong' }
  | { kind: 'workspaceOpened'; id: number; channel: number; descriptor: ChannelDescriptor }
  | { kind: 'workspaceFailed'; id: number; error: string }
  | { kind: 'workspaceClosed'; channel: number; reason: WorkspaceCloseReason }
  | { kind: 'channelReset'; channel: number; reason: string }
  | { kind: 'frame'; channel: number; frame: CoreToUiFrame }
  | { kind: 'directoriesListed'; id: number; path: string; parent: string | null; entries: DirectoryEntry[] }
  | { kind: 'directoryCreated'; id: number; path: string }
  /** 目录已重命名；`path` 是改名后的新路径 */
  | { kind: 'directoryRenamed'; id: number; path: string }
  | { kind: 'directoryDeleted'; id: number; path: string }
  /** 目录操作失败（列举 / 新建 / 删除共用；按 `id` 对应请求） */
  | { kind: 'directoryFailed'; id: number; error: string; reason: DirectoryFailureReason };

/**
 * 目录操作失败的原因。
 *
 * `notEmpty` 单独拎出来：调用方据此把删除升成「目录非空，确认连同内容一起删除？」，
 * 而不是让用户对着一句错误文本猜该不该重试。
 */
export type DirectoryFailureReason = 'notEmpty' | 'other';

// ==================== 编码 ====================

/** 编码一帧（含结尾换行） */
export function encodeDaemonFrame(frame: HostToDaemonFrame): string {
  return `${stringifyJsonSafe(frame)}\n`;
}

// ==================== 校验 ====================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isChannelDescriptor(value: unknown): value is ChannelDescriptor {
  if (!isRecord(value)) return false;
  if (value['kind'] === 'multiplexed') return typeof value['channel'] === 'number';
  if (value['kind'] === 'direct') {
    return typeof value['transport'] === 'string' && typeof value['address'] === 'string';
  }
  return false;
}

function isDirectoryEntries(value: unknown): value is DirectoryEntry[] {
  return (
    Array.isArray(value)
    && value.every(
      (entry) =>
        isRecord(entry)
        && typeof entry['name'] === 'string'
        && typeof entry['path'] === 'string',
    )
  );
}

/** 收窄为合法的 daemon → Host 帧（未知类型返回 false，由调用方丢弃并记录） */
export function isDaemonToHostFrame(value: unknown): value is DaemonToHostFrame {
  if (!isRecord(value)) return false;
  switch (value['kind']) {
    case 'pong':
      return true;
    case 'directoriesListed':
      return (
        typeof value['id'] === 'number'
        && typeof value['path'] === 'string'
        && (value['parent'] === null || typeof value['parent'] === 'string')
        && isDirectoryEntries(value['entries'])
      );
    case 'directoryCreated':
    case 'directoryRenamed':
    case 'directoryDeleted':
      return typeof value['id'] === 'number' && typeof value['path'] === 'string';
    case 'directoryFailed':
      return (
        typeof value['id'] === 'number'
        && typeof value['error'] === 'string'
        && (value['reason'] === 'notEmpty' || value['reason'] === 'other')
      );
    case 'workspaceOpened':
      return (
        typeof value['id'] === 'number'
        && typeof value['channel'] === 'number'
        && isChannelDescriptor(value['descriptor'])
      );
    case 'workspaceFailed':
      return typeof value['id'] === 'number' && typeof value['error'] === 'string';
    case 'workspaceClosed':
      return (
        typeof value['channel'] === 'number'
        && (value['reason'] === 'closed' || value['reason'] === 'crashed' || value['reason'] === 'failed')
      );
    case 'channelReset':
      return typeof value['channel'] === 'number' && typeof value['reason'] === 'string';
    case 'frame':
      return typeof value['channel'] === 'number' && isRecord(value['frame']);
    default:
      return false;
  }
}
