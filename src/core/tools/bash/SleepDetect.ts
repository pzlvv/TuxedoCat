/**
 * SleepDetect - sleep 命令检测
 *
 * 用于 Bash 工具的超时策略：
 * - 普通命令：默认 60s 超时，超时自动转入后台
 * - sleep 命令（任何子命令段包含 sleep）：不设超时，让 sleep 自然完成；
 *   但在 sleep 过程中若收到后台任务完成通知或子代理 Reply，
 *   则立刻将当前 sleep 执行转入后台，避免阻塞模型处理通知
 */

import { onBackgroundTaskCompleted } from './LocalShellTask.js';
import { onAgentReplyDelivered, type AgentReplyDeliveredInfo } from './NotifyEvents.js';

/** sleep 命令名 */
const SLEEP_COMMAND = 'sleep';

/**
 * 从单个子命令段提取第一个命令名
 * （例如 "sleep 5" -> "sleep"，"'sleep 5'" -> sleep，考虑引号包裹的情况）
 */
function extractCommandName(segment: string): string {
  let s = segment.trim();
  // 去掉环境变量前缀，如 "FOO=1 sleep 5"
  while (true) {
    const m = s.match(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)\s+/);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  // 取第一个词
  const firstWord = s.split(/\s+/)[0] ?? '';
  // 去除包裹引号
  return firstWord.replace(/^["']|["']$/g, '');
}

/**
 * 检查命令是否包含 sleep 子命令
 *
 * 由调用方先按 ; && || | 分隔符拆分（复用 Validation._splitBySeparators 的
 * 引号感知逻辑），再对每个子命令段提取第一个词判断是否为 sleep。
 */
export function containsSleepCommand(segments: string[]): boolean {
  for (const segment of segments) {
    if (extractCommandName(segment) === SLEEP_COMMAND) {
      return true;
    }
  }
  return false;
}

/**
 * sleep 执行过程中的通知监听清理函数集合
 */
export interface SleepNotifyWatch {
  /** 取消所有监听 */
  unsubscribe: () => void;
}

/**
 * 监听 sleep 执行期间的"外部事件"：
 * - 后台 Bash 任务完成通知
 * - 子代理 Reply 消息投递到目标引擎
 *
 * 任一事件发生时立即触发回调（Exec 层会用它把 sleep 转入后台）。
 *
 * @param sessionID 当前会话 ID，用于过滤只关心本会话相关的事件
 * @param onNotify 事件触发回调
 */
export function watchSleepNotifications(
  sessionID: string | undefined,
  onNotify: (reason: string) => void,
): SleepNotifyWatch {
  const unsubscribeBgCompleted = onBackgroundTaskCompleted((info) => {
    // 后台任务完成：与本会话相关（或未指定会话）时触发
    if (!sessionID || !info.sessionID || info.sessionID === sessionID) {
      onNotify('background-task-completed');
    }
  });

  const unsubscribeAgentReply = onAgentReplyDelivered((info: AgentReplyDeliveredInfo) => {
    // 子代理 Reply 投递到本会话（或未指定会话）时触发
    if (!sessionID || !info.targetSessionId || info.targetSessionId === sessionID) {
      onNotify('subagent-reply');
    }
  });

  return {
    unsubscribe: () => {
      unsubscribeBgCompleted();
      unsubscribeAgentReply();
    },
  };
}
