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
import { ELECTRON_HOST_INFO, hostInfoForViewMode } from '../src/host/types.js';

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
// 后台预热的「新对话」视图：页面照常加载，但跳过启动初始化（不生成 session、
// 不申请主题/模型等），等被切到前台时由宿主发 activatePrewarmedView 触发。
// 详见 electron/ChatViewManager.ts 的 spareKey。
const prewarm = getStartArg('prewarm') === '1';
// 视图模式：悬浮窗（单视图）为 single，完整模式（原生侧栏）为 multi
const viewMode = getStartArg('viewMode') || 'multi';
// Shiki 语法高亮按需加载：上次使用过的语言列表（逗号分隔），webview 启动后后台预热
const highlightLanguages = (getStartArg('highlightLanguages') || '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

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
contextBridge.exposeInMainWorld('__highlightLanguages', highlightLanguages);
// 空状态背景图的第一张；webview 只取它所在目录，再拼候选文件名（见 placeholderLogo.ts）
contextBridge.exposeInMainWorld('logoUri', './logo1.png');
contextBridge.exposeInMainWorld('__sessionId', sessionId);
// 是否为后台预热视图（见 ChatViewManager.spareKey）：webview 据此跳过启动初始化
contextBridge.exposeInMainWorld('__prewarm', prewarm);
// 宿主能力声明：对话列表/新建对话由原生侧栏接管，支持关闭 webview，打开会话走 openConversation。
// 悬浮窗（单视图）模式下侧栏被隐藏，能力声明随之推导为 single：列表移到 webview 顶栏、
// 隐藏关闭按钮、新建入口也在顶栏（运行期切换由 setConversationListMode 消息补齐）。
contextBridge.exposeInMainWorld(
  '__hostInfo',
  hostInfoForViewMode(ELECTRON_HOST_INFO, viewMode === 'single' ? 'single' : 'multi'),
);

// main -> webview 消息桥接：ipcRenderer 事件转发为 window message 事件
// 注意：必须在页面脚本执行前注册，webview 挂载时立即监听 window message
ipcRenderer.on('webview-message', (_event, message) => {
  window.postMessage(message, '*');
});
