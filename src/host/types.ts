/**
 * HostInfo - 宿主能力声明
 *
 * 由各宿主（VS Code 扩展 / Electron 应用）在 webview 启动时注入 `window.__hostInfo`，
 * webview 据此渲染 UI，不再通过嗅探 `window.electronAPI` 区分 app / 插件。
 *
 * 各宿主实现（`extension.ts` / `electron/main.ts`）在 bootstrap 时声明自己的能力，
 * 差异全部收敛到此处，webview 只按能力渲染。
 */
export interface HostInfo {
  /**
   * 对话视图模式。它是一整组宿主行为的根，其余差异都由它推导：
   * - `single`：单视图。没有原生侧栏，对话列表由 webview 顶栏渲染；切换会话在当前
   *   webview 内重新加载（loadConversation）；没有独立视图可关，因而不提供关闭按钮。
   * - `multi`：多视图。每个会话一个独立 webview，对话列表由宿主原生侧栏渲染；
   *   切换会话由宿主另开视图（openConversation），并提供关闭按钮销毁当前视图。
   *
   * 该值可在运行期切换（宿主发 `setConversationListMode` 消息）：Electron 悬浮窗模式
   * 会隐藏原生侧栏，此时必须切到 `single`，否则用户既看不到列表也无法新建对话。
   * 用 `hostInfoForViewMode()` 按当前模式推导，不要直接读注入值。
   */
  conversationList: 'single' | 'multi';
  /** 新建对话由谁触发：host（Electron 原生侧栏按钮）或 webview（VS Code 顶部按钮） */
  newConversation: 'host' | 'webview';
}

/** 对话列表是否由 webview 渲染：单视图没有原生侧栏，列表内嵌在顶栏 */
export function rendersConversationListInWebview(info: HostInfo): boolean {
  return info.conversationList === 'single';
}

/** 打开会话的方式：多视图另开 webview（openConversation），单视图在当前视图原地重载（loadConversation） */
export function openConversationModeOf(info: HostInfo): 'openConversation' | 'loadConversation' {
  return info.conversationList === 'multi' ? 'openConversation' : 'loadConversation';
}

/** 是否提供"关闭当前会话"按钮：只有多视图有可销毁的独立视图 */
export function canCloseConversation(info: HostInfo): boolean {
  return info.conversationList === 'multi';
}

/** VS Code 扩展宿主的能力声明：单视图 */
export const VSCODE_HOST_INFO: HostInfo = {
  conversationList: 'single',
  newConversation: 'webview',
};

/** Electron 桌面应用宿主的能力声明：多视图 */
export const ELECTRON_HOST_INFO: HostInfo = {
  conversationList: 'multi',
  newConversation: 'host',
};

/**
 * 按视图模式推导宿主能力。
 *
 * 视图模式可以在运行期切换（Electron 悬浮窗隐藏原生侧栏后，对话列表改由 webview
 * 顶栏渲染，与 VS Code 单视图一致），因此不能只看宿主注入的静态 `__hostInfo`：
 * - `single`：列表由 webview 顶栏渲染（历史对话入口），提供关闭按钮与否也随之变化
 * - `multi`：列表由宿主原生侧栏渲染，顶栏只保留「关闭当前会话」
 *
 * `newConversation` 跟随推导：单视图没有原生侧栏，「新建对话」入口必须在顶栏。
 */
export function hostInfoForViewMode(base: HostInfo, mode: HostInfo['conversationList']): HostInfo {
  if (base.conversationList === mode) return base;
  return {
    ...base,
    conversationList: mode,
    // 必须按目标模式推导，不能回退 base.newConversation：悬浮窗（single/webview）
    // 启动的视图切回完整模式时，回退会得到 multi + webview，顶栏会同时出现
    // 「新建对话」与「关闭会话」，破坏 multi ⇒ newConversation:'host' 的契约。
    newConversation: mode === 'single' ? 'webview' : 'host',
  };
}
