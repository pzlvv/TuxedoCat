---
status: 已收敛
---

# 改动规格：桌面端交互修复（工具卡片 / 侧栏 / 对话树 / 模型恢复）

本次改动收敛一组桌面端（webview + Electron 宿主）的交互缺陷与一处跨端行为约定：Bash 长
输出折叠条的形态、侧栏右缘手柄与滚动条互相遮挡、选中对话的子代理默认展开量、切换工作区
标签页时文件浏览器的过渡动画、远程（SSH）工作区的批量关闭空闲会话、对话模型身份的落盘
与恢复口径、文件浏览器刷新后的滚动位置。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/features/user-stories.md](../../docs/features/user-stories.md) | US-14 工具调用卡片 | 修改 | Bash 折叠提示条的分割线与展开后让位 |
| [docs/features/user-stories.md](../../docs/features/user-stories.md) | US-1 发送消息 | 修改 | 输入框高度自适应（粘贴多行不出现多余滚动条） |
| [docs/features/user-stories.md](../../docs/features/user-stories.md) | US-19 对话历史与切换 | 修改 | 子代理默认展开上限；模型身份随对话恢复 |
| [docs/features/user-stories.md](../../docs/features/user-stories.md) | US-42 侧栏文件浏览器 | 修改 | 刷新保留滚动位置；切换标签页不播放过渡 |
| [docs/features/user-stories.md](../../docs/features/user-stories.md) | US-44 侧栏宽度拖拽 | 修改 | 手柄与对话列表滚动条分居，互不遮挡 |
| [docs/features/user-stories.md](../../docs/features/user-stories.md) | US-48 标签页右键菜单 | 修改 | 远程工作区同样支持关闭所有空闲会话 |
| [docs/hosts/electron-multi-workspace.md](../../docs/hosts/electron-multi-workspace.md) | 8.2 关闭 | 修改 | 批量关闭空闲会话覆盖远程工作区 |
| [docs/hosts/electron-multi-workspace.md](../../docs/hosts/electron-multi-workspace.md) | 9. 侧栏 | 修改 | 文件浏览器的滚动位置与切换动画口径 |
| [docs/hosts/host-matrix.md](../../docs/hosts/host-matrix.md) | 12. 宿主固有差异（有意保留） | 修改 | 侧栏文件浏览器的过渡 / 滚动行为补充 |
| [docs/hosts/webview-facts.md](../../docs/hosts/webview-facts.md) | 5. 会话配置的下发时机 | 修改 | 模型身份恢复的取值口径 |

## 用户场景与验收标准

- 场景 1：Bash 长输出的折叠与展开
  - **AC-1**（FR-001）：GIVEN 一次 Bash 调用的输出行数超出一屏 WHEN 执行完成 THEN 输出框上方显示提示条，提示条与输出框之间有一条分割线。
  - **AC-2**（FR-001）：GIVEN 上述提示条处于显示状态 WHEN 点击提示条 THEN 提示条不再占据空间，输出框高度增加提示条原有的高度，卡片总高度与展开前相同。
- 场景 2：侧栏滚动条与宽度手柄
  - **AC-3**（FR-002）：GIVEN 侧栏对话列表可滚动 WHEN 指针位于列表滚动条上按下并拖动 THEN 列表滚动位置改变，侧栏宽度不变。
  - **AC-4**（FR-002）：GIVEN 侧栏 WHEN 指针位于侧栏右缘手柄上按下并拖动 THEN 侧栏宽度改变，且滚动条与侧栏右缘之间留有空隙（浅色主题下滚动条不与右边框相接）。
- 场景 3：选中对话的子代理默认展开
  - **AC-5**（FR-003）：GIVEN 某对话有 5 个及以上直接子会话 WHEN 该对话成为当前选中对话 THEN 其子会话列表默认折叠。
  - **AC-6**（FR-003）：GIVEN 某对话有 4 个及以下直接子会话 WHEN 该对话成为当前选中对话 THEN 其子会话列表默认展开。
  - **AC-7**（FR-003）：GIVEN 用户对某对话显式折叠或展开了子会话列表 WHEN 对话列表数据刷新 THEN 保持用户的显式选择，不因自动展开规则改变。
  - **AC-8**（FR-003）：GIVEN 当前选中对话是某个对话的子会话 WHEN 对话列表数据刷新 THEN 其祖先对话保持展开，使选中项可见。
- 场景 4：切换工作区标签页时的文件浏览器
  - **AC-9**（FR-004）：GIVEN 工作区 A 的文件浏览器展开、工作区 B 的文件浏览器折叠 WHEN 把活动工作区从 A 切到 B THEN 文件浏览器直接呈现 B 的折叠状态，不播放展开 / 折叠过渡，也不播放内容淡入。
  - **AC-10**（FR-004）：GIVEN 文件浏览器处于折叠态 WHEN 点击分区条展开 THEN 播放展开过渡与内容淡入。
- 场景 5：远程工作区的批量关闭空闲会话
  - **AC-11**（FR-005）：GIVEN 一个远程（SSH）工作区标签页，其下有处于空闲状态的对话 WHEN 在标签页上右键并点击「关闭所有空闲会话」THEN 该工作区内全部空闲对话被关闭，忙碌对话与其它工作区不受影响。
  - **AC-12**（FR-005）：GIVEN 远程工作区标签页 WHEN 弹出右键菜单 THEN「关闭所有空闲会话」在该工作区存在空闲对话时可用、不存在时置灰。
- 场景 6：对话模型身份的落盘与恢复
  - **AC-13**（FR-006）：GIVEN 某对话上一次使用的模型身份为（provider P，model M）且 P / M 仍在当前配置中 WHEN 从磁盘加载该对话 THEN 会话模型身份为（P，M）。
  - **AC-14**（FR-006）：GIVEN 该对话记录的 provider 已从配置移除、或记录的 model 不在该 provider 的模型列表中 WHEN 从磁盘加载该对话 THEN 会话模型身份回退到默认模型（provider 仍在时为该 provider 的默认模型，provider 已移除时为 active provider 的默认模型），并把回退结果写回 `meta.json`。
  - **AC-15**（FR-006）：GIVEN 该对话的 `meta.json` 未记录模型身份 WHEN 从磁盘加载 THEN 使用 active provider 的默认模型，且不回写 `meta.json`。
- 场景 7：文件浏览器刷新
  - **AC-16**（FR-007）：GIVEN 文件浏览器树已滚动到某个位置 WHEN 点击刷新按钮 THEN 刷新完成后树的滚动位置与刷新前一致（内容高度不足时贴底）。
- 场景 8：多行输入框高度自适应
  - **AC-17**（FR-008）：GIVEN 多行输入框为空 WHEN 粘贴或输入两行文本 THEN 输入框高度恰好容纳两行内容，不出现滚动条。
  - **AC-18**（FR-008）：GIVEN 多行输入框内容行数在 1 到 12 行之间 WHEN 输入或粘贴 THEN 不出现滚动条，高度与内容一致。
  - **AC-19**（FR-008）：GIVEN 多行输入框内容超过 12 行 WHEN 继续输入 THEN 高度停在上限并出现框内滚动条。

## 功能需求

### FR-001：Bash 折叠提示条的形态

Bash 工具卡片在输出行数超出一屏时显示折叠提示条：

- 提示条位于输出框上方（tail 变体：显示的是输出的末尾段，chevron 朝上）；
- 提示条与输出框之间有一条分割线（提示条下边线），提示条不自绘其它边框——命令卡片已有外框，双圈是禁止形态；
- 展开后提示条不再占据布局空间，其高度让给输出框：输出框高度 = 折叠态高度 + 提示条高度；
- 展开前后卡片总高度不变（不产生布局跳动）。

### FR-002：侧栏右缘手柄与滚动条分居

侧栏宽度拖拽手柄吸附在侧栏右缘、覆盖侧栏最右侧一条固定宽度的竖带；对话列表与文件树的滚动容器在该竖带左侧结束，使滚动条与手柄不重叠。

- 滚动条区域只响应滚动，手柄区域只响应宽度拖拽；
- 浅色主题下侧栏右边框位于手柄外侧，滚动条不与之相接；
- 手柄宽度、滚动条宽度与留白宽度同源（同一常量）。

### FR-003：选中对话的子代理默认展开上限

对话列表（webview 对话树与 Electron 原生侧栏）的默认展开规则：

- 当前选中对话的祖先链默认展开，保证选中项可见；
- 当前选中对话自身的子会话列表：直接子会话数小于 5 时默认展开，达到 5 及以上时默认折叠；
- 默认展开只在用户尚未对该对话显式设置过展开状态时生效；用户显式设置后（无论展开还是折叠），后续列表数据刷新不再改写它；
- 阈值是一份事实，webview 与 Electron 侧栏共用同一常量。

### FR-004：切换工作区标签页时文件浏览器不做过渡

文件浏览器的展开 / 折叠过渡（`flex-basis` 过渡与内容淡入）只在用户点击分区条时播放；因切换活动工作区导致的状态变化直接生效，不播放过渡与淡入。

每个工作区各自持有文件浏览器的展开状态、树缓存与滚动位置（既有行为保持）。

### FR-005：远程工作区的批量关闭空闲会话

标签页右键菜单的「关闭所有空闲会话」对远程（SSH）工作区与本地工作区同语义：

- 范围是右键工作区内的对话，忙碌（含等待用户输入）不动，空闲即关；
- 该工作区存在空闲对话时菜单项可用，否则置灰；
- 工作区的会话归属在对话列表到达后即可判定——远程工作区的列表晚于工作区激活到达（建链需要时间）不导致归属缺失；
- 远程目录路径按目标机器上的字符串判等，不做本地路径规范化。

### FR-006：对话模型身份的落盘与恢复

- 会话的模型身份（provider + model）随会话落盘到 `meta.json`；
- 从磁盘加载会话时优先使用 `meta.json` 记录的模型身份；
- 记录的身份在当前配置中不成立时回退到默认模型：provider 仍在配置中而 model 不在其模型列表 → 该 provider 的默认模型；provider 已不存在 → active provider 的默认模型；回退结果写回 `meta.json`；
- `meta.json` 未记录身份时使用 active provider 的默认模型，不回写。

### FR-007：文件浏览器刷新保留滚动位置

点击文件浏览器的刷新按钮后，树重新读盘期间与读盘完成后，滚动容器的滚动位置与刷新前一致；内容高度不足以承载原位置时贴底。

### FR-008：多行输入框高度自适应

多行输入框（主输入框与询问回复框）的高度随内容行数自适应：内容在 1 到 12 行之间时，高度恰好容纳全部内容，不出现滚动条；超过 12 行后高度停在上限，出现框内滚动条。高度上限只有一处来源（`maxRows`），不再由 CSS `max-height` 另设一个像素上限——两者不一致时，库按行数算出的高度会被像素上限截短，内容尚未到上限就先出现滚动条。

## 边界与错误路径

- FR-001：输出行数不足一屏（无提示条）时输出框保持自然高度，不出现滚动条；流式输出期间不显示提示条。
- FR-002：窗口极窄（侧栏被压缩到最小宽度）时手柄与滚动条仍不重叠；文件树折叠时不渲染树，留白不影响列表滚动条。
- FR-003：对话列表为空 / 当前无选中对话时不存在默认展开；直接子会话数恰好为 5 时不自动展开。
- FR-004：切换工作区时目标工作区状态与当前一致（都展开或都折叠）时无可见变化；折叠状态下不渲染树（既有懒加载口径不变）。
- FR-005：该工作区没有任何对话时菜单项置灰；判定为空闲后转忙的对话走既有逐会话忙碌确认，不静默跳过。
- FR-006：配置快照不可读（未就绪）时不做回退猜测，保持未到达；`meta.json` 不存在时不创建。
- FR-007：刷新期间用户手动滚动时，以用户的最新滚动位置为准，不再回填刷新前的位置。

## 非目标

- 不改变对话列表的排序、分页与搜索口径。
- 不改变文件浏览器的懒加载、选择模型与右键菜单项集合。
- 不改变 Electron 侧栏宽度的手柄命中宽度、上下限与持久化口径。
- 不为远程（SSH）工作区的文件浏览器与批量关闭补 e2e 驱动（需要真实 SSH 远端，沿用既有豁免口径）。
- 不改变 `meta.json` 的字段名与扁平结构（`model` / `provider` 顶层字段）。

## 对需求基线的影响

无新增 US。修改 US-14 / US-19 / US-42 / US-44 / US-48 的既有验收标准，并给 US-19 增加
一条「模型身份随对话恢复」的验收标准；这些 US 已有 e2e 覆盖（`e2e/webview/sessions.spec.ts`、
`e2e/electron/fileExplorer.spec.ts`、`e2e/webview/bashOutputCollapse.spec.ts`），本次在同
用例文件内扩展。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `src/webview/tools/Bash.tsx`、`src/webview/tools/previewLimit.tsx` | `e2e/webview/bashOutputCollapse.spec.ts` | 自动 |
| FR-002 | `electron/sidebar/styles.css` | `e2e/electron/fileExplorer.spec.ts` | 自动 |
| FR-003 | `src/host/ui/conversationTree.ts`、`src/webview/App.tsx`、`src/webview/hooks/handlers/conversationHandlers.ts`、`electron/sidebar/main.ts` | `e2e/webview/sessions.spec.ts`、`src/test/conversationTreeDefaults.test.ts` | 自动 |
| FR-004 | `electron/sidebar/main.ts`、`electron/sidebar/styles.css` | `e2e/electron/fileExplorer.spec.ts` | 自动 |
| FR-005 | `electron/main.ts` | — | 无自动覆盖 + 需要真实 SSH 远端与原生 OS 菜单（Playwright 不驱动），沿用 US-48 的豁免口径 |
| FR-006 | `src/core/history/Conversation.ts`、`src/host/settingsRead.ts`、`src/host/ui/webviewMessageHandler.ts` | `src/test/hostSettings.test.ts`、`src/test/newConversationMetaParity.test.ts` | 自动 |
| FR-007 | `electron/sidebar/main.ts` | `e2e/electron/fileExplorer.spec.ts` | 自动 |
| FR-008 | `src/webview/InputArea.tsx`、`src/webview/UserChoiceOverlay.tsx` | `e2e/webview/inputExtras.spec.ts` | 自动 |

## 待澄清

（无）

## 收敛记录

- 已满足：
  - FR-001 / AC-1、AC-2 → `src/webview/tools/previewLimit.tsx`（`TAIL_HINT_HEIGHT` + tail 变体固定高度与下边分割线）、`src/webview/tools/Bash.tsx`（展开态输出框高度 = 折叠高度 + 提示条高度、展开时不渲染提示条）；证据：`e2e/webview/bashOutputCollapse.spec.ts` 3 用例全绿（缩略态分割线 1px、展开后提示条消失且框高增加约 22px、初始视点仍在底部）。
  - FR-002 / AC-3、AC-4 → `electron/sidebar/styles.css`（`--resize-handle-width` 同时驱动 `body` 右内边距与手柄宽度，滚动条退到手柄竖带左侧）；证据：`e2e/electron/fileExplorer.spec.ts` 的「右缘手柄与对话列表滚动条分居」用例（手柄吸附右缘、列表右缘不进入手柄竖带、列表仍可滚动）。
  - FR-003 / AC-5–AC-8 → `src/host/ui/conversationTreeDefaults.ts`（阈值单一来源）、`src/webview/App.tsx`、`src/webview/hooks/handlers/conversationHandlers.ts`（祖先链只写祖先）、`electron/sidebar/main.ts`（`defaultSubExpanded`）；证据：`src/test/conversationTreeDefaults.test.ts`（5 断言）+ `e2e/webview/sessions.spec.ts` 的「选中对话的子代理默认展开上限」用例（5 个不展开、列表刷新保持、4 个展开）。
  - FR-004 / AC-9、AC-10 → `electron/sidebar/styles.css`（过渡 / 淡入挂在 `.files-anim`）、`electron/sidebar/main.ts`（`setFilesExpanded` 加类、`setFilesWorkspace` 摘类）；证据：`e2e/electron/fileExplorer.spec.ts` 的「切换工作区标签页时文件分区不做过渡动画」用例。
  - FR-005 / AC-11、AC-12 → `electron/main.ts`（推送对话列表时 `syncSessionWorkspaceIndex()`；`sameRemotePath` 抹平远程路径尾分隔符差异，`canonicalWorkspacePath` 同步）；覆盖：无自动覆盖 + 需要真实 SSH 远端与原生 OS 菜单（Playwright 不驱动），沿用 US-48 既有豁免口径。
  - FR-006 / AC-13–AC-15 → 存量实现核对（`src/core/history/Conversation.ts` 落盘、`src/host/settingsRead.ts` 的 `resolveModelRef`、`src/host/ui/webviewMessageHandler.ts` 的校验与 `modelChanged` 回写；Rust 侧同口径）；证据：`src/test/sessionModelRestore.test.ts` 16 断言（真实 `appendMessage` 落盘 → 组装身份 → 合法原样 / 模型失配回退 provider 默认 / provider 移除回退 active 默认 / 未记录取 active 默认不回写）。
  - FR-007 / AC-16 → `electron/sidebar/main.ts`（`WorkspaceFilesState.pendingScrollTop` + `renderFiles` 回填 + 用户滚动即放弃）；证据：`e2e/electron/fileExplorer.spec.ts` 的「刷新后保留文件树的滚动位置」用例（repeat-each=3 全绿）。
  - FR-008 / AC-17–AC-19 → `src/webview/InputArea.tsx`、`src/webview/UserChoiceOverlay.tsx`（去掉与 `maxRows` 冲突的 CSS 像素上限）；证据：`e2e/webview/inputExtras.spec.ts` 的「多行输入框高度自适应」用例（2 行 / 12 行无滚动条、16 行出现框内滚动条）。
- 偏差：
  - FR-006 无代码改动：核对确认两侧 Core 与宿主侧的落盘 / 校验 / 回退链路已就绪，delta 为回归测试与文档口径（追溯矩阵的「实现落点」列按存量实现登记）。
  - 收敛期在本机（Windows 开发机）观察到两处**与本次改动无关**的存量 e2e 不稳定：`e2e/webview/inputExtras.spec.ts` 的 US-6（合成 paste 事件后发送按钮未启用）与 `e2e/webview/sessions.spec.ts` 的 US-20（草稿未带回）——两者在 `git stash` 回 HEAD 后同样失败（US-20 复跑 3 次失败 2 次），登记为环境 / 存量问题，不随本 spec 处理。
  - 顺带修复存量 lint 阻断：`src/test/agentConcurrency.test.ts` 的 `eslint-disable-line @typescript-eslint/no-unreachable-code` 指向不存在的规则名，HEAD 上 `npm run lint` 即报错；改为说明性注释（该规则实际不报此代码）。
- 未做：无。
