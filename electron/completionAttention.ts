/**
 * 「任务完成」绿色呼吸灯的武装判定（`electron/main.ts` 的完成提醒数据源）。
 *
 * 会话从运行中变为空闲时，如果用户当时**看不到这次完成**——主窗口失焦、会话归属
 * 的标签页未激活、或该会话不是当前对话——就把这次完成对**对话列表项**武装起来；
 * **标签页**只在完成时该标签页未激活才武装：绿色表示未读，用户正看着的标签页
 * （激活中）本身就是已读状态，里面的完成由对话项的灯当场表达，切走再切回不该
 * 翻旧账。武装项进入待播放集合，等用户回到现场（窗口聚焦且标签页可见）再亮灯：
 * 呼吸一次后常亮，直到用户阅读（激活标签页 / 打开该对话）。
 *
 * core 只推全量 `sessionRuntimeChanged` 快照（第 4.5 节），没有单会话完成事件；
 * 与托盘「任务结束提醒」（`trayAttention.ts`）同一手法：对相邻两次全量推送按
 * sessionId 差分出事件，不引入新的事件流。差分语义与托盘一致：只有 running → idle
 * 算完成（waiting → idle 是用户应答 / 中止的结果，不是刚结束的任务）；新出现的会话
 * 只登记不产生事件；消失的会话从级别表移除（调用方据此清掉其待播放项）。
 *
 * 本模块保持纯函数（不 import electron），可被 `src/test/completionAttention.test.ts`
 * 单测；焦点 / 激活 / 当前对话等事实由调用方经 `factsOf` 回调注入。
 */

import { sessionBusyLevel } from '../src/core/sessionRuntime.js';
import type { SessionLevel } from './trayAttention.js';

/** 完成时刻的画面事实（由宿主注入；呼吸是否武装完全由它们推导） */
export interface CompletionAttentionFacts {
  /** 会话归属工作区的稳定 id（`workspaceRefKey`）；解析不出（未登记归属）为 null */
  workspaceKey: string | null;
  /** 会话归属的标签页是否是当前激活项 */
  tabActive: boolean;
  /** 该会话是否是聊天区当前展示的对话 */
  sessionCurrent: boolean;
  /** 主窗口是否持有焦点 */
  windowFocused: boolean;
}

/** 差分结果：推进后的级别表 + 本次要武装的标签页 / 对话 + 快照里消失的会话 */
export interface CompletionAttentionDiff {
  /** 推进后的级别表（调用方持有，作为下一次差分的 `prev`） */
  next: Map<string, SessionLevel>;
  /** 本次武装的标签页（工作区稳定 id，已去重；仅完成时未激活的标签页） */
  tabs: string[];
  /** 本次武装的对话（sessionId，已去重） */
  sessions: string[];
  /** 本次快照里消失的会话（关闭工作区 / 删除对话）：调用方应从待播放集合移除 */
  gone: string[];
}

/**
 * 差分两次全量推送，产出「完成任务见」的武装项与推进后的级别表。
 *
 * `factsOf` 只对**本次真正完成**（running → idle）的会话调用——其余迁移不需要
 * 画面事实，避免为每次状态推送全量求值焦点 / 激活状态。
 */
export function diffCompletionAttention(
  prev: ReadonlyMap<string, SessionLevel>,
  states: ReadonlyArray<{ sessionId: string; idle?: boolean; waiting?: boolean }>,
  factsOf: (sessionId: string) => CompletionAttentionFacts,
): CompletionAttentionDiff {
  const next = new Map<string, SessionLevel>();
  const tabs = new Set<string>();
  const sessions = new Set<string>();
  const gone: string[] = [];

  for (const item of states) {
    // 忙闲判定收敛在 core 的 sessionBusyLevel（与托盘状态点 / 标签页流水灯同一份派生）
    const level = sessionBusyLevel({ idle: item.idle ?? true, waiting: item.waiting ?? false });
    const before = prev.get(item.sessionId);
    if (before !== undefined && before === 'running' && level === 'idle') {
      const facts = factsOf(item.sessionId);
      // 对话项：用户当时看不到这次完成（窗口失焦 / 标签页未激活 / 非当前对话）才武装；
      // 标签页：只在完成时该标签页未激活才武装——激活中的标签页视为已读，
      // 正盯着它看到的完成由对话项的灯表达，切走再切回不补亮
      if (!facts.windowFocused || !facts.tabActive || !facts.sessionCurrent) {
        sessions.add(item.sessionId);
      }
      if (facts.workspaceKey && !facts.tabActive) {
        tabs.add(facts.workspaceKey);
      }
    }
    next.set(item.sessionId, level);
  }

  for (const sessionId of prev.keys()) {
    if (!next.has(sessionId)) gone.push(sessionId);
  }

  return { next, tabs: [...tabs], sessions: [...sessions], gone };
}
