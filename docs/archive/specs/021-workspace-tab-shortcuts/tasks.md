# 任务分解：工作区标签页快捷键切换与改键

执行顺序即依赖序：先纯函数与常量（可单测），再主进程接线（菜单动作表 + 切换动作），
再偏好窗口改键，最后 e2e 与文档同步、全量验证。需求见 [spec.md](spec.md)，方案见
[plan.md](plan.md)。

## 任务清单

- [x] **T001**（FR-001、FR-002）：新建 `electron/tabSwitching.ts` 纯函数
      `selectAdjacentWorkspace(ids, activeId, direction)`（环绕、不足 2 项返回
      `null`）与 `electron/shortcut.ts` 新增 `DEFAULT_NEXT_TAB_SHORTCUT` /
      `DEFAULT_PREV_TAB_SHORTCUT` / `findShortcutConflict` 冲突判定纯函数；依赖：—；
      完成判据：`src/test/tabSwitching.test.ts` 覆盖相邻 / 环绕 / 空集单项 / activeId
      缺席 / 冲突全组合，`npm run test:all -- tabSwitching` 绿。
- [x] **T002**（FR-002）：`electron/workspaceStateStore.ts` 的 `WorkspaceState` 加
      `nextTabShortcut` / `prevTabShortcut` 字段并同步文件头格式注释；依赖：T001；
      完成判据：`npm run check-types:electron` 绿，字段注释与头注格式块一致。
- [x] **T003**（FR-001、FR-004）：`electron/main.ts` 加 `readTabShortcutSync` /
      `writeTabShortcut` 读写对与 `switchToAdjacentWorkspace`，`buildMenuSections`
      新增 `main.nextWorkspaceTab` / `main.prevWorkspaceTab` 两条目（accelerator 取
      读侧收敛值，Windows/Linux 与 macOS 分区同摆位）；依赖：T002；完成判据：
      `npm run check-types:electron` 绿；`src/test/titlebarMenu.test.ts` 既有断言不红。
- [x] **T004**（FR-003）：`electron/preferenceDialogHtml.ts` 快捷键区改三行（唤醒 /
      下一标签 / 上一标签），`PreferenceDialogState` 泛化为三行显示 + `capturing`
      行标识 + 行内错误；`electron/main.ts` 偏好窗口录制 handler 按行路由（冲突判定
      → 写盘 → `setupMenu()` 换绑 → 回推状态），`preference-dialog:capture-shortcut`
      携带行标识；`electron/preferencePreload.ts` 同步签名；依赖：T003；完成判据：
      `src/test/preferenceDialog.test.ts` 三行渲染断言绿，`npm run check-types:electron`
      绿。
- [x] **T005**（FR-001、FR-004）：e2e `e2e/electron/workspace.spec.ts` 新增 US-53
      键盘切换用例（`sendInputEvent` 驱动 before-input-event，覆盖相邻切换 / 环绕 /
      少于 2 项 no-op），`e2e/electron/desktopShell.spec.ts` 新增 US-53 改键用例
      （沿 US-34 录制形态：录制、冲突拒绝、菜单展示更新）；依赖：T004；完成判据：
      `npm run test:e2e:electron -- --grep "US-53"` 绿（本地无显示环境时记录 skipped
      留给 /converge 核验口径）。
- [x] **T006**（FR-001~004）：文档同步——[docs/hosts/electron-multi-workspace.md](../../docs/hosts/electron-multi-workspace.md)
      的 [第 5 节](../../docs/hosts/electron-multi-workspace.md#5-标签页)、[第 7 节](../../docs/hosts/electron-multi-workspace.md#7-菜单)、[第 11 节](../../docs/hosts/electron-multi-workspace.md#11-持久化)并入 delta，`docs/features/user-stories/desktop.md` 新增 US-53，
      `docs/features/user-stories.md` 附录映射登记；依赖：T003（文档只写已落地行为）；
      完成判据：`npm run test:all -- docs-lint` 绿。
- [x] **T007**（FR-001~004）：全量验证——`npm run compile`、`npm run test:all`、
      （涉及 core 不涉但 CI 会跑）`npm run test:core` 不需要；依赖：T005、T006；
      完成判据：三项命令全绿（e2e 如本机不可驱动则按 T005 口径登记）。
