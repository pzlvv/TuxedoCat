/**
 * bootstrapCore - 宿主无关的启动接线骨架（见 DEVELOPMENT.md 第 8.6 节）
 *
 * 两个宿主（VS Code 扩展 / Electron 主进程）的启动接线由本函数统一执行，
 * 宿主只提供自身差异（locale / 日志出口 / 资源根目录）。
 * 本模块位于 host/ 层，不 import `vscode` / `electron`。
 *
 * 顺序（不可调换，理由见 DEVELOPMENT.md 第 3.5、8.6 节）：
 *   创建总线并注册 → 注册 core 侧 UiEvent 订阅
 *   → 发「宿主环境」事件（locale / 扩展路径 / 日志出口开关）
 *   → 创建 WebViewUI（其构造函数注册 CoreEvent / CoreRequest 处理器）
 *   → 会话队列
 *   → 异步收尾：配置目录 / MCP 残留清理
 *
 * 顺序错误在启动期暴露：`setGlobalEventBus` 重复注册抛错，
 * `emitToUi` 在 `WebViewUI.create` 之前抛错（DEVELOPMENT.md 第 3.5、3.7 节）。
 */

import type { AssistantEventBus } from '../core/AssistantEventBus.js';
import { requireEventBus, setGlobalEventBus } from '../core/AssistantEventBus.js';
import { initializeCoreEvents } from '../core/initializeCoreEvents.js';
import { initializeSessionQueue } from '../core/Integration.js';
import { sessionQueue } from '../core/SessionQueue.js';
import {
  ensureConfigDirs,
  hasExtensionPath,
  readUiLanguageSync,
} from '../core/history/index.js';
import { getMCPHost } from '../core/mcp/MCPHost.js';
import { createEventBus } from './EventBus.js';
import { WebViewUI } from './WebViewUI.js';
import { UserChoiceManager } from './ui/userChoice.js';
import type { UIHost } from './UIHost.js';
import type { SpinDesign } from './SpinDesign.js';
import type { ConversationManager } from './ConversationManager.js';
import type { WebViewUiPort, WebviewPoster } from './ui/ports.js';

/** 宿主提供的启动差异（全部必选：缺失即编译错误） */
export interface CoreBootstrapOptions {
  /** 宿主 locale 原始值（BCP-47 等）；「是否中文」的收敛由 core 的 setCoreLocale 承担 */
  locale: string;
  /** 日志出口：core Logger / WebViewUI / UserChoiceManager 共用 */
  log: (...args: unknown[]) => void;
  /** core 日志是否同时输出到控制台 */
  logToConsole: boolean;
  /** 扩展 / 应用根目录（ripgrep、pandoc 等资源的定位基准） */
  extensionPath: string;
}

export interface CoreBootstrapResult {
  bus: AssistantEventBus;
  ui: WebViewUI;
}

/** 启动接线快照（只读；用于启动日志与双端对照） */
export interface BootstrapSnapshot {
  locale: string;
  uiLanguage: 'auto' | 'zh' | 'en';
  eventBusRegistered: boolean;
  uiCreated: boolean;
  extensionPathProvided: boolean;
  sessionQueueInitialized: boolean;
  logToConsole: boolean;
}

let snapshot: BootstrapSnapshot | null = null;

/**
 * 执行共享启动接线。
 *
 * 三个契约（host / spinDesign / conversations）由宿主构造后传入；
 * 宿主专属的句柄注入与界面构造在返回后执行。
 */
export function bootstrapCore(
  host: UIHost,
  spinDesign: SpinDesign,
  conversations: ConversationManager,
  options: CoreBootstrapOptions,
): CoreBootstrapResult {
  const log = options.log;

  // ── 1. 总线：注册全局总线 → 注册 core 侧 UiEvent 订阅 ──
  // initializeCoreEvents 内**同步**注册「宿主环境」与「活动工作目录」两条事件的处理器，
  // 因此紧接着的 emitToCore 一定能被接住。
  const bus = createEventBus();
  setGlobalEventBus(bus);
  initializeCoreEvents(bus);

  // ── 2. 宿主环境：经总线交给 core（core 侧没有对应的注入入口）──
  bus.emitToCore({
    type: 'hostEnvironmentProvided',
    locale: options.locale,
    extensionPath: options.extensionPath,
    logToConsole: options.logToConsole,
  });

  // ── 3. UI：构造函数注册 CoreEvent / CoreRequest 处理器 ──
  const ui = WebViewUI.create(host, bus, spinDesign, conversations, {
    log,
    createUserChoiceManager: (
      post: WebviewPoster,
      closePreview: () => void,
      uiPort: WebViewUiPort,
    ) =>
      new UserChoiceManager({
        outputChannel: { appendLine: (line: string) => log(line) },
        postToWebview: post,
        closePreview,
        getActiveSessionIdInternal: () => uiPort.getActiveSessionId(),
      }),
  });

  // ── 4. 依赖 WebViewUI 实例的接线 ──
  initializeSessionQueue();

  // ── 5. 异步收尾：不阻塞启动，失败只记日志 ──
  void ensureConfigDirs().catch((error: Error) => {
    log(`[bootstrap] Failed to initialize config directories: ${error.message}`);
  });

  void (async () => {
    try {
      await getMCPHost().prune();
    } catch (error) {
      log(`[bootstrap] Failed to prune MCP servers: ${error}`);
    }
  })();

  snapshot = readSnapshot(options);
  return { bus, ui };
}

/** 释放 core 侧的进程级资源（MCP 子进程）；宿主退出钩子调用一次 */
export function shutdownCore(): void {
  try {
    getMCPHost().shutdown();
  } catch {
    // 退出阶段的清理失败不应影响退出
  }
}

/**
 * 当前进程的接线快照。
 * 未执行 `bootstrapCore` 时抛错（与 WebViewUI.getInstance 同一口径，不做静默降级）。
 */
export function bootstrapSnapshot(): BootstrapSnapshot {
  if (!snapshot) {
    throw new Error('bootstrapCore() has not run; no bootstrap snapshot available.');
  }
  return snapshot;
}

function readSnapshot(options: CoreBootstrapOptions): BootstrapSnapshot {
  let eventBusRegistered = true;
  try {
    requireEventBus();
  } catch {
    eventBusRegistered = false;
  }

  let uiCreated = true;
  try {
    WebViewUI.getInstance();
  } catch {
    uiCreated = false;
  }

  return {
    locale: options.locale,
    uiLanguage: readUiLanguageSync(),
    eventBusRegistered,
    uiCreated,
    extensionPathProvided: hasExtensionPath(),
    sessionQueueInitialized: sessionQueue.hasCallbacks(),
    logToConsole: options.logToConsole,
  };
}
