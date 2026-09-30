/**
 * bootstrapCore - 宿主无关的启动接线骨架（见 DEVELOPMENT.md 第 8.6 节）
 *
 * 两个宿主（VS Code 扩展 / Electron 主进程）的启动接线由本函数统一执行，
 * 宿主只提供自身差异（locale / 日志出口 / 资源根目录）。
 * 本模块位于 host/ 层，不 import `vscode` / `electron`。
 *
 * Core 实现的装配由 `CORE_KIND` 决定（见 docs/standalone-core.md 第 3 节）：
 * - `embedded`：进程内总线（`createEventBus`）；
 * - `standalone`：帧通道（`createStandaloneCoreBus`）+ Rust Core 进程。
 *
 * 两种装配共用同一套接线顺序；差异只在总线实现上。
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
} from '../core/history/index.js';
import { getMCPHost } from '../core/mcp/MCPHost.js';
import { CONFIG_DIR_NAME } from '../config/project.js';
import { createEventBus } from './EventBus.js';
import { primeCoreFacts, readUiLanguage } from './coreFacts.js';
import { resolveCoreKind, type CoreKind } from './coreKind.js';
import { resolveCoreBinary } from './standalone/coreBinary.js';
import {
  createStandaloneCoreBus,
  type StandaloneCoreBus,
} from './standalone/StandaloneEventBus.js';
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
  /** 本次装配的 Core 实现（第 3 节） */
  coreKind: CoreKind;
  locale: string;
  uiLanguage: 'auto' | 'zh' | 'en';
  eventBusRegistered: boolean;
  uiCreated: boolean;
  extensionPathProvided: boolean;
  sessionQueueInitialized: boolean;
  logToConsole: boolean;
}

let snapshot: BootstrapSnapshot | null = null;

/** Standalone 装配的帧通道总线；宿主退出时由 `shutdownCore` 停止 */
let standaloneBus: StandaloneCoreBus | null = null;

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
  const coreKind = resolveCoreKind();

  // ── 1. 总线：注册全局总线 → 注册 core 侧 UiEvent 订阅（仅 embedded）──
  // initializeCoreEvents 内**同步**注册「宿主环境」与「会话工作目录」两条事件的处理器，
  // 因此紧接着的 emitToCore 一定能被接住。Standalone 下这两条订阅在 Core 进程内。
  let bus: AssistantEventBus;
  if (coreKind === 'standalone') {
    const standalone = createStandaloneCoreBus({
      binaryPath: resolveCoreBinary(options.extensionPath),
      log: (...args: unknown[]) => log(...args),
    });
    standaloneBus = standalone;
    bus = standalone;
    setGlobalEventBus(bus);

    // core 事实（界面语言 / 配置目录）在每次握手后预热成同步可读的缓存；
    // 预热失败只影响同步读取点回落默认值，不让启动流程失败。
    standalone.onReady(() => {
      void primeCoreFacts(options.locale).catch((error: unknown) => {
        log(`[bootstrap] Failed to prime core facts: ${String(error)}`);
      });
    });

    // Core 崩溃 / 无法重启（规格第 7.1 节）：把受影响的「忙」会话标记为失败，
    // 补发错误消息与 queryEnd，并把运行时状态复位为 idle —— 不静默挂起。
    const markSessionsFailed = (reason: string): void => {
      try {
        const states = conversations.getSessionStatesSnapshot();
        const busy = states.filter((state) => state.idle === false);
        for (const state of busy) {
          bus.emitToUi({
            type: 'message',
            sessionId: state.sessionId,
            data: { role: 'system', content: reason },
          });
          bus.emitToUi({ type: 'queryEnd', sessionId: state.sessionId });
        }
        if (busy.length > 0) {
          conversations.updateSessionStates(
            states.map((state) => ({ ...state, idle: true, waiting: false })),
          );
        }
      } catch (error) {
        log(`[bootstrap] failed to mark sessions after core loss: ${String(error)}`);
      }
    };
    standalone.onExit((info) => {
      if (info.expected) return; // 主动关闭不算失败
      markSessionsFailed('Core 进程已退出，本轮请求失败；宿主正在重启 Core。');
    });
    standalone.onFatal((error) => {
      markSessionsFailed(`Core 进程无法恢复：${error.message}`);
    });
  } else {
    bus = createEventBus();
    setGlobalEventBus(bus);
    initializeCoreEvents(bus);
  }

  // ── 2. 宿主环境：经总线交给 core（core 侧没有对应的注入入口）──
  bus.emitToCore({
    type: 'hostEnvironmentProvided',
    locale: options.locale,
    extensionPath: options.extensionPath,
    logToConsole: options.logToConsole,
    configDirName: CONFIG_DIR_NAME,
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
        isSessionOpenInternal: (sessionId: string) => uiPort.isSessionOpen(sessionId),
      }),
  });

  // ── 4. 依赖 WebViewUI 实例的接线（仅 embedded：队列在 Core 进程内）──
  if (coreKind === 'embedded') {
    initializeSessionQueue();
  }

  // ── 5. 异步收尾（仅 embedded：core 自己的资源由 Core 进程管理）──
  if (coreKind === 'embedded') {
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
  }

  snapshot = readSnapshot(coreKind, options);
  return { bus, ui };
}

/**
 * 释放 core 侧的进程级资源（Embedded 为 MCP 子进程；Standalone 为 Core 进程）。
 * 宿主退出钩子调用一次。
 */
export function shutdownCore(): Promise<void> {
  const standalone = standaloneBus;
  standaloneBus = null;
  if (standalone) {
    return standalone.shutdown();
  }

  try {
    getMCPHost().shutdown();
  } catch {
    // 退出阶段的清理失败不应影响退出
  }
  return Promise.resolve();
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

function readSnapshot(
  coreKind: CoreKind,
  options: CoreBootstrapOptions,
): BootstrapSnapshot {
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

  // Standalone 下 core 侧状态在 Core 进程内：UI 侧只报告自己掌握的接线事实。
  if (coreKind === 'standalone') {
    return {
      coreKind,
      locale: options.locale,
      uiLanguage: readUiLanguage(coreKind),
      eventBusRegistered,
      uiCreated,
      extensionPathProvided: true,
      sessionQueueInitialized: true,
      logToConsole: options.logToConsole,
    };
  }

  return {
    coreKind,
    locale: options.locale,
    uiLanguage: readUiLanguage(coreKind),
    eventBusRegistered,
    uiCreated,
    extensionPathProvided: hasExtensionPath(),
    sessionQueueInitialized: sessionQueue.hasCallbacks(),
    logToConsole: options.logToConsole,
  };
}
