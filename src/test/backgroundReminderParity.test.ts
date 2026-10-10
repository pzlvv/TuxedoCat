/**
 * 后台任务周期性提醒对等测试（Embedded ↔ Standalone）。
 *
 * 两侧共用 `src/test/fixtures/backgroundReminderParity.json`：
 * - 本文件断言 Embedded（`src/core/tools/bash/BackgroundReminder.ts`）的间隔档位 /
 *   时钟推进 / 提醒文案等于对照表；
 * - `core-rs/src/bash_task_tests.rs` 断言 Standalone（`core-rs/src/bash_task.rs`）
 *   的输出等于同一张对照表。
 *
 * 对照表由 `scripts/gen-background-reminder-parity.mjs` 生成（先 `npm run compile-tests`）。
 *
 * 运行方式：npm run test:all -- background-reminder-parity
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  BACKGROUND_FALLBACK_REMINDER_MIN_INTERVAL_MS,
  BACKGROUND_REMINDER_FIRST_LABEL,
  BACKGROUND_REMINDER_INTERVALS_MIN,
  advanceReminderClock,
  backgroundReminderIntervalLabel,
  backgroundReminderIntervalMin,
  buildBackgroundReminderText,
  qualifiesBackgroundFallbackReminder,
  type ReminderClock,
} from '../core/tools/bash/BackgroundReminder';
import { createChecker, runTests } from './helpers/harness';

const FIXTURE = path.resolve(__dirname, '../../../src/test/fixtures/backgroundReminderParity.json');

interface IntervalLabelCase {
  round: number;
  min: number;
  label: string;
}

interface ClockStep {
  awakeMs: number;
  fired: number[];
}

interface ClockCase {
  name: string;
  steps: ClockStep[];
}

interface TextCase {
  name: string;
  taskId: string;
  description: string;
  command: string;
  elapsedMs: number;
  output: string;
  nextIntervalLabel: string;
  killCommand: string;
  expected: string;
}

interface FallbackQualifyCase {
  name: string;
  sinceLastAccessMs: number;
  command: string;
  fallbackReminded: boolean;
  expected: boolean;
}

interface Fixture {
  intervalsMin: number[];
  fallbackMinIntervalMs: number;
  firstLabel: string;
  intervalLabelCases: IntervalLabelCase[];
  clockCases: ClockCase[];
  textCases: TextCase[];
  fallbackQualifyCases: FallbackQualifyCase[];
}

function run(): void {
  const { check, finish } = createChecker();
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Fixture;

  check(
    '间隔档位与对照表一致',
    JSON.stringify([...BACKGROUND_REMINDER_INTERVALS_MIN]) === JSON.stringify(fixture.intervalsMin),
  );
  check(
    '兜底门槛的最小提醒间隔与对照表一致',
    BACKGROUND_FALLBACK_REMINDER_MIN_INTERVAL_MS === fixture.fallbackMinIntervalMs,
  );
  check('首次提醒标签与对照表一致', BACKGROUND_REMINDER_FIRST_LABEL === fixture.firstLabel);

  for (const item of fixture.intervalLabelCases) {
    check(
      `第 ${item.round} 轮间隔为 ${item.label}`,
      backgroundReminderIntervalMin(item.round) === item.min
        && backgroundReminderIntervalLabel(item.round) === item.label,
    );
  }

  for (const clockCase of fixture.clockCases) {
    const clock: ReminderClock = { round: 0, accumulatedMs: 0 };
    const fired = clockCase.steps.map((step) => advanceReminderClock(clock, step.awakeMs));
    check(
      `时钟推进：${clockCase.name}`,
      JSON.stringify(fired) === JSON.stringify(clockCase.steps.map((step) => step.fired)),
    );
  }

  for (const textCase of fixture.textCases) {
    check(
      `提醒文案：${textCase.name}`,
      buildBackgroundReminderText({
        taskId: textCase.taskId,
        description: textCase.description,
        command: textCase.command,
        elapsedMs: textCase.elapsedMs,
        output: textCase.output,
        nextIntervalLabel: textCase.nextIntervalLabel,
        killCommand: textCase.killCommand,
      }) === textCase.expected,
    );
  }

  // 兜底门槛：now 固定，上次访问时刻按 sinceLastAccessMs 倒推，结果与对照表逐条一致
  const fallbackNow = 10 * 60_000;
  for (const qualifyCase of fixture.fallbackQualifyCases) {
    check(
      `兜底门槛：${qualifyCase.name}`,
      qualifiesBackgroundFallbackReminder(
        {
          lastAccessedAt: fallbackNow - qualifyCase.sinceLastAccessMs,
          command: qualifyCase.command,
          fallbackReminded: qualifyCase.fallbackReminded,
        },
        fallbackNow,
      ) === qualifyCase.expected,
    );
  }

  finish();
}

runTests('backgroundReminderParity', run);
