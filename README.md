# Tuxedo Cat

Tuxedo Cat 是一个面向 VS Code 与 Electron 的 AI 助手，提供侧边栏对话、LLM 配置管理、流式响应、代码 diff 预览与桌面端集成能力。

## 功能特性

- VS Code 侧边栏 AI 助手（Webview）
- Electron 桌面端运行模式
- 内置 HTTP 服务器：把 webview 作为前端在浏览器中访问，Electron 作为后端
- 多 LLM Provider 配置与模型管理
- 流式消息处理与对话会话管理
- 代码编辑/差异预览
- Monaco Editor 集成
- Mermaid 预览、Spin Design 等辅助视图

## 技术栈

- TypeScript
- VS Code Extension API
- Electron + electron-builder
- React + Vite
- Tailwind CSS
- Monaco Editor
- esbuild

## 目录结构

```text
.
├── assets/                 # 图标等静态资源
├── electron/               # Electron 桌面端代码
│   └── server/             # 内置 HTTP/WebSocket 服务器（浏览器访问模式）
├── resources/              # 运行时二进制资源（Git LFS）
│   └── ripgrep/            # ripgrep 各平台可执行文件
├── scripts/                # 开发/打包辅助脚本
├── src/
│   ├── config/             # 工程配置
│   ├── core/               # 核心对话/查询引擎
│   ├── host/               # UI Host 抽象
│   ├── test/               # 测试
│   ├── utils/              # 工具函数
│   ├── webview/            # VS Code Webview UI
│   └── VSCodeUI/           # VS Code UI 集成
├── .gitattributes          # Git LFS 配置
├── electron-builder.config.js
├── package.json
└── vite.config.ts
```

## 环境要求

- Node.js 18+
- npm 9+
- Git LFS（克隆后拉取 `resources/` 下的大文件）

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式（VS Code 扩展）
npm run watch

# 类型检查与 lint
npm run check-types
npm run lint

# 运行测试
npm test

# 构建 VS Code 扩展
npm run build

# 构建 Electron 桌面应用
npm run build:all
```

## 内置 HTTP 服务器（浏览器访问）

Electron 桌面端可以把自身变成一个本地 HTTP 服务器，让浏览器直接使用同一个 AI 助手界面：

1. 打开一个工作目录（File - Open Workspace Folder...）
2. 选择 File - Start Server
3. 用浏览器访问弹窗中给出的地址（默认 `http://localhost:3210/`，同一局域网内也可用其它地址访问）

实现方式：

- **前端**：服务器把 `dist/webview`（与 Electron 内嵌 webview 完全相同的构建产物）作为静态资源提供，
  并在 `index.html` 中注入浏览器版 preload（`electron/server/browserShim.ts`），
  用 WebSocket 复刻 `window.electronAPI` 的 API 表面。
- **后端**：仍然是 Electron 主进程。浏览器消息经 WebSocket 转发到
  `handleWebviewMessageFromSource()`，与原生视图走同一套 `ElectronUI` / core 处理逻辑；
  会话列表、新建/切换对话、流式输出、工具调用、设置面板等能力全部复用。
- 端口被占用时自动向后尝试（3210 起，最多 20 个）；File - Stop Server 可随时关闭服务器。
- 页面加载时会尝试调用 `Element.requestFullscreen()` 全屏显示。由于浏览器要求全屏必须由
  用户手势触发，首次调用被拒绝时会自动退化为「首次点击/按键/触摸时再请求」；按 `Esc` 可退出全屏。
  （可在宿主信息中把 `fullscreen` 设为 `false` 关闭该行为。）

### 移动端适配

手机浏览器上地址栏会随滚动自动隐藏，容易遮挡底部输入框，因此做了如下处理：

- **根容器高度用动态视口单位 `dvh`**（`100vh` 作为旧浏览器回退）。
  `100vh` 等于「地址栏隐藏后」的大视口，地址栏显示时页面底部会被遮挡；
  `dvh` 随地址栏显隐实时变化，页面高度始终等于当前可见区域，因此不会产生整页滚动。
- **`overscroll-behavior: none`**：关闭下拉刷新 / 橡皮筋效果，避免整页滚动触发地址栏自动隐藏。
- **微信内置浏览器**：微信的 X5 / XWeb 内核会按「状态栏 + 微信导航栏」高度上报
  `safe-area-inset-top`（约 88px，接近两倍标题栏），因此顶部一律不使用该值；
  同时 `html/body/#root` 显式 `margin/padding: 0 !important`，防止 WebView 自行追加安全区留白。
- **缓存自愈**：微信内核的文档缓存很激进，`Cache-Control: no-store` 和 `?v=` 查询参数都可能失效
  （它基本按路径命中缓存），只有清理微信缓存才更新。为此：
  - 服务端在 `index.html` 里内嵌 `buildId`（由 `index.html` 的 mtime + 大小算出，每次构建都变），
    WebSocket 连接建立后再下发一次服务端当前的 `buildId`；
  - 页面 shim 比对两者，不一致说明页面来自缓存，自动跳到 `/index-<buildId>.html` ——
    新路径必然 cache miss，从而拿到最新前端（放在根目录是为了让 `./assets/...` 等相对路径仍解析正确）；
  - `index.html` 响应使用 `no-store, no-cache, must-revalidate` 组合，并额外加了传统
    `<meta http-equiv="Cache-Control">` 等标签，部分 WebView 会参考它们。
  - 注意：**升级到该机制的那一次仍需手动清理一次微信缓存**（旧页面里没有这段自愈逻辑），
    之后的前端更新即可自动生效。
- **状态栏 / 地址栏配色**：`<meta name="theme-color">` 设为与 App 背景一致的深色（运行时随主题同步）。
  页面内容画不到系统预留的顶部区域（刘海、状态栏），那块由浏览器用 `theme-color` 填充，
  不设置时是白色，深色界面下顶部就会出现一条白条；刘海机型该区域更高、更明显。
- **安全区**：`viewport-fit=cover` 让全屏时页面铺满屏幕；底部输入区用
  `max(1rem, env(safe-area-inset-bottom))` 避开手势条（`max` 而非相加，普通浏览器下不会多出空白）。
  顶部刻意不加 `env(safe-area-inset-top)`：普通标签页里浏览器 UI 已占住状态栏，
  全屏时该值又会变成状态栏/挖孔高度，两种情况都会在顶部多出一条空白。
- **软键盘**：`viewport meta` 增加 `interactive-widget=resizes-content`（Chrome 108+ 让布局视口随键盘收缩）；
  iOS Safari 不支持该属性，改由 `src/webview/viewport.ts` 通过 `visualViewport` 检测键盘，
  仅在键盘弹出时把 `--app-vh` 覆盖为键盘上方的真实可见高度（桌面端 / Electron 中为空操作）。

### 多端同步规则

Electron 原生窗口与浏览器端可以同时使用同一个后端。为避免互相干扰，消息按以下规则投递：

| 行为 | 投递范围 | 实现 |
| --- | --- | --- |
| 查看文件 / 图片 / 虚拟文档 / diff / Mermaid | **只回给发起端** | 浏览器页面注入唯一 `__clientId`，请求带上它；`ChatViewManager.sendTo` 按 clientId 精确投递，不落到其它端 |
| 打开设置面板（`requestLLMConfig`） | **只回给发起端** | 同上（`showLLMConfig` 携带 clientId / sessionId） |
| 会话级设置：模型 / agent 模式 / thinking / 联网 / 提示词模式 | **同步到该会话的所有端** | 处理完成后按 sessionId 回推，其它端更新 UI |
| 主题、工作区、模型列表、对话列表、设置保存结果 | **广播到所有端** | 全局状态，不带 sessionId / clientId |

浏览器端点击文件或图片时，由服务端读取内容（图片转 data URL）后回推给发起端，
在页面内的 `PreviewOverlay` 中展示，**不会打开桌面原生窗口**。

## 打包

```bash
# 打包 VS Code 扩展
npm run package:ext

# 打包 Electron 桌面安装包
npm run package:app
```

## Git LFS

`resources/` 目录下的文件使用 Git LFS 管理。提交前请确保已安装并初始化 Git LFS：

```bash
git lfs install
git lfs ls-files
```

## License

[Apache-2.0](LICENSE)
