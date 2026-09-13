import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { getHostInfo } from './webviewEnv';
import { setupAppViewportHeight } from './viewport';
import './styles/index.css';
// CSS mask 图标形状表（由 scripts/gen-icons.mjs 从 lucide 生成）
import './styles/icons.css';
import 'katex/dist/katex.min.css';

// 桌面/内置服务器环境标记：由 __hostInfo 能力声明驱动。
// 用于在 CSS 层提供深色背景（如 electron-app），不影响 VS Code 扩展。
if (getHostInfo().kind === 'electron' || getHostInfo().kind === 'server') {
  document.documentElement.classList.add('electron-app');
}

// 移动端视口高度适配（地址栏显隐由 CSS dvh 处理；软键盘遮挡在此兜底）
setupAppViewportHeight();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);