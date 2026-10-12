# 任务分解：桌面端交互修复（工具卡片 / 侧栏 / 对话树 / 模型恢复）

执行顺序：先做相互独立的实现任务（T001–T007），再补 e2e（T008）与文档（T009），最后跑
全量校验（T010）。每条回指 `spec.md` 的 FR，判据是可验证的证据。指向同目录
`spec.md` / `plan.md`。

## 任务清单

- [x] **T001**（FR-001）：Bash 折叠提示条加分割线、展开后让位；依赖：—；完成判据：
      `src/webview/tools/previewLimit.tsx` 导出 `TAIL_HINT_HEIGHT`，`Bash.tsx` 展开态输出框
      高度 = `OUTPUT_BOX_HEIGHT + TAIL_HINT_HEIGHT` 且展开时不渲染提示条，
      `npm run check-types:webview` 绿。
- [x] **T002**（FR-002）：侧栏右缘手柄与滚动条分居；依赖：—；完成判据：
      `electron/sidebar/styles.css` 中 `--resize-handle-width` 同时用于 `body` 的
      `padding-right` 与 `.resize-handle` 的 `width`，`e2e/electron/fileExplorer.spec.ts`
      新增「手柄区域拖拽改宽度、滚动条区域拖拽改滚动」用例通过。
- [x] **T003**（FR-003）：子代理默认展开上限（webview + Electron 侧栏）；依赖：—；完成判据：
      新增 `src/host/ui/conversationTreeDefaults.ts`（`SUBAGENT_AUTO_EXPAND_LIMIT` /
      `shouldAutoExpandSubSessions`），`App.tsx` 根节点默认展开与 `electron/sidebar/main.ts`
      的 `isSubExpanded` 都消费它，`src/test/conversationTreeDefaults.test.ts` 与
      `e2e/webview/sessions.spec.ts` 的新用例通过。
- [x] **T004**（FR-004）：切换标签页不播放文件浏览器过渡；依赖：—；完成判据：
      `electron/sidebar/styles.css` 的过渡 / 淡入只在 `.files-section.files-anim` 下生效，
      `setFilesExpanded` 加类、`setFilesWorkspace` 摘类，`e2e/electron/fileExplorer.spec.ts`
      新增「切换标签页后展开态直接生效且无过渡」用例通过。
- [x] **T005**（FR-005）：远程工作区支持关闭所有空闲会话；依赖：—；完成判据：
      `electron/main.ts` 在推送 `sidebar:conversations-updated` 时调用
      `syncSessionWorkspaceIndex()`，远程工作区列表晚到时索引不再为空
      （`collectWorkspaceSessionFacts` 能取到该工作区会话）。
- [x] **T006**（FR-006）：模型身份落盘 / 恢复回归测试；依赖：—；完成判据：
      新增 `src/test/sessionModelRestore.test.ts`，覆盖身份合法 / 模型失配 / provider 移除 /
      未记录四条口径，`npm run test:all -- session-model-restore` 绿。
- [x] **T007**（FR-007）：刷新保留滚动位置；依赖：—；完成判据：
      `electron/sidebar/main.ts` 的 `WorkspaceFilesState.pendingScrollTop` 在 `refreshFiles`
      记录、`renderFiles` 回填、用户手动滚动即放弃，`e2e/electron/fileExplorer.spec.ts`
      新增「刷新后滚动位置不变」用例通过。
- [x] **T011**（FR-008）：输入框高度自适应（粘贴多行不出现多余滚动条）；依赖：—；完成判据：
      `src/webview/InputArea.tsx` 的高度上限只有一处来源（`maxRows`），
      `e2e/webview/inputExtras.spec.ts` 新增「粘贴两行后高度恰好容纳两行、无滚动条」用例通过。
- [x] **T008**（FR-001、FR-002、FR-003、FR-004、FR-007、FR-008）：e2e 扩展；依赖：T001–T004、T007、T011；
      完成判据：`e2e/webview/bashOutputCollapse.spec.ts`、`e2e/webview/sessions.spec.ts`、
      `e2e/webview/inputExtras.spec.ts`、`e2e/electron/fileExplorer.spec.ts` 的新用例通过。
- [x] **T009**（FR-001…FR-008）：文档同步；依赖：T001–T008；完成判据：
      US-1 / US-14 / US-19 / US-42 / US-44 / US-48 的验收标准与
      `docs/hosts/electron-multi-workspace.md`（8.2 / 9）、`docs/hosts/host-matrix.md`（12）、
      `docs/hosts/webview-facts.md`（5）改到与实现一致，`npm run test:all -- docs-lint` 绿。
- [x] **T010**（FR-001…FR-008）：全量校验；依赖：T001–T009；完成判据：
      `npm run check-types`、`npm run lint`、`npm run test:all`（含 docs-lint）全绿；
      涉及 Core 的测试按 [AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)先跑 `npm run build:core:host`。
