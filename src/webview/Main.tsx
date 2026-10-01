import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { getInjectedSessionId } from './webviewEnv';
import { rotatePlaceholderLogo } from './placeholderLogo';
import { setupAppViewportHeight } from './viewport';
import './styles/index.css';
// CSS mask 图标形状表（由 scripts/gen-icons.mjs 从 lucide 生成）
import './styles/icons.css';
import 'katex/dist/katex.min.css';

// 独立窗口标记：独立宿主（Electron / 浏览器端）不继承 VS Code 主题，
// 需在 CSS 层提供深色背景兜底（避免 BrowserWindow 白闪）；VS Code 扩展内不加。
//
// 判定必须用「宿主类型」而不是对话列表渲染方：Electron 悬浮窗注入的 conversationListOwner
// 是 webview（运行期能力），但它仍然是独立窗口，一样需要深色兜底。这里用 Electron preload
// 注入的 electronAPI 作为判据（VS Code 走 acquireVsCodeApi，没有这个对象）。
if (typeof (window as { electronAPI?: unknown }).electronAPI !== 'undefined') {
  document.documentElement.classList.add('standalone-host');
  // 浅色主题下的首帧兜底背景：宿主注入 __initialTheme（跟随 nativeTheme）。
  // 权威主题仍由 setTheme 消息驱动，这里只保证加载期不闪深色。
  if ((window as { __initialTheme?: unknown }).__initialTheme === 'light') {
    document.documentElement.classList.add('theme-light');
  }
}

// 移动端视口高度适配（地址栏显隐由 CSS dvh 处理；软键盘遮挡在此兜底）
setupAppViewportHeight();

// 空状态背景图轮换：没有绑定会话的视图启动后就是「新对话」，先换一张（不与上次重复）。
// 放在渲染前是为了首帧就画对，避免先画出上一张再跳变；单视图内点「+」新建由 App 负责。
if (!getInjectedSessionId()) {
  rotatePlaceholderLogo();
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);