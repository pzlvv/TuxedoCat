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
