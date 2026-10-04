import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider } from 'antd';
import App from './App';
import { getInjectedSessionId } from './webviewEnv';
import { rotatePlaceholderLogo } from './placeholderLogo';
import { setupAppViewportHeight } from './viewport';
import { applyUiFontOffset } from './fontSize';
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

// 界面字号档位：把宿主注入的 `__uiFontSize` 写成根元素 CSS 变量，首帧即按档位渲染
applyUiFontOffset();

// 空状态背景图轮换：没有绑定会话的视图启动后就是「新对话」，先换一张（不与上次重复）。
// 放在渲染前是为了首帧就画对，避免先画出上一张再跳变；单视图宿主内点「+」新建由 App 负责
// （多视图宿主由宿主另开视图，新视图在这里轮换）。
if (!getInjectedSessionId()) {
  rotatePlaceholderLogo();
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* 全局把 antd 动效压到 0.01s：Dropdown 及其子菜单浮层的打开动画都消费
        motionDurationMid（默认 0.2s），是「菜单点击到可见」感知延迟的大头；
        antd 动效只做过渡、不承载信息，压短不影响可用性。
        不能设为 0s：rc-motion 靠 transitionend 判定动效结束，零时长过渡浏览器
        不触发该事件且 antd 无 motionDeadline 兜底，浮层关闭 / 卸载会卡住；
        0.01s 能真实触发事件，视觉上与 0 无差别。
        ToggleMenu 内的嵌套 ConfigProvider 会继承这里的 token（antd 主题浅合并）。 */}
    <ConfigProvider theme={{ token: { motionDurationMid: '0.01s' } }}>
      <App />
    </ConfigProvider>
  </React.StrictMode>
);