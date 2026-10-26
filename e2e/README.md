# e2e 场景级测试（Playwright）

以真实用户操作（输入、点击、悬停、快捷键）驱动的场景级端到端测试，需求基线是
`docs/features/user-stories.md`（每条用例标题标注覆盖的 `US-xx`，`US ↔ 用例` 映射与
未覆盖豁免段见该文件的附录）。六个 project 对应五层（`electron-app` 与 `electron-ssh`
同属整应用层：后者要外部 SSH 环境，拆开是为了让没有远端机器的开发机与 CI 车道各自独立跑）：

| project | 层级 | 驱动对象 | 宿主侧 |
| --- | --- | --- | --- |
| `webview-ui` | webview UI | Chromium 加载构建产物 `dist/webview/index.html` | 假宿主（`helpers/fakeHost.ts`）按 `src/host/webviewMessages.ts` 协议应答 |
| `electron-app` | 整应用 | 真实 Electron 应用（`dist-electron/main.cjs`） | **standalone core**（Rust，`dist/resources/core/`，先 `npm run build:core`）+ 本地 mock LLM SSE 服务器（`helpers/mockLlmServer.ts`） |
| `electron-ssh` | 整应用（真实 SSH 远端） | 同上，工作区为 `ssh://` 远端（`e2e/environments.json` 的 ssh 段） | 远端机器上的 standalone core：SSH 建链 → 上传 Core / ripgrep → 远端 daemon 引导（`docs/core/core-remote.md`） |
| `remote-workspace-ui` | 远端目录选择器页面 | Chromium 加载构建产物 `dist/remoteWorkspace/index.html`（`electron/remoteWorkspace/`） | 假 `window.remoteWorkspaceAPI`（内存目录树）：这一步要连真实 SSH 才走得到，整应用 e2e 覆盖不了 |
| `terminal-ui` | 远程终端页面 | Chromium 加载构建产物 `dist/terminal/index.html`（`electron/terminal/`） | 假 `window.terminalAPI`（内存标签表 + 回显 shell）：同上，真实链路要连 SSH |
| `tui-installer` | TUI 分发 | TUI 版安装程序（`release/tui-installer/`，用例内构建宿主平台） | 内嵌 Core / ripgrep / TUI bundle 的自解压安装与启动（`docs/features/tui-installer.md`） |

## 运行

前置：构建产物必须存在（配置文件加载时校验并给出提示）。

```bash
# 首次：构建被测产物 + 安装浏览器
npm run build:webview && npm run copy-assets && npm run build:electron
npx playwright install chromium            # 网络受限时：PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright/

npm run test:e2e            # 全部（六个 project，串行，workers=1）
npm run test:e2e:webview    # 仅 webview UI 级
npm run test:e2e:electron   # 仅 Electron 整应用（不需要 SSH 环境）
npm run test:e2e:ssh        # 仅真实 SSH 远端车道（需要 e2e/environments.json）
npm run test:e2e:remoteWorkspace   # 仅远端目录选择器页面
npm run test:e2e:terminal   # 仅远程终端页面
npm run test:e2e:tui        # 仅 TUI 安装程序
```

Electron 用例不需要 Playwright 的 Chromium，用项目自带的 `node_modules/electron`。

排查：`E2E_DEBUG=1 npm run test:e2e:electron` 会把应用主进程日志透传到测试输出；
失败时 Playwright 输出 trace（`npx playwright show-trace <zip>`）。

## CI 车道（`.github/workflows/e2e.yml`）

`prepare` job 构建一次产物（7 个前端产物 + 宿主平台 Core + Electron 主进程），并跑
`npm run check-types:e2e`；三个车道并行下载产物后各跑一层：

| job | project | 车道额外前置 |
| --- | --- | --- |
| `ui` | `webview-ui` / `remote-workspace-ui` / `terminal-ui` | `npx playwright install --with-deps chromium` |
| `electron` | `electron-app` | xvfb + openbox（Linux 无显示；裸 X 没有窗口管理器）+ Chromium 运行时库（`playwright install-deps`）+ artifact 下载后补可执行位（已知坑 6） |
| `tui` | `tui-installer` | rust + musl 工具链（用例内 cargo 构建安装器） |

失败时每个车道把 test-results/ 作为 artifact 上传（`npx playwright show-trace <zip>`）。
`electron-app` 与 `electron-ssh` 是两个 project：前者不碰外部环境，CI 与开发机都能直接跑；
后者缺 `environments.json` 时在收集期报错（无效直接报错，不做兜底）。

`electron-ssh` **不进 CI**：它要求一台可连的真实远端机器，runner 内临时起的 sshd 与真实
远端在服务配置 / 网络 / 权限模型上差异太大，判定为本地车道——本地跑
`npm run test:e2e:ssh`（前置见下节）。要接回 CI 时，在 `.github/workflows/e2e.yml` 里加回
job 并同步本表。

## 测试环境配置（environments.json）

依赖真实外部环境（当前：真实 SSH 远端，`e2e/electron/remoteSshExecution.spec.ts`）的用例
从 `e2e/environments.json` 读取环境信息；该文件**不入库**（gitignore，内容含 SSH 凭证）。
首次使用：复制 `e2e/environments.example.json` 为同目录的 `e2e/environments.json` 并填入
本机可用的环境。各段字段与含义以 `e2e/helpers/testEnvironment.ts` 的类型与校验为准。

有效性判断分三层，**无效直接报错，不做任何修复**（不补默认值、不从 example 兜底、
不换凭证重试、不清远端状态）——与产品代码同一原则
（[不过度 fallback](../docs/architecture/principles.md)）：

| 层 | 时机 | 覆盖 | 无效时的表现 |
| --- | --- | --- | --- |
| 产物层 | 配置加载期（`assertArtifact`） | 全部用例 | 缺构建产物 / Core 二进制即整车道报错，附构建命令 |
| 配置层 | 配置加载期（`assertEnvironmentFileIfPresent`） + 用例文件加载期（`require*`） | 文件存在但形状非法 → 全部用例；依赖的段缺失 / 字段非法 → 该文件用例 | 收集期即失败，错误列出全部问题与复制指引 |
| 连通层 | 依赖外部环境的用例的 `beforeEach` | 该用例 | 用例开头探测（SSH `uname -sm`），失效立即失败并指明恢复责任在使用者 |

报错信息只描述「缺什么、去哪补」，环境本身永远由使用者恢复；用例不做任何修复动作
（测试内的清场与场景预置是 arrange，不是修复）。

## 结构

```
e2e/
├── playwright.config.ts        # 六个 project，串行执行（workers=1）
├── helpers/
│   ├── fakeHost.ts             # webview 级假宿主：注入 window.vscode / __hostInfo 等全局，
│   │                           # 自动应答启动序列，sendMessage 播放脚本化流式轮次
│   ├── webviewHarness.ts       # 静态伺服 dist/webview + 页面装配（clipboard 权限等）
│   ├── mockLlmServer.ts        # OpenAI Chat Completions 兼容 SSE 服务器：
│   │                           #   写入文件 <名> → Write 工具轮；执行命令 <cmd> → Bash 工具轮；
│   │                           #   慢速回答 → 慢速流（中止场景）；无响应 → 不回响应头（静默挂住）；
│   │                           #   其余 → 文本终轮
│   └── electronApp.ts          # Electron 启动器：沙箱隔离 + CDP 直连 + 活动视图解析
├── webview/                    # webview UI 级场景用例（覆盖的 US 见 user-stories 附录）
├── electron/                   # Electron 整应用场景用例（同上）
├── remoteWorkspace/            # 远端目录选择器页面（路径框编辑 / 选中项 / Tab 补全 / 焦点常驻）
├── terminal/                   # 远程终端页面（标签 / 断开态与重连 / 主题跟随 / 复制粘贴）
└── tui/                        # TUI 安装程序 e2e（构建 / 自解压 / 载荷可执行 / 启动守卫，docs/features/tui-installer.md）
```

## 隔离策略（electron-app）

- `USERPROFILE` / `HOME` / `APPDATA` / `XDG_CONFIG_HOME` 指向临时目录：`~/<configDir>/`
  （settings.json、会话落盘）与 Electron userData（workspace-state.json）全部进沙箱，
  用例结束删除。Electron 的 appData 按平台解析：Windows 读 `%APPDATA%`，Linux 走
  `$XDG_CONFIG_HOME` 或 `~/.config`（不认 APPDATA，见已知坑 7）——启动器按平台选
  同一基目录（`electronApp.ts` 的 `roamingDir`），预置与断言才和应用读写同一份状态。
- settings.json 预写 mock provider（manual 询问模式让写操作弹权限确认），
  LLM 指向本地 mock SSE 服务器，全程无外网请求。
- Core 为 Rust 独立进程（standalone，产品唯一形态），多 Connection / daemon / SSH 链路与
  产品一致；前置 `npm run build:core`。
- `--multi-instance=<id>` 跳过单实例锁；实例后缀会被 main.ts 截断到 32 字符，
  预置 workspace-state.json 时必须用同样的短 id 规则。
- `DISABLE_TRAY_SOUND=1`：关掉「任务结束」的托盘提醒音（`electron/trayAttentionSound.ts`
  的 `TRAY_SOUND_DISABLE_ENV`，启动器与宿主共用同一常量）。用例在开发机上跑完整链路，
  会话结束同样触发提醒——不出声免得与开发机上真实运行的应用撞在一起。托盘闪烁照旧。

## 已知坑（实证结论）

1. **Playwright 连接 Electron 的两个前提**（`_electron.launch` 与裸 CDP 均适用）：
   - 应用主窗口从不 `loadURL`（视图全挂 contentView），其 webContents 没有渲染进程，
     对该 target 的 CDP 命令永不响应，会让 Playwright 页面初始化无限挂起。启动器经
     Node inspector（`--inspect=0`）在主进程执行 `loadURL('about:blank')` 拉起渲染器。
   - `--inspect=0` / `--remote-debugging-port=0` / `--remote-allow-origins=*` 必须放在
     入口文件之前。
2. **多视图宿主的活动视图解析**：标题栏 / 侧栏 / 每会话聊天视图都是 WebContentsView，
   在 CDP 目标列表里同为 page target；且 Electron 对未挂载视图仍报告
   `visibilityState=visible`、`hasFocus()=true`，两者都不能判别活动视图。启动器用
   「视图绑定工作区（`electronAPI.getWorkspacePath()`）+ 视图自身会话
   （`window.__currentSessionId`）+ 侧栏列表」组合解析。
3. **antd 菜单项整项 disabled**：功能菜单 / 模型子菜单的条目刻意 `disabled: true`
   （交互交给内部控件），Playwright 的可点击性检查会拒绝，需要 `click({ force: true })`。
4. **会话条目操作按钮 hover 才显示**（纯 CSS `group-hover`）：悬停要用条目根
   （`.group`），且同名按钮在每条根会话上都存在，定位必须按行作用域化。
5. **全局快捷键会被泄漏实例占用**：用例中断（Ctrl+C / 超时强杀）跳过 afterEach 时，
   上一轮的 Electron 实例可能残留并持有全局热键，新实例启动注册静默失败（现会落
   日志）。US-34 预置独占组合键（`Ctrl+Alt+8`）断言，不依赖默认 `Ctrl+Alt+X` 是否
   空闲；跑套件前可用 `tasklist | findstr "Tuxedo"` 检查残留实例。
6. **CI 的 artifact 不保留可执行位**：`actions/upload-artifact` 的 zip 把所有文件落成
   644（官方 Limitations「Permission Loss」）。electron 车道下载后必须
   `chmod -R u+x dist/resources/core resources/core`，否则宿主 spawn Core 直接 EACCES，
   `CoreProcess` 按重启策略试满 5 次后 fatal——凡过 core 的用例全部超时，纯宿主 / UI
   用例照常通过（首次 CI 实证的失败面）。
7. **Linux 上 Electron 的 appData 不认 `APPDATA`**：Windows 读 `%APPDATA%` 环境变量，
   Linux 走 `$XDG_CONFIG_HOME` 或 `~/.config`。沙箱只把 workspace-state.json 预置到
   `AppData/Roaming` 时，Linux 上应用读不到——打开集合恢复 / 快捷键 / 最近 SSH 等
   预置全部静默失效，落盘断言读到 ENOENT。启动器按平台选基目录并显式钉住
   `XDG_CONFIG_HOME`（`electronApp.ts`）。
8. **裸 Xvfb 没有窗口管理器**：`win.maximize()` / `isMaximized()` 这类窗口管理语义在
   只有显示没有 WM 的 X 里不成立（`_NET_WM_STATE` 无人响应）。electron 车道在
   `xvfb-run` 里先拉起 openbox 再跑用例。
