/**
 * HostInfo - 宿主能力声明
 *
 * 由各宿主（VS Code 扩展 / Electron 应用）在 webview 启动时注入 `window.__hostInfo`，
 * webview 据此渲染 UI，不再通过嗅探 `window.electronAPI` 区分 app / 插件。
 *
 * 每个宿主（VSCodeUI / ElectronUI，均实现 AssistantUI）在 bootstrap 时声明自己的能力，
 * 差异全部收敛到此处，webview 只按能力渲染。
 */
export interface HostInfo {
  /** 宿主类型 */
  kind: 'vscode' | 'electron' | 'server';
  /** 对话列表由谁渲染：host（Electron 原生侧栏）或 webview（VS Code 内置下拉） */
  conversationList: 'host' | 'webview';
  /** 新建对话由谁触发：host（Electron 原生侧栏按钮）或 webview（VS Code 顶部按钮） */
  newConversation: 'host' | 'webview';
  /** 是否提供"关闭当前会话"按钮（Electron 可销毁 webview 释放渲染进程） */
  closeConversation: boolean;
  /** 打开会话的方式：Electron 新起 webview（openConversation），VS Code 当前 webview 内加载（loadConversation） */
  openConversationMode: 'openConversation' | 'loadConversation';
}

/** VS Code 扩展宿主的能力声明 */
export const VSCODE_HOST_INFO: HostInfo = {
  kind: 'vscode',
  conversationList: 'webview',
  newConversation: 'webview',
  closeConversation: false,
  openConversationMode: 'loadConversation',
};

/** Electron 桌面应用宿主的能力声明 */
export const ELECTRON_HOST_INFO: HostInfo = {
  kind: 'electron',
  conversationList: 'host',
  newConversation: 'host',
  closeConversation: true,
  openConversationMode: 'openConversation',
};

/**
 * 内置 HTTP 服务器宿主（Electron 开启「Start Server」后，浏览器访问的 Web 端）的能力声明。
 *
 * 与 Electron 桌面端的差异：
 * - 浏览器没有原生侧栏，对话列表 / 新建对话 / 关闭对话全部由 webview 自己渲染
 * - 打开会话在当前页面内重新加载（loadConversation），而不是新起一个原生视图
 * - 后端仍然是 Electron 主进程（复用 ElectronUI / core），因此 kind 语义上与 electron 一致
 */
export const SERVER_HOST_INFO: HostInfo = {
  kind: 'server',
  conversationList: 'webview',
  newConversation: 'webview',
  closeConversation: false,
  openConversationMode: 'loadConversation',
};
