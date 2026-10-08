#!/usr/bin/env node
/**
 * 生成「后台任务周期性提醒」对等对照表。
 *
 * 对照表 `src/test/fixtures/backgroundReminderParity.json` 被两侧共用：
 * - `src/test/backgroundReminderParity.test.ts` 断言 Embedded
 *   （`src/core/tools/bash/BackgroundReminder.ts`）的输出等于对照表；
 * - `core-rs/src/bash_task_tests.rs` 断言 Standalone
 *   （`core-rs/src/bash_task.rs`）的输出等于对照表。
 *
 * 覆盖四件事：间隔档位（5 / 10 / 20 / 30 / 30…）、提醒时钟推进（空闲累加、
 * 暂停不累加、一次跨多档）、提醒文案（描述 / 命令 / 时长 / 输出尾部 / 下次间隔）、
 * 兜底提醒门槛（满 3 分钟或命令含 sleep 才进查询结束的兜底列表）。
 *
 * 用法：先 `npm run compile-tests`，再 `node scripts/gen-background-reminder-parity.mjs`。
 */

import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const reminder = require(
  join(repoRoot, 'out', 'src', 'core', 'tools', 'bash', 'BackgroundReminder.js'),
);

const MINUTE = 60_000;

// ---- 间隔档位 ----
const intervalLabelCases = [0, 1, 2, 3, 4, 100].map((round) => ({
  round,
  min: reminder.backgroundReminderIntervalMin(round),
  label: reminder.backgroundReminderIntervalLabel(round),
}));

// ---- 提醒时钟推进 ----
// steps 里每个元素是「本次空闲时长」，fired 由真实实现推进后记录。
const clockStepSpecs = [
  {
    name: '未满 5min 不触发',
    steps: [299_999],
  },
  {
    name: '满 5min 触发第 0 轮',
    steps: [5 * MINUTE],
  },
  {
    name: '按 5 / 10 / 20 / 30 / 30 依次到点',
    steps: [5 * MINUTE, 10 * MINUTE, 20 * MINUTE, 30 * MINUTE, 30 * MINUTE],
  },
  {
    name: '暂停后按剩余量继续（不足一档不触发）',
    steps: [3 * MINUTE, 2 * MINUTE],
  },
  {
    name: '一次跨过多档逐档触发',
    steps: [15 * MINUTE],
  },
];

const clockCases = clockStepSpecs.map((spec) => {
  const clock = { round: 0, accumulatedMs: 0 };
  const steps = spec.steps.map((awakeMs) => ({
    awakeMs,
    fired: reminder.advanceReminderClock(clock, awakeMs),
  }));
  return { name: spec.name, steps };
});

// ---- 提醒文案 ----
const textInputs = [
  {
    name: '带命令与短输出',
    taskId: 'bg-1',
    description: 'Say hello',
    command: 'echo hello',
    elapsedMs: 5 * MINUTE,
    output: 'hello\n',
    nextIntervalLabel: '10min',
    killCommand: 'kill 1234',
  },
  {
    name: '命令与描述相同、无输出',
    taskId: 'bg-2',
    description: 'echo hi',
    command: 'echo hi',
    elapsedMs: 65_000,
    output: '',
    nextIntervalLabel: '5min',
    killCommand: 'taskkill /T /F /PID 4321',
  },
  {
    name: '亚秒级时长',
    taskId: 'bg-3',
    description: 'Quick',
    command: 'quick',
    elapsedMs: 999,
    output: 'done',
    nextIntervalLabel: '30min',
    killCommand: 'kill 7',
  },
  {
    name: '长输出取尾部 500 字符',
    taskId: 'bg-4',
    description: 'Stream',
    command: 'stream',
    elapsedMs: 125_000,
    output: '0123456789'.repeat(52),
    nextIntervalLabel: '20min',
    killCommand: 'kill 999',
  },
];

const textCases = textInputs.map((input) => ({
  ...input,
  expected: reminder.buildBackgroundReminderText(input),
}));

// ---- 兜底提醒门槛（查询结束的一次性提醒）----
// 时间无关口径：只记 elapsedMs 与 command，startTime 由消费侧以「now - elapsedMs」
// 现算，两侧对同一份用例断言布尔结果。
const FALLBACK_NOW = 10 * 60_000;
const fallbackQualifyInputs = [
  { name: '刚起不久的普通命令不进列表', elapsedMs: 1_000, command: 'echo hi' },
  { name: '不满 3 分钟的普通命令不进列表', elapsedMs: 3 * MINUTE - 1, command: 'echo hi' },
  { name: '满 3 分钟进列表', elapsedMs: 3 * MINUTE, command: 'echo hi' },
  { name: 'sleep 命令即时进列表', elapsedMs: 0, command: 'sleep 300' },
  { name: '组合段里的 sleep 也进列表', elapsedMs: 0, command: 'echo a && sleep 5' },
  { name: '参数里的 sleep 字样不算', elapsedMs: 1_000, command: 'echo sleep' },
  { name: '环境变量前缀后的 sleep 算', elapsedMs: 0, command: 'FOO=1 sleep 5' },
  { name: '管道后面的 sleep 算', elapsedMs: 0, command: 'cat x | sleep 1' },
];

const fallbackQualifyCases = fallbackQualifyInputs.map((input) => ({
  ...input,
  expected: reminder.qualifiesBackgroundFallbackReminder(
    { startTime: FALLBACK_NOW - input.elapsedMs, command: input.command },
    FALLBACK_NOW,
  ),
}));

const fixture = {
  note: '后台任务周期性提醒对照表：Embedded（src/core/tools/bash/BackgroundReminder.ts）与 Standalone（core-rs/src/bash_task.rs）逐字一致。由 scripts/gen-background-reminder-parity.mjs 生成。',
  intervalsMin: [...reminder.BACKGROUND_REMINDER_INTERVALS_MIN],
  fallbackMinElapsedMs: reminder.BACKGROUND_REMINDER_MIN_ELAPSED_MS,
  firstLabel: reminder.BACKGROUND_REMINDER_FIRST_LABEL,
  intervalLabelCases,
  clockCases,
  textCases,
  fallbackQualifyCases,
};

const outPath = join(repoRoot, 'src', 'test', 'fixtures', 'backgroundReminderParity.json');
writeFileSync(outPath, JSON.stringify(fixture, null, 2) + '\n', 'utf8');
console.log(`已写入 ${outPath}`);
