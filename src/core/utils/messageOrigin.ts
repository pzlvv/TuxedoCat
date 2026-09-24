import type { MessageOrigin } from '../types.js';

/**
 * 读取消息来源，兼容历史持久化字段。
 *
 * 新格式只写 `origin`；旧会话文件里是 `fromSubAgent` / `fromBashTask` 两个布尔字段，
 * 这里统一归一化成同一个值，避免调用方到处写兼容判断。
 *
 * 返回值 `undefined` 表示「未显式标记」，语义上等同于 `user`（用户真实输入）。
 */
export function getMessageOrigin(msg: unknown): MessageOrigin | undefined {
  const m = msg as {
    origin?: unknown;
    fromSubAgent?: unknown;
    fromBashTask?: unknown;
  } | null | undefined;
  if (!m) return undefined;
  if (m.origin === 'user' || m.origin === 'agent' || m.origin === 'bash') {
    return m.origin;
  }
  if (m.fromSubAgent === true) return 'agent';
  if (m.fromBashTask === true) return 'bash';
  return undefined;
}

/** 是否为系统自动消息（子代理 / 后台 Bash 通知），即非用户真实输入。 */
export function isAutoMessageOrigin(origin: MessageOrigin | undefined): boolean {
  return origin === 'agent' || origin === 'bash';
}

/** 便捷判断：给定消息是否来自系统自动消息（兼容旧字段）。 */
export function isAutoMessage(msg: unknown): boolean {
  return isAutoMessageOrigin(getMessageOrigin(msg));
}
