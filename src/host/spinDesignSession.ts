/**
 * Spin 设计器的会话切换判定（宿主无关）。
 *
 * 设计器是单例窗口：从别的标签页再 `/spin` 时先读新会话，读成功才切绑定；
 * 读失败（Core 返回 error 或请求 reject）保持原绑定，避免把 A 的画布保存到 B。
 *
 * 两个宿主实现共用这一份判定，差异只在「怎么聚焦窗口 / 怎么推消息」。
 */
import type { SpinDesignReadResult } from '../shared/AssistantEventBus.js';

export type SpinDesignSessionSwitch =
  | { kind: 'unchanged' }
  | { kind: 'switch'; sessionId: string; read: Extract<SpinDesignReadResult, { status: 'ok' }> }
  | { kind: 'error'; message: string };

/**
 * 判定是否切换设计器绑定的会话。
 *
 * `read` 只在「确实要切」时调用；`unchanged` 不触发任何读取（同会话聚焦复用）。
 */
export async function planSpinDesignSessionSwitch(
  currentSessionId: string | null,
  requestedSessionId: string | null,
  read: (sessionId: string) => Promise<SpinDesignReadResult>,
): Promise<SpinDesignSessionSwitch> {
  if (requestedSessionId === null || requestedSessionId === currentSessionId) {
    return { kind: 'unchanged' };
  }
  try {
    const result = await read(requestedSessionId);
    if (result.status === 'error') {
      return { kind: 'error', message: result.message };
    }
    return { kind: 'switch', sessionId: requestedSessionId, read: result };
  } catch (err) {
    return { kind: 'error', message: String(err) };
  }
}
