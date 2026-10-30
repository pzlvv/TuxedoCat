---
owner: pzlvv
last_reviewed: 2026-10-31
---

# 规格：PyCharm 插件宿主

本规格界定第四宿主——JetBrains 平台插件（以 PyCharm 为验收对象）的进程形态、与 Core 的
接线、面板承载、Edit / Write 的 IDE diff 与焦点行为、权限确认流、图标与自包含分发。
改动来源见 [specs/035 归档](../archive/specs/035-pycharm-plugin/spec.md)。

交叉引用：[docs/hosts/tui.md](tui.md)（stdio 直连接入的同款先例）、
[docs/hosts/host-matrix.md](host-matrix.md)（四宿主分叉清单）、
[docs/hosts/webview-facts.md](webview-facts.md)（面板注入的宿主事实清单）、
[docs/core/standalone-core.md](../core/standalone-core.md)（帧协议 v2 与握手序列）、
[docs/hosts/product-identity.md](product-identity.md)（产品身份派生）。

## 1. 形态与进程模型

- 源码在 `pycharm-plugin/`（Kotlin + Gradle，JVM 17 字节码、JDK 25 工具链编译），与
  `tui-rs/` 同级的非 TS 宿主：不进 `src/` 分层、不 import TS 源码；与 Core 的唯一边是
  stdio 帧通道（协议 v2，`hello`/`ready` 握手、`hostEnvironmentProvided`、`coreReady`
  门禁）。
- Core 生命周期常量与 `src/host/standalone/CoreProcess.ts` 同口径：握手 10s、优雅关闭
  2s、重启 60s 窗口 5 次（500ms→10s 指数退避）、出站有序队列 + drain 背压（1 万帧告警）、
  JVM shutdown hook 孤儿兜底。
- 总线接线语义与 `src/host/standalone/StandaloneEventBus.ts` 同口径：就绪前 UiEvent 排队、
  `hostEnvironmentProvided` 连接态重放（每次 ready 最先发）、`conversationOpened` 按
  openSessions 重放、`connectionEpoch` 丢弃旧应答、CoreRequest 未注册回 `ok:false`。
- 配置读写与既有宿主同源：`<home>/<configDir>/settings.json`（读三态 ok/missing/invalid、
  写四层保护、`settings.json.lock` 字节级互操作——`wx` 创建、内容 `<pid> <毫秒>`、陈旧
  15s / pid 探活、同目录 tmp + rename 原子落盘）。快照解析是 `settingsSnapshot.ts` 的
  第三份实现（tui-rs 先例同款），字段名单与默认值由 Gradle 单测锁定
  （SettingsAndLockTest）。
- 每个 project 窗口独立面板与独立会话，会话工作目录取 project 内容根，经
  `sessionWorkspaceAssigned` 登记给 Core。

## 2. 面板承载与消息桥

- 工具窗口（`<product-name>`）承载 JCEF（JBCefBrowser）加载同一份 webview 渲染实现
  （`dist/webview`，铁律「预览只有一份渲染实现」）；`HostInfo` 取 `single`/`webview`
  组合（同 VS Code 宿主）。
- 静态资源由面板内嵌的 JDK HttpServer（`127.0.0.1` 随机端口）伺服，`index.html` 响应
  做运行期注入（对齐 `src/extension.ts` 的改写手法）：在 module 脚本前插入
  bootstrap——`window.vscode` shim（postMessage → JBCefJSQuery）与
  `__hostInfo`/`__initialTheme`/`__uiLocale`/`__uiFontSize`/`__vscodeLocale`/
  `__systemLocale`/`logoUri`/`__hasWorkspace`（注入清单见
  [docs/hosts/webview-facts.md 第 3 节](webview-facts.md#3-事实清单)，webview
  对缺失项即抛错）。不用 CEF 自定义 scheme：addCefCustomSchemeHandlerFactory 要求在
  CEF 初始化前注册，而 IDE 其它组件可能先把 JCEF 跑起来（实测报
  「JBCefApp has already been initialized!」）——http://127.0.0.1 无时序问题。
- 下行走 `executeJavaScript(window.postMessage(<json>,'*'))`（对齐 electron preload 的
  window message 转发语义）；上行 query handler 进宿主路由。
- 光标补偿：JCEF-in-IDE 的「CEF OnCursorChange → AWT 光标」链路有断点，页面 CSS 的
  `cursor: pointer` 落不到系统光标（VS Code / Electron 宿主自实现了转发，无此问题）。
  bootstrap 注入 pointermove 探测——读悬停目标的 computed cursor、仅在值变化时经桥发
  面板私有消息 `__cursor`，Java 侧映射为 AWT 光标（pointer→手型、text→文本、其余→箭头）。
- 项目打开后面板自动展示（`StartupActivity`，`show()` 不夺焦点，且必须在 EDT——
  ProjectActivity 包 `withContext(Dispatchers.EDT)`）。
- 插件 `<depends>com.intellij.modules.jcef</depends>`：无 JCEF 的 IDE 在装载期明确失败，
  不静默降级。

## 3. Edit / Write 的 IDE diff 与焦点

- diff 数据取 `CoreRequest.toolPermissionRequested` 的 `permResult` / `displayArgs`，
  不做第二份 diff 计算。manual 模式权限判定为 ask 时以 IntelliJ Diff API 打开
  before/after 视图；`beforeContent` 为 null（Write 新建文件）只展示新内容单侧。
- 打开行为对齐 `src/VSCodeUIHost/documentManager.ts` 四约定：不夺焦点打开；内容哈希
  去重；同一时刻至多一个 diff 视图（开新关旧）；应答 `userChoice` 后关闭
  （`closePreview` 同时机）。auto / risk 模式不弹 IDE diff（Electron 宿主空实现同口径）。
- 焦点变化只有用户主动路径：点击卡片文件路径 → `OpenFileDescriptor.navigate(true)` 夺焦
  打开并选中 `startLine`–`endLine` 行区间（webview 既有 `openFile` 消息语义）。diff 与
  工具窗口的打开都不改用户焦点位置。
- diff 打开 / 关闭 / 去重 / 焦点决策写 idea.log 结构化诊断行（`[diff] open|close`、
  `[openFile] opened`）——e2e 的 IDE 侧断言面（Swing 不可经 CDP 断言）。

## 4. 权限确认流

与 `src/host/ui/userChoice.ts`（`UserChoiceManager`）同语义：`userChoice` 到达即上报
`userChoicePendingChanged`；每会话至多一个等待确认，新请求顶替旧请求（旧 Promise 以
「被顶替」错误结束）；会话未 open 保留 pending、open / 会话加载时重投；会话关闭按补偿
语义拒答（core 不悬挂）。应答形状 `{kind:'permission'; index; reply}` /
`{kind:'question'; answers}`。工具卡片与 `_meta` 追加写（会话 jsonl 的宿主侧读取 /
写入按 `src/shared/history/` 格式，fixture 测试锁定）。

## 5. 分发包与 e2e 车道

- 分发产物是单个自包含 zip（`npm run package:pycharm`，脚本 `scripts/build-pycharm.mjs`）：
  插件 jar、四平台目录（win32/linux × x64/arm64）的 `<core.binaryName>` + `fingerprint` +
  ripgrep、`webview/` 静态资源、图标（`assets/logo.svg` 构建期派生 pluginIcon /
  toolWindow 两落点）。解压即用，不依赖 Node / Python / 预装 Core，运行期不联网下载。
  文件名 `<extensionName>-pycharm-<version>.zip`，全部身份字段构建期从
  `src/config/project.json` 派生（`brandLiteral` 全仓扫描覆盖插件源码树）。
- 构建环境：JDK 25（2026.2 平台类文件为 Java 25；Gradle daemon 本体 ≤ 24，工具链经
  `-Porg.gradle.java.installations.paths` 注入；Kotlin 插件 2.3.21+——2.2.20 在 JDK 25
  上 `JavaVersion.parse` 崩）。本机 PyCharm 经 `intellijPlatform local()` 作为编译平台
  （路径来自 `e2e/environments.json` 的 pycharm 段 / `local.properties`），缺省远程坐标。
- e2e 本地车道 `pycharm-plugin`（`e2e/pycharm/`，`npm run test:e2e:pycharm`）：不进 CI。
  zip 结构层无 IDE 依赖；IDE 内链路层以沙箱化目录拉起本机 PyCharm——`PYCHARM_VM_OPTIONS`
  四路径重定向 + `-Didea.trust.all.projects=true` + `-Djb.consents.confirmation.enabled=false`
  + CDP 端口经 `options/ide.general.xml` 持久化覆盖（`-D` 不进 Registry，实测无效）；
  面板经 CDP 驱动，IDE 侧行为走 idea.log 诊断行断言。环境段缺失 / 非法收集期报错不 skip
  （同 `electron-ssh` 口径）。

## 6. 宿主差异（与 VS Code / Electron 宿主的有意分叉）

- 跨工作区 agent / transfer 能力声明为 `false`（core 不派发对应请求；相应 CoreEvent 只
  记日志）；Spin 设计器、远程终端、remoteWorkspace 选择器、预览窗口等 Electron surface
  不实现，webview 内对应入口走既有降级路径。
- `fetchProviderModels` 的协议探测按端点状态码分类（OpenAI / Anthropic / Responses），
  与 `shared/llm/apiTypes` 判定精神一致但未逐字段对齐——探测只服务面板默认值，不影响
  core 链路（有意的 v1 简化，注释留痕）。
- `expandCompactDone` 的归档展开回包 v1 只带完成信号（紧凑 diff 的按需拉取走
  `requestToolMeta`）；归档展开的完整回填面待后续 spec。
