/**
 * Encapsulated access to host webview globals injected via HTML / preload.
 * 
 * VS Code 扩展：由 extension.ts 在 HTML 中注入 window.vscode / window.logoUri / window.__hostInfo 等
 * Electron 应用：由 preload.ts 通过 contextBridge 注入 window.electronAPI / __hostInfo / __hasWorkspace 等
 * 
 * 这些全局变量在 webview 加载时即已就绪，只读。集中在此处避免重复
 * `(window as any).xxx` 转换，并使 API 表面显式。
 * 宿主差异（app / 插件）统一由 __hostInfo 能力声明驱动，webview 不做宿主嗅探。
 */

import { hostInfoForConversationListOwner, openConversationModeOf, type HostInfo } from '../host/types';
import type { WebviewToHostMessage } from '../host/webviewMessages';

/**
 * 宿主消息通道的最小契约：VS Code 的 `acquireVsCodeApi()` 与 Electron preload 暴露的
 * `window.electronAPI` 都满足它，webview 只依赖这一个方法，不关心通道由谁提供。
 */
interface HostMessageApi {
  postMessage(message: unknown): void;
}

let _hostMessageApi: HostMessageApi | null = null;
let _logoUri: string | null = null;
let _hasWorkspace: boolean | undefined;
let _hostInfo: HostInfo | null = null;
/**
 * 运行期「对话列表渲染方」。宿主注入的 `__hostInfo.conversationListOwner` 只是启动时的
 * 初始值；Electron 悬浮窗会隐藏原生侧栏，此时列表改由 webview 顶栏渲染，
 * 宿主通过 `setConversationListOwner` 消息在运行期切换（见 App.tsx 的订阅）。
 *
 * 视图模式（`conversationView`）是宿主的静态能力，不参与运行期切换——它只决定
 * 「打开会话」是另开视图还是原地重载（见 src/host/types.ts 的 openConversationModeOf）。
 */
let _conversationListOwner: HostInfo['conversationListOwner'] | null = null;
const _conversationListOwnerListeners = new Set<(owner: HostInfo['conversationListOwner']) => void>();
/** getEffectiveHostInfo 的派生缓存（按渲染方失效），保证同渲染方下引用稳定 */
let _effectiveHostInfo: HostInfo | null = null;
let _effectiveHostInfoOwner: HostInfo['conversationListOwner'] | null = null;

/**
 * 解析宿主消息通道。
 * Electron 走 window.electronAPI（preload 注入），VS Code / 浏览器 shim 走 window.vscode。
 * 两者都不存在时抛错——这是宿主集成缺失，不做静默降级。
 */
function resolveHostMessageApi(): HostMessageApi {
  if (_hostMessageApi) return _hostMessageApi;
  const electronApi = (window as any).electronAPI as { postMessage?: (m: unknown) => void } | undefined;
  if (electronApi?.postMessage) {
    _hostMessageApi = { postMessage: (msg: unknown) => electronApi.postMessage!(msg) };
    return _hostMessageApi;
  }
  const vscodeApi = (window as any).vscode as HostMessageApi | undefined;
  if (vscodeApi?.postMessage) {
    _hostMessageApi = vscodeApi;
    return _hostMessageApi;
  }
  throw new Error(
    '宿主消息通道未就绪：既没有 window.electronAPI（Electron preload），也没有 window.vscode（VS Code / 浏览器 shim）。'
  );
}

/**
 * 取宿主消息通道。
 * Electron 下返回 electronAPI 的包装对象（内部走 ipcRenderer.send），VS Code 下返回 acquireVsCodeApi() 的实例。
 */
export function getHostMessageApi(): HostMessageApi {
  return resolveHostMessageApi();
}

/** 宿主消息通道是否就绪：存在即 true；不抛错、不写缓存（供可选发送路径先行判断）。 */
export function hasHostMessageApi(): boolean {
  if (_hostMessageApi) return true;
  const electronApi = (window as any).electronAPI as { postMessage?: (m: unknown) => void } | undefined;
  if (electronApi?.postMessage) return true;
  const vscodeApi = (window as any).vscode as HostMessageApi | undefined;
  return !!vscodeApi?.postMessage;
}

/**
 * 获取宿主能力声明（由各宿主在页面加载时注入 window.__hostInfo）。
 *
 * 这是 webview 感知宿主差异的唯一入口：注入缺失或字段不完整时直接抛错，
 * 让「新宿主忘记声明能力」在启动时就暴露，而不是靠嗅探回退掩盖。
 */
export function getHostInfo(): HostInfo {
  if (_hostInfo) return _hostInfo;
  const injected = (window as any).__hostInfo as Partial<HostInfo> | undefined;
  if (!injected) {
    throw new Error('window.__hostInfo 未注入：宿主必须在 webview 启动前声明能力（见 src/host/types.ts）。');
  }
  const problems: string[] = [];
  if (injected.conversationView !== 'single' && injected.conversationView !== 'multi') {
    problems.push(`conversationView=${String(injected.conversationView)}`);
  }
  if (injected.conversationListOwner !== 'host' && injected.conversationListOwner !== 'webview') {
    problems.push(`conversationListOwner=${String(injected.conversationListOwner)}`);
  }
  if (problems.length > 0) {
    throw new Error(`window.__hostInfo 字段非法或缺失：${problems.join(', ')}（见 src/host/types.ts 的 HostInfo）。`);
  }
  _hostInfo = injected as HostInfo;
  return _hostInfo;
}

/** 当前对话列表渲染方（未收到过运行期切换时即宿主注入的初始值） */
export function getConversationListOwner(): HostInfo['conversationListOwner'] {
  if (_conversationListOwner) return _conversationListOwner;
  _conversationListOwner = getHostInfo().conversationListOwner;
  return _conversationListOwner;
}

/**
 * 按当前对话列表渲染方推导的宿主能力：UI 渲染与「打开会话」行为都读它，不直接读 getHostInfo()。
 *
 * 派生结果按渲染方缓存：同一个渲染方下多次调用返回**同一个对象引用**，否则
 * `hostInfoForConversationListOwner` 在「注入渲染方 ≠ 当前渲染方」时每次都会新建对象，
 * 放进 useMemo/useCallback 依赖里会造成无谓重建。
 */
export function getEffectiveHostInfo(): HostInfo {
  const owner = getConversationListOwner();
  if (!_effectiveHostInfo || _effectiveHostInfoOwner !== owner) {
    _effectiveHostInfo = hostInfoForConversationListOwner(getHostInfo(), owner);
    _effectiveHostInfoOwner = owner;
  }
  return _effectiveHostInfo;
}

/**
 * 运行期切换对话列表渲染方（宿主消息 `setConversationListOwner` 驱动）。
 * 渲染方未变化时不通知，避免无意义的重渲染。
 */
export function setConversationListOwner(owner: HostInfo['conversationListOwner']): void {
  if (getConversationListOwner() === owner) return;
  _conversationListOwner = owner;
  // 隔离单个订阅者的异常：否则一个组件抛错会中断其余订阅者的重渲染
  for (const listener of _conversationListOwnerListeners) {
    try {
      listener(owner);
    } catch (err) {
      console.error('[webviewEnv] conversation list owner listener failed:', err);
    }
  }
}

/** 订阅对话列表渲染方变化，返回取消订阅函数（供 React 组件在 useEffect 中调用） */
export function onConversationListOwnerChanged(
  listener: (owner: HostInfo['conversationListOwner']) => void,
): () => void {
  _conversationListOwnerListeners.add(listener);
  return () => { _conversationListOwnerListeners.delete(listener); };
}

export function getLogoUri(): string {
  if (_logoUri === null) {
    _logoUri = (window as any).logoUri ?? './logo1.png';
  }
  return _logoUri as string;
}

/**
 * Shared Tailwind classes for the logo image in empty/placeholder states.
 *
 * `max-w-full`：窄侧栏（VS Code 面板可以拖到很窄）下按容器收缩，避免横向溢出；
 * 有空间时按 360px 展示（原 240px 的 1.5 倍）。
 */
export const LOGO_CLASS_NAME = 'w-[360px] max-w-full h-auto opacity-80';

export function getHasWorkspace(): boolean {
  if (_hasWorkspace === undefined) {
    _hasWorkspace = (window as any).__hasWorkspace;
  }
  return _hasWorkspace as boolean;
}

/** Get the current session ID stored on the window (for tool components). */
export function getWindowSessionId(): string | null {
  return (window as any).__currentSessionId as string ?? null;
}

/**
 * 本视图创建时绑定的目标会话（Electron：URL `?session=` / preload 注入的 `__sessionId`）。
 *
 * 与 getWindowSessionId 的区别：这里读的是**视图创建时**由宿主绑定的会话（只读、不变），
 * 而不是 webview 自己维护的当前会话。没有绑定会话（单视图 VS Code，或 Electron 的
 * 新对话视图）时返回 null —— 调用方据此判断本页启动后进入的是「新对话」。
 */
export function getInjectedSessionId(): string | null {
  const urlSession = new URLSearchParams(window.location.search).get('session');
  const injectedSession = (window as any).__sessionId as string | undefined;
  return urlSession || injectedSession || null;
}

/**
 * 是否为后台预热的「新对话」视图（仅 Electron 宿主会注入 window.__prewarm）。
 *
 * 预热视图的页面照常加载，但跳过启动初始化（不生成 session、不申请主题/模型等），
 * 等被切到前台时由宿主发 activatePrewarmedView 触发。其他宿主返回 false。
 */
export function getIsPrewarmView(): boolean {
  return (window as any).__prewarm === true;
}

/**
 * 宿主注入的"上次已使用过的 Shiki 语言"列表（来自 settings.json）。
 * 语法高亮全部按需加载，这里记录的集合会在启动后后台预热，
 * 避免每次都重新经历首次加载延迟。宿主未注入时返回空数组。
 */
export function getPreloadedHighlightLanguages(): string[] {
  const list = (window as any).__highlightLanguages;
  if (!Array.isArray(list)) return [];
  return list.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/**
 * 宿主注入的首帧主题（`window.__initialTheme`）。
 *
 * 主题的权威值由宿主的 `setTheme` 消息下发（VS Code 跟随编辑器主题、Electron 跟随
 * nativeTheme）；首帧主题是**同步注入**的事实（`docs/webview-facts.md` 第 3 节），
 * 用于 React 渲染前选对兜底背景色，避免浅色主题下先闪一帧深色 loading。
 *
 * 注入缺失或取值非法说明宿主接线不完整，直接抛错——不猜一个主题。
 */
export function getInitialTheme(): 'dark' | 'light' {
  const v = (window as any).__initialTheme;
  if (v === 'dark' || v === 'light') return v;
  throw new Error(
    `window.__initialTheme 未注入或取值非法（${String(v)}）：宿主必须在 webview 启动前写入首帧主题（'dark' | 'light'）。`,
  );
}

/** Post a typed message to host (VS Code extension / Electron main), returns false if no API. */
export function postMessage(msg: WebviewToHostMessage): boolean {
  if (!hasHostMessageApi()) return false;
  getHostMessageApi().postMessage(msg);
  return true;
}

/**
 * 会话跳转的**底层原语**：只负责按视图模式把跳转消息发给宿主。
 *
 * 打开方式由视图模式推导（见 src/host/types.ts 的 openConversationModeOf）——
 * 与对话列表由谁渲染无关（`conversationListOwner` 只决定列表 / 新建入口在哪）：
 *   - 单视图（VS Code 插件）：当前 webview 内重新加载对话（loadConversation）
 *   - 多视图（Electron App）：新起一个 webview 加载对话（openConversation，由主进程创建/切换聊天视图）
 *
 * 架构约束：**UI 层的会话跳转入口有且只有 `App.tsx` 的 `navigateToSession`**。
 * 它负责切换前的固定动作（草稿暂存、loading 状态、清空消息等），再委托到这里。
 * 子代理链接 / From 链接 / 返回父会话等任何入口都不得直接调用本函数——否则会绕过
 * loading，出现「有的跳转显示加载、有的不显示」的双路径不一致。
 */
export function navigateToConversation(sessionId: string): boolean {
  return postMessage({
    type: openConversationModeOf(getEffectiveHostInfo()),
    sessionId,
  });
}
