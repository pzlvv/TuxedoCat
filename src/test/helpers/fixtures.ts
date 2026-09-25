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
import { createEventBus } from '../../host/EventBus';
import type { UIHost } from '../../host/UIHost';
import type { WebviewMessage } from '../../core/webviewTypes';
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

/**
 * 创建一个「只记录、不做副作用」的总线。
 *
 * 默认所有事件处理器只把事件记进 `received()`，请求一律放行 / 选第 0 项，
 * 这样测试只关心自己要断言的那条路径。
 */
export function makeTestBus(options: TestBusOptions = {}): TestBus {
  const recorded = new Map<string, unknown[]>();
  const record = (type: string, event: unknown): void => {
    const list = recorded.get(type);
    if (list) list.push(event);
    else recorded.set(type, [event]);
  };

  const handlers: MutableCoreEventHandlers = {
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
    sessionRuntimeChanged: (e) => record('sessionRuntimeChanged', e),
    spinDesignDataChanged: (e) => record('spinDesignDataChanged', e),
    highlightLanguagesUsed: (e) => record('highlightLanguagesUsed', e),
    projectConversationDirReady: (e) => record('projectConversationDirReady', e),
    compactBegin: (e) => record('compactBegin', e),
    compactEnd: (e) => record('compactEnd', e),
    commandDispatched: (e) => record('commandDispatched', e),
    sessionConfigChanged: (e) => record('sessionConfigChanged', e),
  };

  const bus = createEventBus();
  const unsubscribeCoreEvents = bus.onCoreEvents(handlers);
  bus.onCoreRequests({
    toolPermissionRequested:
      options.toolPermissionRequested ?? (async () => ({ behavior: 'allow' })),
    userChoice: options.userChoice ?? (async () => ({ index: 0 })),
  });

  const list = <T extends CoreEvent['type']>(type: T): Array<Extract<CoreEvent, { type: T }>> =>
    (recorded.get(type) ?? []) as Array<Extract<CoreEvent, { type: T }>>;

  return {
    bus,
    handlers,
    received: list,
    last: <T extends CoreEvent['type']>(type: T) => list(type).at(-1),
    count: (type) => list(type).length,
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
    onDidChangeWorkspace: (listener) => {
      // 契约：订阅时立即回调一次当前值
      listener(undefined);
      return () => undefined;
    },
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
    ensureProjectSettings: async () => undefined,
  };

  return Object.assign(base, overrides, { sent, broadcast });
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tuxedo-cat-${prefix}-`));
  trackedTempDirs.add(dir);
  return dir;
}
