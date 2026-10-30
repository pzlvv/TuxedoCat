# 实施方案：PyCharm 插件宿主

技术路线：新增顶层目录 `pycharm-plugin/`（Kotlin + Gradle，定位同 `tui-rs/` 的非 TS 宿主），
JCEF 承载同一份 `dist/webview` 渲染实现，JVM 直连 Standalone Core 的 stdio 帧通道（协议 v2，
模板 `tui-rs`）；打包为单 zip 自包含分发；e2e 新增本地车道 `pycharm-plugin` 经 JCEF CDP 驱动
本机 PyCharm。**不改 core-rs、不改 TS 契约与事件词汇表**。需求与验收见同目录
[spec.md](spec.md)；版本下限经评审定为 PyCharm 2024.1+。

## 技术方案

### 0. 风险前置 spike（结论已回写，2026-10-31 实测）

1. **沙箱启动 ✓**：`PYCHARM_VM_OPTIONS` 指向生成的 .vmoptions
   （`-Didea.config.path` / `-Didea.system.path` / `-Didea.plugins.path` / `-Didea.log.path`）
   隔离生效。四个必带开关（缺任何一个 e2e 都会被首启对话框卡死）：沙箱路径四个 `-D` +
   `-Didea.trust.all.projects=true`（信任项目对话框）+
   `-Djb.consents.confirmation.enabled=false`（数据共享对话框）。**CDP 调试端口不能走
   `-D`**：Registry 键 `ide.browser.jcef.debug.port` 要经沙箱 config 的
   `options/ide.general.xml` 持久化覆盖。
2. **CDP 通道 ✓**：`http://127.0.0.1:9222/json/version` + `/json/list` 可达，目标页就是
   插件面板的 JCEF 浏览器。两个前置：插件 zip 解压进沙箱 plugins 目录装载
   （`Loaded custom plugins` 确认）；面板必须在项目打开后自动 `show()`（见 3）——
   工具窗口内容创建时 JCEF 才初始化、CDP 才监听。
3. **JCEF 注入 ✓（骨架级）**：`JBCefApp` 正常初始化（CEF 144），`about:blank` 目标页即
   插件的 `JBCefBrowser`；`executeJavaScript` 通道可用于下行。实施要点（实测踩坑）：
   `ToolWindow.show()` 必须在 EDT（ProjectActivity 包 `withContext(Dispatchers.EDT)`）；
   插件必须 `<depends>com.intellij.modules.jcef</depends>`（否则运行期
   NoClassDefFoundError）。运行期注入（module 脚本前）的最终验证随 T005 落地。
4. 工具链（T002 顺带）：Gradle 8.14 daemon 须跑在 JDK 21（内嵌 Kotlin 编不了 JDK 25 的
   版本串），工具链 25 经 `-Porg.gradle.java.installations.paths` 指向；Kotlin 插件
   2.3.21+（2.2.20 在 JDK 25 上 `JavaVersion.parse` 崩）；local() 平台依赖必须配
   `intellijPlatform { defaultRepositories() }`；Java/Kotlin 都产 17 字节码。

### 1. 目录与模块划分（`pycharm-plugin/`，Kotlin JVM 17）

- Gradle 8 + IntelliJ Platform Gradle Plugin 2.x，构建目标 PyCharm 2024.1
  （`since-build 241`，Community / Professional 皆可加载）。Gradle 构建期读
  `src/config/project.json` 生成身份常量（`ProductIdentity.kt` 生成物）与 `plugin.xml`
  expand（FR-010 去字面化；`brandLiteral.test.ts` 全仓扫描天然覆盖新目录，无需改测试）。
- 包结构：
  - `protocol/`：帧编解码。kotlinx.serialization 解析为 `JsonObject`、载荷子对象**透传
    不建模**（同 `tui-rs/src/protocol.rs` 手法）；encode 侧复刻 `stringifyJsonSafe` 的孤立
    代理项兜底，decode 坏行跳过。
  - `core/`：CoreProcess / Bus。生命周期常量同口径 `src/host/standalone/CoreProcess.ts`
    （握手 10s、shutdown 2s、重启 `{maxAttempts:5, windowMs:60_000, base 500ms→10s}`、
    出站有序队列 + drain 背压 1 万帧告警、`windowsHide`、JVM shutdown hook 孤儿兜底）；
    总线接线语义同 `src/host/standalone/StandaloneEventBus.ts`（就绪前 UiEvent 排队、
    `hostEnvironmentProvided` 连接态重放、`conversationOpened` 重放、`connectionEpoch`
    防旧应答、CoreRequest 未注册回 `ok:false`）。
  - `settings/`：SettingsStore / FileLock。移植 `resolveSettingsSnapshot`（同
    `tui-rs/src/settings.rs` 先例：注释声明对齐 + 空配置 / 白名单 / payload 形状锁值测试，
    **不做第二份默认值文件**）；写路径复刻 `src/host/SettingsStore.ts` 的 `updateSettings`
    （读不出拒绝写、内容未变不落盘、未知字段与键序保留）；FileLock 字节级互操作
    （`settings.json.lock` 以 `wx` 创建、内容 `<pid> <ms>`、陈旧 15s / pid 探活、同步
    20×10ms；原子落盘同目录 tmp + rename，Windows EPERM/EACCES 重试 10 次退避 5ms→100ms）；
    mcp 表移植 `src/shared/mcp/parse.ts` 的解析容错。
  - `webview/`：面板 / 桥 / scheme。插件 zip 内 `webview/` 为松散目录（jar 外），自定义
    scheme（构建期从产品身份派生，取 `<extensionName>` 去分隔符的字母数字形式）的
    SchemeHandlerFactory 伺服静态资源；对 `index.html` 响应做
    运行期注入（对齐 `src/extension.ts` 的改写手法）：`window.vscode = { postMessage →
    JBCefJSQuery }` shim + `__hostInfo(single/webview)` + `__initialTheme` +
    `__uiLocale/__uiFontSize/__vscodeLocale/__systemLocale` + `logoUri` + `__hasWorkspace`
    （webview 对缺失项即抛错，注入清单以
    [docs/hosts/webview-facts.md](../../docs/hosts/webview-facts.md) 的同步注入事实清单为
    准）。下行经 `executeJavaScript(window.postMessage(<json>, '*'))`。
  - `messages/`：CoreEvent → HostToWebview、WebviewToHost → UiEvent/UiRequest 双向翻译表
    （协议唯一来源 `src/host/webviewMessages.ts`）。
  - `tools/`：ToolHandler / UserChoiceManager / DiffSnapshot。diff 数据取
    `toolPermissionRequested` 的 `permResult` / `displayArgs`，复刻
    `src/VSCodeUIHost/documentManager.ts` 四约定（内容哈希去重、单实例开前关旧、应答即关、
    `beforeContent` null 单侧显示）；manual 判定同 `src/host/ui/toolHandler.ts`；确认流同
    `src/host/ui/userChoice.ts`（`userChoicePendingChanged` 上报、每会话至多一个 pending、
    会话关闭拒答补偿）。会话 jsonl `_meta` 读取（`requestToolMeta`）按
    `src/shared/history/` 格式 + fixture 测试锁语义。
  - `ide/`：DiffService / FileJump。文件跳转 `OpenFileDescriptor.navigate(true)` + 选中
    `startLine`–`endLine`；diff 打开 / 关闭 / 去重 / 焦点决策写 idea.log 结构化诊断行
    （e2e 断言面）。
- Gradle 单测覆盖：帧编解码、握手状态机、FileLock、快照解析锁值、确认队列补偿、jsonl
  `_meta` 读取。

### 2. 打包链（FR-008）

`npm run package:pycharm` = 断言四平台 Core 产物齐（缺则报对应构建命令）→ `build:webview`
→ `gradlew buildPlugin`（`prepareSandbox` 把 `dist/webview/**`、
`dist/resources/core/<四平台>/**`（含 ripgrep）、图标复制进沙箱）→ 产物复制到
`release/pycharm/<extensionName>-pycharm-<version>.zip`（`release/` 已 gitignore，脚本为
`scripts/build-pycharm.mjs`）。图标（FR-007）：Gradle 任务从 `assets/logo.svg` 派生插件图标
与工具窗口图标（平台规格尺寸），插件树内无第二份产品图标。构建环境前置：JDK 17+（Gradle
wrapper 自带发行版）。

### 3. e2e 本地车道（FR-009）

- `e2e/helpers/testEnvironment.ts` 增 `pycharm` 段 `{ idePath: string; llmAdvertiseHost? }`
  + `requirePycharmEnvironment()`（收集期全量校验报错）；`e2e/environments.example.json`
  同步占位。
- `e2e/playwright.config.ts`：新 project `pycharm-plugin`（`pycharm/*.spec.ts`）+ 产物断言
  zip 存在（缺失报 `npm run package:pycharm`）；`test:e2e:local` 与 `test:all` **不含**它，
  新增单独入口 `npm run test:e2e:pycharm`；`.github/workflows/all.yml` 仅注释单列（同
  `electron-ssh` 本地车道先例）。
- 新 helper `e2e/helpers/pycharmIde.ts`：mkdtemp 沙箱 home（`USERPROFILE`/`HOME` 覆盖，
  settings.json 预置同 `e2e/helpers/electronApp.ts` 手法）+ `PYCHARM_VM_OPTIONS` + 解压插件
  zip 进沙箱 plugins 目录 + spawn idePath + 轮询 CDP → `chromium.connectOverCDP`；
  `close()` 杀进程树并清理沙箱。mock LLM 复用 `e2e/helpers/mockLlmServer.ts`。
- 用例两层：`e2e/pycharm/pluginPackage.spec.ts`（zip 解压核验：jar、四平台
  core+fingerprint+ripgrep、webview 资源、图标、plugin.xml 身份派生）；
  `e2e/pycharm/pluginInIde.spec.ts`（面板就绪 `coreReady`、mock LLM 对话轮、Write/Edit ask
  的 overlay + idea.log diff 诊断断言 + 应答关闭 + 落盘副作用；auto 模式 log 断言不弹
  diff）。IDE 侧（Swing）不可经 CDP 断言的面（不夺焦的最终体验）按既有口径登记豁免 +
  log 证据。
- devDependency 增加 `adm-zip`（仅 e2e 解包用，不影响产物自包含约束）。

### 4. 实施顺序

T0 spike → T1 Gradle 骨架 + `plugin.xml` + 身份注入 + 空工具窗口 → T2 帧协议 / Core 进程 /
总线语义 + settings 移植 + Gradle 单测 → T3 消息桥 + 双向翻译表（对话链路通）→ T4
ToolHandler / UserChoice / diff / 跳转（Edit/Write 全语义）→ T5 打包链 → T6 e2e 车道全套
→ T7 文档与 README 同步（配合 /converge 并入 docs/）。

### 5. 构建平台与工具链（环境探测结论，2026-10-31）

本机验收环境：JDK 21（Temurin 21.0.12.1）+ PyCharm 2026.2.4（build `PY-262.11879.98`，
`product-info.json` 声明 `minRequiredJavaVersion: 25`）。据此定：

- Gradle 构建目标平台 = **PyCharm 2026.2**：`e2e/environments.json` 的 `pycharm.idePath`
  存在时经 `intellijPlatform { local(...) }` 直接用本机安装（免下载整平台），否则走远程
  坐标 `create("PY", "2026.2.4")`——e2e 驱动的 IDE 与编译平台严格一致。
- 编译工具链 = **JDK 25**（Gradle toolchain 自动供给），产出 Java 17 字节码（`jvmTarget 17`），
  支撑 `since-build 241` 的声明；`until-build 262.*`。2024.1–2026.1 区间为未测兼容（e2e 只
  覆盖 2026.2），如实写入文档。
- 环境依赖入口：`e2e/environments.json` 的 `pycharm` 段 `{ idePath: string; llmAdvertiseHost? }`，
  本机已登记 `D:\Program Files\JetBrains\PyCharm 2026.2.4\bin\pycharm64.exe`。

## 测试计划

四层测试面；每层定义入口、覆盖物与归属。实现任务与测试任务一一配对（见 tasks.md）。

1. **Kotlin Gradle 单测**（`pycharm-plugin/src/test/`，入口 `gradlew test`；无 IDE 依赖、
   不启 IntelliJ Platform）：
   - 帧编解码：hello/ready/event/request/response 往返、孤立代理项兜底、坏行跳过不中断；
   - Core 进程状态机：握手超时 10s 杀进程、优雅 shutdown 2s、重启策略（60s 窗口 5 次、
     500ms→10s 指数退避）、fatal 后不再重启；
   - 总线接线语义：就绪前 UiEvent 排队与按序冲刷、`hostEnvironmentProvided` 连接态重放、
     `conversationOpened` 重放、`connectionEpoch` 丢弃旧应答、CoreRequest 未注册回
     `ok:false`；
   - FileLock：互斥获取、陈旧接管（15s / pid 探活）、锁内容 `<pid> <ms>` 格式、获取失败
     返回 false 不抛；
   - settings 快照锁值：空配置落默认值、白名单外回落、payload 形状（camelCase、整数出线）、
     **字段名单对照**（快照字段集与 TS `SettingsSnapshot` 一致，防 multimodal 式漂移）；
     updateSettings 的读不出拒绝写 / 内容未变不落盘 / 未知字段与键序保留；
   - 确认队列：每会话至多一个 pending、新顶旧 reject、会话关闭拒答补偿、
     `userChoicePendingChanged` 上报；
   - 会话 jsonl `_meta` 读取：fixture 覆盖 tool_use 顶层 `_meta` 与 tool_result 兜底两来源。
2. **TS 侧既有守卫回归**（`npm run check-types && npm run lint && npm run test:unit`）：
   docsLint（specs 结构、US↔e2e 闭合、FR↔测试名）、brandLiteral（`pycharm-plugin/` 源码树
   零字面量命中——全仓扫描天然覆盖）、check-types:e2e（e2e 新文件纳入）。
3. **e2e 本地车道**（`npm run test:e2e:pycharm`，Playwright project `pycharm-plugin`）：
   - `pluginPackage.spec.ts`（无 IDE 依赖）：zip 解压核验——jar、四平台
     `<core.binaryName>`+`fingerprint`+ripgrep、`webview/` 静态资源（index.html/assets）、
     图标资源、`plugin.xml` 的 id/name 派生自 `src/config/project.json`；
   - `pluginInIde.spec.ts`（真实本机 PyCharm，沙箱化 config/system/plugins/log 目录 +
     `PYCHARM_VM_OPTIONS` + JCEF CDP 9222）：面板就绪（`coreReady` 后输入框可用）、mock
     LLM 对话轮（复用 `e2e/helpers/mockLlmServer.ts`）、Write/Edit ask → overlay + idea.log
     diff 诊断行（打开/去重/应答关闭）+ 落盘副作用、auto 模式 log 断言不弹 diff、卡片文件
     路径跳转（log 证据）；
   - 环境依赖：`pycharm` 段缺失/非法收集期报错不 skip（同 `electron-ssh` 口径）；不进 CI。
4. **打包验证**（`npm run package:pycharm`）：产物落 `release/pycharm/`、四平台产物齐全
   （缺失报构建命令）、zip 内无指向外部运行时的引用。

IDE 侧（Swing）无法经 CDP 断言的体验面（不夺焦的最终手感）按既有口径登记豁免 + idea.log
诊断行佐证；e2e 用例标题带 FR-nnn（docsLint 第 28 项闭合校验）。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `pycharm-plugin/` | 新增（Kotlin 全套 + Gradle） | 无新成员；消费既有 CoreEvent / CoreRequest / UiEvent / UiRequest 全集（含 `toolPermissionRequested`、`userChoice`、`userChoicePendingChanged`）与 webview 消息协议（`src/host/webviewMessages.ts`） |
| `package.json` | 修改 | 无；+`package:pycharm`、`test:e2e:pycharm`、devDep `adm-zip` |
| `scripts/build-pycharm.mjs` | 新增 | 无；产物 / 文件名派生自 `src/config/project.json` |
| `e2e/playwright.config.ts` | 修改 | 无；+project 与产物断言 |
| `e2e/helpers/testEnvironment.ts`、`e2e/environments.example.json` | 修改 | 无；+`pycharm` 段 |
| `e2e/pycharm/`、`e2e/helpers/pycharmIde.ts` | 新增 | 无；用例标题带 FR-nnn（docsLint 第 28 项） |
| `.github/workflows/all.yml`、`e2e/README.md`、`AGENTS.md` | 修改 | 无；车道登记 |
| `core-rs/`、`src/shared/`、`src/host/` | **不改** | 事件词汇表、wire 消息、落盘格式零变化 |

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：`pycharm-plugin/` 与 `tui-rs/` 同级的宿主实现，不进
      `src/` 分层、不 import TS 源码与宿主 API；与 Core 唯一边是帧协议
      （[docs/architecture/overview.md 第 1 节](../../docs/architecture/overview.md#1-架构概述)）；
      无宿主嗅探——符合。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：不过度 fallback（平台 / 产物 / JCEF 缺失启动期报错，
      [docs/architecture/principles.md 第 1 节](../../docs/architecture/principles.md#1-不过度-fallback)）；
      契约成员全必选（载荷透传）；core 描述事实 UI 决定表现；一份事实一个写入点（settings
      写全走锁）；一份渲染实现
      （[docs/architecture/principles.md 第 5 节](../../docs/architecture/principles.md#5-预览只有一份渲染实现不做重复)）。
      **默认值单源的既有偏差如实声明**：Kotlin 移植 `resolveSettingsSnapshot` 是第三份实现
      （tui-rs 先例已接受此模式），以锁值测试 + 字段名单对照测试防漂移。调研发现现存漂移
      实例：specs/012 给 core-rs 加必选 `multimodal` 时漏改 tui-rs，当前 TUI 快照会被 core
      拒收——**另立缺陷修复（/fix），不塞进 035**——符合（含声明的偏差）。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：不涉及——core-rs 零改动；Kotlin
      只读会话 jsonl `_meta`，以 fixture 测试锁读取语义，不改格式。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：按 spec「影响基线」清单执行——新增
      `docs/hosts/pycharm-plugin.md` 与 `docs/features/user-stories/pycharm-plugin.md`
      （EP-15 / US-68~72 + 附录映射），实施完成后 /converge 并入并归档；`e2e/README.md`、
      `docs/README.md`、`AGENTS.md` 随 T6 / T7 同步。

## 被否决的替代方案

1. **Node sidecar 复用 TS 宿主层**（bootstrapCore + WebViewUI 原样跑）：zip 须内嵌 Node
   运行时，违背自包含；进程 / 生命周期复杂度双倍。否。
2. **原生 Swing 对话 UI**：第二套渲染实现，违反
   [docs/architecture/principles.md 第 5 节](../../docs/architecture/principles.md#5-预览只有一份渲染实现不做重复)。否。
3. **分平台四 zip**：用户要求完整单包，Marketplace 亦单包分发；平台解析运行期做（体积
   优化留待后续）。否。
4. **JCEF `loadHTML` / about:blank 注入**：相对资源解析破坏；选自定义 scheme + 运行期
   index.html 改写（VS Code 同手法）。否。
5. **RemoteRobot 驱动 e2e**：引入 Java 测试栈；CDP 复用 Playwright 与 electron 车道资产。
   IDE 侧断言改走 idea.log 诊断行。否。
6. **macOS 支持**：无 Core 产物（平台矩阵如此），启动期明确报错。否。

够分量的决策（第四宿主 JVM 直连帧通道 + 复用 webview 渲染 + 自包含单 zip）建议收敛时进
`docs/adr/0015`。
