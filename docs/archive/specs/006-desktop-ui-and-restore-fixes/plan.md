# 实施方案：桌面端交互修复（工具卡片 / 侧栏 / 对话树 / 模型恢复）

技术路线分七块互不依赖的改动，全部落在 UI 呈现层与宿主接线层，不动总线契约与事件词汇表；
唯一涉及 Core 的是 FR-006，核对后确认两侧 Core 的落盘 / 回退链路已就绪，本次只补回归测试
与文档口径，不新增 Core 行为。指向同目录 `spec.md`。

## 技术方案

### FR-001：Bash 折叠提示条（webview）

- 提示条高度是一份事实：`src/webview/tools/previewLimit.tsx` 新增
  `TAIL_HINT_HEIGHT`（tail 变体的固定高度，含下边 1px 分割线），`PreviewMoreHint` 在
  `tail` 分支上套 `height` + `boxSizing: 'border-box'`，并给 `borderBottom` 一条
  `colors.border` 分割线（默认变体不变，仍自绘左 / 右 / 下三边）。
- `src/webview/tools/Bash.tsx`：输出框高度按状态取 `OUTPUT_BOX_HEIGHT` 或
  `OUTPUT_BOX_HEIGHT + TAIL_HINT_HEIGHT`；展开态渲染时不再输出提示条（`{!expanded && moreHint}`），
  于是提示条让出的高度由输出框接管，卡片总高度不变。
- 现有「展开后钉在底部」的 `useLayoutEffect` 已依赖 `expanded`，无需改动。

### FR-002：侧栏手柄与滚动条分居（Electron 侧栏）

- `electron/sidebar/styles.css`：新增 `--resize-handle-width`（6px），`body` 加
  `padding-right: var(--resize-handle-width)`，`.resize-handle` 的 `width` 复用同一变量。
  手柄仍是 `position: fixed; right: 0`，因此它占据侧栏最右侧那条竖带；`.list` /
  `.files-body` 的滚动条退到竖带左侧，二者不再重叠（浅色主题的 `body` 右边框在手柄外侧）。
- 不改手柄的命中宽度、拖拽实现与持久化口径。

### FR-003：子代理默认展开上限（webview + Electron 侧栏）

- 新增共享常量模块 `src/host/ui/conversationTreeDefaults.ts`：
  `SUBAGENT_AUTO_EXPAND_LIMIT = 5` 与纯函数 `shouldAutoExpandSubSessions(childCount)`。
  两侧对话树（webview 的 `ConversationTreeItem` 渲染源与 Electron 侧栏的 `isSubExpanded`）
  共用它，避免阈值两处漂移。
- webview：`src/webview/App.tsx` 的根节点默认展开条件追加子会话数判定；
  `src/webview/hooks/handlers/conversationHandlers.ts` 的祖先链自动展开不再写「当前会话
  自身」这一项（自身展开交给上面的默认规则 + 用户显式状态），祖先仍强制展开保证选中项可见。
- Electron 侧栏：`electron/sidebar/main.ts` 把 `isSubExpanded` 的默认分支改为
  「活动会话 → 子会话数 < 上限；其余 → 子树含活动会话」，`toggleSubSession` 的默认值
  复用同一函数，保证首次点击与默认状态一致。

### FR-004：切换标签页不播放文件浏览器过渡（Electron 侧栏）

- `electron/sidebar/styles.css`：`flex-basis` 过渡与 `files-body-in` 淡入挂到
  `.files-section.files-anim` 下，默认不播放。
- `electron/sidebar/main.ts`：`setFilesExpanded`（用户点击分区条）先加 `files-anim` 再切
  `expanded`，动画时长后摘除；`setFilesWorkspace`（切换活动工作区）先摘 `files-anim` 再切
  `expanded`，状态直接生效。

### FR-005：远程工作区的批量关闭空闲会话（Electron 主进程）

- `electron/main.ts`：宿主在收到工作区对话列表并推给侧栏时（`sidebar:conversations-updated`）
  立即调用 `syncSessionWorkspaceIndex()`，把该工作区的会话写进「会话 → 工作目录」索引。
  远程工作区建链慢、列表晚于激活到达时，索引不再停留在空集，右键菜单的置灰判定
  （`collectWorkspaceSessionFacts` + `selectClosableIdleSessions`）与执行路径即可用。
- 远程路径判等沿用既有口径（`workspacePathMatches` 远程逐字比较、`canonicalWorkspacePath`
  远程分支返回引用自身的 `path`），不引入本地路径规范化。

### FR-006：模型身份落盘与恢复（核对 + 回归测试）

现状核对（两侧 Core 已就绪，本次不改行为）：

- 落盘：`src/core/history/Conversation.ts` 的 `updateMetadataForNewMessage` /
  `updateConversationContext` 写顶层 `model` / `provider`；Rust 侧 `history.rs` 的
  `create_sub_agent_metadata` / `update_context` 同口径，`engine.rs` 在用户消息带模型时
  `persist_context`。
- 恢复：`src/host/ui/webviewMessageHandler.ts` 的 `handleLoadConversation` 用
  `resolveModelRef(snapshot, getConversationModelRef(metadata))` 校验，失效时经
  `UiEvent.modelChanged` 让 Core 写回 `meta.json` 并同步引擎；`conversationLoaded` 下发
  解析后的身份，webview 用它设置会话模型。TUI 侧同口径（`tui-rs/src/settings.rs`）。
- 本次新增 `src/test/sessionModelRestore.test.ts`：用真实 `appendMessage` 落一条会话的
  `meta.json`，再走 `getConversationModelRef` → `resolveModelRef` 链路，锁定
  「身份合法原样恢复 / 模型失配回退 provider 默认 / provider 移除回退 active 默认 /
  未记录取 active 默认」四条口径，把落盘与恢复两段拼成一条可回归的链。

### FR-007：刷新保留滚动位置（Electron 侧栏）

- `electron/sidebar/main.ts`：`WorkspaceFilesState` 增加 `pendingScrollTop`。
  `refreshFiles()` 在清缓存前记下 `filesBodyEl.scrollTop`；`renderFiles()` 末尾回填该值，
  只有当内容已能容纳（回填后 `scrollTop` 达到目标）才清除；用户在刷新期间手动滚动
  （`filesBody` 的 `wheel` / `pointerdown` / 树 `keydown`）即放弃回填，以用户最新位置为准。

### FR-008：多行输入框高度自适应（webview）

- 现象（实测于 Electron 宿主）：`TextareaAutosize` 按 `maxRows={12}` 算出的高度是
  234px（行高 19.5px），但 className 上还挂着 `max-h-[200px]`——CSS 像素上限把实际
  高度截到 200px，于是 11 / 12 行内容就已经出现框内滚动条（`scrollHeight` 215/234 >
  `clientHeight` 200）。库自身禁止用 `style.maxHeight`（会抛错），class 形式同样冲突。
- 改法：`InputArea.tsx` 与 `UserChoiceOverlay.tsx` 的多行输入框去掉 `max-h-[200px]`，
  高度上限只由 `maxRows` 一份事实决定（超过 12 行由 textarea 自身的 `overflow-y: auto`
  出现框内滚动条）。不加其它高度逻辑：库的实测高度在未到上限时与内容一致。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `src/webview/tools/previewLimit.tsx` | 修改 | 无（新增导出常量 `TAIL_HINT_HEIGHT`） |
| `src/webview/tools/Bash.tsx` | 修改 | 无 |
| `src/webview/InputArea.tsx` | 修改 | 无（去掉与 `maxRows` 冲突的 CSS 像素上限） |
| `src/webview/UserChoiceOverlay.tsx` | 修改 | 无（同上） |
| `src/host/ui/conversationTreeDefaults.ts` | 新增 | 无（纯常量 + 纯函数，被 webview 与 Electron 侧栏共用） |
| `src/webview/App.tsx` | 修改 | 无 |
| `src/webview/hooks/handlers/conversationHandlers.ts` | 修改 | 无 |
| `electron/sidebar/main.ts` | 修改 | 无 |
| `electron/sidebar/styles.css` | 修改 | 无 |
| `electron/main.ts` | 修改 | 无（不新增 IPC 通道） |
| `src/test/conversationTreeDefaults.test.ts` | 新增 | 无 |
| `src/test/sessionModelRestore.test.ts` | 新增 | 无 |
| `e2e/webview/bashOutputCollapse.spec.ts` | 修改 | 无 |
| `e2e/webview/sessions.spec.ts` | 修改 | 无 |
| `e2e/electron/fileExplorer.spec.ts` | 修改 | 无 |

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：新增的 `src/host/ui/conversationTreeDefaults.ts` 是
      无依赖纯模块，不 import 宿主 API、不做宿主嗅探；webview 只经它读常量，不经宿主实现；
      Electron 侧栏本就是宿主渲染层。不涉及 `vscode` / `electron` 的越层引用。
- [x] 架构铁律（[docs/architecture/principles.md](../../docs/architecture/principles.md)）：不引入可选契约成员；FR-006 只做「已保存数据 → 运行时
      身份」的既有校验入口，不新增默认值来源（默认值仍唯一来自 settings 快照）；FR-003 的
      阈值是单一常量，不出现两处写入点；FR-005 只补索引时机，不新增 fallback。
- [x] 两套 Core parity 义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：FR-006 核对后确认两侧 Core 行为一致
      （`history.rs` / `engine.rs` 与 `Conversation.ts` / `Integration.ts` 同口径），本次不
      改任一侧 Core 行为，无需新增对照表项；其余 FR 均在 UI / 宿主接线层。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：落地时同步 US-14 / US-19 / US-42 / US-44 / US-48、
      `docs/hosts/electron-multi-workspace.md`（8.2 / 9）、`docs/hosts/host-matrix.md`（12）、
      `docs/hosts/webview-facts.md`（5）；`npm run test:all -- docs-lint` 必须绿。

## 被否决的替代方案

- **Bash 提示条改用 `visibility: hidden` 保留占位**：不能「空出更多空间显示内容」，
  与 AC-2 相悖；否决。
- **Bash 展开高度用实测提示条高度（ref + state）**：多一次测量与状态往返，且提示条高度
  由固定字号 / 内边距决定，直接给固定高度常量即可满足「总高度不变」；否决。
- **FR-002 改成给滚动容器加 `margin-right`**：只挪动列表与文件树，顶部搜索栏 / 底部
  分区条的右缘仍被手柄覆盖（按钮点不实），且三处留白需各写一遍；改用 `body` 统一内缩，
  一处定义；否决。
- **FR-003 只在 webview 加阈值、Electron 侧栏各自写一份**：阈值两处漂移（改一处忘另一处）
  正是本次要收敛的问题；抽出共享常量；否决。
- **FR-003 让祖先链也遵守「显式状态优先」**：选中子会话时若祖先被用户折叠过，选中项会
  不可见，与 AC-8 相悖；祖先仍强制展开；否决。
- **FR-004 用「加 `no-anim` 类 → 切状态 → 下一帧摘除」**：摘除时 `animation-name` 由
  `none` 变回 `files-body-in` 会重新触发淡入；改为动画只挂在用户点击路径上的
  `files-anim` 类；否决。
- **FR-005 让 `collectWorkspaceSessionFacts` 在菜单弹出时同步读盘**：菜单 `enabled` 是同步
  判定，原生菜单不支持异步置灰；改为在列表到达时更新索引；否决。
- **FR-006 在 Core 侧再加一层模型校验**：宿主已按快照校验并经 `modelChanged` 让 Core 写回，
  再在 Core 加一层会形成两个校验点（同一事实两个写入点），且要同步 Rust 侧与对照表；
  本次只补回归测试；否决。
