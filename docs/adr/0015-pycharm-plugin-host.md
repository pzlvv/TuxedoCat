# ADR-0015：第四宿主以 PyCharm 插件直连帧通道并复用 webview 渲染

- 状态：已采纳
- 日期：2026-10
- 规格：[docs/hosts/pycharm-plugin.md](../hosts/pycharm-plugin.md)，随 specs/035 落地

## 决策

新增第四宿主：JetBrains 平台插件（`pycharm-plugin/`，Kotlin + Gradle，以 PyCharm 为验收
对象）。三个子决策：

1. **JVM 直连帧通道**：插件进程内实现协议 v2 客户端（spawn `<core.binaryName> stdio`
   子进程），宿主层行为（消息翻译、工具卡片、确认流、settings 读写、FileLock）从 TS
   宿主层移植——与 `tui-rs/` 的非 TS 宿主模式一致，不引入 Node sidecar。
2. **面板复用同一份 webview 渲染实现**：JCEF（JBCefBrowser）加载 `dist/webview` 构建
   产物，静态资源由面板内嵌的 JDK HttpServer（127.0.0.1 随机端口）伺服并在 `index.html`
   响应中运行期注入宿主事实（对齐 VS Code 扩展的 HTML 改写手法）；不写原生 Swing UI。
3. **自包含单 zip 分发**：插件 jar + 四平台（win32/linux × x64/arm64）Core 产物与
   fingerprint + ripgrep + webview 静态资源打进一个 zip（`npm run package:pycharm`），
   解压即用，运行期按 `<arch>-<platform>` 目录解析当前平台；不联网下载、不分平台出包。

## 背景

VS Code 扩展与 Electron 桌面端之后，用户需要在 PyCharm 里直接使用助手。JetBrains 插件
是 JVM 进程，无法复用 TS 宿主层的 `bootstrapCore` 骨架；Core 侧契约（事件词汇表、帧协议、
落盘格式）已由 tui-rs 证明可被非 TS 宿主按同一规范实现。Edit / Write 的权限确认需要
IDE 内 diff 能力（IntelliJ Diff API）与「不夺焦点」的窗口语义。

## 被否决的替代方案

- **Node sidecar 复用 TS 宿主层**：zip 须内嵌 Node 运行时，违背自包含；进程 / 生命周期
  复杂度双倍。
- **原生 Swing 对话 UI**：第二套渲染实现，违反架构原则「预览只有一份渲染实现」
  （[架构原则第 5 节](../architecture/principles.md#5-预览只有一份渲染实现不做重复)）。
- **CEF 自定义 scheme 伺服 webview 资源**：`addCefCustomSchemeHandlerFactory` 要求在
  CEF 初始化前注册，而 IDE 其它组件（What's New 页等）可能先把 JCEF 跑起来——实测报
  「JBCefApp has already been initialized!」。改用内嵌 JDK HttpServer（127.0.0.1 随机
  端口），无时序约束。
- **分平台四 zip**：用户要求完整单包；Marketplace 亦单包分发，平台解析在运行期做。
- **RemoteRobot 驱动 e2e**：引入 Java 测试栈；改用 JCEF 的 CDP 调试通道
  （Registry 键 `ide.browser.jcef.debug.port` 经沙箱 config 的 `options/ide.general.xml`
  持久化覆盖）+ idea.log 结构化诊断行，复用 Playwright 资产。

## 后果

- 宿主层移植面（webview 消息协议、总线接线语义、settings/FileLock 字节级口径）由
  Gradle 单测锁值 + 字段名单对照测试防漂移（`tui-rs` 的 multimodal 漂移教训，
  修复项在 TODO.md 登记）。
- 2024.1（`since-build` 下限）至 2026.1 的 IDE 版本区间为未测兼容（e2e 只覆盖 2026.2），
  已在 [docs/hosts/pycharm-plugin.md](../hosts/pycharm-plugin.md) 声明。
