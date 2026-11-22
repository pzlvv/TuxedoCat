/**
 * `launchApp` 的启动后视图等待必须用调用方预算，不能写死
 * （`specs/defects/e2e-launchapp-inner-chatpage-wait-ignores-caller-timeout.md`）。
 *
 * 缺陷背景：`launchApp` 在返回 `AppHandle` 之前无条件调一次
 * `waitForChatPage()`（无参数 → 空 opts + 默认 45s），而 `AppHandle.chatPage(opts, timeoutMs)`
 * 声明的超时是调用方传的。于是 `remoteSshExecution.spec.ts` 写的 180s 从未生效：
 * CI 上远端工作区恢复超过 45s 时，用例在 78s 处失败（run 44973531021），报错文案里的
 * `opts` 是 `{}` 而不是调用方传的 `{workspaceIncludes:'tuxedo-e2e-ssh'}`——排障时被误导成
 * 「调用方没传条件」。同一份代码在远端恢复较快时（29.7s，run 44962124641）通过，
 * 分界线正是 45s。
 *
 * 为什么静态断言：`waitForChatPage` 依赖真实 Electron + CDP 上下文，单测里起不了。
 * 这条缺陷的性质是「契约声明的预算没被内部路径使用」，落点是**调用形态**——内部那次
 * 等待必须带显式预算参数。同 `e2eCiLane.test.ts` 的做法，读源码做结构对照。
 *
 * 运行方式：`npm run test:unit -- e2eLaunchStartupBudget`
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { runCases } from './helpers/harness';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ELECTRON_APP = path.join(REPO_ROOT, 'e2e', 'helpers', 'electronApp.ts');

function read(file: string): string {
  if (!fs.existsSync(file)) throw new Error(`缺少文件：${path.relative(REPO_ROOT, file)}`);
  return fs.readFileSync(file, 'utf-8');
}

/**
 * 取 `launchApp` 函数体文本。
 *
 * 从 `export async function launchApp(` 起，到下一个顶格 `}` 止（函数体内缩进都 >= 2 空格）。
 * 不引 TS 解析器：这份断言只看调用形态，正则足够且不增加依赖。
 */
function launchAppBody(source: string): string {
  const start = source.indexOf('export async function launchApp(');
  if (start < 0) throw new Error('`electronApp.ts` 里找不到 launchApp 定义');
  // 从签名末尾的 `): Promise<AppHandle> {` 之后开始算函数体：签名里的
  // `}): Promise<AppHandle> {` 含顶格 `}`，直接搜 `\n}\n` 会在签名处就误判闭合。
  const sigEnd = source.indexOf('): Promise<AppHandle> {', start);
  if (sigEnd < 0) throw new Error('launchApp 签名不是预期的 `): Promise<AppHandle> {`');
  const bodyStart = source.indexOf('\n', sigEnd) + 1;
  const rest = source.slice(bodyStart);
  const end = rest.search(/^\}/m);
  if (end < 0) throw new Error('launchApp 函数体没有正常闭合');
  return rest.slice(0, end);
}

/** `waitForChatPage` 的 timeout 默认值（用于核对「不传预算时的上限」） */
function waitForChatPageDefaultTimeout(source: string): number {
  const match = /const waitForChatPage = \(\s*opts: ChatPageOptions = \{\},\s*timeout = ([\d_]+),?\s*\)/s
    .exec(source);
  if (!match) throw new Error('找不到 waitForChatPage 的签名（形如 `(opts = {}, timeout = N)`）');
  return Number(match[1].replace(/_/g, ''));
}

runCases('e2eLaunchStartupBudget', [
  {
    name: 'RT-1 launchApp 内部不得无参调用 waitForChatPage',
    run: () => {
      const body = launchAppBody(read(ELECTRON_APP));
      // 缺陷形态：`await waitForChatPage();` —— 空 opts + 默认 45s，调用方的 180s 用不到。
      assert.ok(
        !/await waitForChatPage\(\s*\)/.test(body),
        'launchApp 里有 `await waitForChatPage()`（无参数）：内部用默认 45s，'
          + '调用方在 chatPage(opts, timeoutMs) 上声明的预算（如 remoteSshExecution 的 180s）失效。'
          + '应改为传入显式的启动等待预算。',
      );
    },
  },
  {
    name: 'RT-1b launchApp 声明并透传 startupChatWaitMs',
    run: () => {
      const source = read(ELECTRON_APP);
      const body = launchAppBody(source);
      assert.ok(
        /startupChatWaitMs\??:\s*number/.test(source),
        'launchApp 的 options 没有 `startupChatWaitMs` 字段：调用方无法表达'
          + '「启动阶段最多等多久」，只能被动接受内部默认值。',
      );
      assert.ok(
        /waitForChatPage\([^)]*startupChatWaitMs/.test(body),
        'launchApp 里没有把 `startupChatWaitMs` 传给 `waitForChatPage`：'
          + '声明了字段但不透传，超时仍是默认值。',
      );
    },
  },
  {
    name: 'RT-2 不传预算时仍按默认上限失败（不退化成无限等）',
    run: () => {
      const value = waitForChatPageDefaultTimeout(read(ELECTRON_APP));
      assert.ok(Number.isFinite(value), `waitForChatPage 的 timeout 默认值不是有限数字（读到 ${value}）`);
      assert.ok(
        value >= 30_000 && value <= 180_000,
        `waitForChatPage 的默认超时是 ${value}ms，超出 30s–180s 的合理区间：`
          + '太小会让正常启动偶发失败，太大则退化成「等很久才报错」。',
      );
    },
  },
  {
    name: 'RT-3 超时文案仍打印实际等待条件',
    run: () => {
      const source = read(ELECTRON_APP);
      assert.ok(
        /等待活动聊天视图超时（候选 \$\{pages\.length\} 个均不满足 \$\{JSON\.stringify\(opts\)\}）/.test(source),
        '超时文案没有打印等待条件（opts）：排障时看不出在等什么视图。',
      );
    },
  },
]);
