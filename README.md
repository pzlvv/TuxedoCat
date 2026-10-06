# Tuxedo Cat

Tuxedo Cat 是一个面向 VS Code 与 Electron 的 AI 助手，提供侧边栏对话、LLM 配置管理、流式响应、代码 diff 预览与桌面端集成能力。

## 功能特性

- VS Code 侧边栏 AI 助手（Webview）
- Electron 桌面端运行模式
- 多 LLM Provider 配置与模型管理
- 流式消息处理与对话会话管理
- 代码编辑/差异预览
- Monaco Editor 集成
- Mermaid 预览、Spin Design 等辅助视图

## 技术栈

- TypeScript
- Rust（Standalone Core，见 `docs/standalone-core.md`）
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
├── core-rs/                # Standalone Core（Rust，独立进程）
├── electron/               # Electron 桌面端代码
├── resources/              # 运行时二进制资源（Git LFS）
│   ├── core/               # Standalone Core 各平台产物目录（可执行文件 + 自带的 ripgrep/）
│   └── ripgrep/            # ripgrep 各平台可执行文件（Embedded Core 用；也是上一条的来源）
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
- Rust 工具链（构建 Standalone Core；目标矩阵见 `docs/standalone-core.md` 第 4.1 节）
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
npm run test:all     # 单元测试：快，不需要 VS Code 宿主
npm test             # 宿主集成测试：需要真实 VS Code，首次会下载

# 构建 VS Code 扩展
npm run build

# 构建 Electron 桌面应用
npm run build:all
```

## Standalone Core

Core 有两种实现，由 `src/host/coreKind.ts` 的 `CORE_KIND` 装配（默认 `standalone`）：
`embedded` 为 `src/core` 的 TypeScript 实现（与 UI 同进程），`standalone` 为 `core-rs/`
的 Rust 实现（独立进程，经帧通道通信）。规格见 `docs/standalone-core.md`。

```bash
# 构建 Standalone Core（产物落在 resources/<core.resourceDir>/<arch>-<platform>/）
# 默认构建打包要携带的 Windows x64 + Linux x64；只建当前平台用 npm run build:core:host
npm run build:core

# 独立运行（帮助 / 版本 / 远程模式）
./resources/core/x64-win32/tuxedo-cat-core.exe --help
./resources/core/x64-win32/tuxedo-cat-core.exe --version

# 开发 / 测试时临时切回进程内实现
TUXEDO_CAT_CORE=embedded npm run dev:electron

# Rust 侧单测
cd core-rs && cargo test
```

### 远程工作区（Electron）

远程接入只有一条路径：**SSH**。在 Electron 里选「打开远程工作区...」（或标题栏加号
菜单 →「打开远程工作区」），填目标的 SSH 主机 / 端口 / 用户 / 口令即可：

- 目标机器不需要映射 daemon 端口，也不需要预装 Core——Host 按本机产物的构建指纹把
  对应平台的产物经 SFTP 部署到 `~/.local/bin/share/tuxedo-cat/<指纹>/`，再用 SSH 转发通道接入；
- daemon 只监听目标机器的回环地址、端口交给内核分配，用户不需要填任何连接信息；
- 连接成功后**立刻**弹出远端目录选择器，选定目录即作为远程工作区打开。

细节见 `docs/core-daemon.md` 第 12 节。

Standalone Core 的 `start` / `kill` 仍是可用的命令行入口：`start` 确保后台 daemon 在跑
（没有就拉起）并打印就绪信息后自己退出，`kill` 结束它。不带动作直接运行可执行文件同样
按 `start` 处理。

```bash
# 在开发机上交叉编译出 Linux core（Windows / Linux 同一条命令，产物是静态 musl）
npm run build:core:linux-x64
# 把产物拷到目标机器后启动（也可由 Host 经 SSH 自动部署）
./resources/core/x64-linux/tuxedo-cat-core start
# [core] 远程服务已就绪，监听 127.0.0.1:<内核分配端口>（Host 经 SSH 转发接入）
```

daemon 只监听回环，访问边界就是承载它的 SSH 通道：不需要凭证、不需要端口映射，也不
需要用户填任何连接信息。再执行一次 `start` 会复用同一个 daemon；`tuxedo-cat-core kill`
结束它。

`npm run watch:app`（VS Code 的后台任务 / 手动运行）会在前端 watcher 之外额外轮询
`core-rs/src/**/*.rs` 与 `core-rs/Cargo.toml`：**改动时**自动跑一次 `npm run build:core`
（release，产物直接落 `resources/<core.resourceDir>/`）。源码没动时不会触发构建，
构建失败只打日志、不影响前端 watcher。只想改前端时用 `WATCH_CORE=0 npm run watch:app`
关掉它，Rust 侧改动则手动 `npm run build:core` 重建。

### 架构图（Mermaid）

`DEVELOPMENT.md` 里的架构图用 Mermaid 渲染：VS Code 内置的 Markdown 预览、GitHub 等
支持 Mermaid 的渲染器都直接识别 `mermaid` 代码块，不需要装扩展、起本地服务或额外
安装 JDK。

> 助手回复里的 mermaid 代码块走的是另一条路径（webview 内「预览」按钮 → 宿主原生
> 窗口），见 `docs/user-stories.md`。

## 打包

```bash
# 打包 VS Code 扩展
npm run package:ext

# 打包 Electron 桌面安装包
npm run package:app
```

打包默认装配 Standalone Core（Rust，独立进程）。要产出 Embedded Core
（`src/core` 的 TypeScript 实现，与 UI 同进程）的变体，加 `:embedded` 后缀：

```bash
# 同时产出 embedded 的 .vsix 与 Electron 安装包
npm run package:embedded

# 只产出其中一种
npm run package:ext:embedded
npm run package:app:embedded
```

变体由构建期环境变量 `TUXEDO_CAT_CORE` 选择，产物分开落位、互不覆盖：
standalone → `release/`，embedded → `release/embedded/`。embedded 变体不构建
也不打包 Rust Core。

Standalone 变体的包里要同时有 Windows 与 Linux 两个 core，而 `build:core` 只编当前
平台，所以 Linux core 要先单独构建：

```bash
# Windows 上直接交叉编译（需要 zig，见 docs/standalone-core.md 第 4.3 节）
npm run build:core:linux-x64

npm run package
```

打包前会校验这两个 core 产物（`scripts/verify-core-artifacts.mjs`）：缺失、比 Rust 源码旧、
或没同步进 `dist/` 都直接报错，不会把旧 core 静默打进包。

## Git LFS

`resources/` 目录下的文件使用 Git LFS 管理。提交前请确保已安装并初始化 Git LFS：

```bash
git lfs install
git lfs ls-files
```

## License

[Apache-2.0](LICENSE)
