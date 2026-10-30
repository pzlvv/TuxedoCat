# 任务分解：PyCharm 插件宿主

执行顺序按依赖排布：spike 先行（T001）→ Gradle 骨架与身份（T002）→ Kotlin 宿主层移植与
单测（T003/T004）→ 面板承载与翻译（T005/T006）→ 确认流与 diff（T007/T008/T009）→ 打包与
e2e（T010–T014）→ 全量闸门与文档（T015/T016）。需求与方案见同目录
[spec.md](spec.md) / [plan.md](plan.md)；测试面分层见 plan.md「测试计划」。

## 任务清单

- [x] **T001**（FR-001、FR-004、FR-009）：spike 三项——`PYCHARM_VM_OPTIONS` 沙箱启动 + JCEF CDP 调试通道连通；非模态 diff「不夺焦」API 选型（`DiffVirtualFile` 首选）；自定义 scheme handler 在 module 脚本前注入全局变量；依赖：—；完成判据：三条结论回写 plan.md 第 0 节，探测脚本留档 `exp/`。
- [x] **T002**（FR-010）：Gradle 骨架——`pycharm-plugin/` 的 build/settings.gradle.kts + wrapper、IntelliJ Platform 依赖（本机 `local()` 优先，远程坐标兜底）、`src/config/project.json` 身份生成任务与 `plugin.xml` expand、空工具窗口注册；依赖：T001；完成判据：`gradlew buildPlugin` 产出 zip，生成物内 id/name 与 project.json 一致，`npm run test:unit -- brand-literal` 绿。
- [ ] **T003**（FR-002）：帧协议 + Core 进程/总线移植（协议 v2 编解码、握手 10s、shutdown 2s、重启 5 次/60s/500ms→10s、背压 1 万帧、就绪排队/连接态重放/conversationOpened 重放/connectionEpoch/未注册回 `ok:false`）；依赖：T002；完成判据：`gradlew test` 含 FrameCodec / CoreProcess / CoreBus 三组单测全绿。
- [ ] **T004**（FR-003）：settings/FileLock/mcp 移植（`resolveSettingsSnapshot` 锁值 + 字段名单对照、updateSettings 四层保护、`settings.json.lock` 字节级口径、mcp 解析容错）；依赖：T002；完成判据：`gradlew test` 含 FileLock / SettingsSnapshot / SettingsStore / McpParse 四组单测全绿。
- [ ] **T005**（FR-001）：JCEF 承载——自定义 scheme handler 伺服 `webview/`、`index.html` 运行期注入（`window.vscode` shim + `__hostInfo`/`__initialTheme`/locale/`__uiFontSize`/`logoUri`/`__hasWorkspace`）、`JBCefJSQuery` 上行、`executeJavaScript` 下行、工具窗口接入；依赖：T002；完成判据：注入改写纯函数单测绿；面板就绪由 T014 e2e 锁定。
- [ ] **T006**（FR-001）：双向翻译表——CoreEvent→HostToWebview 全集、WebviewToHost→UiEvent/UiRequest 全集、`hostEnvironmentProvided` 推送（快照来自 T004）、会话/工作目录接线（每 project 独立会话）；依赖：T003、T004、T005；完成判据：翻译表完备性单测绿（对齐 `src/host/webviewMessages.ts` 成员名单）。
- [ ] **T007**（FR-006）：UserChoiceManager 移植——每会话至多一个 pending、新顶旧 reject、会话关闭拒答补偿、`userChoicePendingChanged` 上报、应答形状 `{index, reply}` / `{answers}`；依赖：T006；完成判据：`gradlew test` UserChoiceQueue 组单测全绿。
- [ ] **T008**（FR-004）：DiffService——manual+ask 时 before/after diff、四约定（内容哈希去重/单实例开前关旧/应答即关/null 单侧）、auto/risk 不弹、idea.log 结构化诊断行；依赖：T001、T007；完成判据：去重/单实例纯函数单测绿；diff 行为由 T014 e2e 锁定。
- [ ] **T009**（FR-005）：FileJumpService——卡片文件路径点击 `OpenFileDescriptor.navigate(true)` + 选中 `startLine`–`endLine`，诊断行落 idea.log；依赖：T006；完成判据：e2e 跳转断言（T014）+ log 证据。
- [ ] **T010**（FR-007）：图标派生——Gradle 任务从 `assets/logo.svg` 生成插件清单图标与工具窗口图标（平台规格），插件树无第二份产品图标；依赖：T002；完成判据：buildPlugin 产物内图标资源在位（T013 断言）。
- [ ] **T011**（FR-008）：打包链——`scripts/build-pycharm.mjs` + `package.json` 的 `package:pycharm` + `prepareSandbox` 复制 `dist/webview/**`、四平台 core+fingerprint+ripgrep；依赖：T006；完成判据：`npm run package:pycharm` 产出 `release/pycharm/<extensionName>-pycharm-<version>.zip`，四平台产物缺失时报构建命令。
- [ ] **T012**（FR-009）：e2e 车道基建——`e2e/helpers/testEnvironment.ts` 增 `pycharm` 段校验、`environments.example.json` 占位、playwright project + 产物断言、`test:e2e:pycharm` 脚本、all.yml 注释单列、`e2e/README.md` 登记、`e2e/helpers/pycharmIde.ts`（沙箱启动/CDP 连接/清理）；依赖：T011；完成判据：`npm run check-types:e2e` 绿；`pycharm` 段缺失时收集期报错（`--list` 行为验证）。
- [ ] **T013**（FR-008、FR-009）：`e2e/pycharm/pluginPackage.spec.ts`——zip 解压核验（jar / 四平台 core+fingerprint+ripgrep / webview 资源 / 图标 / plugin.xml 身份）；依赖：T012；完成判据：用例跑绿（标题带 FR-nnn）。
- [ ] **T014**（FR-001、FR-002、FR-003、FR-004、FR-005、FR-006）：`e2e/pycharm/pluginInIde.spec.ts`——真实本机 PyCharm：面板 `coreReady` 就绪、mock LLM 对话轮、Write/Edit ask 的 overlay + diff 诊断 + 应答关闭 + 落盘副作用、auto 不弹 diff、文件跳转 log 证据；依赖：T013、T007、T008、T009；完成判据：`npm run test:e2e:pycharm` 全绿（本机）。
- [ ] **T015**（FR-001、FR-002、FR-003、FR-004、FR-005、FR-006、FR-007、FR-008、FR-009、FR-010）：全量闸门——`npm run check-types && npm run lint`、`npm run test:unit`、`npm run check-types:e2e`、`gradlew test`、`npm run package:pycharm`、（环境可用时）`npm run test:e2e:pycharm`；依赖：T014；完成判据：全部命令输出绿，环境缺失项单列说明。
- [ ] **T016**（FR-010）：文档并入与 ADR（/converge 配套）——新增 `docs/hosts/pycharm-plugin.md` 与 `docs/features/user-stories/pycharm-plugin.md`（EP-15 / US-68~72 + 附录映射）、更新 host-matrix / repo-map / overview / host-bootstrap / docs/README / AGENTS.md 车道句、ADR-0015；依赖：T015；完成判据：`npm run test:unit -- docs-lint` 绿，`docs/README.md` 地图含新条目。
