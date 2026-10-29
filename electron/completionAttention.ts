/**
 * 「任务完成」绿色呼吸灯的武装判定（`electron/main.ts` 的完成提醒数据源）。
 *
 * 会话从运行中变为空闲时，如果用户当时**看不到这次完成**——主窗口失焦、会话归属
 * 的标签页未激活、或该会话不是当前对话——就把这次完成对**对话列表项**武装起来；
 * **标签页**只在完成时该标签页未激活才武装：绿色表示未读，用户正看着的标签页
 * （激活中）本身就是已读状态，里面的完成由对话项的灯当场表达，切走再切回不该
 * 翻旧账。武装即推（失焦也推）：可见但未聚焦的窗口当场亮灯，不回窗不补亮；窗口
 * 最小化 / 隐藏时推送无可见效果，恢复后灯条以常亮呈现。呼吸一次后常亮，直到用户
 * 阅读（激活标签页 / 打开该对话）；回窗聚焦那一刻正完全可见的对话由
 * `pickReadCompletions` 清掉——聚焦即已读，切走后不补亮。
 *
 * core 只推全量 `sessionRuntimeChanged` 快照（docs/core/session-runtime.md），没有单会话完成事件；
 * 与托盘「任务结束提醒」（`trayAttention.ts`）同一手法：对相邻两次全量推送按
 * sessionId 差分出事件，不引入新的事件流。差分语义与托盘一致：只有 running → idle
 * 算完成（waiting → idle 是用户应答 / 中止的结果，不是刚结束的任务）；新出现的会话
 * 只登记不产生事件；消失的会话从级别表移除（调用方据此清掉其待播放项）。
 *
 * 本模块保持纯函数（不 import electron），可被 `src/test/completionAttention.test.ts`
 * 单测；焦点 / 激活 / 当前对话等事实由调用方经 `factsOf` 回调注入。
 */

import { sessionBusyLevel } from '../src/shared/sessionRuntime.js';
import { isAgentCreator, type SessionCreator } from '../src/shared/sessionCreator.js';
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
  states: ReadonlyArray<{ sessionId: string; idle?: boolean; waiting?: boolean; creator?: SessionCreator }>,
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
    // 非 user 创建的会话（本地子代理 / Agent 工具派发的跨工作区对话）完成保持安静
    // （specs/025 FR-003）：不武装对话行绿灯，也不武装标签页灯——武装是未读事实的
    // 写入点，在源头掐掉，未读集合与各处显示天然一致
    const isAgentCreated = item.creator !== undefined && isAgentCreator(item.creator);
    if (before !== undefined && before === 'running' && level === 'idle' && !isAgentCreated) {
      const facts = factsOf(item.sessionId);
      // 对话项：用户当时看不到这次完成（窗口失焦 / 标签页未激活 / 非当前对话）才武装；
      // 标签页：只在完成时该标签页未激活才武装——激活中的标签页视为已读，
      // 正盯着它看到的完成由对话项的灯表达，切走再切回不补亮
      if (!isCompletionVisible(facts)) {
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

/** 此刻的画面事实下用户是否完全看得到该会话：窗口聚焦 + 标签页激活 + 当前对话。
 * 武装取它的反义（看不到才记未读），回窗清理取它本身（看得到即已读）——两个
 * 判定共用这一份，不会各写一遍走样。 */
function isCompletionVisible(facts: CompletionAttentionFacts): boolean {
  return facts.windowFocused && facts.tabActive && facts.sessionCurrent;
}

/**
 * 从待播放集合挑出「已读」项：此刻完全可见（`isCompletionVisible`）的未读完成。
 *
 * 完成发生在窗口失焦期间、而该对话**本来就是**当前对话时，「成为当前对话」的
 * 清除迁移永远不来（它没有迁移过）——聚焦是它唯一的已读时机。回窗播放前就地
 * 清掉，用户切到别的对话后灯条不会补亮（正在看的就是「已读」，不翻旧账）。
 * 返回应从未读集合移除的 sessionId，其余照常播放（呼吸一次后常亮）。
 */
export function pickReadCompletions(
  unread: ReadonlyArray<string>,
  factsOf: (sessionId: string) => CompletionAttentionFacts,
): string[] {
  return unread.filter((sessionId) => isCompletionVisible(factsOf(sessionId)));
}

/**
 * 「离场完成」的补武装（specs/defects/orphan-completion-unread-light）：后台运行
 * 期间会话完成时宿主不在场——帧进 daemon 孤儿表，不进任何连接，实时差分永远
 * 看不到迁移；core 把次数记进 meta.json 的 `unreadCompletions`，重开后宿主装载
 * 对话列表据它补武装。daemon 空退（30s 空闲窗口）后重开的是全新 Core，快照流里
 * 不会再出现该会话，这份磁盘证据是绿灯不丢的唯一来源。
 *
 * 与在线差分的分工天然不相交：在线完成走连接路由、core 不计数，本函数只补
 * 「宿主完全缺席」的那部分。agent 创建的会话保持安静（specs/025 FR-003，与差分
 * 同一在源头掐掉的口径）；已在未读集合里的 id 保留原到达时刻（不重复呼吸）。
 * 标签页灯的归属解析需要画面事实（会话 → 工作目录归属），由调用方在武装后按
 * 未读集合统一补挂——归属索引晚到的会话（非活动目录的列表后到）在索引补齐后
 * 也要挂上，见 `electron/main.ts` 的列表到达出口。
 */
export function backfillCompletionAttention(
  existing: ReadonlyArray<string>,
  list: ReadonlyArray<{
    sessionId: string;
    unreadCompletions?: number;
    creator?: SessionCreator;
  }>,
): string[] {
  const known = new Set(existing);
  const sessions: string[] = [];
  for (const item of list) {
    if (!item?.sessionId || known.has(item.sessionId)) continue;
    if ((item.unreadCompletions ?? 0) <= 0) continue;
    if (item.creator !== undefined && isAgentCreator(item.creator)) continue;
    sessions.push(item.sessionId);
  }
  return sessions;
}
