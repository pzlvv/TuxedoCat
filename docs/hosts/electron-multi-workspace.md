---
owner: pzlvv
last_reviewed: 2026-10-18
---

# 规格：Electron 多工作目录

本规格描述 Electron 宿主同时打开多个工作目录的能力。工作目录是对话的属性；每个已打开的
工作目录在标题栏以标签页呈现；标题栏菜单收编为单一图标入口。VS Code 宿主不参与本能力。

---

## 1. 能力

Electron 宿主在任一时刻持有一个**打开集合**——若干个已打开的工作目录，按打开顺序排列。
集合中的每一项在标题栏对应一张标签页，其中一张为活动项。

能力范围：

1. 添加工作目录（目录选择框、最近工作目录列表、空态入口）；
2. 多个工作目录并排为标签页，可切换活动项；
3. 关闭工作目录；
4. 对话归属于工作目录，运行时按对话解析工作目录；
5. 菜单收编为单一图标入口；
6. 无工作目录时的空态引导；
7. 浮窗模式沿用活动工作目录为窗口上下文；
8. 远程终端：为打开的远程（SSH）工作区提供独立终端窗口（见第 14 节）。

---

## 2. 术语与事实来源

| 术语 | 含义 | owner |
| --- | --- | --- |
| 工作目录 | 一个已打开的本地目录绝对路径 | Electron 主进程 |
| 打开集合 | 当前处于打开状态的工作目录，有序，即标签页顺序 | Electron 主进程 |
| 活动工作目录 | 打开集合中当前选中的一项，集合非空时唯一 | Electron 主进程 |
| 标签页 | 打开集合中一项在标题栏的呈现 | Electron 标题栏 |
| 对话的工作目录 | 对话归属的工作目录，写入对话元数据 `project` | core |
| 会话工作目录表 | 进程内 `sessionId → 工作目录` 映射 | core |
| 宿主会话工作目录索引 | 进程内 `sessionId → 工作目录` 映射 | Electron 主进程 |
| 最近工作目录 | 历史打开过的目录，去重、有序、有上限 | Electron 主进程 |
| 工作区代理身份 | `<机器名>:<工作区路径>`，跨工作区代理的寻址键（本地取机器名，远程取 SSH 目标主机） | Electron 主进程（`src/host/workspaceIdentity.ts`） |
| 跨工作区子代理 | 运行时在目标工作区 Core、创建者在发起方 Core 的子代理会话 | 目标工作区 Core（会话事实）+ 发起方 Core（登记与槽位） |
| 占位父对话 | 目标工作区列表里代表发起方会话的容器节点，由子代理 meta 的 `crossWorkspaceOrigin` 派生 | 列表读取方 |

「工作目录」与现有代码里的「工作区（workspace）」指同一事物；路径按规范化绝对路径参与去重。

---

## 3. 工作目录模型

- 打开集合可含 0 到 N 项。
- 集合内按规范化绝对路径去重，同一目录至多出现一次。
- 新添加的工作目录追加到集合末尾，并成为活动项。
- 已存在于集合中的目录再次添加时，不重复入集合，直接切换为活动项。
- 活动项唯一。关闭活动项后，活动权移交给集合中与它相邻的项；集合为空时无活动项。
- 关闭非活动项不改变活动项。
- 集合为空即「无工作目录」态。

---

## 4. 对话与工作目录（架构）

### 4.1 对话的工作目录

- 对话创建时归属当时的活动工作目录，该归属写入对话元数据（`ConversationMetadata.project`）。
- 对话的工作目录是对话的固有属性，在对话生命周期内保持不变。
- 子对话（子代理）归属其父对话的工作目录；**例外**：跨工作区子代理（`Agent.target`）
  归属目标工作区，发起方只保留「远程子代理」登记与并发槽位。
- 打开历史对话时，以该对话自己的工作目录为上下文，与当前活动标签页无关。

### 4.2 会话工作目录表（core）

core 持有进程级映射 `sessionId → 工作目录`。登记时机：

| 时机 | 来源 |
| --- | --- |
| 新建 / 加载对话 | 宿主在会话首次被 core 解析目录之前登记（Electron 主进程按来源视图解析，见 4.3；VS Code 用宿主当前工作目录） |
| 加载对话（读盘后校正） | 对话元数据的 `project` |
| 子对话 / 子代理 | 继承父对话的工作目录 |

解析规则：core 内所有需要工作目录的调用按 `sessionId` 查表；未登记时
`getProjectRoot(sessionId)` 抛错、`hasProjectRoot(sessionId)` 为假（按「无工作目录」降级，
不退回进程启动目录）。core 没有「活动工作目录」这一进程级概念——「哪个对话在前台」
是 UI 自己的状态。

对话列表缓存按工作目录分桶：每个工作目录各有一份磁盘列表缓存，切换活动项不互相清空。
读取列表的入口接收显式工作目录参数（`loadConversationList(workspacePath)`）。

### 4.3 宿主会话工作目录索引（Electron 主进程）

主进程持有进程级映射 `sessionId → 工作目录`，来源：

| 来源 | 内容 |
| --- | --- |
| 各工作目录的对话列表 | 列表元素的 `project` 字段 |
| 新建对话 | 当时的活动工作目录 |
| 子对话 | 继承父对话 |

用途：

- 打开某个对话时，为该对话的聊天视图注入它自己的工作目录（`--workspace=`），而非活动工作目录；
- 在会话被 core 解析目录之前登记到 core（`registerCoreSessionWorkspace`）；
- 关闭工作目录时判断哪些对话视图属于该目录。

### 4.4 按会话解析的消费点

| 消费点 | 工作目录来源 |
| --- | --- |
| 历史读写（会话文件 / 元数据 / 压缩归档路径） | 会话工作目录表 |
| 工具结果目录 | 会话工作目录表 |
| 项目级 MCP 配置 | 会话工作目录表 |
| 权限判定 / 相对路径展开 | `ToolUseContext.cwd`（引擎的 `config.cwd`） |
| 引擎 `cwd` | 创建 / 恢复引擎时取对话工作目录 |
| 系统提示 / 技能目录 | 会话工作目录表 |
| Spin 运行器 `cwd` | 父引擎的 `cwd` |
| 资源定位（ripgrep 的兜底路径） | 应用 / 扩展根目录（不使用对话工作目录） |

### 4.5 引擎 cwd

- 每个 `QueryEngine` 持有自己的 `cwd`，创建 / 恢复时由对话工作目录填入。
- 工具执行上下文沿用引擎 `cwd`；工具展开相对路径以该 `cwd` 为基准，不读进程级全局值。
- `ToolUseContext` 同时携带 `cwd` 与 `sessionId`，作为工具侧的唯一工作目录来源。

---

## 5. 标签页

- 位置：标题栏中，原菜单栏所在区域。
- 每张标签页展示工作目录名（路径 basename）；远程为 `目录名@主机名`（如
  `TEST@192.168.1.1`），目录名在前以便标签页收窄时先截掉主机名。悬停提示完整路径。
- 活动标签页高亮。
- 每张标签页提供关闭入口。
- 右键标签页弹出原生上下文菜单（渲染层只上报标签 id，`titlebar:tab-context-menu`；
  主进程 `Menu.popup` 在光标处弹出，与「添加工作区」加号菜单同形态）：关闭 / 关闭所有
  空闲会话 / 关闭其它所有工作区 / 打开命令行（本地工作区）或打开终端（远程工作区，
  见第 14 节），置灰规则见 8.2 节。「打开命令行 / 打开终端」条目尾随显示「打开终端」
  快捷键的当前值（与主菜单条目同源取宿主本地偏好，见第 7 节）。原生菜单无法被
  Playwright 驱动，交互按 US-48 豁免人工验证。
- 标签页支持拖拽调整顺序：拖到目标标签页前半 / 后半即插到其前 / 后，顺序写入打开集合并持久化。
- 快捷键切换相邻标签页：「下一标签」（默认 Ctrl+Tab）/「上一标签」（默认 Ctrl+Shift+Tab）
  按打开集合顺序把活动项移向相邻一项，末项向后环绕回首项、首项向前环绕到末项；
  打开集合不足 2 项时不动作。组合键可在偏好设置窗口录制改键（见第 7 节），
  动作经菜单动作表下发，主窗口内焦点在侧栏 / 标题栏 / 聊天区任意一处均生效。
  浮窗模式下不动作（浮窗只呈现活动工作目录的对话，不呈现标签页区，见第 10 节）。
- 首次启动为非活动标签页预加载聊天视图（后台加载并渲染页面，跳过会话初始化）；
  切换标签页时直接呈现已加载的视图，不出现空白闪烁。
- 标签页总宽超过可用宽度时逐张收窄，收窄到下限后横向滚动。
- 打开集合为空时不渲染标签页区域。
- 同一对组合键在终端窗口内切相邻终端标签（终端窗口自己的标签，见 14.4 节）。

---

## 6. 标题栏

- 完整模式从左到右：品牌区（logo + 产品名）、单一菜单图标、工作目录标签页区、
  弹性空白、置顶按钮、模式切换按钮、窗口控制按钮。
- 单一菜单图标即顶层菜单入口，取代分区并排的菜单栏。
- 浮窗模式隐藏单一菜单图标与标签页区，品牌位显示活动工作目录名（沿用现有形态）。
- macOS：标题栏沿用系统菜单栏与系统红绿灯；自绘标题栏只呈现品牌区与工作目录标签页区，
  不渲染单一菜单图标（顶层菜单在系统菜单栏里，已有 `buildMenuSections` 的 macOS 分区）。

---

## 7. 菜单

- 顶层菜单以单一图标按钮表示，点击展开单一菜单面板；再次点击收起；Esc 收起。
- 菜单面板条目：

| 条目 | 行为 |
| --- | --- |
| 打开本地工作区...（Ctrl+O） | 打开系统目录选择框，选中目录加入打开集合 |
| 打开远程工作区...（Ctrl+Shift+O） | 打开远程工作区对话框（SSH 接入，连远端 Core 后弹远端目录选择） |
| 打开最近的工作区 ▸ | 子菜单列出最近工作目录，点击即添加 |
| 下一标签（默认 Ctrl+Tab） | 活动项切到打开集合顺序的下一张标签页，环绕规则见第 5 节 |
| 上一标签（默认 Ctrl+Shift+Tab） | 活动项切到打开集合顺序的上一张标签页，环绕规则见第 5 节 |
| 打开命令行 / 打开终端（默认 Ctrl+Alt+T） | 打开活动工作区的命令行（本地）或 SSH 终端窗口（远程），按端点分叉、与标签页右键同一套入口语义与置灰规则（见 14.1 节）；无活动工作区或入口不可用时条目置灰、组合键不动作 |
| 偏好设置... | 打开偏好设置窗口：主题单选、快捷键录制（唤醒 / 下一标签 / 上一标签 / 打开终端四行逐行录制）、提示音开关与音量（见 [docs/architecture/contracts.md 第 5 节](../architecture/contracts.md#5-宿主侧入口动作翻译为-uievent)） |
| 开发者工具 | 在独立窗口打开 / 关闭开发者工具 |
| 关于 | 显示关于对话框（自绘消息框 `electron/styledMessageBox.ts`，与应用深浅主题一致，含版本号） |
| 退出 | 退出应用 |

- 「打开最近的工作区」子菜单在无可用最近目录时显示不可用占位项。
- 菜单动作与快捷键绑定沿用同一份动作表（原生菜单与自绘菜单同源）。
- 三条可录制快捷键（下一标签 / 上一标签 / 打开终端）可录制改键，默认下一标签
  Ctrl+Tab、上一标签 Ctrl+Shift+Tab、打开终端 Ctrl+Alt+T；组合键持久化在宿主本地
  状态文件（见第 11 节），缺失 / 非法按默认值生效。录制中按 Esc 取消、原值保持；
  录制组合与任一既有绑定冲突（三条可录制快捷键互撞、菜单既有组合 Ctrl+O /
  Ctrl+Shift+O / Ctrl+Shift+I、当前唤醒快捷键）时拒绝保存，行内显示冲突原因；
  保存后重建菜单动作表即时换绑。唤醒快捷键的录入路径不做冲突检测（既有口径不变）。
  快捷键全部只应用内生效（原生菜单 accelerator 与无边框窗口的 before-input-event
  兜底），不做全局注册——`globalShortcut` 仍只用于唤醒快捷键。

---

## 8. 添加与关闭工作目录

### 8.1 添加

- 入口：菜单「打开本地工作区...」、菜单「打开最近的工作区」、空态按钮、空态最近列表项。
- 「打开本地工作区...」打开系统目录选择框，支持一次选择多个目录；确认后按选择顺序把所选目录
  加入打开集合，最后一个成为活动项。
- 已存在于集合中的目录直接切换为活动项，不重复入集合。
- 添加成功后该目录写入最近工作目录（置顶、去重、上限 20）。
- 最近列表只展示仍然存在的目录。

### 8.2 关闭

- 入口：标签页关闭按钮。
- 关闭把该目录移出打开集合，并按第 3 节规则更新活动项。
- 关闭同时销毁该目录下所有已打开的对话视图（卸运行时内存），并中止其中运行中的查询；
  磁盘上的对话数据保留。
- 受影响的是该目录已打开的对话视图：视图按工作区稳定 id 登记归属，关闭时逐个销毁。
- 右键菜单的关闭动作（清理链与 `closeWorkspace` 共用，确认语义有差别）：
  - 「关闭」与关闭按钮同一语义：存在忙碌会话先经既有逐区忙碌确认，之后走同一份清理链
    （`teardownWorkspace`）。
  - 「关闭所有空闲会话」只作用于右键的工作区，候选＝该工作区**已打开**的对话视图
    （含子代理对话）：逐个按判定时刻的会话运行时快照判定忙闲（忙碌含等待用户不动），
    空闲即关——当前选中的对话只要空闲也包含在内，关闭后由既有关闭入口切到相邻会话；
    判定与执行分离，执行时逐会话走既有关闭入口——判定后转忙的会话在关闭时刻落入既有
    逐会话忙碌确认（确认则关、取消则跳过继续其余），不静默跳过。只出现在磁盘对话列表、
    本进程没打开过的会话不进候选：它没有可卸的视图与运行时资源，关闭它只会发一条按
    sessionId 路由的 `conversationClosed`，多 Connection 下查不到归属直接抛错（异常还会
    中断整批关闭）。判定纯函数在 `electron/workspaceBatchClose.ts`
    （`selectWorkspaceLoadedSessions` / `selectClosableIdleSessions` /
    `summarizeOtherWorkspaces`），口径由 `src/test/workspaceBatchClose.test.ts` 锁定。
    该工作区没有已打开的空闲对话时菜单项置灰。本地与远程（SSH）工作区同语义。
  - 「关闭其它所有工作区」在任一其它工作区有忙碌会话时先弹**一次**汇总确认（取消则
    全部不动），确认后逐个工作区走同一份清理链（不经逐区确认，否则一次确认被放大成
    每区一次）。只有一张标签时置灰。
  - 「打开命令行」（本地工作区）在该工作区根目录拉起系统终端，与侧栏「在此处打开命令行」
    共用同一实现（detached、不随应用退出）；目录已不存在时置灰。远程（SSH）工作区同位置
    为「打开终端」，打开该工作区的远程终端窗口（可用性口径与行为见第 14.1 节）。

---

## 9. 侧栏

- 头部：搜索框 + 新对话按钮。
- 搜索框按对话标题过滤当前活动工作目录的对话列表；输入即时过滤；清空恢复全部。
- 对话列表展示当前活动工作目录的对话（含子对话树）。
- 跨工作区子代理的占位父对话在列表里以容器节点呈现（标题后带「跨工作区容器」标记），
  不提供重命名 / 智能命名 / 删除入口；点击打开只显示跳转页。
- 容器行的状态灯按其直接子代理会话的运行时聚合派生（specs/024 FR-001）：任一子代理
  等待用户 → 黄色呼吸，否则任一子代理在跑 → 蓝色流水，全部空闲 → 无灯；容器自身
  没有运行时事实，灯是子代理运行时的只读投影（`src/shared/sessionRuntime.ts` 的
  `deriveContainerBusyLevel` 是唯一派生），不挂未读完成呼吸、不触发完成提醒音
  （与本地子代理同口径）；子代理转等待用户的提醒音照常（specs/024 FR-002）。
- 子对话树的默认展开：当前活动会话的祖先链展开（保证选中项可见）；活动会话自身的
  直接子会话数达到 5 时不默认展开（阈值与 webview 对话列表共用
  `src/host/ui/conversationTreeDefaults.ts`），用户点击折叠按钮显式设置后不再被默认
  规则改写。
- 右缘宽度手柄占据侧栏最右侧一条竖带（宽度与 `body` 的右内边距同源）：对话列表 /
  文件树的滚动条在该竖带左侧结束，拖滚动条与拖宽度互不干扰。
- 列表尚未取到时侧栏先留白，等待超过 100ms 仍未取到才显示加载中（快速切换工作区时
  列表毫秒级回包，转圈闪现反而像闪烁）；「暂无对话」只表示列表已取到且为空——
  列表要等 core 连接就绪才能读到，等待态不猜空值。
- 活动工作目录变化时，对话列表随之切换。
- 新对话按钮在活动工作目录下创建对话。

### 9.1 空态

打开集合为空时：

- 侧栏显示「添加工作目录」按钮；
- 按钮下方列出最近工作目录，点击即添加；
- 无最近工作目录时只显示添加按钮；
- 聊天区沿用现有纯提示空态，不提供添加入口。

---

## 10. 浮窗模式

- 切换到浮窗模式时，以当前活动工作目录（即活动对话的工作目录）为窗口上下文。
- 浮窗隐藏侧栏与标签页，只呈现活动对话。
- 打开集合为空时不允许切换到浮窗模式。
- 浮窗标题栏品牌位显示活动工作目录名（远程形态见第 5 节）。
- 浮窗最小化隐藏到系统托盘，不在任务栏保留最小化按钮；唤醒入口为托盘图标与全局快捷键。

---

## 11. 持久化

状态文件（Electron `userData/workspace-state.json`）记录：

| 字段 | 内容 |
| --- | --- |
| `openWorkspaces` | 打开集合，按标签页顺序 |
| `activeWorkspaceKey` | 活动工作区的 refKey；无活动项时为 `null`（旧字段 `activeWorkspace` 仅作本地路径兼容保留） |
| `recentWorkspaces` | 最近工作目录，去重、有序、上限 20 |
| `windowSize` / `floatingWindowSize` | 完整模式 / 浮窗模式的上次位置与尺寸 |
| `nextTabShortcut` / `prevTabShortcut` / `openTerminalShortcut` | 「下一标签 / 上一标签 / 打开终端」快捷键（Electron accelerator 形式）；缺失 / 非法按默认值（Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+Alt+T）生效，读取路径不写回 |
| `viewerWindowRect` / `spinDesignWindowRect` | 查看器窗口名额（Monaco / 图片 / Markdown 共用）与 Spin 设计器窗口的上次位置与尺寸，各自独立存储；开窗前做多屏可见性校验，失效回退默认尺寸（`electron/viewerWindowRect.ts`） |
| `windowMode` / `floatingPinned` | 上次窗口模式与浮窗置顶状态 |

启动时恢复打开集合与活动项；已不存在的本地目录**保留**并标记为不可用（宿主只标记，
不做静默丢弃——该由用户决定何时关闭标签页，与最近列表的「不显示失效项」口径不同）。

一次性迁移：目标状态文件不存在时，从旧版本的状态文件（旧 userData 目录
`<appData>/<productName>`（打包态）/ `<appData>/Electron`（开发态））搬迁，并把旧版本的单个
`lastWorkspace` 提升为 `openWorkspaces` 的唯一一项 + `activeWorkspace`；迁移只做形状过滤
（目录是否仍存在不参与判定），目录已不存在的本地项同样保留、由读取路径标记为不可用；
迁移后不再回退读旧字段。

---

## 12. 不变量

- 打开集合内工作目录按规范化绝对路径唯一。
- 集合非空时活动项唯一存在。
- 对话的工作目录在对话生命周期内不变（跨工作区子代理除外：它归属目标工作区）。
- 工作区代理身份由唯一纯函数计算；同一身份对应多个打开项时 `Agent.target` 报错，不取第一项。
- 占位父对话没有消息文件与会话运行时，只能由带 `crossWorkspaceOrigin` 的子代理 meta 派生。
- 跨工作区跳转只认打开集合；目标未打开时链接不可用，不自动打开工作区。
- 对话的历史读写、工具执行、MCP 配置一律以对话自己的工作目录为准，不读进程级全局值。
- 浮窗模式只呈现活动对话，且其工作目录等于活动工作目录。
- VS Code 宿主不参与本能力。

---

## 13. 验收要点

1. 添加两个目录后出现两张标签页，活动项为最新添加者。
2. 切换标签页时侧栏对话列表与聊天区随之切换。
3. 在标签页 A 新建对话后切到 B，再切回 A，A 的对话仍在 A 的列表中。
4. 在 A、B 分别打开对话，各自的历史文件写入各自目录。
5. 搜索框按标题过滤活动目录的对话列表。
6. 菜单为单一图标；点击展开全部条目。
7. 无工作目录时空态展示添加按钮与最近列表；点击最近项即添加。
8. 关闭标签页后其目录移出集合；关闭活动项后活动权移交相邻项。
9. 关闭标签页销毁该目录下已打开的对话视图并中止运行中查询，磁盘数据保留。
10. 浮窗模式以活动目录为上下文。
11. 重启后恢复打开集合与活动项。
12. 同一目录重复添加不产生第二张标签页。
13. 按 Ctrl+Tab / Ctrl+Shift+Tab 沿标签页顺序切换活动项并环绕；单标签时按键不动作；
    偏好设置窗口录制改键后新组合生效、菜单展示同步。
14. 标签页右键「打开终端」仅远程工作区可用（本地工作区同位置为「打开命令行」）；打开后
    首标签自动连上远端 shell，关闭工作区时其终端窗口一并关闭。
15. 每个工作区的代理身份为「机器名:路径」；`@` 候选排除来源视图自己的工作区。
16. `Agent.target` 指向另一工作区时，子代理对话出现在目标工作区；目标工作区列表里
    占位父对话把子代理挂在发起方会话下，点击占位页可跳回发起方对话。
17. 发起方 abort 能中止目标工作区的跨工作区子代理；目标不可达时按结束收敛。

---

## 14. 远程终端

远程终端是**远程工作区的配套能力**（VS Code 宿主没有）：为远程（`ssh` scheme）工作区的
标签页提供一个独立终端窗口，内含多个终端标签，每个标签是远端机器上的一条 PTY shell
通道。终端不经过 daemon、不经过 Core，直接用 SSH shell 通道；渲染引入 `@xterm/xterm`
做终端仿真（应用内首个使用场景即本节，SSH 侧不引新库）。

### 14.1 入口与可用性

- 入口是标签页右键菜单：远程（SSH）工作区的标签页显示「打开终端」，作用于右键的那张
  标签（不必是活动项）；本地工作区同位置为「打开命令行」（见 8.2 节），两者按端点互斥，
  一张标签只出现其一。
- 「打开终端」仅当该工作区带可用凭证时可点（`canOpenRemoteTerminal`），无凭证置灰；
  右键菜单每次弹出时构建，可用性即时判定，条目 `run` 内再判一次（防弹出与点击之间的
  时序）。
- 同一入口有键盘路径：单一菜单条目「打开命令行 / 打开终端」（随活动工作区端点分叉
  文案与可用性，见第 7 节）与快捷键（默认 Ctrl+Alt+T，可改键）都作用于**活动工作区**，
  与右键菜单共用 `spawnTerminalAt` / `openRemoteTerminalFor` 同一套入口语义；无活动
  工作区或入口不可用时快捷键不动作。侧栏不设入口。

### 14.2 窗口

- 每个工作区一个终端窗口（按 `workspaceRefKey` 单例）：独立 `BrowserWindow`，标题含
  `ssh://<user>@<host>` 与工作区路径，标准标题栏；同一工作区重复触发入口时聚焦既有窗口，
  不叠开。不同工作区（含同一 endpoint 的不同目录）可同时各开一个窗口。
- 窗口位置尺寸用默认值，不做记忆。终端属于工作区而不属于会话：会话视图的打开 / 关闭 /
  LRU 淘汰、工作区标签切换都不影响终端窗口。
- 页面（`dist/terminal/`）未构建时窗口照常打开、标题追加「页面未构建：
  npm run build:terminal」，错误落日志（`fileLogger` 的 `terminal` 组件），不弹框。

### 14.3 标签

- 窗口内可开多个终端标签（标签条「+」新建、悬停 / 活动标签显示 ✕ 关闭），窗口打开即
  自动建首个标签；每个标签对应远端一条独立的 PTY shell 通道，互不共享输入输出。
- 新标签的起始工作目录为该工作区路径；标签名 `bash N`（窗口内自增）。新建标签后自动
  切到新页。
- shell 因用户退出（`exit` / `logout`，ssh2 的 `exit` 事件）而结束时该标签自动关闭；
  最后一个标签关闭时窗口关闭（窗口出现过标签后才生效——开窗瞬间的空表不触发）。标签带
  运行状态点（绿 = 在跑，红 = 断开）；标签条形态对齐主窗口标题栏的工作区标签
  （[第 6 节](docs/hosts/electron-multi-workspace.md#6-标题栏)）：全高上圆角标签、活动标签实色底
  并与标签条 4px 底边线同色、未选中标签之间竖线分隔。

### 14.4 交互

- 终端数据按字节流直达渲染端（UTF-8 由 xterm 增量解码），宿主不按行重组、不解析内容；
  键入经主进程写通道 stdin，写满时等 drain 再写后续（不丢键入）。
- 窗口尺寸变化实时同步远端 PTY（`setWindow`）：通道建立以发起时刻的窗口尺寸为 PTY 初值，
  就绪前的 resize 先记账、就绪后补齐。滚动回看缓冲不少于 1000 行。
- 剪贴板：Windows / Linux `Ctrl+Shift+C` / `Ctrl+Shift+V`，macOS 沿 `Cmd+C` / `Cmd+V`
  （有选区才拦复制）；读写走主进程 `clipboard` 模块（渲染端剪贴板权限不可依赖）。
- 标签切换快捷键：「下一标签 / 上一标签」（与工作区标签页同一组合与改键偏好，见第 5 节）
  在终端窗口内切相邻终端标签，环绕规则同一份纯函数（`selectAdjacentId`）；不足 2 个标签
  或活动标签不在表里时不动作。终端窗口是独立窗口、无菜单栏，组合键由主进程
  `before-input-event` 拦截（无原生 accelerator 通道）后把方向推给渲染端
  （`terminal:switch-tab`），目标计算与点击激活同一条渲染端管线；改键保存即时换绑
  （`writeTabShortcut` 经 `applyTerminalShortcuts` 同步到已开的终端窗口）。

### 14.5 连接复用与鉴权

- shell 通道开在与侧栏文件浏览器同一 endpoint 连接池上（`sharedClientFor`，按
  `sshTargetKey` 缓存）：同一条 SSH 连接多路复用，口令鉴权与主机密钥 TOFU 不重复发生。
- 终端窗口打开期间对该连接登记一份租约（`retainRemoteFilesClient`），与工作区租约独立
  计数，全部归零才真正断开。
- 终端是该 endpoint 首个使用者且主机密钥与 known-hosts 记录不一致时，走与远程接入同一套
  的告警确认（`confirmHostKeyChange`）；确认后 `recordKnownHostFingerprint` 重建信任并
  重试一次，拒绝则失败原样呈现。

### 14.6 断开语义

- 通道结束按两个事件判别：`exit` 先行（远端 shell 正常退出）→ 标签自动关闭（14.3）；
  无 `exit` 先行的 `close`（SSH 连接断开 / 通道层错误）→ 标签转「已断开」态，标签页内
  以覆盖层呈现原因（通道 error 优先，缺省给固定文案）与「重新连接」按钮。
- 建链中（connecting，含新标签与重连）的覆盖层以对话加载同款的 logo 动画呈现
  （波纹 + logo + 弹跳圆点，形态对齐聊天侧 `ConversationLoading`）——连接中不是错误，
  红色警示图标只属于断开态。
- 重连只作用于单个标签、以当下窗口尺寸重建一条 shell，不自动重连、不批量复活其它标签。
  断开态与建链中（connecting）的键入直接丢弃（界面上该标签不在可输入态，设计允许的
  瞬时 no-op）；连接失败（认证失败 / 不可达）同样进断开态，不清除已存凭证、不新增
  口令输入框（重新走「打开远程工作区」接入即可更新凭证）。

### 14.7 生命周期

- 关闭工作区（`teardownWorkspace`）时其终端窗口一并关闭；应用退出（`will-quit`）时全部
  终端窗口关闭并同步销毁通道，先于 SSH 连接池的统一释放。
- 远端不留孤儿进程：shell 生命周期就是 SSH 通道生命周期，连接断开后 PTY 内进程由 sshd
  回收，宿主不做额外的进程清理协议。关标签先尽力发 SIGHUP（远端 Windows sshd 不支持
  信号则忽略）再发 EOF。

### 14.8 数据面与外观

- 终端的输入输出走独立的 `terminal:*` IPC 面（`electron/terminalPreload.ts` 暴露
  `window.terminalAPI`），不进入对话 webview 的消息协议、不进入 `AssistantEventBus`；
  终端大量输出只进自己的渲染器，主窗口（对话）不经手。
- 标签表（id、名称、状态、失败原因）的 owner 在主进程（`electron/terminalShells.ts` 的
  `TerminalSessionGroup`），每次变化整表推送；渲染端（`electron/terminal/`）是纯投影，
  只回传动作。
- 主题即时跟随应用主题（`nativeTheme` 推送，深浅两套 ANSI 配色）；界面语言与字号档位在
  窗口创建时经 query 注入、运行期变更不热切到已开的终端窗口（字号档位映射见
  `terminalFontSizePx`）。
- 配色基线是 MobaXterm 的默认方案（`electron/terminal/xtermThemes.ts`）：深色取
  `MobaXterm.ini` 的 `[Colors]` 原值（底色 `#1e1e1e`、前景 `#ececec`、光标 `#b4b4c0`
  与十六色），浅色是同色相的白底加深版（底色 `#ffffff`）。配色表只决定「用哪个颜色」，
  彩色前后景组合（`ls` 的 777 目录是蓝字绿底）由 xterm 的 `minimumContrastRatio`
  在渲染时把前景色向黑 / 白收敛到 4.5:1（WCAG AA）——不为了对比度改动 MobaXterm 的原色。
- 页面底色与 xterm 底色同源：`--term-bg` 由 `applyTheme` 从配色表注入，样式表里的值只用于
  JS 接管前的首帧；xterm viewport 的默认黑底（画布整行取整余量处会露出）也换用同一变量，
  不在窗口底部留黑边。
- 终端滚动条是 xterm 的 DOM 滑块（VS Code 式，`::-webkit-scrollbar` 管不到）：宽度 / 圆角
  与 Electron 原生页面的统一滚动条（`electron/ui/scrollbar.css`）一致，宽度由页面样式压过
  xterm 写进内联样式的默认值；滑块配色取该文件同一组值，在 `electron/terminal/xtermThemes.ts`
  的配色表里同步维护（xterm 公开 API 只暴露滑块颜色）。

---

## 15. 落点对照

| 规格项 | 现有落点 |
| --- | --- |
| 工作目录单值 | `electron/main.ts` 的 `workspacePath` |
| 最近工作目录 / 状态文件 | `electron/workspaceStateStore.ts` 的 `readWorkspaceState` / `writeWorkspaceState` / `saveOpenWorkspaces` |
| 菜单定义与动作表 | `electron/main.ts` 的 `buildMenuSections` / `setupMenu` / `invokeMenuAction` |
| 标签页相邻切换 | `electron/tabSwitching.ts` 的 `selectAdjacentId`（工作区与终端标签共用）；动作接线 `electron/main.ts` 的 `switchToAdjacentWorkspace` 与 `electron/terminal/main.ts` 的 `switchTabByShortcut` |
| 标签快捷键偏好 | `electron/shortcut.ts` 的 `DEFAULT_NEXT_TAB_SHORTCUT` / `DEFAULT_PREV_TAB_SHORTCUT` / `DEFAULT_OPEN_TERMINAL_SHORTCUT` / `findShortcutConflict`；持久化字段 `electron/workspaceStateStore.ts` 的 `nextTabShortcut` / `prevTabShortcut` / `openTerminalShortcut` |
| 自绘菜单渲染 | `electron/titlebar/main.ts` 的 `renderMenubar`、`electron/titlebarMenuHtml.ts` |
| 标题栏品牌 / 模式状态 | `electron/titlebar/main.ts` 的 `applyModeState`、`electron/main.ts` 的 `pushTitlebarModeState` |
| 侧栏头部 | `electron/sidebar/index.html` 的静态 `.header`；数据刷新走 `electron/sidebar/main.ts` 的 `render()` |
| 侧栏对话列表 | `electron/sidebar/main.ts` 的 `render`、`sidebar:conversations-updated` 流 |
| 远程终端窗口 | `electron/terminalWindow.ts` 的 `openTerminalWindow` / `closeTerminalWorkspace` / `closeAllTerminalWindows`；挂点 `electron/main.ts` 的 `popupTabContextMenu`（条目）/ `teardownWorkspace` / `will-quit` |
| 终端标签 / 通道状态机 | `electron/terminalShells.ts` 的 `TerminalSessionGroup`；单测 `src/test/terminalShells.test.ts` |
| 终端 SSH shell 通道 | `src/host/standalone/sshClient.ts` 的 `openShell`；连接复用 `electron/sidebarFilesRemote.ts` 的 `sharedClientFor` |
| 终端页面 | `electron/terminal/`（vite 入口 `vite.terminal.config.ts` → `dist/terminal`）；preload `electron/terminalPreload.ts` |
| 终端 e2e | `e2e/terminal/terminalUi.spec.ts`（假通道驱动真实页面，project `terminal-ui`） |
| 对话列表加载 | `src/host/coreFacts.ts` 的 `loadConversationListForHost`（`UiRequest.conversationListRequested`；落盘读取库 `src/shared/history/Conversation.ts` 服务宿主侧例外） |
| 对话元数据 | `src/shared/history/Conversation.ts` 的 `ConversationMetadata.project` |
| 项目根解析 | 宿主侧索引 `src/shared/history/Config.ts` 的 `getSessionWorkspace` / `setSessionWorkspace`（权威表在 Core 进程内：目录是对话的属性） |
| 宿主工作目录传递 | `src/host/ui/webviewMessageHandler.ts` 的 `ensureSessionWorkspace`：新建 / 加载对话时按来源视图登记会话工作目录；`src/host/UIHost.ts` 的 `WorkspaceProvider.getWorkspacePath` 提供宿主当前目录（对话列表、Spin 设计器消费） |
| 聊天视图工作目录 | `electron/ChatViewManager.ts` 的 `createView`（`--workspace=` 参数） |
| 工作区代理身份 | `src/host/workspaceIdentity.ts` 的 `resolveMachineName` / `workspaceAgentId`；`src/host/ui/webviewMessageHandler.ts` 的 `handleRequestWorkspaces` |
| 跨工作区派发 | `src/host/WebViewUI.ts` 的 `requestCrossWorkspaceAgent`（`CoreRequest.crossWorkspaceAgentRequested`）；`src/host/crossWorkspaceRouting.ts` 的 `resolveCrossWorkspaceTarget` |
| 跨工作区子代理会话 | `core-rs/src/engine.rs` 的 `start_remote_sub_agent` / `spawn_remote_agent`；`core-rs/src/history.rs` 的 `create_remote_sub_agent_metadata` |
| 占位父对话 | `core-rs/src/history.rs` 与 `src/shared/history/Conversation.ts` 的列表派生；`electron/sidebar/main.ts` 的占位行渲染 |
| 跨工作区跳转 | `electron/main.ts` 的 `showCrossWorkspacePlaceholder` / `jumpToCrossWorkspaceConversation`；`electron/chatPlaceholderHtml.ts` 的 `crossWorkspaceAgent` |
| 工具工作目录 | `src/shared/tools/Tool.ts` 的 `ToolUseContext.cwd`（Core 侧工具执行以它为基准展开相对路径） |
| 引擎 cwd | Core 进程内的会话引擎（`core-rs/src/engine.rs`，随会话工作目录派生） |
| 浮窗模式 | `electron/main.ts` 的 `applyWindowMode` / `canToggleWindowMode` / `workspaceDisplayName` |
