/**
 * TUI 入口（docs/tui.md 第 2、4 节）：组装三契约 → bootstrapCore → 启动 Ink App。
 *
 * 用法：
 *   node dist/tui.mjs [--workspace <dir>] [--core embedded|standalone] [--verbose] [--version]
 *
 * - `--workspace`：唯一本地工作区（默认 process.cwd()）；
 * - `--core`：只在进程启动早期转设 `TUXEDO_CAT_CORE` 环境变量，Core 形态的选择
 *   仍由 `resolveCoreKind()` 单一出口决定；
 * - Standalone 下 Core 进程按需 spawn（`<core-binary> stdio`，本机不存在时由本进程
 *   拉起；产物部署由独立安装程序负责，见 `src/tui/coreRoot.ts`）。
 */

import * as path from 'path';
import { render } from 'ink';
import React from 'react';
import { resolveCoreKind } from '../../host/coreKind.js';
import { bootstrapCore, shutdownCore } from '../../host/bootstrapCore.js';
import { fileLogger } from '../../core/Logger.js';
import { getSystemLocale } from '../../host/i18n.js';
import { TuiApp } from './App.js';
import { createTuiStore } from '../store.js';
import { TuiUIHost } from '../TuiUIHost.js';
import { TuiSpinDesign } from '../TuiSpinDesign.js';
import { TuiConversationManager } from '../TuiConversationManager.js';
import { resolveTuiExtensionPath } from '../coreRoot.js';

const TUI_VERSION = '0.1.0';

interface TuiCliArgs {
  workspace: string;
  core: string | null;
  verbose: boolean;
  version: boolean;
}

function parseArgs(argv: readonly string[]): TuiCliArgs {
  const args: TuiCliArgs = {
    workspace: process.cwd(),
    core: null,
    verbose: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--workspace' || arg === '-w') {
      args.workspace = path.resolve(argv[++i] ?? '.');
    } else if (arg === '--core') {
      args.core = argv[++i] ?? null;
    } else if (arg === '--verbose' || arg === '-v') {
      args.verbose = true;
    } else if (arg === '--version') {
      args.version = true;
    }
  }
  return args;
}

/** 日志出口：stderr（--verbose 时）+ 文件；绝不写 stdout（stdout 是 Ink 渲染面） */
function createLog(verbose: boolean): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    const line = args.map((a) => (a instanceof Error ? a.stack ?? a.message : String(a))).join(' ');
    fileLogger.info('tui', line);
    if (verbose) process.stderr.write(`${line}\n`);
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) {
    process.stdout.write(`tuxedo-cat tui ${TUI_VERSION} (core=${args.core ?? resolveCoreKind()})\n`);
    return;
  }
  // Core 形态：只转设环境变量，选择来源仍是 resolveCoreKind()（单一出口）
  if (args.core !== null) process.env.TUXEDO_CAT_CORE = args.core;

  // Ink 依赖 raw mode（现代终端 / conpty 均支持；老 conhost 与重定向管道不支持）。
  // Core 产物根：安装程序的前缀或开发仓库（找不到直接抛错，不静默降级）。
  // bundle 目录用 argv[1] 推导（ESM 产物无 __dirname，import.meta 与 CJS 测试车道互斥）。
  // 放在 TTY 检查之前：非交互环境下「产物缺失 / 装错位置」也能得到可行动的报错
  const bundleDir = path.dirname(path.resolve(process.argv[1] ?? process.cwd()));
  const extensionPath = resolveTuiExtensionPath(bundleDir);

  // Ink 依赖 raw mode（现代终端 / conpty 均支持；老 conhost 与重定向管道不支持）。
  // 渲染前显式拦截，给出可行动的报错，而不是 React 错误边界里的堆栈
  if (!process.stdin.isTTY) {
    process.stderr.write('TUI 需要交互式终端（raw mode）：请在 Windows Terminal / VS Code 终端等现代终端中运行，不要重定向 stdin。\n');
    process.exitCode = 1;
    return;
  }

  const log = createLog(args.verbose);
  const store = createTuiStore(log);
  const host = new TuiUIHost({
    workspacePath: args.workspace,
    log,
    dispatch: (action) => store.dispatch(action),
  });
  const spinDesign = new TuiSpinDesign((action) => store.dispatch(action));
  const conversations = new TuiConversationManager(host, (action) => store.dispatch(action));
  log(`[tui] workspace=${args.workspace} extensionPath=${extensionPath}`);

  const { ui } = bootstrapCore(host, spinDesign, conversations, {
    locale: getSystemLocale(),
    log,
    logToConsole: args.verbose,
    extensionPath,
  });

  const send = (message: Parameters<typeof ui.handleWebviewMessage>[0]): void => {
    void ui.handleWebviewMessage(message, { sender: null });
  };

  // 入口保持 .ts（不含 JSX）：组件树用 createElement 组装
  const instance = render(
    React.createElement(TuiApp, { store, workspacePath: args.workspace, send }),
    {
      stdout: process.stdout,
      stdin: process.stdin,
      exitOnCtrlC: true,
    },
  );
  await instance.waitUntilExit();
  await shutdownCore();
}

main().catch((err) => {
  // 启动失败（Core 产物缺失 / 接线错误）：stdout 还没被 Ink 占用，直接报告
  process.stderr.write(`TUI 启动失败：${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
  return shutdownCore().catch(() => undefined);
});
