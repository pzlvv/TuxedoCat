/**
 * 后台 Bash 任务的周期性提醒调度。
 *
 * 每个后台任务有自己的提醒时钟，时钟只在会话「前台空闲」时前进——即
 * `sessionRuntime`（`DEVELOPMENT.md 第 4.5 节`）的 `queryRunning` / `compacting`
 * 均为假，对应 abort 按钮的黄色（`docs/abort-button.md`）。到达 5 / 10 / 20 / 30
 * 分钟（此后固定 30 分钟）时向 LLM 投递一条 reminder，报告任务当前输出、
 * 已执行时间与下次提醒间隔。
 *
 * 时钟只在空闲时累加：query engine 有任务时暂停，避免在 LLM 正在工作时反复打断；
 * 提醒本身会启动一轮查询，因此同一时刻只投递一条。
 *
 * 每个任务另有一个「上次访问时刻」（`lastAccessedAt`）：周期提醒投递时刷新，查询结束时
 * 由 `QueryEngine` 对本会话运行中的全部任务刷新。查询结束的兜底提醒据此冷却
 * （`BACKGROUND_FALLBACK_REMINDER_MIN_INTERVAL_MS`），避免定时提醒刚投递完、它拉起的
 * 那轮查询一结束就又被兜底提醒一次。
 *
 * 对应 Standalone 实现：`core-rs/src/engine.rs` 的 `tick_background_reminders`
 * 与 `core-rs/src/bash_task.rs` 的间隔常量 / 文案。
 */

import { closeSync, fstatSync, openSync, readSync } from 'fs';
import { logger } from '../../Logger.js';
import { getSessionRuntimeState } from '../../sessionRuntime.js';
import { getTaskOutputPath } from './TaskOutput.js';

/**
 * 提醒间隔（分钟）：第 1 次 5min，其后 10 / 20 / 30min，再往后固定 30min。
 *
 * 与 Standalone `bash_task::BACKGROUND_REMINDER_INTERVALS_MIN` 逐项一致。
 */
export const BACKGROUND_REMINDER_INTERVALS_MIN = [5, 10, 20, 30] as const;

/**
 * 同一任务两次提醒之间的最小间隔（查询结束兜底门槛）：距上次「访问」不足 3 分钟的，
 * 查询结束时不进兜底提醒列表——它刚被周期提醒报告过，或本轮查询刚刚看过它。
 *
 * 与 Standalone `bash_task::BACKGROUND_FALLBACK_REMINDER_MIN_INTERVAL_MS` 一致。
 */
export const BACKGROUND_FALLBACK_REMINDER_MIN_INTERVAL_MS = 3 * 60_000;

/**
 * 距上次访问是否已满最小间隔：`lastAccessedAt` 是该任务上次被「访问」的时刻
 * （周期提醒投递 / 查询结束，任务注册时取开始时间）。纯函数，供两侧对等测试共用。
 */
export function qualifiesBackgroundFallbackReminder(
  lastAccessedAt: number,
  now: number = Date.now(),
): boolean {
  return now - lastAccessedAt >= BACKGROUND_FALLBACK_REMINDER_MIN_INTERVAL_MS;
}

/** 调度器轮询间隔：1s 粒度足够（最小间隔是分钟级），开销可忽略 */
const BACKGROUND_REMINDER_TICK_MS = 1000;

/** 提醒里附带的任务输出尾部字符数（与完成通知的 500 保持一致） */
export const BACKGROUND_REMINDER_OUTPUT_CHARS = 500;

/** 第 round 次提醒与上一次之间的分钟数（round 从 0 起；越界取最后一档） */
export function backgroundReminderIntervalMin(round: number): number {
  const index = Math.min(Math.max(Math.trunc(round), 0), BACKGROUND_REMINDER_INTERVALS_MIN.length - 1);
  return BACKGROUND_REMINDER_INTERVALS_MIN[index];
}

/** 第 round 次提醒的间隔标签（如 `5min` / `30min`） */
export function backgroundReminderIntervalLabel(round: number): string {
  return `${backgroundReminderIntervalMin(round)}min`;
}

/** 首次提醒间隔标签（后台任务 tool_result 里告知 LLM 用） */
export const BACKGROUND_REMINDER_FIRST_LABEL = backgroundReminderIntervalLabel(0);

/**
 * 时长格式化（完成通知与提醒共用一份实现）。
 * 对齐 Standalone `bash_task::format_duration`。
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * 提醒时钟状态：`round` 是下一次提醒的序号，`accumulatedMs` 是自上次提醒以来
 * 累积的「空闲」时长。纯数据，供两侧对等测试共用。
 */
export interface ReminderClock {
  round: number;
  accumulatedMs: number;
}

/**
 * 推进提醒时钟：把 `awakeMs` 累加进来，返回本次到点的提醒轮次（从早到晚）。
 *
 * 时钟只由调用方在会话空闲时推进；query engine 有任务时调用方不累加，
 * 因此这里不需要知道查询状态。一次推进可能跨过多个间隔（进程被挂起等），
 * 逐档扣减，保证后续轮次不漂移。
 */
export function advanceReminderClock(clock: ReminderClock, awakeMs: number): number[] {
  const fired: number[] = [];
  if (awakeMs > 0) clock.accumulatedMs += awakeMs;
  while (true) {
    const due = backgroundReminderIntervalMin(clock.round) * 60_000;
    if (clock.accumulatedMs < due) break;
    clock.accumulatedMs -= due;
    fired.push(clock.round);
    clock.round += 1;
  }
  return fired;
}

/** 提醒投递回调（由 `LocalShellTask` 注入：定位该会话引擎并投递 reminder） */
export type BackgroundReminderDelivery = (content: string) => void;

/** 一个后台任务的提醒登记项 */
export interface BackgroundReminderRegistration {
  taskId: string;
  sessionID: string;
  description: string;
  command: string;
  /** 命令开始时间（wall clock），用于报告「已执行时间」 */
  startTime: number;
  pid?: number;
  deliver: BackgroundReminderDelivery;
}

interface ReminderSchedule extends ReminderClock {
  taskId: string;
  sessionID: string;
  description: string;
  command: string;
  startTime: number;
  pid?: number;
  lastTickMs: number;
  /**
   * 上次「访问」该任务的时刻（周期提醒投递 / 查询结束）：查询结束兜底门槛据此冷却。
   * 登记时取任务开始时间（任务刚起不算「已访问」）。
   */
  lastAccessedAt: number;
  deliver: BackgroundReminderDelivery;
}

const schedules = new Map<string, ReminderSchedule>();
let ticker: ReturnType<typeof setInterval> | null = null;

/** 会话是否「前台空闲」（abort 按钮为黄）：queryRunning / compacting 均为假 */
function isSessionAwake(sessionID: string): boolean {
  const state = getSessionRuntimeState(sessionID);
  if (!state) return false;
  return !state.queryRunning && !state.compacting;
}

/** 按当前 OS 生成可执行的 kill 命令（与 LocalShellTask 的兜底提醒同一口径） */
function buildKillCommand(pid: number | undefined): string {
  if (pid === undefined) return 'unknown (pid unavailable)';
  return process.platform === 'win32' ? `taskkill /T /F /PID ${pid}` : `kill ${pid}`;
}

/**
 * 读取后台任务输出文件的尾部（最多 `maxChars * 4` 字节，按 UTF-8 解码）。
 *
 * 后台任务由子进程直接写文件，这里只取尾部做提醒预览，避免把整个输出读进内存。
 */
function readTaskOutputTail(taskId: string, maxChars: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(getTaskOutputPath(taskId), 'r');
    const size = fstatSync(fd).size;
    if (size <= 0) return '';
    const byteCount = Math.min(size, maxChars * 4);
    const buffer = Buffer.alloc(byteCount);
    readSync(fd, buffer, 0, byteCount, size - byteCount);
    return buffer.toString('utf-8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 文件已被子进程关闭 / 删除：忽略
      }
    }
  }
}

/** 提醒文案所需的字段（纯数据，供两侧对等测试共用） */
export interface BackgroundReminderTextInput {
  taskId: string;
  description: string;
  command: string;
  elapsedMs: number;
  /** 任务当前输出（尾部预览由本函数按 UTF-16 截断） */
  output: string;
  /** 下次提醒间隔标签（如 `10min`） */
  nextIntervalLabel: string;
  /** 不再需要时执行的 kill 命令 */
  killCommand: string;
}

/**
 * 构造后台任务的提醒文案（纯文本，纯函数）。
 *
 * 对齐 Standalone `bash_task::build_background_reminder_text`：两侧逐字一致，
 * 差异即对等测试失败。
 */
export function buildBackgroundReminderText(input: BackgroundReminderTextInput): string {
  const commandPart =
    input.command && input.command !== input.description ? `\nCommand: ${input.command}` : '';
  const lines = [
    '<reminder>',
    `Background bash task ${input.taskId} is still running.`,
    `Description: ${input.description}${commandPart}`,
    `Elapsed: ${formatDuration(input.elapsedMs)}`,
  ];

  const output = input.output.trimEnd();
  if (output) {
    const preview =
      output.length > BACKGROUND_REMINDER_OUTPUT_CHARS
        ? `...\n${output.slice(-BACKGROUND_REMINDER_OUTPUT_CHARS)}`
        : output;
    lines.push(`Current output (last ${BACKGROUND_REMINDER_OUTPUT_CHARS} chars):`);
    lines.push(preview);
  }

  lines.push(`Next reminder in ${input.nextIntervalLabel}.`);
  lines.push(`If this task is no longer needed, kill it: ${input.killCommand}`);
  lines.push('Do not sleep or poll; if there is nothing else to do, end this turn.');
  lines.push('</reminder>');
  return lines.join('\n');
}

/** 到点：构造并投递提醒（`round` 是刚触发的轮次，下一次是 `round + 1`） */
function fireReminder(schedule: ReminderSchedule, round: number, now: number): void {
  // 投递即一次「访问」：它拉起的那轮查询结束时，兜底门槛不会再为同一任务触发
  schedule.lastAccessedAt = now;
  const output = readTaskOutputTail(schedule.taskId, BACKGROUND_REMINDER_OUTPUT_CHARS);
  const content = buildBackgroundReminderText({
    taskId: schedule.taskId,
    description: schedule.description,
    command: schedule.command,
    elapsedMs: now - schedule.startTime,
    output,
    nextIntervalLabel: backgroundReminderIntervalLabel(round + 1),
    killCommand: buildKillCommand(schedule.pid),
  });
  try {
    schedule.deliver(content);
  } catch (err) {
    logger.error('BackgroundReminder', `Failed to deliver reminder for ${schedule.taskId}: ${err}`);
  }
}

/**
 * 推进一次所有提醒时钟。由定时器调用；导出以便测试注入确定性的 `now`。
 *
 * 时钟只在会话空闲时累加；`lastTickMs` 每轮都更新，保证暂停期间的时长不计入。
 */
export function tickBackgroundReminders(now: number): void {
  for (const schedule of Array.from(schedules.values())) {
    const delta = now - schedule.lastTickMs;
    schedule.lastTickMs = now;
    if (delta <= 0) continue;
    if (!isSessionAwake(schedule.sessionID)) continue;
    const fired = advanceReminderClock(schedule, delta);
    if (fired.length > 0) {
      fireReminder(schedule, fired[fired.length - 1], now);
    }
  }
}

function ensureTicker(): void {
  if (ticker || schedules.size === 0) return;
  ticker = setInterval(() => tickBackgroundReminders(Date.now()), BACKGROUND_REMINDER_TICK_MS);
  (ticker as { unref?: () => void }).unref?.();
}

function stopTickerIfIdle(): void {
  if (ticker && schedules.size === 0) {
    clearInterval(ticker);
    ticker = null;
  }
}

/** 登记一个后台任务的提醒时钟（任务注册时调用） */
export function registerBackgroundReminder(registration: BackgroundReminderRegistration): void {
  const now = Date.now();
  schedules.set(registration.taskId, {
    taskId: registration.taskId,
    sessionID: registration.sessionID,
    description: registration.description,
    command: registration.command,
    startTime: registration.startTime,
    pid: registration.pid,
    round: 0,
    accumulatedMs: 0,
    lastTickMs: now,
    lastAccessedAt: registration.startTime,
    deliver: registration.deliver,
  });
  ensureTicker();
}

/** 注销单个任务的提醒时钟（任务完成时调用） */
export function unregisterBackgroundReminder(taskId: string): void {
  schedules.delete(taskId);
  stopTickerIfIdle();
}

/** 注销一个会话的全部提醒时钟（会话中止后台任务 / 关闭时调用） */
export function unregisterSessionBackgroundReminders(sessionID: string): void {
  for (const [taskId, schedule] of Array.from(schedules.entries())) {
    if (schedule.sessionID === sessionID) schedules.delete(taskId);
  }
  stopTickerIfIdle();
}

/**
 * 查询结束兜底门槛的运行时入口：该任务距上次访问已满最小间隔才需要兜底。
 *
 * 未登记提醒时钟的任务不进兜底列表（无会话的任务不在 `getRunningBackgroundTasksForSession`
 * 的结果里，查不到时钟说明任务已结束 / 已被注销，此时不该再提醒）。
 */
export function isBackgroundFallbackReminderDue(taskId: string, now: number = Date.now()): boolean {
  const schedule = schedules.get(taskId);
  if (!schedule) return false;
  return qualifiesBackgroundFallbackReminder(schedule.lastAccessedAt, now);
}

/**
 * 登记一次「访问」：把给定任务的上次访问时刻刷新到 `atMs`。
 *
 * 周期提醒在 `fireReminder` 内自调；查询结束由 `QueryEngine` 对本会话运行中的
 * 全部任务调用（无论本次是否兜底）——提醒自己拉起的那轮查询结束时，同一批任务
 * 距上次访问不足最小间隔，不会再被兜底。
 */
export function markBackgroundTasksAccessed(taskIds: readonly string[], atMs: number = Date.now()): void {
  for (const taskId of taskIds) {
    const schedule = schedules.get(taskId);
    if (schedule) schedule.lastAccessedAt = atMs;
  }
}
