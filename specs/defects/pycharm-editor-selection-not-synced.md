---
status: 已修
---

# 缺陷：PyCharm 插件缺少编辑器当前文件与选区联动

PyCharm 插件面板丢失了 VS Code 宿主的「编辑器当前文件与选区」联动：用户在 IDE 编辑器里
选中代码后，面板输入框应出现文件引用芯片（`@文件:行号`），发消息时自动携带该文件与行
区间给 core 当上下文，并持久化进 meta.json。当前 PyCharm 面板没有任何此联动——输入框
永远不带文件引用。面板能力基线是「与 VS Code 宿主一致」（US-69），此为交付缺口。

## 现状

- VS Code 宿主：`src/extension.ts` 监听 `onDidChangeActiveTextEditor` 与
  `onDidChangeTextEditorSelection`，每次变化经 `sendCurrentFileInfo()`：
  1. 发 webview 消息 `setCurrentFile {filePath, selectedLines}`（无选区时
     `selectedLines = {start: 光标行, end: 光标行}`，即芯片恒显示光标行）；
  2. 非文件编辑器（Output / 控制台 / 虚拟文档）发 `{filePath: ''}` 清芯片；
  3. 经 `UiEvent.conversationContextUpdated` 把 currentFile / selectedLines 持久化到
     **活跃会话**的 meta.json。
- PyCharm 插件（`pycharm-plugin/`）：没有任何编辑器事件监听；`setCurrentFile` 消息
  从未发出。webview 侧芯片渲染与 `sendMessage` 携带 filePath / selectedLines 的链路
  已就绪（HostUi.handleUserMessage 已翻译 `fileSelectedLines`），只缺宿主侧的推送。
- 复现：PyCharm 打开任意文件、选中几行 → 面板输入框无文件引用芯片（VS Code 同操作有）。

## 期望

- 插件监听 IDE 编辑器的活跃文件与选区变化（FileEditorManagerListener 的 selectionChanged + EditorFactory eventMulticaster 的 SelectionListener），语义逐条对齐 VS Code：
  1. 变化即发 `setCurrentFile {filePath, selectedLines}`（无选区 = 光标行 start===end）；
  2. 非本地文件系统编辑器发 `{filePath: ''}` 清芯片；
  3. 有活跃会话时经 `UiEvent.conversationContextUpdated` 持久化到 meta.json。
- 面板 webview 首条消息到达后（挂载完成的信号）补发一次当前状态（对齐 VS Code 在
  resolveWebviewView 时的初始推送）。

## 不变量

- webview 消息协议不变（`setCurrentFile` / `updateConversationContext` /
  `sendMessage` 的载荷形状与既有宿主逐字段一致）。
- `openFile`（卡片路径跳转）行为不变；跳转后的选区变化应自然触发本联动。
- 会话上下文持久化仍走 `UiEvent.conversationContextUpdated`（写 meta.json 归 core），
  宿主不直接写盘。

## 回归测试

- **RT-1**：e2e——点击 Write 卡片文件路径（编辑器打开 notes.md 并选中改动行）后，
  idea.log 出现 `[currentFile]` 诊断行（联动已触发），且面板输入区出现文件芯片
  （DOM 断言，选择器按 webview 实际标记）。（落点：`e2e/pycharm/pluginInIde.spec.ts`
  的 US-71 用例扩展）
- **RT-2**：人工验证——无选区时芯片显示光标行（start===end）、Run 控制台聚焦时芯片
  清除（选区→行区间换算需要 IntelliJ 编辑器夹具，Gradle 单测环境未搭；换算与推送逻辑
  已由 RT-1 的跳转 + 选区路径端到端覆盖）。

## 验证记录

实现落点：`pycharm-plugin/src/main/kotlin/pycharm/host/ide/EditorSelectionWatcher.kt`
（SelectionEvent 直接用事件载荷的 editor + newRange——跨编辑器切换瞬间回读全局
selectedTextEditor 会拿到旧编辑器，实测竞态）；`PanelController` 装配 +
`onFirstWebviewMessage` 初始推送（对齐 VS Code 在 resolveWebviewView 的推送时序）；
`FileJumpService` 打开目标文件后直接触发一次推送（绕过切换事件回读竞态）。

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1 | `npm run test:e2e:pycharm`（US-71 用例扩展） | 红 | 修复前：watcher 未实现，`[currentFile]` 行不出现，断言超时（即用户报告的缺口） |
| RT-1 | 同上 | 绿 | 修复后：卡片跳转打开编辑器 → SelectionEvent → `setCurrentFile` 推送 + 芯片出现，车道 10/10 通过 |
| RT-2 | 人工（IDE 编辑器选中 / 控制台聚焦） | 部分验证 | 无选区=光标行已实现；控制台清芯片分支待人工复核 |
