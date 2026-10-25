/**
 * bootstrapCore - 宿主无关的启动接线骨架（见 docs/hosts/host-bootstrap.md 第 1 节）
 *
 * 两个宿主（VS Code 扩展 / Electron 主进程）的启动接线由本函数统一执行，
 * 宿主只提供自身差异（locale / 日志出口 / 资源根目录 / 工作区事实）。
 * 本模块位于 host/ 层，不 import `vscode` / `electron`。
 *
 * Core 是独立进程（core-rs，见 docs/core/standalone-core.md）：每个工作区一个
 * Connection、一个 Core 进程，经 daemon 通道通信。
 *
 * 连接模型见 `docs/core/client-connection.md`：
 * - `Client` 是宿主级唯一实例，维护工作区 / 会话路由与配置快照推送；
 * - `Connection` 是总线、就绪状态与生命周期的作用域。
 *
 * 顺序（不可调换，理由见 docs/architecture/events.md 第 5 节；宿主专属接线见 `docs/hosts/host-bootstrap.md` 第 1 节）：
 *   创建 Client 并注册全局总线
 *   → 创建 WebViewUI（其构造函数注册 CoreEvent / CoreRequest 处理器）
 *   → 按工作区打开 Connection（连接建立时推送宿主环境与配置快照）
 *   → 对齐活动 Connection 到宿主当前工作区（打开顺序 ≠ 活动项）
 *   → 订阅工作区打开 / 关闭
 *
 * 顺序错误在启动期暴露：`setGlobalEventBus` 重复注册抛错、
 * `emitToUi` 在 `WebViewUI.create` 之前抛错、未注册处理器时打开 Connection 抛错
 * （docs/architecture/events.md 第 5 / 6 节）。
 */

import type { AssistantEventBus, UiEvent } from '../shared/AssistantEventBus.js';
import { requireEventBus, setGlobalEventBus } from '../shared/AssistantEventBus.js';
import { CONFIG_DIR_NAME } from '../config/project.js';
import { Client, type OpenedCoreChannel } from './Client.js';
import type { Connection } from './Connection.js';
import { primeHostLocale, readUiLanguage } from './coreFacts.js';
import { getSettingsStore, type SettingsStore } from './SettingsStore.js';
import { resolveCoreBinary } from './standalone/coreBinary.js';
import { CoreDaemon, SSH_DAEMON_LINK_TIMEOUT_MS, type CoreDaemonLinkOpener } from './standalone/CoreDaemon.js';
import { createSshDaemonOpener } from './standalone/sshTransport.js';
import { createCoreChannelBus, createStandaloneCoreBus } from './standalone/StandaloneEventBus.js';
import { WebViewUI } from './WebViewUI.js';
import { UserChoiceManager } from './ui/userChoice.js';
import type { UIHost } from './UIHost.js';
import type { SpinDesign } from './SpinDesign.js';
import type { ConversationManager } from './ConversationManager.js';
import type { WebViewUiPort, WebviewPoster } from './ui/ports.js';
import {
  emptyWorkspaceRef,
  remoteWorkspaceRef,
  type WorkspaceEndpoint,
  type WorkspaceRef,
} from './workspaceRef.js';
import { sshTargetFor, sshTargetKey } from './sshTarget.js';
import type { DirectoryListing } from './standalone/daemonProtocol.js';

/** 宿主提供的启动差异（全部必选：缺失即编译错误） */
export interface CoreBootstrapOptions {
  /** 宿主 locale 原始值（BCP-47 等）；「是否中文」的收敛由宿主 i18n 承担 */
  locale: string;
  /** 日志出口：core Logger / WebViewUI / UserChoiceManager 共用 */
  log: (...args: unknown[]) => void;
  /** core 日志是否同时输出到控制台 */
  logToConsole: boolean;
  /**
   * 扩展 / 应用根目录：定位 Core 产物目录
   * （`resources/core/<arch-platform>/`，其中已含 Core 自带的 `ripgrep/`）。
   */
  extensionPath: string;
  /**
   * 宿主是否支持跨工作区代理（specs/023 FR-009）：随 `hostEnvironmentProvided` 下发给
   * Core，决定 `@` reminder 与 `Agent.target` 是否生效。Electron true，VS Code false。
   */
  crossWorkspaceAgent: boolean;
  /**
   * 宿主是否支持跨工作区文件传输（specs/028 FR-005）：随 `hostEnvironmentProvided`
   * 下发给 Core，只作用于 `Transfer` 工具的执行。Electron true，VS Code / TUI false。
   */
  crossWorkspaceTransfer: boolean;
  /**
   * 测试注入：为一个工作区打开 Core 通道。
   * 默认经 daemon 启动配置中的 Core 可执行文件。
   */
  openStandaloneChannel?: (ref: WorkspaceRef) => OpenedCoreChannel;
}

export interface CoreBootstrapResult {
  /** 宿主侧总线：Client 路由器 */
  bus: AssistantEventBus;
  /** 连接模型入口（路由 / 配置快照 / 关闭） */
  client: Client;
  ui: WebViewUI;
}

/** 启动接线快照（只读；用于启动日志） */
export interface BootstrapSnapshot {
  locale: string;
  uiLanguage: 'auto' | 'zh' | 'en';
  eventBusRegistered: boolean;
  uiCreated: boolean;
  extensionPathProvided: boolean;
  logToConsole: boolean;
  /** 已建立的 Connection 数（Standalone 下每个打开的工作区一个） */
  connectionCount: number;
}

let snapshot: BootstrapSnapshot | null = null;

/** 本次装配的 Client；宿主退出时由 `shutdownCore` 关闭全部 Connection */
let activeClient: Client | null = null;
/** 本次装配的启动参数；远程目录选择器在打开工作区之前就要用它连 daemon */
let activeOptions: CoreBootstrapOptions | null = null;

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

  // ── 0. 配置：读宿主自己的 settings.json / mcp.json（同步，webview 首帧要同步取值）──
  // 配置归 UI（`docs/architecture/core-ui-separation.md` 第 4 节）：两种装配都读宿主自己的文件，
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

  // 宿主语言（界面语言）归宿主：`settings.json` 读进来后立刻收敛进进程内 i18n。
  // 宿主原生 UI（Electron 菜单 / 托盘、Spin 设计器）用的都是这套 `tt()`，必须在这里
  // 同步定好——不能等 Connection 就绪事件（要拉起 Core 进程），否则 UI 先按默认
  // 英文建好、语言设置看起来「没生效」。
  // 语言与 Core 装配无关（Core 不感知语言），只读宿主自己的配置。
  try {
    primeHostLocale(options.locale);
  } catch (error) {
    log(`[bootstrap] Failed to prime host locale: ${String(error)}`);
  }

  // 宿主环境与配置快照：构造与推送收敛到一处。首次连接与后续配置变更走同一条
  // 路径（`docs/architecture/core-ui-separation.md` 第 4.5 节：整份快照，没有增量语义）。
  const hostEnvironment = (): Extract<UiEvent, { type: 'hostEnvironmentProvided' }> => ({
    type: 'hostEnvironmentProvided',
    extensionPath: options.extensionPath,
    logToConsole: options.logToConsole,
    configDirName: CONFIG_DIR_NAME,
    settings: settingsStore.getSnapshot(),
    mcpServers: settingsStore.getMcpServers(),
    crossWorkspaceAgent: options.crossWorkspaceAgent,
    crossWorkspaceTransfer: options.crossWorkspaceTransfer,
  });

  // ── 1. Client 与总线：注册全局总线 ──
  const client = new Client({
    log: (...args: unknown[]) => log(...args),
    hostEnvironment,
    openChannel:
      options.openStandaloneChannel ?? ((ref: WorkspaceRef) => openStandaloneChannel(ref, options)),
    // Core 崩溃 / 无法重启（`docs/core/standalone-core.md` 第 6.1 节）：把该连接上受影响的「忙」会话标记为失败，
    // 补发错误消息与 queryEnd，并把运行时状态复位为 idle —— 不静默挂起。
    // 同时把生命周期转发给宿主订阅者（`onWorkspaceConnectionState`）。
    onConnectionLost: (connection, reason) => {
      markConnectionSessionsFailed(connection, conversations, reason, log);
      notifyWorkspaceConnectionState(log, connection.workspaceRef, 'lost', reason);
      // 该工作区上的跨工作区子代理按结束收敛（specs/023 FR-010）
      ui?.onWorkspaceUnavailable(connection.workspaceRef);
    },
    onConnectionReady: (connection) => {
      notifyWorkspaceConnectionState(log, connection.workspaceRef, 'ready', '');
    },
  });
  setGlobalEventBus(client);

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
  // 没有打开的工作区时用空引用占位，保证宿主环境与配置快照在启动期送达、空态视图的
  // 只读请求（技能列表 / 对话列表等）仍可应答；打开第一个真实工作区时这个空引用
  // Connection 会被关闭（Client.openWorkspace）。
  const currentRef = host.getWorkspaceRef();
  const openRefs = host.getOpenWorkspaceRefs();
  const refs: WorkspaceRef[] = openRefs.length > 0
    ? [...openRefs]
    : currentRef
      ? [currentRef]
      : [emptyWorkspaceRef()];
  const openWorkspace = (ref: WorkspaceRef): Promise<void> => {
    try {
      const opened = client.openWorkspace(ref);
      if (opened instanceof Promise) {
        return opened.then(
          () => undefined,
          (error) => {
            log(`[bootstrap] Failed to open workspace ${ref.path}: ${String(error)}`);
          },
        );
      }
    } catch (error) {
      log(`[bootstrap] Failed to open workspace ${ref.path}: ${String(error)}`);
    }
    return Promise.resolve();
  };
  void Promise.all(refs.map(openWorkspace)).then(() => {
    // 启动期的活动连接以宿主为准：Connection 按打开集合顺序建立，「最后建立的」
    // 不一定是宿主正显示的活动工作区（恢复标签页不触发 activated 事件——状态没变）。
    // 不对齐的话，统计 / 清空这类「跟当前连接走」的请求会落到别的连接上：远程标签页
    // 显示本地数据。对已打开的引用 activateWorkspace 是纯激活；未打开时为 no-op。
    if (currentRef) client.activateWorkspace(currentRef);
  });

  // 工作区打开 / 关闭 / 激活：Connection 随之建立 / 销毁 / 切换活动项
  const unsubscribeWorkspace = host.onWorkspaceChanged((change) => {
    try {
      if (change.type === 'opened') {
        openWorkspace(change.ref);
      } else if (change.type === 'closed') {
        ui.onWorkspaceUnavailable(change.ref);
        void client.closeWorkspace(change.ref);
      } else {
        client.activateWorkspace(change.ref);
      }
    } catch (error) {
      log(`[bootstrap] workspace change (${change.type}) failed: ${String(error)}`);
    }
  });
  workspaceUnsubscribers.add(unsubscribeWorkspace);

  activeClient = client;
  activeOptions = options;
  snapshot = readSnapshot(options, client);
  return { bus: client, client, ui };
}

/** 工作区变化订阅（测试可重置；宿主退出时不需要显式取消） */
const workspaceUnsubscribers = new Set<() => void>();

/**
 * Standalone 默认通道。
 *
 * - 本地同机（`endpoint === null`）：Host 直接以 `stdio` 动作起一个 Core 进程，stdio 是帧通道
 *   （不监听端口、不需要 token）；
 * - 远程：连该 endpoint 的 daemon 控制通道（TCP + `auth`），每个工作区一条 channel
 *   （`docs/core/core-remote.md` 第 2 节）。
 *
 * 两种形态对 Connection 暴露同一个 `AssistantEventBus`。
 */
function openStandaloneChannel(
  ref: WorkspaceRef,
  options: CoreBootstrapOptions,
): OpenedCoreChannel {
  const log = (...args: unknown[]) => options.log(...args);
  if (!ref.endpoint) {
    const bus = createStandaloneCoreBus({
      binaryPath: resolveCoreBinary(options.extensionPath),
      // 显式 `stdio`（裸词动作，`docs/core/core-daemon.md` 第 3 节）：单进程 Core，stdio 帧通道
      spawnArgs: ['stdio'],
      log,
    });
    return {
      bus,
      dispose: () => bus.shutdown(),
    };
  }
  const daemon = remoteDaemonForEndpoint(ref, options);
  const transport = daemon.openChannel(ref);
  const bus = createCoreChannelBus(transport, log);
  return {
    bus,
    dispose: () => bus.shutdown(),
  };
}

/**
 * 取该远程工作区 endpoint 的 daemon（一个 endpoint 一个 daemon；宿主退出只断开自己的
 * 控制链路，不发 shutdown——daemon 的 idle-exit 自行清场，见 `shutdownCore`）。
 *
 * 全部通信走 SSH 端口（`docs/core/core-remote.md` 第 2 节）。
 */
function remoteDaemonForEndpoint(ref: WorkspaceRef, options: CoreBootstrapOptions): CoreDaemon {
  const endpoint = ref.endpoint;
  if (!endpoint) {
    // 调用点已保证：只有远程引用才建 daemon
    throw new Error('remoteDaemonForEndpoint requires a remote workspace ref.');
  }
  const key = daemonRegistryKey(endpoint);
  const existing = standaloneDaemons.get(key);
  if (existing) return existing;
  const daemon = new CoreDaemon({
    transport: daemonOpenerFor(endpoint, options),
    // SSH 建链含「上传产物 + 启动 daemon」，沿用默认的 10s 会误杀首次接入
    linkTimeoutMs: SSH_DAEMON_LINK_TIMEOUT_MS,
    log: (...args: unknown[]) => options.log(...args),
  });
  standaloneDaemons.set(key, daemon);
  return daemon;
}

/**
 * 建链方式（`docs/core/core-remote.md` 第 2 节）：全部通信走 SSH 端口，daemon 的
 * endpoint 与 token 由引导流程取得（`sshDaemonBootstrap.ts`）。
 */
function daemonOpenerFor(
  endpoint: WorkspaceEndpoint,
  options: CoreBootstrapOptions,
): CoreDaemonLinkOpener {
  // 凭证 / 用户的校验收敛在 sshTargetFor（缺即抛错，不静默降级）
  return createSshDaemonOpener(
    {
      target: sshTargetFor(endpoint),
      extensionPath: options.extensionPath,
    },
    options.log,
  );
}

/**
 * 远程 daemon 注册表键：SSH 连接目标的唯一身份键（`sshTargetKey`——端口缺省归一、
 * 凭证以指纹参与身份）。换一个凭证必须换一条连接（否则「第一次输错口令，改对后
 * 重试」会复用旧连接、继续用错的凭证鉴权）；指纹不进日志。
 */
function daemonRegistryKey(endpoint: WorkspaceEndpoint): string {
  if (!endpoint) {
    throw new Error('remote daemon registry requires an endpoint.');
  }
  return sshTargetKey(sshTargetFor(endpoint));
}

/**
 * 列出远程 endpoint 上的子目录（远程目录选择器用）。
 *
 * 复用 `openStandaloneChannel` 的 daemon 注册表：选择目录时建立的连接，随后打开该目录
 * 时仍是同一个 daemon、同一条控制通道。`path` 为 null 时从远端主目录开始。
 */
export async function listRemoteDirectories(
  endpoint: WorkspaceEndpoint,
  path: string | null,
): Promise<DirectoryListing> {
  const daemon = remoteDaemonFor(endpoint);
  return daemon.listDirectories(path);
}

/**
 * 在远程 endpoint 上新建目录（父目录不存在时一并创建），返回实际路径。
 *
 * 与 `listRemoteDirectories` 走同一个 daemon：目录选择期间的连接随后就用来打开工作区。
 */
export async function createRemoteDirectory(
  endpoint: WorkspaceEndpoint,
  path: string,
): Promise<string> {
  const daemon = remoteDaemonFor(endpoint);
  return daemon.createDirectory(path);
}

/**
 * 重命名远程 endpoint 上的目录（只改同一父目录下的名字），返回新路径。
 */
export async function renameRemoteDirectory(
  endpoint: WorkspaceEndpoint,
  path: string,
  name: string,
): Promise<string> {
  const daemon = remoteDaemonFor(endpoint);
  return daemon.renameDirectory(path, name);
}

/**
 * 删除远程 endpoint 上的目录，返回实际路径。
 *
 * `recursive` 为 `false` 时只接受空目录：非空会以 `DirectoryOperationError`
 * （`reason === 'notEmpty'`）失败，调用方据此提示「连同内容一起删除」。
 */
export async function deleteRemoteDirectory(
  endpoint: WorkspaceEndpoint,
  path: string,
  recursive: boolean,
): Promise<string> {
  const daemon = remoteDaemonFor(endpoint);
  return daemon.deleteDirectory(path, recursive);
}

/** 工作区 Connection 生命周期通知：就绪，或无法建立 / 终止（附原因） */
export type WorkspaceConnectionState = 'ready' | 'lost';

/**
 * 工作区 Connection 状态订阅（宿主启动恢复 / 手动重连用）。
 *
 * Client 的 `onConnectionReady` / `onConnectionLost` 在构造时一次性注册给
 * bootstrapCore 内部使用（快照重推、忙会话失败标记）；宿主（Electron main）拿不到
 * Client 实例，从这里订阅同一份信号。注意 `lost` 含运行期 Core 退出的场景
 * （总线会按重启策略自动恢复），是否判定「不可用」由订阅方按「是否曾就绪」自行决定。
 */
const workspaceConnectionStateListeners = new Set<
  (ref: WorkspaceRef, state: WorkspaceConnectionState, reason: string) => void
>();

export function onWorkspaceConnectionState(
  listener: (ref: WorkspaceRef, state: WorkspaceConnectionState, reason: string) => void,
): () => void {
  workspaceConnectionStateListeners.add(listener);
  return () => workspaceConnectionStateListeners.delete(listener);
}

function notifyWorkspaceConnectionState(
  log: (...args: unknown[]) => void,
  ref: WorkspaceRef,
  state: WorkspaceConnectionState,
  reason: string,
): void {
  for (const listener of [...workspaceConnectionStateListeners]) {
    try {
      listener(ref, state, reason);
    } catch (error) {
      log(`[bootstrap] workspace connection state listener error: ${String(error)}`);
    }
  }
}

/**
 * 探测远程 endpoint 是否可连（宿主启动恢复 / 点击重连用）。
 *
 * 直接走传输层建链（TCP 连接 + auth 第一帧；SSH 为完整引导流程），**不经过 daemon
 * 注册表**：正式连接的建链超时是长超时（SSH 首次引导 `SSH_DAEMON_LINK_TIMEOUT_MS`），
 * 探测需要自己的短超时（`timeoutMs`），复用注册表 daemon 会把失败信号拖到两分钟后。
 * 探测拿到链路立即断开——不发 `shutdown` 帧，远端 daemon 的生命周期不受影响；
 * 超时后迟到的链路同样就地杀掉，不留悬挂 socket / SSH 进程。
 *
 * **远端引导不计入 `timeoutMs`**：opener 有 `prepare`（SSH 为发现 / 部署 / 启动
 * daemon）时先跑它——冷部署要上传产物再拉起 daemon，远超探测预算；`timeoutMs`
 * 只管「daemon 就绪之后的建链」。同一 endpoint 的并发引导已被 `sshTransport` 按
 * SSH 目标去重，这里的引导不会与正式连接的重复部署。
 */
export async function probeRemoteEndpoint(endpoint: WorkspaceEndpoint, timeoutMs: number): Promise<void> {
  const options = activeOptions;
  if (!options) {
    throw new Error('bootstrapCore() has not run; no remote opener available.');
  }
  const opener = daemonOpenerFor(endpoint, options);
  // dispose 必须覆盖所有失败出口：prepare（SSH 已 connect 后引导失败）抛错时
  // 不收尾会漏一条挂着 keepalive 的 SSH 连接——每次「重新连接」重试失败净增一条
  try {
    await opener.prepare();
    const opening = opener.open();
    // 探测的 opener 是临时建的（每次 probe 一个，不复用注册表 daemon 的）：链路落定后
    // 关掉底层 SSH 连接。挂在 `opening` 之后而不是探测的 return / 超时点——探测超时
    // 只是调用方放弃，建链（含引导）继续走完，socket 与 SSH 连接届时才收。
    void opening
      .then((link) => link.kill(), () => undefined)
      .finally(() => opener.dispose());
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        opening,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`远程连接超时（${Math.round(timeoutMs / 1000)} 秒）`)),
            timeoutMs,
          );
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      // 超时后迟到的链路：就地杀掉（已 settle 的路径上这是无害的重复 kill）
      void opening.then((link) => link.kill(), () => undefined);
    }
  } catch (err) {
    opener.dispose();
    throw err;
  }
}

/** 取（或建立）该 endpoint 的 daemon 客户端 */
function remoteDaemonFor(endpoint: WorkspaceEndpoint): CoreDaemon {
  const options = activeOptions;
  if (!options) throw new Error('bootstrapCore() has not run; no remote daemon available.');
  // 与随后打开该目录时用的引用同构：scheme 一致，注册表键才一致
  return remoteDaemonForEndpoint(remoteWorkspaceRef(endpoint, ''), options);
}

/** 远程 endpoint → daemon（宿主退出时全部关闭） */
const standaloneDaemons = new Map<string, CoreDaemon>();

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
        // 一次性通知（`docs/hosts/webview-ui.md` 第 11 节）：时间线末位显示、后继即删；
        // 失联提示只当次显示——meta.json 的 `onceMessage` 只由 core 侧通知写入，
        // 此刻 Core 已不可写，重开对话不重建本提示。
        data: { role: 'system', content: reason, once: true },
      });
      connection.emitToUi({ type: 'queryEnd', sessionId: state.sessionId });
    }
    if (busy.length > 0) {
      const busyIds = new Set(busy.map((state) => state.sessionId));
      conversations.updateSessionStates(
        states.map((state) =>
          busyIds.has(state.sessionId)
            ? {
                ...state,
                // Core 已失联：会话的所有运行时来源一并归零，避免留下
                // 「idle 但 queryRunning」这类自相矛盾的快照（``docs/architecture/principles.md` 第 8 节）。
                idle: true,
                waiting: false,
                queryRunning: false,
                compacting: false,
                pendingCompact: false,
                backgroundRunning: false,
                subAgentRunning: false,
              }
            : state,
        ),
      );
    }
  } catch (error) {
    log(`[bootstrap] failed to mark sessions after core loss: ${String(error)}`);
  }
}

/**
 * 释放 core 侧的进程级资源：关闭全部 Connection（Core 进程 / daemon channel）。
 * 宿主退出钩子调用一次。
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
  // 远程 daemon：只断开自己的控制链路，**不发 shutdown**——任一连接的 shutdown 在
  // daemon 侧是全局停机，多客户端接入下会连坐杀掉其它客户端的会话；SSH 引导的
  // daemon 自带 idle-exit，最后一条链路断开后自行退出并清状态文件
  const daemons = [...standaloneDaemons.values()];
  standaloneDaemons.clear();
  for (const daemon of daemons) tasks.push(daemon.disconnect());
  activeOptions = null;
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
    locale: options.locale,
    uiLanguage: readUiLanguage(),
    eventBusRegistered,
    uiCreated,
    logToConsole: options.logToConsole,
    connectionCount: client.listConnections().length,
  };

  // core 侧状态在 Core 进程内：UI 侧只报告自己掌握的接线事实。
  return {
    ...base,
    extensionPathProvided: true,
  };
}
