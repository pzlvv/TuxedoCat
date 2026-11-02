/**
 * Electron 主进程的诊断出口。
 *
 * 打包态从图标启动时没有控制台，stdout/stderr 无处可去——只写 `console.*` 的诊断
 * 等于没写。而事后最需要查的恰恰是这些：渲染进程崩溃 / OOM、页面未响应、视图加载
 * 失败、启动被单实例锁挡下。所以这里把「一条诊断」统一成两个出口：
 *
 * - `console`：开发期（`npm run electron`）在终端里直接看见，格式与调用点原样一致；
 * - `fileLogger`：落 `~/<configDir>/logs/<logFileName>`，打包态唯一可事后排查的出口。
 *
 * 只用于**诊断**（进程里发生了什么）。面向用户的提示走 i18n，不经过这里。
 *
 * 组件名沿用既有口径（`workspace-tab` / `sidebar-files` / `completion-sync` 等），
 * 这里是主进程新增的两个：`launch`（启动 / 单实例 / 退出）与 `main`（其余主进程诊断）。
 */
import { fileLogger } from '../src/shared/Logger.js';

export type DiagLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * 参数转一行文本供落盘。
 *
 * 与 `src/shared/Logger.ts` 的 `formatArg` 同一目标（Error 带栈、对象可读），但不复用
 * 它的实现：那份是共享日志的格式化点，主进程诊断不需要它的 2 空格缩进与多行输出。
 * 循环引用与 bigint 在这里同样要兜住——`JSON.stringify` 遇到它们会抛错。
 */
function stringify(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  if (typeof arg === 'bigint') return arg.toString();
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(arg, (_key, value: unknown) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return typeof value === 'bigint' ? value.toString() : value;
    });
  } catch {
    try {
      return String(arg);
    } catch {
      return '[Unserializable]';
    }
  }
}

/**
 * 写一条主进程诊断：控制台原样输出 + 日志文件落盘。
 *
 * 控制台保留调用点自己的前缀（`[main]` / `[chat-view]` / `[sidebar]` …），因为
 * 开发期的肉眼检索依赖这些既有格式；`component` 只用于日志文件的分类。
 */
export function diag(level: DiagLevel, component: string, ...args: unknown[]): void {
  if (level === 'error') {
    console.error(...args);
  } else if (level === 'warn') {
    console.warn(...args);
  } else if (level === 'info') {
    console.log(...args);
  } else {
    console.debug(...args);
  }
  fileLogger[level](component, args.map(stringify).join(' '));
}
