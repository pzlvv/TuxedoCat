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

import type { HostInfo } from '../host/types';
import { VSCODE_HOST_INFO, ELECTRON_HOST_INFO } from '../host/types';

interface VscodeApi {
  postMessage(message: unknown): void;
}

let _vscode: VscodeApi | null = null;
let _logoUri: string | null = null;
let _hasWorkspace: boolean | undefined;
let _hostInfo: HostInfo | null = null;

/**
 * Lazily resolve host API handle. Electron 优先走 window.electronAPI，
 * VS Code 走 window.vscode（acquireVsCodeApi），standalone / dev 构建可能回退。
 */
export function getVscodeApi(): VscodeApi {
  if (!_vscode) {
    const electronApi = (window as any).electronAPI as { postMessage?: (m: unknown) => void } | undefined;
    if (electronApi?.postMessage) {
      _vscode = { postMessage: (msg: unknown) => electronApi.postMessage!(msg) };
    } else {
      _vscode = (window as any).vscode as VscodeApi ?? null;
    }
  }
  if (!_vscode) {
    throw new Error('Host API not available');
  }
  return _vscode;
}

export function hasVscodeApi(): boolean {
  if (!_vscode) {
    const electronApi = (window as any).electronAPI as { postMessage?: (m: unknown) => void } | undefined;
    if (electronApi?.postMessage) {
      _vscode = { postMessage: (msg: unknown) => electronApi.postMessage!(msg) };
    } else {
      _vscode = (window as any).vscode as VscodeApi ?? null;
    }
  }
  return !!_vscode;
}

/**
 * 获取宿主能力声明（由各宿主注入 window.__hostInfo）。
 * 未注入时（dev / standalone 构建）按 electronAPI 存在性回退推断，保持向后兼容。
 */
export function getHostInfo(): HostInfo {
  if (!_hostInfo) {
    const injected = (window as any).__hostInfo as HostInfo | undefined;
    if (injected && (injected.kind === 'vscode' || injected.kind === 'electron')) {
      _hostInfo = injected;
    } else if ((window as any).electronAPI) {
      _hostInfo = ELECTRON_HOST_INFO;
    } else {
      _hostInfo = VSCODE_HOST_INFO;
    }
  }
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
 * 打开方式由宿主能力声明决定：
 *   - VS Code 插件：当前 webview 内重新加载对话（loadConversation）
 *   - Electron App：新起一个 webview 加载对话（openConversation，由主进程创建/切换聊天视图）
 */
export function navigateToConversation(sessionId: string): boolean {
  return postMessage({
    type: getHostInfo().openConversationMode,
    sessionId,
  });
}
