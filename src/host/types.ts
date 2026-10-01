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
   * 会话视图模式：每个会话是否有独立的 webview。它是「切换会话 / 关闭会话」这一组
   * 行为的根：
   * - `multi`：多视图。每会话一个独立 webview；切换会话由宿主另开 / 切换视图
   *   （openConversation，已打开的视图直接复用，不重新加载），并提供关闭按钮销毁当前视图。
   * - `single`：单视图。一个 webview 承载全部会话；切换会话在当前 webview 内原地加载
   *   （loadConversation）；没有独立视图可关，因而不提供关闭按钮。
   *
   * 由宿主在启动时注入（Electron 走 `--conversationView=`），运行期不变。
   */
  conversationView: 'single' | 'multi';
  /**
   * 对话列表的渲染方（唯一 owner），可在运行期切换：
   * - `host`：宿主原生侧栏（Electron 完整模式）
   * - `webview`：webview 顶栏下拉（VS Code / Electron 悬浮窗）
   *
   * 与 `conversationView` 解耦：Electron 悬浮窗没有放原生侧栏的位置，把列表交给
   * webview 顶栏渲染，但视图模式仍是 `multi`（切换会话照旧复用 / 另开视图，不原地重载）。
   *
   * 该值可在运行期切换（宿主发 `setConversationListOwner` 消息）：Electron 悬浮窗
   * 隐藏原生侧栏后必须切到 `webview`，否则用户既看不到列表也无法新建对话。
   * 用 `hostInfoForConversationListOwner()` 按当前渲染方推导，不要直接读注入值。
   */
  conversationListOwner: 'host' | 'webview';
}

/** 对话列表是否由 webview 渲染：原生侧栏缺席时列表内嵌在顶栏 */
export function rendersConversationListInWebview(info: HostInfo): boolean {
  return info.conversationListOwner === 'webview';
}

/**
 * 「新建对话」入口的渲染方：跟对话列表走——列表在原生侧栏时按钮也在侧栏，
 * 列表搬到 webview 顶栏后入口跟着搬（顶栏「+」）。
 *
 * 只表达「谁渲染入口」；点击后是另开视图还是原地重载由 `openConversationModeOf` 决定。
 */
export function newConversationEntryOf(info: HostInfo): 'host' | 'webview' {
  return info.conversationListOwner;
}

/** 打开会话的方式：多视图另开视图（openConversation），单视图在当前视图原地重载（loadConversation） */
export function openConversationModeOf(info: HostInfo): 'openConversation' | 'loadConversation' {
  return info.conversationView === 'multi' ? 'openConversation' : 'loadConversation';
}

/** 是否提供"关闭当前会话"按钮：只有多视图有可销毁的独立视图 */
export function canCloseConversation(info: HostInfo): boolean {
  return info.conversationView === 'multi';
}

/** VS Code 扩展宿主的能力声明：单视图，对话列表由顶栏渲染 */
export const VSCODE_HOST_INFO: HostInfo = {
  conversationView: 'single',
  conversationListOwner: 'webview',
};

/** Electron 桌面应用宿主的能力声明：多视图，对话列表由原生侧栏渲染 */
export const ELECTRON_HOST_INFO: HostInfo = {
  conversationView: 'multi',
  conversationListOwner: 'host',
};

/**
 * 按对话列表渲染方推导宿主能力。
 *
 * 渲染方可以在运行期切换（Electron 悬浮窗隐藏原生侧栏后，列表改由 webview 顶栏渲染），
 * 因此不能只看宿主注入的静态 `__hostInfo`：切换后「列表 / 新建入口」都跟着换人渲染。
 * 视图模式是宿主的静态能力（不随悬浮窗变化），原样保留。
 */
export function hostInfoForConversationListOwner(
  base: HostInfo,
  owner: HostInfo['conversationListOwner'],
): HostInfo {
  if (base.conversationListOwner === owner) return base;
  return { ...base, conversationListOwner: owner };
}
