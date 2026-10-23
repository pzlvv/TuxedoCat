# 实施方案：工作区标签页快捷键切换与改键

技术路线：完全沿唤醒快捷键的既有形态扩展——组合键定义集中在 `electron/shortcut.ts`，
持久化加进 `electron/workspaceStateStore.ts` 的 `WorkspaceState`，录制与冲突判定复用
偏好设置窗口的 `before-input-event` 捕获管线，动作经 `buildMenuSections()` 的菜单动作表
下发（原生菜单 + 自绘菜单 + `before-input-event` 兜底三处自动生效）；相邻标签页计算
抽成纯函数模块供单测。不改 core、不改 `src/shared/` 契约面。需求见同目录
[spec.md](spec.md)。

## 技术方案

### 1. 相邻标签页计算（新纯函数模块 `electron/tabSwitching.ts`）

```ts 示意
export type TabSwitchDirection = 'next' | 'prev';
export function selectAdjacentWorkspace(
  open: readonly WorkspaceRef[],
  active: WorkspaceRef | null,
  direction: TabSwitchDirection,
): WorkspaceRef | null
```

- 按去重键（`refKey`，`electron/main.ts` 内既有函数——保持留在 main.ts，本模块接收
  已算好的 id 数组更利于纯测：签名收敛为 `selectAdjacentWorkspace(ids: readonly string[], activeId: string | null, direction)`，
  返回目标 id 或 `null`）。环绕：末项的下一项是首项、首项的上一项是末项。
- `ids.length < 2` 或 `activeId` 不在 `ids` 中时返回 `null`（调用方 no-op）。
- `WorkspaceRef` 类型从 `src/host/workspaceState.js` import（main.ts 现状同源）。

### 2. 组合键定义与默认值（`electron/shortcut.ts`）

- 新增常量 `DEFAULT_NEXT_TAB_SHORTCUT = 'Ctrl+Tab'`、
  `DEFAULT_PREV_TAB_SHORTCUT = 'Ctrl+Shift+Tab'`（与 `DEFAULT_WAKE_SHORTCUT` 并列）。
- 组合键合法性、规范化、展示、键盘事件转换全部复用既有 `normalizeAccelerator` /
  `formatAcceleratorForDisplay` / `acceleratorFromKeyboardEvent`——Ctrl+Tab 已满足
  「必须带修饰键」口径（`shortcut.ts` 第 118 行判定），无需改判定逻辑。

### 3. 持久化（`electron/workspaceStateStore.ts`）

`WorkspaceState` 新增两个可选字段（与 `shortcut` 同口径：缺失 / 非法按默认处理，
读侧不写回）：

- `nextTabShortcut?: string`、`prevTabShortcut?: string`。

main.ts 新增读写对（沿 `readWakeShortcutSync` / `writeWakeShortcut` 的形态）：

- `readTabShortcutSync(field)`：`normalizeAccelerator(readWorkspaceState()[field]) || 默认值`；
- `writeTabShortcut(field, accelerator)`：合并写回 + `setupMenu()` 刷新动作表。

### 4. 菜单动作表接线（`electron/main.ts` 的 `buildMenuSections`）

- 新增两个 `MenuItemDef`：`main.nextWorkspaceTab`（下一标签）、`main.prevWorkspaceTab`
  （上一标签），`accelerator` 取读侧收敛后的当前值（默认或用户自定义），
  `run` 调 `switchToAdjacentWorkspace(direction)`。
- 摆位：Windows / Linux 放在「打开最近的工作区」之后、偏好设置分隔线之前
  （与工作区打开类动作相邻）；macOS 放 File 分区同位（自绘标题栏在 macOS 不渲染，
  条目只进系统菜单栏，原生 accelerator 生效）。
- `switchToAdjacentWorkspace(direction)`（main.ts 内）：
  `selectAdjacentWorkspace(openWorkspaces.map(refKey), workspacePath ? refKey(workspacePath) : null, direction)`
  → 非 `null` 时 `activateWorkspace(targetId)`。集合不足 2 项 / 定位不到目标即返回
  （`activateWorkspace` 本就按 id 重新定位、找不到即 no-op）。
- 加速器兜底零改动：`collectMenuAccelerators` 收集新条目后，侧栏 / 标题栏 / 聊天视图
  三处 `before-input-event` 自动命中（`handleMenuAccelerator`）。
- 自绘菜单展示组合文本由 `toTitlebarMenuNodes` 的既有
  `formatAcceleratorForDisplay(def.accelerator)` 路径自动带出。

### 5. 偏好设置窗口改键（`electron/preferenceDialogHtml.ts` + `electron/main.ts`）

状态与 IPC 泛化（字段级多路录制，替换现在的单一唤醒字段）：

- `PreferenceDialogState`：`shortcutDisplay` → `wakeShortcutDisplay`、
  `nextTabShortcutDisplay`、`prevTabShortcutDisplay`；`shortcutCapturing: boolean` →
  `capturing: 'wake' | 'nextTab' | 'prevTab' | null`；`shortcutError` →
  `shortcutError?: string`（保留单槽：同一时刻只有一行在录制、错误随行展示）。
- IPC `preference-dialog:capture-shortcut` 携带行标识参数（channel 名不变，
  `ipcChannels.test.ts` 的 send/on 配对不受影响）。
- main.ts 录制 handler 泛化：`capturing` 记录行标识；`before-input-event` 捕获到组合后
  按行路由——先冲突判定、再写盘、再 `setupMenu()`（标签行改键即时换绑）、最后 `pushState()`。
- **冲突判定**（新纯函数，放 `electron/shortcut.ts` 便于单测）：
  `findShortcutConflict(candidate, { wake, nextTab, prevTab, menuAccelerators })` →
  返回冲突原因描述或 `null`。冲突集合 = 另两条标签行 + 菜单既有 accelerator
  （Ctrl+O、Ctrl+Shift+O、Ctrl+Shift+I，从 `buildMenuSections` 的固定定义收集）+
  当前唤醒快捷键。全部按 `normalizeAccelerator` 规范化后比较（别名如
  CommandOrControl 不误报）。
- HTML：快捷键区改为三行（唤醒 / 下一标签 / 上一标签），每行 label + 录制按钮 +
  行内错误槽；渲染逻辑按 `capturing` 高亮对应行。文案 zh / en 双语内联（沿现状，
  该窗口不经 `tt()` 而按 `locale` 参数生成）。

### 6. 数据流小结

按键（任一视图）→ `before-input-event` 兜底 / 原生菜单 → 动作表 id
→ `switchToAdjacentWorkspace` → 纯函数算目标 → `activateWorkspace`（既有切换链：
持久化、侧栏 / 聊天区 / 标题栏联动）。改键：偏好窗口点击行 → IPC → 录制态 →
键盘事件 → 冲突判定 → `writeWorkspaceState` → `setupMenu()` 换绑 → 状态回推。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `electron/tabSwitching.ts` | 新增 | 无（纯函数） |
| `electron/shortcut.ts` | 修改：两个默认值常量 + 冲突判定纯函数 | 无 |
| `electron/workspaceStateStore.ts` | 修改：`WorkspaceState` 加 `nextTabShortcut` / `prevTabShortcut`，文件头格式注释同步 | 无（宿主本地状态文件，core 不读；`src/shared/` 不涉） |
| `electron/main.ts` | 修改：菜单两条目、`switchToAdjacentWorkspace`、读写对、录制 handler 泛化、`onHostLocaleChanged` 重建菜单既有路径不变 | 无（不动 `UIHost` / `WebViewUiPort` / wire 消息） |
| `electron/preferenceDialogHtml.ts` | 修改：三行快捷键区、状态形状泛化 | 无（页面内部协议，preload 通道名不变） |
| `electron/preferencePreload.ts` | 修改：`captureShortcut` 带行标识参数 | IPC channel 名不变（`src/test/ipcChannels.test.ts` 配对不变） |
| `src/test/tabSwitching.test.ts` | 新增：相邻计算 / 环绕 / 不足 2 项 / 默认值回退 / 冲突判定 | — |
| `src/test/preferenceDialog.test.ts` | 修改：三行状态渲染断言 | — |
| `e2e/electron/workspace.spec.ts` | 新增 US-53 键盘切换用例（`sendInputEvent` 驱动） | — |
| `e2e/electron/desktopShell.spec.ts` | 新增 US-53 录制改键用例（沿 US-34 形态） | — |

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：不涉及 core 与 `src/shared/` 契约——全部改动
      落在 `electron/` 宿主实现层与 `src/test/`、`e2e/`；`tabSwitching.ts` 只 import
      `src/host/workspaceState.js` 的类型（`host/` 只读类型引用，main.ts 现状同源），
      不 import `vscode` / `electron` API 之外的宿主实现；无宿主嗅探（macOS 分支沿用
      `buildMenuSections` 既有的平台分区写法）。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：默认值单源——两条默认组合只定义在
      `electron/shortcut.ts` 常量，读侧收敛唯一入口 `readTabShortcutSync`；不过度
      fallback——集合不足 2 项的 no-op 是设计允许的瞬时状态（注释留痕），非法持久化
      值回默认沿唤醒快捷键既有口径；一份事实一个写入点——组合键唯一写入点是偏好
      窗口保存路径，菜单 / 兜底全是只读消费；契约成员全必选不涉及（无契约改动），
      `WorkspaceState` 新字段沿用该文件既有的可选字段 + 读侧默认口径（宿主本地
      状态文件不在「契约成员」范畴）。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：不涉及——`workspace-state.json`
      是 Electron 宿主私有状态文件，core 不读不写；`src/shared/history/` 不涉。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：实施提交内同步
      [docs/hosts/electron-multi-workspace.md](../../docs/hosts/electron-multi-workspace.md)（[第 5 节](../../docs/hosts/electron-multi-workspace.md#5-标签页)、[第 7 节](../../docs/hosts/electron-multi-workspace.md#7-菜单)、[第 11 节](../../docs/hosts/electron-multi-workspace.md#11-持久化)）与
      `docs/features/user-stories/desktop.md`（US-53）、`docs/features/user-stories.md`
      （附录映射）；`npm run test:all -- docs-lint` 必须绿。

## 被否决的替代方案

1. **组合键走 webview keydown 上报**（宿主收 `UiEvent` 再翻译）：否决——切换是主进程
   内在操作（`activateWorkspace` 就在 main.ts），绕道 webview 要给三类视图各埋上报、
   还要动 wire 消息契约，收益为零；菜单 accelerator + `before-input-event` 兜底是
   现成的单一来源机制。
2. **组合键固化不可改**（只加两条固定 accelerator）：否决——需求方明确要「快捷键定义」，
   且唤醒快捷键已有完整的「持久化 + 录制 + 展示」先例，泛化成本集中在
   `preferenceDialogHtml.ts` 一处状态形状，顺带把三行快捷键的 UI 结构统一。
3. **冲突时静默拒绝 / 只落日志**：否决——铁律 1（不过度 fallback）：录制结果无效必须
   让用户看见，行内错误是既有 `shortcutError` 槽的复用，不是新机制。
4. **切换逻辑进 `activateWorkspace` 加 direction 参数**：否决——相邻计算是纯顺序
   问题，`activateWorkspace` 的职责是「切到给定项」；混入方向语义会让单测不得不
   拉 main.ts（5000 行、依赖 electron 运行时），抽纯函数模块是本仓既有习惯
   （`workspaceBatchClose.ts` 同型）。
