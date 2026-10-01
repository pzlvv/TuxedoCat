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

Standalone Core 用 `start` 动作启动远程服务：它确保后台 daemon 在跑（没有就拉起），
打印连接串（`<IP>:<端口>#<token>`）后自己退出，桌面端整行粘贴即可直连
（`docs/core-daemon.md` 第 12 节）。不带动作直接运行可执行文件同样按 `start` 处理。

```bash
# 在开发机上交叉编译出 Linux core（Windows / Linux 同一条命令，产物是静态 musl）
npm run build:core:linux-x64
# 把产物拷到目标机器后启动
./resources/core/x64-linux/tuxedo-cat-core start
# [core] 远程服务已就绪，在桌面端「打开远程工作区」粘贴下面任一连接串：
# 172.20.1.5:10975#<32 位十六进制>
# 127.0.0.1:10975#<32 位十六进制>
```

`start` 默认绑 `0.0.0.0:10975`（全部网卡）；端口被占用时从该端口起逐个 +1 重试，
连接串里给的是实际端口。绑定通配地址时按网卡逐个打一条连接串，末尾固定有一条回环。
token 用 `--token` 指定；缺省时优先复用 `~/<configDir>/core-daemon.token` 里的，没有才用
操作系统安全随机数生成。token 单独存一份文件（与会话数据同目录），所以 `kill` 掉 daemon 再
`start` 还是同一个 token，不用重新抄连接串。只在本机自测时传 `--host 127.0.0.1`。
再执行一次 `start` 会复用同一个 daemon，打印同一份连接串；`tuxedo-cat-core kill` 结束它。

在 Electron 里选「打开远程工作区...」（或标题栏加号菜单 →「打开远程工作区」），
把上面任意一条连接串整行粘进唯一的输入框：连接成功后**立刻**弹出远端目录选择器，
选定目录即作为远程工作区打开。token 只用于本次连接，不写入本地状态文件。

WSL 端到端验证（用交叉编译出的 Linux core，在 WSL 里启动服务、从 Windows 连上去鉴权并列目录）：

```bash
node scripts/verify-remote-wsl.mjs
```

`npm run watch:app`（VS Code 的后台任务 / 手动运行）会在前端 watcher 之外额外轮询
`core-rs/src/**/*.rs` 与 `core-rs/Cargo.toml`：**改动时**自动跑一次 `npm run build:core`
（release，产物直接落 `resources/<core.resourceDir>/`）。源码没动时不会触发构建，
构建失败只打日志、不影响前端 watcher。只想改前端时用 `WATCH_CORE=0 npm run watch:app`
关掉它，Rust 侧改动则手动 `npm run build:core` 重建。

### PlantUML 架构图

`DEVELOPMENT.md` 里的架构图用 PlantUML 渲染，两种场景走的是**不同**的渲染路径：

- **编辑 `.puml` 文件**：用扩展自带的本地渲染（`.vscode/settings.json` 中 `plantuml.render: Local`）。
  只需要 JDK，不需要装 Graphviz（jar 内置 vizjs / Smetana）。
- **Markdown 预览**：PlantUML 扩展的 markdown-it 插件**只支持 HTTP 服务器渲染**，会忽略
  `plantuml.render`，`plantuml.server` 为空时报错
  `No PlantUML server, specify one with "plantuml.server".`。

因此 `.vscode/settings.json` 把 `plantuml.server` 指向 `http://127.0.0.1:8090`，
该服务由 `npm run plantuml:server` 启动——用扩展自带的 `plantuml.jar` 起 PicoWeb，
只监听回环地址，架构图源码不会发往公网。`.vscode/tasks.json` 已把它配置成
打开文件夹时自动启动（后台任务，端口上已有服务则直接复用）。

> **首次查看需要一步手动设置**：VS Code 内置 Markdown 预览默认是 Strict 安全级别，
> 会拦截 `http://` 图片，预览顶部会出现「Some content has been disabled in this document」。
> 点击预览右上角的盾牌图标（或命令面板执行 *Markdown: Change Preview Security Settings*），
> 选择 **Allow insecure local content** 即可。该选择按工作区持久化，只需设置一次。
>
> 另外首次打开文件夹时 VS Code 会弹一次「Allow Automatic Tasks in Folder」，需要点允许，
> 否则 `plantuml:server` 不会自动启动——此时手动执行 `npm run plantuml:server` 也一样。
> 端口可用 `PLANTUML_PORT` 环境变量调整（需同步修改 `plantuml.server`）；
> 若不想自动启动，删掉 `tasks.json` 里 `plantuml:server` 任务的 `runOptions` 即可。

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
