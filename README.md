# <product-name>

`<product-name>` 是一个面向 VS Code 与 Electron 的 AI 助手，提供侧边栏对话、LLM 配置管理、流式响应、代码 diff 预览与桌面端集成能力。

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
- Rust（Core，见 `docs/core/standalone-core.md`）
- VS Code Extension API
- Electron + electron-builder
- React + Vite
- Tailwind CSS
- Monaco Editor
- esbuild

## 目录结构

目录布局与各路径的唯一事实在 [docs/architecture/repo-map.md](docs/architecture/repo-map.md)，此处不再重复。

## 环境要求

- Node.js 18+
- npm 9+
- Rust 工具链（构建 Core；目标矩阵见 [docs/core/standalone-core.md 第 3.1 节](docs/core/standalone-core.md#31-平台矩阵)）
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

## Core（Rust）

Core 只有 Rust 一套实现（`core-rs/`），以独立进程形态运行、经帧通道与 UI 通信。
规格见 `docs/core/standalone-core.md`。

```bash
# 构建 Core（产物落在 resources/<core.resourceDir>/<arch>-<platform>/）
# 默认构建打包要携带的全部平台（x64-win32 / arm64-win32 / x64-linux / arm64-linux）；只建当前平台用 npm run build:core:host
npm run build:core

# 独立运行（帮助 / 版本 / 远程模式）
./resources/core/x64-win32/<core.binaryName>.exe --help
./resources/core/x64-win32/<core.binaryName>.exe --version

# Rust 侧单测
cd core-rs && cargo test
```

### 远程工作区（Electron）

远程接入只有一条路径：**SSH**。在 Electron 里选「打开远程工作区...」（或标题栏加号
菜单 →「打开远程工作区」），填目标的 SSH 主机 / 端口 / 用户 / 口令即可：

- 目标机器不需要映射 daemon 端口，也不需要预装 Core——Host 按本机产物的构建指纹把
  对应平台的产物经 SFTP 部署到 `~/.local/share/<core.deployPrefix>/<指纹>/`，再用 SSH 转发通道接入；
- daemon 只监听目标机器的回环地址、端口交给内核分配，用户不需要填任何连接信息；
- 连接成功后**立刻**弹出远端目录选择器，选定目录即作为远程工作区打开。

细节见 [docs/core/core-remote.md 第 2 节](docs/core/core-remote.md#2-远程服务start--kill)。

Standalone Core 的 `start` / `kill` 仍是可用的命令行入口：`start` 确保后台 daemon 在跑
（没有就拉起）并打印就绪信息后自己退出，`kill` 结束它。不带动作直接运行可执行文件同样
按 `start` 处理。

```bash
# 在开发机上交叉编译出 Linux core（Windows / Linux 同一条命令，产物是静态 musl）
npm run build:core:linux-x64
# 把产物拷到目标机器后启动（也可由 Host 经 SSH 自动部署）
./resources/core/x64-linux/<core.binaryName> start
# [core] 远程服务已就绪，监听 127.0.0.1:<内核分配端口>（Host 经 SSH 转发接入）
```

daemon 只监听回环，访问边界就是承载它的 SSH 通道：不需要凭证、不需要端口映射，也不
需要用户填任何连接信息。再执行一次 `start` 会复用同一个 daemon；`<core.binaryName> kill`
结束它。

`npm run watch:app`（VS Code 的后台任务 / 手动运行）会在前端 watcher 之外额外轮询
`core-rs/src/**/*.rs` 与 `core-rs/Cargo.toml`：**改动时**自动跑一次 `npm run build:core:host`
（release，只重建当前平台，产物直接落 `resources/<core.resourceDir>/`）。源码没动时不会触发构建，
构建失败只打日志、不影响前端 watcher。只想改前端时用 `WATCH_CORE=0 npm run watch:app`
关掉它；要重建全平台携带目标时手动 `npm run build:core`。

### 架构图（Mermaid）

`docs/architecture/`（[overview.md](docs/architecture/overview.md) / [class-diagrams.md](docs/architecture/class-diagrams.md)）里的架构图用 Mermaid 渲染：VS Code 内置的 Markdown 预览、GitHub 等
支持 Mermaid 的渲染器都直接识别 `mermaid` 代码块，不需要装扩展、起本地服务或额外
安装 JDK。

> 助手回复里的 mermaid 代码块走的是另一条路径（webview 内「预览」按钮 → 宿主原生
> 窗口），见 `docs/features/user-stories.md`。

## 文档

- `docs/README.md` —— 文档地图：全部规格的索引与「什么内容写到哪」的分类法
- `docs/architecture/` —— 架构规格：总览、分层规则、事件词汇表、架构原则、待定事项
- `AGENTS.md` —— AI 协作约定（也适用于人类贡献者）
- `docs/adr/` —— 架构决策记录（ADR）
- 文档一致性守卫 `src/test/docsLint.test.ts`：CI 在每个 PR 上运行（`.github/workflows/docs.yml`），本地 `npm run test:all -- docs-lint`

## 打包

```bash
# 打包 VS Code 扩展
npm run package:ext

# 打包 Electron 桌面安装包
npm run package:app
```

两个脚本各自可独立跑（各自完整构建所需产物）。`npm run package` 把两者串成一次
发布：Electron 那一段复用 `package:ext` 已经构建好的 `dist/`，只追加主进程打包与
NSIS 产出，不重复跑 vite / cargo。构建链与打包前校验都在 `vscode:prepublish` 里
（`vsce` 打包时会自动执行它，见 `scripts/package-ext.mjs`）。

`npm run package:x64` 产出与 `npm run package` 同一组发布物，但按架构分发的安装器
只出 x64：Electron 安装包只出 NSIS x64（`package:app:x64`），TUI 安装器只出 x64
两平台（`package:tui:x64`）。`.vsix` 架构无关，包里携带的 Core 是远端 SSH 部署
载荷（不分本机架构），不受 x64 限定影响：

```bash
# 全量发布物，但安装器只出 x64
npm run package:x64

# 只出其中一种的 x64 版本
npm run package:app:x64
npm run package:tui:x64
```

Standalone 变体的包里要同时有全部四个平台的 core（`x64-win32` / `arm64-win32` /
`x64-linux` / `arm64-linux`）。`build:core` 默认就构建全部携带目标（Windows 上直接交叉编译
Linux 与 Windows arm64，需要 zig，见 [docs/core/standalone-core.md 第 3.3 节](docs/core/standalone-core.md#33-构建与目标平台)），无需先单独构建：

```bash
npm run package
```

打包前会校验这四个 core 产物（`scripts/verify-core-artifacts.mjs`）：缺失、比 Rust 源码旧、
或没同步进 `dist/` 都直接报错，不会把旧 core 静默打进包。

## Git LFS

`resources/` 目录下的文件使用 Git LFS 管理。提交前请确保已安装并初始化 Git LFS：

```bash
git lfs install
git lfs ls-files
```

## License

[Apache-2.0](LICENSE)
