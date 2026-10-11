# 任务分解：会话交互增强——标签页右键菜单、空闲发送与跳到底部

执行顺序按依赖排列：先纯函数与单测（T001），再主进程菜单（T002），webview 发送模式与
空闲挂起（T003）与跳到底部（T004）可并行推进，e2e（T005）在前三者落地后跑，文档 delta
（T006）在收敛前完成，全量验证（T007）收口。指向 `spec.md` / `plan.md`。

## 任务清单

- [x] **T001**（FR-001）：新增 `electron/workspaceBatchClose.ts` 纯函数（`selectClosableIdleSessions` / `summarizeOtherWorkspaces`）并在 `src/test/workspaceBatchClose.test.ts` 覆盖：空闲可关（含当前选中的对话）/ 忙碌不动 / 任一他区忙碌需汇总确认 / 全闲免确认；`tsconfig.test.json` include 补该模块；依赖：—；完成判据：`npm run test:all -- workspace-batch-close` 绿
- [x] **T002**（FR-001）：主进程新增 `titlebar:tab-context-menu` IPC（`isTitlebarSender` 守卫、按 refKey 回查）、`popupTabContextMenu`（四项 + 置灰规则 + 「关闭其它所有工作区」一次汇总确认 + 「打开命令行」`endpoint === null && fs.existsSync` 判定 + `spawnTerminalAt`）、`closeWorkspace` 抽 `teardownWorkspace`；preload 暴露 `showTabContextMenu`，`TitlebarAPI` 补成员，`.ws-tab` 挂 `contextmenu`；依赖：T001；完成判据：`npm run check-types`（含 electron 配置）与 `npm run lint` 绿、`npm run test:all -- ipc-channels` 绿（新通道收发自动配对）
- [x] **T003**（FR-002、FR-003）：webview 发送模式——`useAppHandlers.handleSend` 抽共用提交段，新增 `handleSendIdle`（时刻 `idle === true` 直接提交否则挂起）、挂起编辑 / 删除（纯本地，不发 `discardQueuedMessage`）、`handleAbort` 补挂起回填（中止回填优先）、排队守卫与 `sendDisabled` 查双来源；App 层挂起 Map/state、`sessionIdleVersion` 触发 effect（显式 `idle === true` 才触发）、会话关闭 / 删除清理挂起项、`InputArea` split 下拉（立即发送 / 空闲发送，禁用口径同主按钮）与空闲横幅（文案区分「空闲后发送」）；zh / en i18n 键对齐；依赖：—；完成判据：`npm run check-types` 与 `npm run lint` 绿
- [x] **T004**（FR-004）：`MessagesView` 跳到底部按钮——useAutoScroll 布尔翻转回调镜像 `isAtBottomRef`、按钮绝对定位于容器 relative 包装底部居中（`data-jump-to-bottom`）、点击清 `userScrolledAwayRef` + `scrollToBottom(true)`、会话切换随既有重置隐藏；i18n `messages.jumpToBottom`（zh / en）；依赖：—；完成判据：`npm run check-types` 绿
- [x] **T005**（FR-002、FR-003、FR-004）：e2e `e2e/webview/sendModes.spec.ts`（US-46：下拉两项与禁用、忙碌下空闲发送不上送且横幅可区分、空闲触发自动提交、编辑 / 删除撤回、中止回填、中止后注入 idle 不重复投递、重载丢失）与 `e2e/webview/jumpToBottom.spec.ts`（US-47：底部隐藏、滚离显示、点击回底并恢复跟随）；映射表登记两文件；依赖：T003、T004；完成判据：`npm run test:e2e:webview` 两文件全绿
- [x] **T006**（FR-001、FR-002、FR-003、FR-004）：文档 delta——`docs/features/user-stories.md` 新增 US-46 / US-47 / US-48 本体、映射表登记、US-48 豁免文案随四项菜单与范围收缩更新；`docs/features/user-message-pipeline.md` FR-003 补空闲挂起 / 中止回填 / 重载丢失口径与追溯矩阵、基线影响补 US-46；`docs/hosts/electron-multi-workspace.md` §5 右键菜单与 §8.2 批量关闭（含显示中不关、汇总确认）；`docs/hosts/vscode-idle-close.md` §1 / §4 补 Electron 手动批量入口说明；发送模式与跳到底部行为按 docs/README 地图落对应 as-built 文档；依赖：T002、T003、T004；完成判据：`npm run test:all -- docs-lint` 绿（含组 18 US 闭合）
- [x] **T007**（FR-001、FR-002、FR-003、FR-004）：全量验证——`npm run check-types`、`npm run lint`、`npm run test:all` 全绿；依赖：T005、T006；完成判据：三命令退出码 0，`docsLint` 43 组全绿（实测 122 项测试全过 / check-types 0 错 / lint 干净）
- [x] **T008**（实施期发现，非 spec 范围）：T007 首跑暴露 `brandLiteral` 红——上一条流程提交（43f13c6）在 `AGENTS.md` 与 `scripts/githooks/pre-commit` 引用了会话技能目录的真实路径（目录名即品牌字面量），但该提交验证未跑 `test:all` 故未察觉。处置：两文件加入 `src/test/brandLiteral.test.ts` 的 `ALLOWED_FILES`（指路必须写真实目录名，属白名单逃生舱的既定用途）；依赖：—；完成判据：`npm run test:all -- brand-literal` 绿
