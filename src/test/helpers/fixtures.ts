/**
 * 测试夹具：把各测试文件里重复搭的桩收拢到一处。
 *
 * - `makeTestBus()`：注册了全部 `CoreEventHandlers` 的记录型总线。
 *   `CoreEventHandlers` 是穷尽映射类型，以前每个测试文件都要手抄 23 个字段；
 *   总线加一个事件就要改 N 个文件。现在只有这里一处，漏抄照样编译报错。
 * - `createTestHost()`：`UIHost` 契约的最小实现（契约完整、无可选成员，
 *   所以宿主桩必须显式列全；同样只在这里维护一份）。
 * - `makeTempDir()`：临时工作区目录，进程退出时自动清理。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CONFIG_DIR_NAME } from '../../config/project';
import { createEventBus } from '../../host/EventBus';
import type { UIHost } from '../../host/UIHost';
import { localWorkspaceRef } from '../../host/workspaceRef';
import type { WebviewMessage } from '../../host/webviewMessages';
import {
  resolveSettingsSnapshot,
  type McpServerDefinition,
  type SettingsSnapshot,
} from '../../core/settingsSnapshot';
import { applySettingsSnapshot } from '../../core/settings';
import { parseMcpServerDefinitions } from '../../core/mcp/parse';
import type {
  AssistantEventBus,
  CoreEvent,
  CoreEventHandlers,
  CoreRequestHandlers,
} from '../../core/AssistantEventBus';

/** 去掉 `readonly` 的处理器表：测试里可以按需替换某个事件的接线 */
export type MutableCoreEventHandlers = {
  -readonly [K in keyof CoreEventHandlers]: CoreEventHandlers[K];
};

export interface TestBus {
  bus: AssistantEventBus;
  handlers: MutableCoreEventHandlers;
  /** 某个 core→UI 事件收到的全部事件对象（按到达顺序） */
  received<T extends CoreEvent['type']>(type: T): Array<Extract<CoreEvent, { type: T }>>;
  /** 某个事件的最后一条；没收到则为 undefined */
  last<T extends CoreEvent['type']>(type: T): Extract<CoreEvent, { type: T }> | undefined;
  /** 某个事件收到的条数 */
  count(type: CoreEvent['type']): number;
  /** 注销 core 事件处理器：用来验证「未注册时 emitToUi 抛错」这条边界 */
  unsubscribeCoreEvents(): void;
}

export interface TestBusOptions {
  /** 工具权限请求的答复，默认一律放行 */
  toolPermissionRequested?: CoreRequestHandlers['toolPermissionRequested'];
  /** 用户选择的答复，默认选第 0 项 */
  userChoice?: CoreRequestHandlers['userChoice'];
}

export interface RecordingCoreEventHandlers {
  handlers: MutableCoreEventHandlers;
  /** 某个 core→UI 事件收到的全部事件对象（按到达顺序） */
  received<T extends CoreEvent['type']>(type: T): Array<Extract<CoreEvent, { type: T }>>;
  /** 某个事件的最后一条；没收到则为 undefined */
  last<T extends CoreEvent['type']>(type: T): Extract<CoreEvent, { type: T }> | undefined;
  /** 某个事件收到的条数 */
  count(type: CoreEvent['type']): number;
}

/**
 * 创建一个「只记录、不做副作用」的 CoreEvent 处理器表。
 *
 * `CoreEventHandlers` 是穷尽映射类型，总线加一个事件就要改一处；
 * 这里与 `makeTestBus` 共用同一份定义。
 */
export function createRecordingCoreEventHandlers(): RecordingCoreEventHandlers {
  const recorded = new Map<string, unknown[]>();
  const record = (type: string, event: unknown): void => {
    const list = recorded.get(type);
    if (list) list.push(event);
    else recorded.set(type, [event]);
  };

  const handlers: MutableCoreEventHandlers = {
    coreReady: (e) => record('coreReady', e),
    message: (e) => record('message', e),
    streamMessage: (e) => record('streamMessage', e),
    streamEnd: (e) => record('streamEnd', e),
    toolCall: (e) => record('toolCall', e),
    toolResult: (e) => record('toolResult', e),
    toolArgsUpdated: (e) => record('toolArgsUpdated', e),
    toolProgress: (e) => record('toolProgress', e),
    aiBegin: (e) => record('aiBegin', e),
    aiEnd: (e) => record('aiEnd', e),
    messagesReplaced: (e) => record('messagesReplaced', e),
    queryBegin: (e) => record('queryBegin', e),
    queryEnd: (e) => record('queryEnd', e),
    titleChanged: (e) => record('titleChanged', e),
    sessionCreated: (e) => record('sessionCreated', e),
    conversationListChanged: (e) => record('conversationListChanged', e),
    conversationSpaceCleared: (e) => record('conversationSpaceCleared', e),
    sessionRuntimeChanged: (e) => record('sessionRuntimeChanged', e),
    spinDesignDataChanged: (e) => record('spinDesignDataChanged', e),
    highlightLanguagesUsed: (e) => record('highlightLanguagesUsed', e),
    compactBegin: (e) => record('compactBegin', e),
    compactEnd: (e) => record('compactEnd', e),
    commandDispatched: (e) => record('commandDispatched', e),
    sessionConfigChanged: (e) => record('sessionConfigChanged', e),
    notice: (e) => record('notice', e),
    log: (e) => record('log', e),
  };

  const list = <T extends CoreEvent['type']>(type: T): Array<Extract<CoreEvent, { type: T }>> =>
    (recorded.get(type) ?? []) as Array<Extract<CoreEvent, { type: T }>>;

  return {
    handlers,
    received: list,
    last: <T extends CoreEvent['type']>(type: T) => list(type).at(-1),
    count: (type) => list(type).length,
  };
}

/**
 * 创建一个「只记录、不做副作用」的总线。
 *
 * 默认所有事件处理器只把事件记进 `received()`，请求一律放行 / 选第 0 项，
 * 这样测试只关心自己要断言的那条路径。
 */
export function makeTestBus(options: TestBusOptions = {}): TestBus {
  const recording = createRecordingCoreEventHandlers();
  const bus = createEventBus();
  const unsubscribeCoreEvents = bus.onCoreEvents(recording.handlers);
  bus.onCoreRequests({
    toolPermissionRequested:
      options.toolPermissionRequested ?? (async () => ({ behavior: 'allow' })),
    userChoice: options.userChoice ?? (async () => ({ index: 0 })),
  });

  return {
    bus,
    handlers: recording.handlers,
    received: recording.received,
    last: recording.last,
    count: recording.count,
    unsubscribeCoreEvents,
  };
}

export interface TestHost extends UIHost {
  /** 经 `sendToWebview` / `sendToWebviewView` 发出的全部消息 */
  readonly sent: WebviewMessage[];
  /** 经 `broadcastToWebviews` 发出的全部消息 */
  readonly broadcast: WebviewMessage[];
}

/**
 * `UIHost` 的最小实现。
 *
 * `overrides` 用来覆盖需要记录 / 造错的成员；未覆盖的成员是「什么都不做」。
 * 注意 `broadcastToWebviews` 与 `sendToWebview` 分开记录——单视图宿主里二者等价，
 * 但多视图语义下的区分正是要测的点，所以不要合并。
 */
export function createTestHost(overrides: Partial<UIHost> = {}): TestHost {
  const sent: WebviewMessage[] = [];
  const broadcast: WebviewMessage[] = [];

  const base: UIHost = {
    // 传输
    sendToWebview: (message) => {
      sent.push(message);
    },
    broadcastToWebviews: (message) => {
      broadcast.push(message);
    },
    sendToWebviewView: (_view, message) => {
      sent.push(message);
    },
    onThemeChanged: () => undefined,
    // 环境
    log: () => undefined,
    getWorkspacePath: () => undefined,
    getWorkspaceRef: () => undefined,
    getOpenWorkspaceRefs: () => [],
    onWorkspaceChanged: () => () => undefined,
    isDarkTheme: () => false,
    getLocale: () => 'en',
    // 面板 / 窗口
    openFile: async () => undefined,
    showVirtualDocument: async () => undefined,
    showDiff: async () => undefined,
    openMermaidPreview: async () => undefined,
    closePreview: () => undefined,
    openExternalUrl: async () => undefined,
    saveTextFile: async () => ({ success: false, canceled: true }),
    // 会话
    closeConversationView: async () => undefined,
    // 配置文件
    updateSettingsJson: async () => undefined,
  };

  const host = Object.assign(base, overrides, { sent, broadcast });
  // 只覆写 getWorkspacePath 的用例自动派生出工作区引用 / 打开集合，
  // 避免每个用例都要同时给三个方法（工作区路径是唯一事实来源）。
  if (!overrides.getWorkspaceRef) {
    host.getWorkspaceRef = () => {
      const p = host.getWorkspacePath();
      return p ? localWorkspaceRef(p) : undefined;
    };
  }
  if (!overrides.getOpenWorkspaceRefs) {
    host.getOpenWorkspaceRefs = () => {
      const ref = host.getWorkspaceRef();
      return ref ? [ref] : [];
    };
  }
  return host;
}

const trackedTempDirs = new Set<string>();

// 进程退出时兜底清理：测试失败中断时也不会在系统临时目录里留垃圾
process.on('exit', () => {
  for (const dir of trackedTempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响测试结果 */
    }
  }
});

/** 建一个临时目录（`mkdir` + 退出时自动删除），用来当 projectRoot / HOME */
export function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tc-${prefix}-`));
  trackedTempDirs.add(dir);
  return dir;
}

/**
 * 最小可用的配置快照（`UiEvent.hostEnvironmentProvided.settings` 用）。
 *
 * 直接走 `resolveSettingsSnapshot(undefined)`，与产品代码共用同一份默认值，
 * 避免测试里手抄一份迟早和实现漂移的常量。
 */
export function emptySettingsSnapshot(): SettingsSnapshot {
  return resolveSettingsSnapshot(undefined);
}

/**
 * 把原始 settings / mcp 对象解析成配置快照并写入 core 侧唯一入口（测试用）。
 *
 * 与宿主 `SettingsStore` 走同一套纯函数，避免测试里手写快照形状。
 */
export function applyTestSettings(rawSettings: unknown, rawMcp?: unknown): void {
  applySettingsSnapshot(resolveSettingsSnapshot(rawSettings), parseMcpServerDefinitions(rawMcp));
}

/**
 * 从 `<homeDir>/<CONFIG_DIR_NAME>/settings.json` 读原始配置并产出配置快照（测试用）。
 *
 * 与宿主 `SettingsStore` 走同一套纯函数。Standalone 测试会先 `writeSettings(homeDir, ...)`
 * 再起 Core，这里负责把那份配置变成 Core 真正消费的快照。
 */
export function settingsSnapshotFromHome(homeDir: string): SettingsSnapshot {
  const settingsPath = path.join(homeDir, CONFIG_DIR_NAME, 'settings.json');
  return resolveSettingsSnapshot(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
}

/**
 * 模拟宿主连接：发一次 `hostEnvironmentProvided`（宿主环境 + 空配置快照）。
 *
 * Core 就绪前只接受这一条 `UiEvent`（`docs/architecture/core-ui-separation.md` 第 7 节），
 * 因此任何直接 `emitToCore` 驱动 core 的用例都必须先握手。配置快照按空配置解析
 * （等价于「用户还没配置过」）；需要具体配置的用例自己构造快照再发。
 */
export function provideHostEnvironment(
  bus: AssistantEventBus,
  overrides: {
    extensionPath?: string;
    logToConsole?: boolean;
    configDirName?: string;
    settings?: SettingsSnapshot;
    mcpServers?: readonly McpServerDefinition[];
  } = {},
): void {
  bus.emitToCore({
    type: 'hostEnvironmentProvided',
    extensionPath: overrides.extensionPath ?? process.cwd(),
    logToConsole: overrides.logToConsole ?? false,
    configDirName: overrides.configDirName ?? CONFIG_DIR_NAME,
    settings: overrides.settings ?? resolveSettingsSnapshot({}),
    mcpServers: overrides.mcpServers ?? [],
  });
}
