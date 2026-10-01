/**
 * daemon 控制通道协议（`docs/core-daemon.md` 第 7 节）。
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

// ==================== 通道描述符 ====================

/** ChannelDescriptor（`docs/core-daemon.md` 第 4.1 节） */
export type ChannelDescriptor =
  /** 走当前控制通道的该 channel（本规格实现） */
  | { kind: 'multiplexed'; channel: number }
  /** 直连一个独立端点（预留，不实现） */
  | { kind: 'direct'; transport: string; address: string };

// ==================== 帧类型 ====================

/** Host → daemon */
export type HostToDaemonFrame =
  /** 远程控制通道的第一帧（`docs/core-daemon.md` 第 12 节）；本地 stdio 通道不发送 */
  | { kind: 'auth'; token: string }
  | { kind: 'openWorkspace'; id: number; workspaceRef: WorkspaceRef }
  | { kind: 'closeWorkspace'; channel: number }
  | { kind: 'frame'; channel: number; frame: UiToCoreFrame }
  | { kind: 'listDirectories'; id: number; path: string | null }
  | { kind: 'shutdown' };

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
  | { kind: 'authOk' }
  | { kind: 'authFailed'; error: string }
  | { kind: 'workspaceOpened'; id: number; channel: number; descriptor: ChannelDescriptor }
  | { kind: 'workspaceFailed'; id: number; error: string }
  | { kind: 'workspaceClosed'; channel: number; reason: WorkspaceCloseReason }
  | { kind: 'channelReset'; channel: number; reason: string }
  | { kind: 'frame'; channel: number; frame: CoreToUiFrame }
  | { kind: 'directoriesListed'; id: number; path: string; parent: string | null; entries: DirectoryEntry[] }
  | { kind: 'directoriesFailed'; id: number; error: string };

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
    case 'authOk':
      return true;
    case 'authFailed':
      return typeof value['error'] === 'string';
    case 'directoriesListed':
      return (
        typeof value['id'] === 'number'
        && typeof value['path'] === 'string'
        && (value['parent'] === null || typeof value['parent'] === 'string')
        && isDirectoryEntries(value['entries'])
      );
    case 'directoriesFailed':
      return typeof value['id'] === 'number' && typeof value['error'] === 'string';
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
