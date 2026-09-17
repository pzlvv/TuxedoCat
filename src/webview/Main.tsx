import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { getHostInfo } from './webviewEnv';
import { setupAppViewportHeight } from './viewport';
import './styles/index.css';
// CSS mask 图标形状表（由 scripts/gen-icons.mjs 从 lucide 生成）
import './styles/icons.css';
import 'katex/dist/katex.min.css';

// 独立窗口标记：多视图宿主（Electron / 浏览器端）不继承 VS Code 主题，
// 需在 CSS 层提供深色背景兜底（避免 BrowserWindow 白闪）；单视图（VS Code 扩展）不加。
if (getHostInfo().conversationList === 'multi') {
  document.documentElement.classList.add('standalone-host');
}

// 移动端视口高度适配（地址栏显隐由 CSS dvh 处理；软键盘遮挡在此兜底）
setupAppViewportHeight();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);