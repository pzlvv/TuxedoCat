# e2e 场景级测试（Playwright）

以真实用户操作（输入、点击、悬停、快捷键）驱动的场景级端到端测试，需求基线是
`docs/features/user-stories.md`（每条用例标题标注覆盖的 `US-xx`，`US ↔ 用例` 映射与
未覆盖豁免段见该文件的附录）。七个 project 对应六层（`electron-app` 与 `electron-ssh`
同属整应用层：后者要外部 SSH 环境，拆开是为了让没有远端机器的开发机与 CI 车道各自独立跑；
`pycharm-plugin` 为本地车道，见下表末行）：

| project | 层级 | 驱动对象 | 宿主侧 |
| --- | --- | --- | --- |
| `webview-ui` | webview UI | Chromium 加载构建产物 `dist/webview/index.html` | 假宿主（`helpers/fakeHost.ts`）按 `src/host/webviewMessages.ts` 协议应答 |
| `electron-app` | 整应用 | 真实 Electron 应用（`dist-electron/main.cjs`） | **standalone core**（Rust，`dist/resources/core/`，先 `npm run build:core`）+ 本地 mock LLM SSE 服务器（`helpers/mockLlmServer.ts`） |
| `electron-ssh` | 整应用（真实 SSH 远端） | 同上，工作区为 `ssh://` 远端（`e2e/environments.json` 的 ssh 段） | 远端机器上的 standalone core：SSH 建链 → 上传 Core / ripgrep → 远端 daemon 引导（`docs/core/core-remote.md`） |
| `remote-workspace-ui` | 远端目录选择器页面 | Chromium 加载构建产物 `dist/remoteWorkspace/index.html`（`electron/remoteWorkspace/`） | 假 `window.remoteWorkspaceAPI`（内存目录树）：这一步要连真实 SSH 才走得到，整应用 e2e 覆盖不了 |
| `terminal-ui` | 远程终端页面 | Chromium 加载构建产物 `dist/terminal/index.html`（`electron/terminal/`） | 假 `window.terminalAPI`（内存标签表 + 回显 shell）：同上，真实链路要连 SSH |
| `tui-installer` | TUI 分发 | TUI 版安装程序（`release/tui-installer/`，用例内构建宿主平台） | 内嵌 Core / ripgrep / TUI bundle 的自解压安装与启动（`docs/features/tui-installer.md`） |
| `pycharm-plugin` | PyCharm 插件分发 + IDE 内链路 | 分发 zip 结构核验（无 IDE）；本机 PyCharm 沙箱化拉起，JCEF 面板经 CDP 驱动 | 插件自带 standalone core（zip 内四平台产物）+ 本地 mock LLM（`helpers/pycharmIde.ts`） |

## 运行

前置：构建产物必须存在（配置文件加载时校验并给出提示）。

```bash
# 首次：构建被测产物 + 安装浏览器
npm run build:webview && npm run copy-assets && npm run build:electron
npx playwright install chromium            # 网络受限时：PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright/

npm run test:e2e            # 全部（六个 project，串行，workers=1）
npm run test:e2e:local      # 除真实 SSH 远端外的五个 project（= CI 三车道同集，test:all 收的就是它）
npm run test:e2e:webview    # 仅 webview UI 级
npm run test:e2e:electron   # 仅 Electron 整应用（不需要 SSH 环境）
npm run test:e2e:ssh        # 仅真实 SSH 远端车道（需要 e2e/environments.json）
npm run test:e2e:pycharm    # 仅 PyCharm 插件车道（本地车道：需要 e2e/environments.json 的 pycharm 段 + npm run package:pycharm 产物）
npm run test:e2e:remoteWorkspace   # 仅远端目录选择器页面
npm run test:e2e:terminal   # 仅远程终端页面
npm run test:e2e:tui        # 仅 TUI 安装程序

# 真实 SSH 车道的单文件跑法（远端是 Linux 时本机必须携带对应 Core 产物）
npm run build:core:linux-x64
npx playwright test -c e2e/playwright.config.ts --project=electron-ssh remoteChangeList
```

Electron 用例不需要 Playwright 的 Chromium，用项目自带的 `node_modules/electron`。

Windows 上若 Smart App Control 处于评估 / 开启态，tui-installer 车道会被本机安全策略
拦下刚构建的无签名安装器（spawn EACCES）：车道按环境前置显式跳过并单列原因，
在 CI 与不受影响的机器上照常真跑。

排查：`E2E_DEBUG=1 npm run test:e2e:electron` 会把应用主进程日志透传到测试输出；
失败时 Playwright 输出 trace（`npx playwright show-trace <zip>`）。

## CI 车道（`.github/workflows/all.yml`）

e2e 在全量回归工作流 `all.yml` 里跑：合入 main 后整点定时（每小时）+ 手动 dispatch。
MR 的合入闸门是冒烟工作流 `smoke.yml`（文档守卫 + 编译类检查 + 单测 + Rust 测试 +
`check-types:e2e`，不含 e2e 用例；`all.yml` 直接复用它的两个 job）。`prepare` job 构建
一次产物（7 个前端产物 + 宿主平台 Core + Electron 主进程），三个车道并行下载产物后
各跑一层：

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
`npm run test:e2e:ssh`（前置见下节）。要接回 CI 时，在 `.github/workflows/all.yml` 里加回
job 并同步本表。

`pycharm-plugin` 同为**本地车道**：要本机 PyCharm（`environments.json` 的 `pycharm` 段，
至少 `idePath`）与 `npm run package:pycharm` 产出的分发 zip，runner 两者皆无。前置：
JDK 25（2026.2 平台类文件为 Java 25；构建脚本按 PYCHARM_JDK25 / local.properties /
常见安装位探测）。要接回 CI 时，在 `.github/workflows/all.yml` 里加回 job 并同步本表。

## 测试环境配置（environments.json）

依赖真实外部环境（当前：真实 SSH 远端，`e2e/electron/remoteSshExecution.spec.ts` /
`remoteTaskSurvival.spec.ts` / `remoteChangeList.spec.ts`）的用例从 `e2e/environments.json`
读取环境信息；该文件**不入库**（gitignore，内容含 SSH 凭证）。
首次使用：复制 `e2e/environments.example.json` 为同目录的 `e2e/environments.json` 并填入
本机可用的环境。各段字段与含义以 `e2e/helpers/testEnvironment.ts` 的类型与校验为准。

`electron-ssh` 车道的用例文件名单只有一份（`e2e/playwright.config.ts` 的
`REMOTE_SSH_SPECS`）：`electron-app` 用它做 `testIgnore`、`electron-ssh` 用做
`testMatch`。新增一条真实 SSH 用例时改这一处即可——只改其中一侧的后果是「新用例在
没有远端机器的机器上被收集」或「新用例永远不跑」。

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
├── electron/                   # Electron 整应用场景用例（同上）；remoteSshExecution /
│                               #   remoteTaskSurvival / remoteChangeList 三条跑真实 SSH 远端
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
9. **侧栏文件分区的标题是折叠开关，不是「打开分区」**：`#filesHeader` 点一次展开、再点
   一次收起；收起后分段 switch（`#filesModeSwitch`）整体隐藏，等它可见会一直等不到。
   助手要按 `#filesSection` 的 `expanded` class 判断当前状态再决定点不点
   （`e2e/electron/fileExplorer.spec.ts` / `remoteChangeList.spec.ts` 的展开助手）。
10. **真实 SSH 远端的建链有瞬时失败**：实测一台 Ubuntu 24.04 上的 OpenSSH 在 30 次
    连续建链里约 1 次直接断开（ssh2 报 `read ECONNRESET` 或 `Timed out while waiting
    for handshake`，同机 `ssh` 命令行也复现），失败也可能落在 `ready` 之后、exec 通道
    打开之前。用例脚手架（`remoteChangeList.spec.ts` 的 `sshExec`）只在远端**还没受理**
    这条命令时重试（通道都没建起来），已开始执行的命令不会跑两遍；被测链路本身不重试
    ——那是产品行为，重试会掩盖 `specs/defects/` 里那一类缺陷。
11. **远端残留的 daemon 会拖住下一轮**：上一轮用例被杀时远端 Core 进程可能还在空闲
    退出倒计时里，`~/.<configDir>/run/core-daemon-<fingerprint>.json` 也还在。
    连真实远端的用例开头与收尾都要清场（`pkill -f '<core 名>'` + 删状态文件），
    标识符从 `src/config/project.ts` 取、不写字面量（`remoteSshExecution.spec.ts` 的
    `CORE_PROCESS_PATTERN` / `REMOTE_RUN_DIR`，`remoteChangeList.spec.ts` 的
    `afterAll` 同一套）。
12. **链路抖动会以「产品错误态」的形式出现在界面里**：已知坑 10 那 3% 的瞬时失败若落在
    **被测代码**发起的那次 exec 上（不是用例脚手架），侧栏会进入既定的错误态「读取失败，
    点击重试」——这是产品应有的行为（不静默空列表，见
    [「全部变更」视图规格](../docs/archive/specs/041-sidebar-all-changes-view/spec.md) 的 FR-003），
    不是回归。用例
    只等目标行出现就会把抖动判成缺陷（`remoteChangeList.spec.ts` 首轮全量跑即如此：RT-2
    红在 `keep.md` 不出现，单跑与复跑都绿）。等待助手因此替用户点掉 `[data-retry-doc]`
    的重试，并在判定「取数不得报错」时按日志把传输层失败与非传输层失败分开计数：只有后者
    算红。判据不因此放宽——持续报错的真失败仍然红。
13. **点「重试」会真的重发一次远端取数，必须限次退避**：错误态的重试不是幂等的空操作，
    它重跑整条取数链路。按固定间隔轮询点击会自己造一场往返风暴——`remoteChangeList.spec.ts`
    的等待助手上一版每 250ms 点一次，链路持续抖动时 120 秒里点了 324 次（诊断日志
    `runBatch: 324`），既拖长用例又把后续用例的取数计数基线搅乱。现在最多重试 3 次、
    间隔 1s / 2s / 4s 指数退避，且只在错误态出现时点（加载中点没用，还会作废在途回包）。
14. **启动阶段失败必须自己收尸，否则会自我放大**：`launchApp` 的 CDP 握手（3 次 × 60s）
    全超时时，`AppHandle` 还没返回、`close` 也不存在——早前没有任何人负责杀进程与清沙箱，
    实测留下过完整的 Electron 进程树（主进程 + GPU + 网络 + 两个渲染进程）与
    `tuxedo-e2e-home-*`。而垂死的 Electron 进程与下一个实例争 CPU 正是「时序敏感断言偶发
    超时」的成因（见 `close` 的原注释），于是泄漏会让后续用例继续握手超时。现在启动失败走
    与 `close` 同一个 `killSpawnedApp`（taskkill `/T /F` + 轮询等进程树真正退出 + 删沙箱）。
    排查残留：`Get-CimInstance Win32_Process -Filter "Name='electron.exe'"` 看
    `--multi-instance=` 的沙箱实例（**不要**误杀用户真实运行的 `Tuxedo Cat.exe`）。
