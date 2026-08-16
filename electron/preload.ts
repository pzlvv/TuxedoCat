/**
 * Electron preload - 通过 contextBridge 向 webview 暴露宿主 API
 *
 * 桥接策略：
 * 1. window.electronAPI.postMessage  -> ipcRenderer.send('webview-message')（webview -> main）
 * 2. ipcRenderer.on('webview-message') -> window.postMessage(msg, '*')（main -> webview）
 *    现有 webview 代码全部通过 window.addEventListener('message') 收消息，此桥接使其零改动
 * 3. 注入与 VS Code 扩展 HTML 注入一致的全局变量（logoUri / __hasWorkspace / __vscodeLocale / __systemLocale）
 */

import { contextBridge, ipcRenderer } from 'electron';

// 收集启动参数（由 main 在创建窗口前通过 additionalArguments 传入）
const getStartArg = (key: string): string | undefined => {
  const prefix = `--${key}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
};

const workspacePath = getStartArg('workspace') || '';
const vscodeLocale = getStartArg('locale') || 'en';
const systemLocale = getStartArg('systemLocale') || 'en';
const uiLanguage = getStartArg('uiLanguage') || 'auto';
const sessionId = getStartArg('session') || '';

// 暴露给 webview 的 API
contextBridge.exposeInMainWorld('electronAPI', {
  /** webview -> main：发送消息（与 VS Code acquireVsCodeApi().postMessage 形状一致） */
  postMessage: (message: unknown): void => {
    ipcRenderer.send('webview-message', message);
  },
  /** main -> webview：注册接收回调 */
  onMessage: (callback: (message: unknown) => void): void => {
    ipcRenderer.on('webview-message', (_event, message) => callback(message));
  },
  /** 获取当前工作区路径（用于 webview 启动时展示） */
  getWorkspacePath: (): string => workspacePath,
  /** 获取当前会话 ID（由侧栏点击传入，用于加载指定对话） */
  getSessionId: (): string => sessionId,
});

// 注入与 VS Code 扩展一致的全局变量（webviewEnv.ts / i18n 依赖）
contextBridge.exposeInMainWorld('__hasWorkspace', workspacePath.length > 0);
contextBridge.exposeInMainWorld('__vscodeLocale', vscodeLocale);
contextBridge.exposeInMainWorld('__systemLocale', systemLocale);
contextBridge.exposeInMainWorld('__uiLocale', uiLanguage);
contextBridge.exposeInMainWorld('logoUri', './logo.png');
contextBridge.exposeInMainWorld('__sessionId', sessionId);
// 宿主能力声明：对话列表/新建对话由原生侧栏接管，支持关闭 webview，打开会话走 openConversation
contextBridge.exposeInMainWorld('__hostInfo', {
  kind: 'electron',
  conversationList: 'host',
  newConversation: 'host',
  closeConversation: true,
  openConversationMode: 'openConversation',
});

// main -> webview 消息桥接：ipcRenderer 事件转发为 window message 事件
// 注意：必须在页面脚本执行前注册，webview 挂载时立即监听 window message
ipcRenderer.on('webview-message', (_event, message) => {
  window.postMessage(message, '*');
});
