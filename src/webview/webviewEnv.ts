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

import { openConversationModeOf, type HostInfo } from '../host/types';

interface VscodeApi {
  postMessage(message: unknown): void;
}

let _vscode: VscodeApi | null = null;
let _logoUri: string | null = null;
let _hasWorkspace: boolean | undefined;
let _hostInfo: HostInfo | null = null;

/**
 * 解析宿主消息通道。
 * Electron 走 window.electronAPI（preload 注入），VS Code / 浏览器 shim 走 window.vscode。
 * 两者都不存在时抛错——这是宿主集成缺失，不做静默降级。
 */
function resolveVscodeApi(): VscodeApi {
  if (_vscode) return _vscode;
  const electronApi = (window as any).electronAPI as { postMessage?: (m: unknown) => void } | undefined;
  if (electronApi?.postMessage) {
    _vscode = { postMessage: (msg: unknown) => electronApi.postMessage!(msg) };
    return _vscode;
  }
  const vscodeApi = (window as any).vscode as VscodeApi | undefined;
  if (vscodeApi?.postMessage) {
    _vscode = vscodeApi;
    return _vscode;
  }
  throw new Error(
    '宿主消息通道未就绪：既没有 window.electronAPI（Electron preload），也没有 window.vscode（VS Code / 浏览器 shim）。'
  );
}

export function getVscodeApi(): VscodeApi {
  return resolveVscodeApi();
}

export function hasVscodeApi(): boolean {
  if (_vscode) return true;
  const electronApi = (window as any).electronAPI as { postMessage?: (m: unknown) => void } | undefined;
  if (electronApi?.postMessage) return true;
  const vscodeApi = (window as any).vscode as VscodeApi | undefined;
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
  if (injected.conversationList !== 'single' && injected.conversationList !== 'multi') {
    problems.push(`conversationList=${String(injected.conversationList)}`);
  }
  if (injected.newConversation !== 'host' && injected.newConversation !== 'webview') {
    problems.push(`newConversation=${String(injected.newConversation)}`);
  }
  if (problems.length > 0) {
    throw new Error(`window.__hostInfo 字段非法或缺失：${problems.join(', ')}（见 src/host/types.ts 的 HostInfo）。`);
  }
  _hostInfo = injected as HostInfo;
  return _hostInfo;
}

export function getLogoUri(): string {
  if (_logoUri === null) {
    _logoUri = (window as any).logoUri ?? './logo.png';
  }
  return _logoUri as string;
}

/** Shared Tailwind classes for the logo image in empty/placeholder states. */
export const LOGO_CLASS_NAME = 'w-[240px] h-auto opacity-80';

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

/** Post a typed message to host (VS Code extension / Electron main), returns false if no API. */
export function postMessage(msg: unknown): boolean {
  if (!hasVscodeApi()) return false;
  getVscodeApi().postMessage(msg);
  return true;
}

/**
 * 加载/跳转到指定会话（子代理链接、From 链接、返回父会话等）。
 *
 * 打开方式由视图模式推导（见 src/host/types.ts 的 openConversationModeOf）：
 *   - 单视图（VS Code 插件）：当前 webview 内重新加载对话（loadConversation）
 *   - 多视图（Electron App）：新起一个 webview 加载对话（openConversation，由主进程创建/切换聊天视图）
 */
export function navigateToConversation(sessionId: string): boolean {
  return postMessage({
    type: openConversationModeOf(getHostInfo()),
    sessionId,
  });
}
