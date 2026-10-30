---
status: 实施中
---

# 改动规格：PyCharm 插件宿主

新增第四个宿主：JetBrains 平台插件（以 PyCharm 为验收与测试对象），在 PyCharm 的工具窗口里
内嵌与既有宿主同一份 webview 渲染实现，直连本机 Standalone Core 的 stdio 帧通道。插件分发为
一个自包含 zip（内置全部支持平台的 Core 产物与 webview 静态资源，不依赖 Node / Python / 预装
Core）；Edit / Write 工具的权限确认在 IDE 内以 diff 视图展示并管理焦点；新增一条本地 e2e 车道
驱动本机 PyCharm 验证以上行为，该车道依赖外部环境、不进 CI。

交叉引用：[docs/hosts/tui.md](../../docs/hosts/tui.md)（stdio 直连接入的先例宿主）、
[docs/hosts/host-matrix.md](../../docs/hosts/host-matrix.md#6-宿主固有差异有意保留)（宿主分叉的登记位置）、
[docs/architecture/events.md](../../docs/architecture/events.md)（帧通道事件词汇表）、
[docs/architecture/principles.md 第 5 节](../../docs/architecture/principles.md#5-预览只有一份渲染实现不做重复)（一份渲染实现）、
[docs/hosts/product-identity.md](../../docs/hosts/product-identity.md)（产品身份占位符约定）、
[docs/core/standalone-core.md](../../docs/core/standalone-core.md)（帧协议 v2 与握手序列）、
[e2e/README.md](../../e2e/README.md)（e2e 车道分层与本地车道先例 `electron-ssh`）。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/hosts/host-matrix.md](../../docs/hosts/host-matrix.md) | [宿主固有差异](../../docs/hosts/host-matrix.md#6-宿主固有差异有意保留)与[尚未收敛的分叉点](../../docs/hosts/host-matrix.md#7-尚未收敛的分叉点) | 修改 | 「三契约两宿主 + 第三宿主 TUI」的口径扩为四宿主，登记 PyCharm 宿主的固有差异 |
| [docs/architecture/overview.md](../../docs/architecture/overview.md) | 宿主清单相关节 | 修改 | 宿主清单补 PyCharm 插件 |
| [docs/architecture/repo-map.md](../../docs/architecture/repo-map.md) | 目录布局 | 修改 | 新增插件源码目录与构建脚本行 |
| [docs/hosts/host-bootstrap.md](../../docs/hosts/host-bootstrap.md) | 适用范围相关节 | 修改 | 宿主接线适用范围补第四宿主的指向 |
| `docs/hosts/pycharm-plugin.md` | — | 新增 | PyCharm 宿主的 as-built 主题规格（进程模型、接线、diff 与焦点行为、分发包结构） |
| [docs/features/user-stories.md](../../docs/features/user-stories.md) | 目录表、附录映射 | 修改 | 新增 EP-15 分册行；附录登记 pycharm 车道 e2e 映射 |
| `docs/features/user-stories/pycharm-plugin.md` | — | 新增 | EP-15 的 US 分册 |
| [e2e/README.md](../../e2e/README.md) | 车道总表、CI 车道表、环境配置节 | 修改 | 登记本地车道 `pycharm-plugin` 与 `pycharm` 环境段 |
| [docs/README.md](../../docs/README.md) | 宿主与 UI 地图 | 修改 | 登记新规格与新分册 |
| [AGENTS.md](../../AGENTS.md) | 工作流节 | 修改 | e2e 车道清单补本地车道 `pycharm-plugin` |

## 用户场景与验收标准

验收标准一行式：GIVEN（前置）WHEN（动作）THEN（可观察结果），回指功能需求条目。

- 场景 1：用户拿到分发包，装进本机 PyCharm 即可使用。
  - **AC-1**（FR-008）：GIVEN 已构建的分发 zip WHEN 解压并逐项核验内容 THEN 插件 jar、四个平台目录（win32/linux × x64/arm64）的 `<core.binaryName>` 与 `fingerprint`、ripgrep、webview 静态资源、插件图标全部在位，且 zip 内无任何指向外部安装（Node / Python / 预装 Core）的引用。
  - **AC-2**（FR-001）：GIVEN 本机 PyCharm 已从磁盘安装该 zip WHEN 重启 PyCharm 并打开工具窗口 THEN 面板加载完成并进入可输入状态（`coreReady` 后输入框可用），全程无需手工配置。
- 场景 2：用户在 PyCharm 面板里完成一轮对话。
  - **AC-3**（FR-001）：GIVEN 面板就绪且 LLM 指向 mock 服务器 WHEN 提交一条用户消息 THEN 流式回复与工具卡片按既有 webview 行为渲染。
- 场景 3：manual 模式下 Edit / Write 权限确认的 diff 展示与焦点。
  - **AC-4**（FR-004）：GIVEN 会话为 manual 模式且目标文件已存在 WHEN 模型发起 Edit 且权限判定为 ask THEN PyCharm 出现 before/after 双侧 diff 视图、焦点仍停留在原位置、webview 卡片同步完整展开 diff。
  - **AC-5**（FR-004）：GIVEN Write 权限确认中且目标文件不存在（`beforeContent` 为 null）WHEN IDE diff 打开 THEN 只展示新内容单侧，不出现伪造的旧内容侧。
  - **AC-6**（FR-004）：GIVEN diff 视图已打开 WHEN 用户在面板应答（允许或拒绝）THEN diff 视图关闭，且下一次 diff 打开前上一次的视图不残留。
  - **AC-7**（FR-004）：GIVEN 同一内容的 diff 已在展示 WHEN 再次触发同一内容 THEN 不重复打开第二个 diff 视图，同一时刻至多存在一个 IDE diff 视图。
  - **AC-8**（FR-006）：GIVEN 会话为 auto 或 risk 模式 WHEN Edit / Write 自动放行 THEN 不弹出 IDE diff，改动只在卡片内展示。
- 场景 4：从对话卡片跳转到文件改动位置。
  - **AC-9**（FR-005）：GIVEN Edit / Write 卡片已产出 WHEN 点击卡片上的文件路径 THEN 编辑器打开该文件、焦点切到编辑器、并选中该次改动的行区间（`startLine`–`endLine`）。
- 场景 5：权限确认的等待语义。
  - **AC-10**（FR-006）：GIVEN 权限请求到达时面板不可见 WHEN 用户稍后打开面板 THEN 等待中的确认框完整出现并可与应答，core 侧 `sessionRuntime` 的 waiting 状态经 `userChoicePendingChanged` 如实上报。
  - **AC-11**（FR-006）：GIVEN 存在等待中的权限确认 WHEN 对应会话被关闭 THEN 该请求按既有 pending 补偿语义拒答，core 不悬挂。
- 场景 6：与其它宿主共用配置。
  - **AC-12**（FR-003）：GIVEN `<configDir>/settings.json` 已由 VS Code / Electron 宿主写好 LLM 配置 WHEN 启动 PyCharm 插件 THEN 直接可用且无第二份默认值，插件侧经面板修改配置落盘后其它宿主读到同一份新值。
- 场景 7：e2e 车道的环境依赖。
  - **AC-13**（FR-009）：GIVEN `e2e/environments.json` 缺失 `pycharm` 段或字段非法 WHEN 运行 `pycharm-plugin` 车道 THEN 在收集期报错并列出全部问题，不静默 skip，其余车道不受影响。
  - **AC-14**（FR-009）：GIVEN 本机已登记 PyCharm 路径 WHEN 运行 `npm run test:e2e:pycharm` THEN 用例以沙箱化配置目录拉起本机 PyCharm、经调试通道驱动面板跑通对话与 diff 断言，且不污染用户常用 IDE 配置。
  - **AC-15**（FR-009）：GIVEN CI 环境 WHEN 跑 `.github/workflows/all.yml` THEN `pycharm-plugin` 车道不执行（仅以注释单列），`npm run test:e2e:local` 与 `npm run test:all` 的结果与本机是否装 PyCharm 无关。
- 场景 8：不支持的平台。
  - **AC-16**（FR-002）：GIVEN 插件运行在无 Core 产物的平台（如 macOS）WHEN 面板初始化 THEN 给出明确错误提示与日志，不静默降级、不尝试联网下载。
- 场景 9：构建期的图标与产品身份。
  - **AC-17**（FR-007）：GIVEN 解压后的插件 zip WHEN 检查图标资源 THEN 插件清单图标与工具窗口图标在位且与 `assets/` 派生源一致，插件源码树内不存在第二份产品图标文件。
  - **AC-18**（FR-010）：GIVEN 插件源码与构建脚本 WHEN 跑 `npm run test:unit -- brand-literal` THEN 除 `src/config/project.json` 与 `package.json` 两个定义处外零字面量命中，zip 文件名与工具窗口标题与定义处派生值一致。

## 功能需求

### FR-001：工具窗口面板复用唯一渲染实现

PyCharm 插件以工具窗口承载助手面板，面板 UI 是既有 webview 构建产物（`dist/webview`）的
同份渲染实现（[docs/architecture/principles.md 第 5 节](../../docs/architecture/principles.md#5-预览只有一份渲染实现不做重复)），
经 JetBrains 平台内嵌浏览器（JCEF）加载；插件侧实现与 `src/host/webviewMessages.ts` 相同
语义的 webview 消息协议，不另写一套原生 Swing 对话 UI。面板能力声明取 `HostInfo` 的
`single` / `webview` 组合（同 VS Code 宿主），对话列表、新建对话、会话切换均由 webview 渲染。
PyCharm 每个 project 窗口拥有独立面板、独立会话，会话工作目录取该 project 的内容根。
对话内与宿主无关的全部行为（消息渲染、工具卡片、设置弹层、i18n）随渲染实现自带，不在
插件侧重复实现。

### FR-002：直连本机 Standalone Core

插件以 JVM 进程直连 Core：启动时按 `src/host/standalone/coreBinary.ts` 的同款规则在插件
分发目录内定位当前平台（`<arch>-<platform>`）的 `<core.binaryName>`，以 `stdio` 动作 spawn
子进程并校验同级 `fingerprint`（64 位小写 hex）；按协议 v2 完成 `hello` / `ready` 握手，
随后推送 `hostEnvironmentProvided`，收到 `CoreEvent.coreReady` 前不放行任何 UiEvent /
UiRequest。Core 进程生命周期（握手超时、退出兜底、崩溃重启策略）与
`src/host/standalone/CoreProcess.ts` 的既有口径一致。未支持平台与产物缺失都是启动期错误：
给用户可见的明确提示并写日志（[docs/architecture/principles.md 第 1 节](../../docs/architecture/principles.md#1-不过度-fallback)），
不做任何 fallback。

### FR-003：配置与既有宿主同源

插件读写与其它宿主相同的 `<configDir>/settings.json` 与 mcp 配置：读侧语义、默认值与
`src/shared/settingsSnapshot.ts` 一致，插件侧不得引入第二份默认值；写侧遵循
[docs/architecture/principles.md 第 11 节](../../docs/architecture/principles.md#11-共享文件的写安全)的共享
文件写安全约定（跨进程锁、读不出拒绝写、原子落盘、内容未变不落盘）。配置变更经
`hostEnvironmentProvided` 重推语义同步到 Core。

### FR-004：Edit / Write 的 IDE diff 展示

manual 模式下 Edit / Write 权限判定为 ask 时，插件以 PyCharm 内置 diff 能力打开 before/after
双侧 diff 视图，数据取 `CoreRequest.toolPermissionRequested` 的 `permResult` diff 字段
（`beforeContent` / `afterContent` / `contextBefore` / `contextAfter`）与 `displayArgs`
（`file_path` 等），不做第二份 diff 计算。打开行为对齐 `src/VSCodeUIHost/documentManager.ts`
的四个约定：以不夺焦点的方式打开（用户停留在面板或原编辑器应答）；按内容去重（相同内容不
重复打开）；同一时刻至多一个 diff 视图（打开新 diff 前先关旧的）；用户应答 `userChoice`
后关闭。`beforeContent` 为 null（Write 新建文件）时只展示新内容单侧。auto / risk 模式不弹
IDE diff，与 Electron 宿主的 `showDiff` 空实现同口径。

### FR-005：焦点变化与文件跳转

点击工具卡片上的文件路径时，插件在编辑器中打开该文件，焦点切换到编辑器，并选中该次改动的
行区间（`startLine`–`endLine`，对应 webview 既有的 `openFile` 消息语义）。除该用户主动跳转
外，插件不主动抢焦点：diff 视图与工具窗口的打开都不改变用户当前焦点位置。等待授权的卡片在
webview 内完整展开 diff 属渲染实现既有行为，插件不干预。

### FR-006：权限确认流的宿主语义

插件实现与 `src/host/ui/userChoice.ts`（`UserChoiceManager`）相同的等待语义：`userChoice`
请求到达即上报 `UiEvent.userChoicePendingChanged`；每会话至多一个等待中的确认，新请求按
既有队列语义顶替旧请求；会话未打开 / 面板不可见时请求保留 pending，会话关闭时按补偿语义
拒答。应答经帧通道回传 `{index, reply}` / `{answers}`，与既有结果类型一致。

### FR-007：插件图标

插件在 JetBrains 平台要求的各落点展示统一产品图标：插件清单图标（插件列表 / 详情页）与
工具窗口标签图标，规格符合平台对相应位置的尺寸与格式要求。图标的单一来源是 `assets/`
（构建期复制或派生进插件资源），插件源码树内不维护第二份产品图标。webview 内部图标随渲染
实现自带，不另行处理。

### FR-008：自包含分发 zip

分发产物是单个 zip：内置插件 jar、四个平台目录（win32/linux × x64/arm64）的
`<core.binaryName>` 与 `fingerprint`、对应 ripgrep、webview 静态资源与插件图标。解压即用，
不依赖 Node.js / Python / 预装 Core，运行期不联网下载任何构件；平台解析在运行期按
`<arch>-<platform>` 目录进行。zip 文件名与内部路径由 `src/config/project.json` 派生
（产品身份占位符约定），版本号取自 `package.json`。构建入口是 npm 脚本（链上先构建 webview
与 Core 产物，再经 Gradle 打包插件与 zip）。

### FR-009：本地 e2e 车道（pycharm-plugin）

新增 Playwright project `pycharm-plugin`（用例目录 `e2e/pycharm/`），与 `electron-ssh` 同为
本地车道：不进 CI（`.github/workflows/all.yml` 仅注释单列），不计入 `npm run test:e2e:local`
与 `npm run test:all`，单独入口 `npm run test:e2e:pycharm`。环境依赖登记在
`e2e/environments.json` 的 `pycharm` 段（至少含本机 PyCharm 可执行文件路径），
`e2e/environments.example.json` 同步占位；校验函数按 `e2e/helpers/testEnvironment.ts` 既有
模式实现，段缺失或字段非法时在收集期报错并列出全部问题，不修复、不 skip。用例分两层：
zip 结构层（构建产物缺失时在配置加载期报错并给出构建命令，与 playwright 配置的
`assertArtifact` 同口径）与 IDE 内链路层（以沙箱化配置目录拉起登记的本机 PyCharm、经调试
通道驱动面板完成对话、diff 与焦点断言，mock LLM 手法与 electron 车道一致）。新增 project
按 AGENTS.md 的同步义务更新 playwright 配置、`e2e/README.md` 车道表与 all.yml 注释。

### FR-010：产品身份去字面化

插件源码、构建脚本与用例不出现 `extensionName` / `productName` 的字面量变体：插件 id、
插件名、工具窗口标题、zip 文件名、内部资源路径全部由 `src/config/project.json` 派生
（Gradle 构建期读取），与
[docs/hosts/product-identity.md](../../docs/hosts/product-identity.md) 的消费方式表一致；
`brandLiteral` 扫描范围覆盖插件源码树。

## 边界与错误路径

- Core 产物缺失、`fingerprint` 缺失或非法、平台不支持：面板初始化期给出明确错误与日志，
  不静默降级（[docs/architecture/principles.md 第 1 节](../../docs/architecture/principles.md#1-不过度-fallback)）。
- Core 握手超时：杀掉子进程并报错，不做半可用状态；崩溃按既有重启策略处理，超限后明确报错。
- `CoreRequest` 到达但插件侧未实现：按既有总线口径回 `ok:false`，不让 core 挂死。
- 权限确认在会话关闭、面板关闭、进程退出时的补偿：拒答 pending，core 不悬挂（对齐
  `UserChoiceQueue` 语义）。
- 同批多工具并发：diff 视图单实例 + 打开前关旧的去重约定，杜绝视图叠加竞态。
- JCEF 不可用（IDE 版本过旧或环境不支持）：初始化期明确报错并给出版本指引，不渲染空白面板。
- e2e 环境层：`environments.json` 形状非法 → 配置加载期整车道报错；`pycharm` 段缺失 → 该
  车道收集期报错；登记路径指向的 IDE 无法启动 → 用例内明确报错（不修复、不 fallback）。
- 会话工作目录：PyCharm project 内容根不存在（如未打开任何目录）时，按既有「无工作区开
  占位会话」语义处理，不猜测目录。

## 非目标

- 其它 JetBrains IDE（IntelliJ IDEA、CLion、WebStorm 等）的适配声明与测试：本 spec 只以
  PyCharm 验收；支持的平台版本区间下限在 plan 阶段确定并写进插件清单。
- macOS / darwin 的 Core 产物与支持（跟随现有平台矩阵）。
- JetBrains Marketplace 上架、自动更新、`.github/workflows/release.yml` 发布链集成（→
  后续记入 TODO.md，本 spec 的分发形态是本地构建 zip）。
- 远程工作区 / SSH 相关能力与跨工作区 agent / transfer：v1 能力声明为不支持（入口随
  webview 既有降级路径置灰或提示），后续以独立 spec 扩展。
- Electron 独有的宿主级 surface（预览窗口、远程终端页面、remoteWorkspace 选择器、原生侧栏
  文件浏览器）：插件内不实现。
- 原生 Swing 对话 UI 与任何第二套渲染实现。

## 对需求基线的影响

新增 EP-15「PyCharm 宿主」，分册 `docs/features/user-stories/pycharm-plugin.md`，编号自
US-68 起，初步清单（落地时按实际收敛）：

- US-68 安装分发 zip 即用：解压安装进 PyCharm 后无需任何外部依赖与手工配置。
- US-69 在 PyCharm 工具窗口完成对话：面板能力与 VS Code 宿主一致，每 project 独立会话。
- US-70 manual 模式 Edit / Write 的 IDE diff 确认：diff 展示、不夺焦、应答后关闭。
- US-71 从卡片跳转文件改动位置：编辑器打开并选中改动行区间。
- US-72 与其它宿主共用配置：一份 settings.json 全宿主生效。

新增 e2e 用例（`e2e/pycharm/`，本地车道）覆盖 US-68–US-71 的自动化验收面；US-69 中无法经
调试通道断言的面板细节按既有口径登记豁免。登记进附录映射表，保持 docsLint 的 US ↔ e2e
闭合校验绿。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `pycharm-plugin/`（工具窗口 + JCEF 承载 `dist/webview`） | `e2e/pycharm/pluginInIde.spec.ts`（面板就绪与对话链路） | 自动 |
| FR-002 | `pycharm-plugin/` 帧通道客户端与 Core 进程管理 | `pycharm-plugin` Gradle 单测（协议编解码 / 握手）+ `e2e/pycharm/pluginInIde.spec.ts` | 自动 |
| FR-003 | 插件侧 settings 读写（对照 `src/shared/settingsSnapshot.ts`） | `pycharm-plugin` Gradle 单测（读写与默认值） | 自动 |
| FR-004 | 插件侧 diff 展示（对照 `src/VSCodeUIHost/documentManager.ts` 四约定） | `e2e/pycharm/pluginInIde.spec.ts`（diff 打开 / 关闭 / 去重） | 自动 |
| FR-005 | 插件侧文件跳转 | `e2e/pycharm/pluginInIde.spec.ts`（跳转与行选中） | 自动 |
| FR-006 | 插件侧确认流（对照 `src/host/ui/userChoice.ts`） | `pycharm-plugin` Gradle 单测（pending 补偿）+ e2e 等待态用例 | 自动 |
| FR-007 | 插件图标资源（来自 `assets/`） | `e2e/pycharm/pluginPackage.spec.ts`（图标资源在位） | 自动 |
| FR-008 | 打包脚本（npm 脚本 + Gradle） | `e2e/pycharm/pluginPackage.spec.ts`（zip 内容全量核验） | 自动 |
| FR-009 | `e2e/pycharm/`、`e2e/helpers/testEnvironment.ts`、`package.json`、`e2e/playwright.config.ts` | 车道自身（AC-13/14/15 断言面） | 自动 |
| FR-010 | Gradle 构建期身份注入 | `src/test/brandLiteral.test.ts`（扫描范围扩展） | 自动 |

## 待澄清

（当前无未决问题；实施中若出现未决项，按 [specs/README.md 第 4 节](../README.md#4-澄清闸门)补记并带去向链接。）

## 收敛记录

收敛时由 /converge 填写，结论只分三类。

- 已满足：<FR / AC → 证据（实现与测试落点）>
- 偏差：<与 spec 的差异；改代码或改 spec 并留痕>
- 未做：<回写 tasks.md 的未完成项>
