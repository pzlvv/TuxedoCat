/**
 * bootstrapCore - 宿主无关的启动接线骨架（见 DEVELOPMENT.md 第 8.6 节）
 *
 * 两个宿主（VS Code 扩展 / Electron 主进程）的启动接线由本函数统一执行，
 * 宿主只提供自身差异（locale / 日志出口 / 资源根目录 / 工作区事实）。
 * 本模块位于 host/ 层，不 import `vscode` / `electron`。
 *
 * Core 实现的装配由 `CORE_KIND` 决定（见 docs/standalone-core.md 第 3 节）：
 * - `embedded`：进程内总线（`createEventBus`），恒一个 Connection；
 * - `standalone`：每个工作区一个 Connection、一个 Core 进程，经 daemon 通道通信。
 *
 * 连接模型见 `docs/client-connection.md`：
 * - `Client` 是宿主级唯一实例，维护工作区 / 会话路由与配置快照推送；
 * - `Connection` 是总线、就绪状态与生命周期的作用域。
 *
 * 顺序（不可调换，理由见 DEVELOPMENT.md 第 3.5、8.6 节）：
 *   创建 Client 并注册全局总线 → 注册 core 侧 UiEvent 订阅（仅 embedded）
 *   → 创建 WebViewUI（其构造函数注册 CoreEvent / CoreRequest 处理器）
 *   → 按工作区打开 Connection（连接建立时推送宿主环境与配置快照）
 *   → 订阅工作区打开 / 关闭
 *   → 会话队列（仅 embedded）
 *   → 异步收尾：配置目录 / MCP 残留清理（仅 embedded）
 *
 * 顺序错误在启动期暴露：`setGlobalEventBus` 重复注册抛错、
 * `emitToUi` 在 `WebViewUI.create` 之前抛错、未注册处理器时打开 Connection 抛错
 * （DEVELOPMENT.md 第 3.5、3.7 节）。
 */

import type { AssistantEventBus, UiEvent } from '../core/AssistantEventBus.js';
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
import { Client, type OpenedCoreChannel } from './Client.js';
import type { Connection } from './Connection.js';
import { createEventBus } from './EventBus.js';
import { primeHostLocale, readUiLanguage } from './coreFacts.js';
import { getSettingsStore, type SettingsStore } from './SettingsStore.js';
import { resolveCoreKind, type CoreKind } from './coreKind.js';
import { resolveCoreBinary } from './standalone/coreBinary.js';
import { CoreDaemon } from './standalone/CoreDaemon.js';
import { createCoreChannelBus } from './standalone/StandaloneEventBus.js';
import { WebViewUI } from './WebViewUI.js';
import { UserChoiceManager } from './ui/userChoice.js';
import type { UIHost } from './UIHost.js';
import type { SpinDesign } from './SpinDesign.js';
import type { ConversationManager } from './ConversationManager.js';
import type { WebViewUiPort, WebviewPoster } from './ui/ports.js';
import { emptyWorkspaceRef, type WorkspaceRef } from './workspaceRef.js';

/** 宿主提供的启动差异（全部必选：缺失即编译错误） */
export interface CoreBootstrapOptions {
  /** 宿主 locale 原始值（BCP-47 等）；「是否中文」的收敛由宿主 i18n 承担 */
  locale: string;
  /** 日志出口：core Logger / WebViewUI / UserChoiceManager 共用 */
  log: (...args: unknown[]) => void;
  /** core 日志是否同时输出到控制台 */
  logToConsole: boolean;
  /** 扩展 / 应用根目录（ripgrep、pandoc 等资源的定位基准） */
  extensionPath: string;
  /**
   * 测试注入：Standalone 下为一个工作区打开 Core 通道。
   * 默认经 daemon 启动配置中的 Core 可执行文件。
   */
  openStandaloneChannel?: (ref: WorkspaceRef) => OpenedCoreChannel;
}

export interface CoreBootstrapResult {
  /** 宿主侧总线：Embedded 为进程内总线，Standalone 为 Client 路由器 */
  bus: AssistantEventBus;
  /** 连接模型入口（路由 / 配置快照 / 关闭） */
  client: Client;
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
  /** 已建立的 Connection 数（Standalone 下每个打开的工作区一个） */
  connectionCount: number;
}

let snapshot: BootstrapSnapshot | null = null;

/** 本次装配的 Client；宿主退出时由 `shutdownCore` 关闭全部 Connection */
let activeClient: Client | null = null;
let activeCoreKind: CoreKind | null = null;

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

  // ── 0. 配置：读宿主自己的 settings.json / mcp.json（同步，webview 首帧要同步取值）──
  // 配置归 UI（`docs/core-ui-separation.md` 第 4 节）：两种装配都读宿主自己的文件，
  // 之后由 `SettingsStore` 的订阅把变更推给各 Connection。
  const settingsStore = getSettingsStore();
  try {
    settingsStore.loadSync();
    // 启动自检：把「读了哪个文件、读到了什么」打出来。设置页误弹这类问题，
    // 一眼就能看出是路径不对还是文件内容不对（不再需要靠猜）。
    log(`[bootstrap] ${describeSettings(settingsStore)}`);
  } catch (error) {
    log(`[bootstrap] Failed to load settings: ${String(error)}`);
  }

  // 宿主环境与配置快照：构造与推送收敛到一处。首次连接与后续配置变更走同一条
  // 路径（`docs/core-ui-separation.md` 第 4.5 节：整份快照，没有增量语义）。
  const hostEnvironment = (): Extract<UiEvent, { type: 'hostEnvironmentProvided' }> => ({
    type: 'hostEnvironmentProvided',
    extensionPath: options.extensionPath,
    logToConsole: options.logToConsole,
    configDirName: CONFIG_DIR_NAME,
    settings: settingsStore.getSnapshot(),
    mcpServers: settingsStore.getMcpServers(),
  });

  // ── 1. Client 与总线：注册全局总线 → 注册 core 侧 UiEvent 订阅（仅 embedded）──
  // initializeCoreEvents 内**同步**注册「宿主环境」与「会话工作目录」两条事件的处理器，
  // 因此紧接着的 hostEnvironmentProvided 一定能被接住。
  const embeddedBus = coreKind === 'embedded' ? createEventBus() : null;
  const client = new Client({
    coreKind,
    log: (...args: unknown[]) => log(...args),
    hostEnvironment,
    embeddedBus: embeddedBus ?? undefined,
    openChannel: coreKind === 'standalone'
      ? (options.openStandaloneChannel ?? ((ref: WorkspaceRef) => openStandaloneChannel(ref, options)))
      : undefined,
    // Core 崩溃 / 无法重启（规格第 7.1 节）：把该连接上受影响的「忙」会话标记为失败，
    // 补发错误消息与 queryEnd，并把运行时状态复位为 idle —— 不静默挂起。
    onConnectionLost: (connection, reason) => {
      markConnectionSessionsFailed(connection, conversations, reason, log);
    },
    // Standalone 下把语言收敛结果灌回宿主进程内的 i18n（每次握手，含崩溃重启后）：
    // Core 进程换了一个，宿主侧的收敛结果是同一份，重跑幂等。
    onConnectionReady: coreKind === 'standalone'
      ? () => {
          try {
            primeHostLocale(options.locale);
          } catch (error) {
            log(`[bootstrap] Failed to prime host locale: ${String(error)}`);
          }
        }
      : undefined,
  });
  if (embeddedBus) {
    setGlobalEventBus(embeddedBus);
    initializeCoreEvents(embeddedBus);
  } else {
    setGlobalEventBus(client);
  }

  // ── 2. 配置快照：写盘后重推整份快照给所有 Connection（`SettingsStore` 通知）──
  settingsStore.subscribe(() => client.emitToCore(hostEnvironment()));

  // ── 3. UI：构造函数注册 CoreEvent / CoreRequest 处理器 ──
  // 必须在打开任何 Connection 之前：Connection 建立时把这份处理器表注册到自己的总线上。
  const ui = WebViewUI.create(host, client, spinDesign, conversations, {
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

  // ── 4. 按工作区打开 Connection：连接建立时推送宿主环境与配置快照 ──
  // Embedded 恒一个 Connection（工作区是会话属性）。没有打开的工作区时用空引用占位，
  // 保证宿主环境与配置快照在启动期送达、空态视图的只读请求（技能列表 / 对话列表等）
  // 仍可应答；Standalone 下打开第一个真实工作区时这个空引用 Connection 会被关闭
  // （Client.openWorkspace）。
  const currentRef = host.getWorkspaceRef();
  const openRefs = host.getOpenWorkspaceRefs();
  const refs: WorkspaceRef[] = openRefs.length > 0
    ? [...openRefs]
    : currentRef
      ? [currentRef]
      : [emptyWorkspaceRef()];
  const openWorkspace = (ref: WorkspaceRef): void => {
    try {
      const opened = client.openWorkspace(ref);
      if (opened instanceof Promise) {
        void opened.catch((error) => {
          log(`[bootstrap] Failed to open workspace ${ref.path}: ${String(error)}`);
        });
      }
    } catch (error) {
      log(`[bootstrap] Failed to open workspace ${ref.path}: ${String(error)}`);
    }
  };
  for (const ref of refs) openWorkspace(ref);

  // 工作区打开 / 关闭 / 激活：Connection 随之建立 / 销毁 / 切换活动项
  const unsubscribeWorkspace = host.onWorkspaceChanged((change) => {
    try {
      if (change.type === 'opened') {
        openWorkspace(change.ref);
      } else if (change.type === 'closed') {
        void client.closeWorkspace(change.ref);
      } else {
        client.activateWorkspace(change.ref);
      }
    } catch (error) {
      log(`[bootstrap] workspace change (${change.type}) failed: ${String(error)}`);
    }
  });
  workspaceUnsubscribers.add(unsubscribeWorkspace);

  // ── 5. 依赖 WebViewUI 实例的接线（仅 embedded：队列在 Core 进程内）──
  if (coreKind === 'embedded') {
    initializeSessionQueue();
  }

  // ── 6. 异步收尾（仅 embedded：core 自己的资源由 Core 进程管理）──
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

  activeClient = client;
  activeCoreKind = coreKind;
  snapshot = readSnapshot(coreKind, options, client);
  return { bus: embeddedBus ?? client, client, ui };
}

/** 工作区变化订阅（测试可重置；宿主退出时不需要显式取消） */
const workspaceUnsubscribers = new Set<() => void>();

/**
 * Standalone 默认通道：每个工作区经 daemon 打开一条 channel
 * （`docs/core-daemon.md`：一个 endpoint 一个 daemon，一个工作区一个 Core 进程）。
 *
 * 两种通道形态（单进程 / daemon）对 Connection 暴露同一个 `AssistantEventBus`。
 */
function openStandaloneChannel(
  ref: WorkspaceRef,
  options: CoreBootstrapOptions,
): OpenedCoreChannel {
  if (!standaloneDaemon) {
    standaloneDaemon = new CoreDaemon({
      binaryPath: resolveCoreBinary(options.extensionPath),
      log: (...args: unknown[]) => options.log(...args),
    });
  }
  const transport = standaloneDaemon.openChannel(ref);
  const bus = createCoreChannelBus(transport, (...args: unknown[]) => options.log(...args));
  return {
    bus,
    dispose: () => bus.shutdown(),
  };
}

/** 本地 daemon 单例（一个 endpoint 一个 daemon；宿主退出时关闭） */
let standaloneDaemon: CoreDaemon | null = null;

/**
 * Core 非预期退出 / 无法恢复：把该 Connection 上受影响的「忙」会话标记为失败。
 * 只处理归属该连接的会话（多 Connection 下不误伤其它工作区）。
 */
function markConnectionSessionsFailed(
  connection: Connection,
  conversations: ConversationManager,
  reason: string,
  log: (...args: unknown[]) => void,
): void {
  try {
    const states = conversations.getSessionStatesSnapshot();
    const busy = states.filter(
      (state) => state.idle === false && connection.hasSession(state.sessionId),
    );
    for (const state of busy) {
      connection.emitToUi({
        type: 'message',
        sessionId: state.sessionId,
        data: { role: 'system', content: reason },
      });
      connection.emitToUi({ type: 'queryEnd', sessionId: state.sessionId });
    }
    if (busy.length > 0) {
      const busyIds = new Set(busy.map((state) => state.sessionId));
      conversations.updateSessionStates(
        states.map((state) =>
          busyIds.has(state.sessionId) ? { ...state, idle: true, waiting: false } : state,
        ),
      );
    }
  } catch (error) {
    log(`[bootstrap] failed to mark sessions after core loss: ${String(error)}`);
  }
}

/**
 * 释放 core 侧的进程级资源：关闭全部 Connection（Standalone 为 Core 进程 /
 * daemon channel；Embedded 为 MCP 子进程）。宿主退出钩子调用一次。
 */
export function shutdownCore(): Promise<void> {
  const client = activeClient;
  activeClient = null;
  for (const unsubscribe of workspaceUnsubscribers) {
    try {
      unsubscribe();
    } catch {
      // 退出阶段的清理失败不应影响退出
    }
  }
  workspaceUnsubscribers.clear();

  const tasks: Array<Promise<void>> = [];
  if (client) tasks.push(client.closeAll());
  // channel 全部关闭后再关 daemon：daemon 收到 shutdown 立即退出，不留 grace 期进程
  const daemon = standaloneDaemon;
  standaloneDaemon = null;
  if (daemon) tasks.push(daemon.shutdown());
  if (activeCoreKind === 'embedded') {
    try {
      getMCPHost().shutdown();
    } catch {
      // 退出阶段的清理失败不应影响退出
    }
  }
  activeCoreKind = null;
  return Promise.all(tasks).then(() => undefined);
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

/**
 * 启动自检：一行描述「配置读自哪个文件、读到了什么」。
 *
 * 「standalone 启动读不到设置、弹设置页」这类问题，靠它可以直接区分是**路径不对**
 * 还是**文件内容不对**，不必再去猜。只打路径与摘要，不打 apiKey。
 */
export function describeSettings(store: SettingsStore): string {
  const snapshot = store.getSnapshot();
  const providers = Object.keys(snapshot.llm.providers);
  const active = snapshot.llm.activeProvider;
  const apiKey = active ? snapshot.llm.providers[active]?.apiKey : '';
  return (
    `settings loaded from ${store.settingsPath} `
    + `(activeProvider="${active || '(none)'}", apiKey=${apiKey ? 'set' : 'empty'}, `
    + `providers=[${providers.join(', ')}])`
  );
}

function readSnapshot(
  coreKind: CoreKind,
  options: CoreBootstrapOptions,
  client: Client,
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

  const base = {
    coreKind,
    locale: options.locale,
    uiLanguage: readUiLanguage(),
    eventBusRegistered,
    uiCreated,
    logToConsole: options.logToConsole,
    connectionCount: client.listConnections().length,
  };

  // Standalone 下 core 侧状态在 Core 进程内：UI 侧只报告自己掌握的接线事实。
  if (coreKind === 'standalone') {
    return {
      ...base,
      extensionPathProvided: true,
      sessionQueueInitialized: true,
    };
  }

  return {
    ...base,
    extensionPathProvided: hasExtensionPath(),
    sessionQueueInitialized: sessionQueue.hasCallbacks(),
  };
}
