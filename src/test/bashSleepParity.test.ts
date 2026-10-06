/**
 * Bash 超时策略对等测试（Embedded ↔ Standalone）。
 *
 * Embedded `Bash.call` 的超时策略：命令含 `sleep` 子命令（按 `;` `&&` `||` `|`
 * 拆分后任一段首词为 `sleep`）时**不设前台超时**（`SLEEP_NO_TIMEOUT_MS = 0`），
 * 其余命令默认 60s。Standalone 侧同一行为由 `core-rs/src/tools.rs` 的
 * `contains_sleep_command` / `run_bash` 实现，对应用例见
 * `core-rs/src/tools_tests.rs` 的 `contains_sleep_command_splits_on_separators` 与
 * `bash_sleep_commands_have_no_foreground_timeout`。
 *
 * 超时的**判定时机**同样对等：Embedded 的定时器是 spawn 后立刻挂上的 `setTimeout`，
 * 与子进程是否已退出无关；Standalone 的 `run_bash` 在「等子进程退出」与「等管道 EOF」
 * 两个阶段共用同一套判定。对应用例见 `core-rs/src/tools_tests.rs` 的
 * `bash_timeout_applies_after_the_shell_exits_with_a_grandchild_holding_the_pipe` 与
 * `bash_abort_applies_after_the_shell_exits_with_a_grandchild_holding_the_pipe`
 * （孙进程持有管道时，子进程退出后 `close` 不会触发）。
 *
 * 本文件断言 Embedded 侧仍然给出同一个「拆分 + sleep 判定 + timeoutMs」口径，
 * 任一侧偏离即失败。
 *
 * 运行方式：npm run test:all -- bash-sleep-parity
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BashTool } from '../core/tools/bash/Bash';
import { execCommand } from '../core/tools/bash/Exec';
import { abortBackgroundTasksForSession } from '../core/tools/bash/LocalShellTask';
import { mapToolResultToToolResultBlockParam } from '../core/tools/bash/Result';
import { containsSleepCommand } from '../core/tools/bash/SleepDetect';
import { splitBySeparators } from '../core/tools/bash/TimeoutPolicy';
import { createChecker, runTests } from './helpers/harness';

const SLEEP_CASES: Array<[string, boolean]> = [
  ['sleep 5', true],
  ['  sleep 5  ', true],
  ['FOO=1 sleep 5', true],
  ['echo a; sleep 5', true],
  ['echo a && sleep 5', true],
  ['echo a || sleep 5', true],
  ['echo a | sleep 5', true],
  ['echo done', false],
  ["echo 'sleep 5'", false],
  ['grep "a|b" file.txt', false],
  ['nosleep 5', false],
  // 首尾各最多去掉一个引号（`replace(/^["']|["']$/g, '')`）
  ["'''sleep 5", false],
];

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // ===== 拆分 + sleep 判定（与 Rust `contains_sleep_command` 同表）=====
  for (const [command, expected] of SLEEP_CASES) {
    check(
      `containsSleepCommand(${JSON.stringify(command)}) === ${expected}`,
      containsSleepCommand(splitBySeparators(command)) === expected,
    );
  }

  // ===== 真实执行：sleep 轮次不设前台超时，进度事件 timeoutMs === 0 =====
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-sleep-parity-'));
  try {
    const progress: Array<Record<string, unknown>> = [];
    const result = await (BashTool as any).call(
      { command: "printf 'go\\n'; sleep 0.2" },
      {
        cwd: dir,
        sessionId: 's1',
        abortController: new AbortController(),
        getAppState: () => ({}),
        setAppState: () => undefined,
      },
      undefined,
      (update: { data?: Record<string, unknown> }) => {
        if (update?.data) progress.push(update.data);
      },
    );
    const data = result.data as { stdout: string; exitCode: number; interrupted?: boolean };
    check('sleep 轮次正常完成（未被超时打断）', data.interrupted !== true);
    check('sleep 轮次退出码为 0', data.exitCode === 0);
    check('sleep 轮次的 stdout 含 printf 输出', String(data.stdout).includes('go'));
    check(
      'sleep 轮次进度事件 timeoutMs === 0',
      progress.length > 0 && progress.every((item) => item.timeoutMs === 0),
    );

    // ===== abort 立刻杀掉不设超时的 sleep 子进程 =====
    // 对齐 Rust `bash_abort_kills_a_sleep_command_without_a_timeout`：
    // `sleep` 轮次没有前台超时，abort 必须自己杀掉子进程（exitCode 130 + interrupted）。
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();
    const aborted = await (BashTool as any).call(
      { command: "printf 'go\\n'; sleep 3" },
      {
        cwd: dir,
        sessionId: 's1',
        abortController: controller,
        getAppState: () => ({}),
        setAppState: () => undefined,
      },
      undefined,
      undefined,
    );
    const elapsed = Date.now() - started;
    const abortedData = aborted.data as {
      stdout: string;
      exitCode: number;
      interrupted?: boolean;
    };
    check('abort 后中断标记为真', abortedData.interrupted === true);
    check('abort 后退出码为 130', abortedData.exitCode === 130);
    check('abort 前已累积的 stdout 被保留', String(abortedData.stdout).includes('go'));
    check('abort 立刻生效（未等待 sleep 结束）', elapsed < 1_500);

    // ===== 超时判定与子进程是否已退出无关 =====
    // `sleep 2 &` 让 bash 立刻退出，但后台 `sleep` 继承了管道写端，`close` 事件不会触发。
    // Embedded 的定时器是独立于子进程状态的 `setTimeout`，到点照常转后台，因此不会卡住。
    // 对齐 Rust `bash_timeout_applies_after_the_shell_exits_with_a_grandchild_holding_the_pipe`。
    const bgStarted = Date.now();
    const bg = await execCommand({
      command: 'echo started; sleep 2 &',
      timeout: 300,
      cwd: dir,
      signal: new AbortController().signal,
      description: 'Grandchild holds the pipe',
      sessionID: 's1',
    });
    const bgElapsed = Date.now() - bgStarted;
    check('孙进程持有管道时前台超时照样转后台', bg.assistantAutoBackgrounded === true);
    check('转入后台前的已累积输出被保留', String(bg.stdout).includes('started'));
    check('超时未等孙进程自然退出', bgElapsed < 1_200);

    // 自动转后台的 tool_result 文案只拼一次，不再与 `Exec` 回传的 stderr 重复。
    // 对齐 Rust `bash_timeout_moves_the_command_to_the_background`。
    const mappedText = String(mapToolResultToToolResultBlockParam(bg, 'toolu-bg-auto').content);
    check(
      '自动转后台说明带已运行时长与 taskId',
      /Command moved to the background after \d+ms \(task ID: bg-auto-/.test(mappedText),
    );
    check('自动转后台说明带输出文件路径', mappedText.includes(`${bg.backgroundTaskId}.output`));
    check(
      '自动转后台的完成通知只出现一次',
      mappedText.split('you will be notified when it completes.').length === 2,
    );
    check(
      '自动转后台说明提示不要轮询、先去处理其它事情',
      mappedText.includes(
        'Do not poll for the result — you will be notified when it completes. Continue with other tasks in the meantime; if there is nothing else to do, end this turn.',
      ),
    );
    abortBackgroundTasksForSession('s1');
  } finally {
    // Windows 上杀掉 shell 不会带走孙进程（`sleep`），它仍持有 cwd / 管道，
    // 立刻删目录会 EPERM；清理失败不影响用例结论，临时目录交给系统回收。
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* ignore */
    }
  }

  finish();
}

runTests('bash-sleep-parity', run);
