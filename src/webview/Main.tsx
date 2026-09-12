import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { getHostInfo } from './webviewEnv';
import './styles/index.css';
// CSS mask 图标形状表（由 scripts/gen-icons.mjs 从 lucide 生成）
import './styles/icons.css';
import 'katex/dist/katex.min.css';

// Electron 桌面环境标记：由 __hostInfo 能力声明驱动。
// 用于在 CSS 层提供 Electron 专属样式（如深色背景），不影响 VS Code 扩展。
if (getHostInfo().kind === 'electron') {
  document.documentElement.classList.add('electron-app');
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);