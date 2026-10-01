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
  | { kind: 'openWorkspace'; id: number; workspaceRef: WorkspaceRef }
  | { kind: 'closeWorkspace'; channel: number }
  | { kind: 'frame'; channel: number; frame: UiToCoreFrame }
  | { kind: 'shutdown' };

/** channel 关闭原因 */
export type WorkspaceCloseReason = 'closed' | 'crashed' | 'failed';

/** daemon → Host */
export type DaemonToHostFrame =
  | { kind: 'workspaceOpened'; id: number; channel: number; descriptor: ChannelDescriptor }
  | { kind: 'workspaceFailed'; id: number; error: string }
  | { kind: 'workspaceClosed'; channel: number; reason: WorkspaceCloseReason }
  | { kind: 'channelReset'; channel: number; reason: string }
  | { kind: 'frame'; channel: number; frame: CoreToUiFrame };

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

/** 收窄为合法的 daemon → Host 帧（未知类型返回 false，由调用方丢弃并记录） */
export function isDaemonToHostFrame(value: unknown): value is DaemonToHostFrame {
  if (!isRecord(value)) return false;
  switch (value['kind']) {
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
