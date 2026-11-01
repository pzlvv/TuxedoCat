# 任务分解：分支对话（git worktree 隔离）

执行顺序：Core 侧能力先行（T001 – T006，`core-rs/src/branch/` 四个模块 + 命名 +
工作根改向），契约面（T007）依赖它们，宿主翻译（T008）依赖契约，UI（T009 – T010）
依赖契约，测试与文档收尾（T011 – T014）。需求口径见 [spec.md](spec.md)，技术方案与
取舍见 [plan.md](plan.md)。

## 任务清单

- [x] **T001**（FR-009）：`core-rs/src/branch/naming.rs`——绝区零角色英文名常量表 + 3 位小写随机后缀 + 撞名重试；依赖：—；完成判据：`core-rs/src/branch/naming_tests.rs` 覆盖格式正则 `^[a-z]+(-[a-z]+)*-[a-z0-9]{3}$`、常量表非空且唯一、撞名重试收敛；`npm run test:core` 绿
- [x] **T002**（FR-003）：`core-rs/src/branch/repo.rs`——`git rev-parse --show-toplevel` / `--git-dir` 探测、`git status --porcelain` 脏判定、`branchPrecheckRequested` 应答组装（`{ ok: true, head, dirty }` / `{ ok: false, reason: 'not-git' }`）；依赖：—；完成判据：`repo_tests.rs` 用 `GitSandbox` 真实仓库覆盖仓库内 / 子目录 / 非仓库 / 脏工作区三态；`npm run test:core` 绿
- [x] **T003**（FR-010）：`core-rs/src/branch/deps.rs`——`DepStrategy` trait + `SkipDeps` + `OverlayDeps`（Linux，进程内试挂探测、只叠加已存在目录、upper 在 worktree 外、卸载顺序）；依赖：—；完成判据：`deps_tests.rs` 覆盖两档装配与 `describe()`、只叠加已存在目录、upper 隔离、卸载先于 remove；overlay 真挂载用例在具备 `CAP_SYS_ADMIN`（或 userns 内 root）时真跑、否则打印 `skip: overlayfs 不可用（...）`
- [x] **T004**（FR-002、FR-005、FR-010）：`core-rs/src/branch/worktree.rs`——创建（`git worktree add <path> -b tuxedo/<name> HEAD`）/ 复用校验 / 删除（卸载 → `worktree remove --force` → `branch -D`）/ 启动对账 / 单文件本地配置符号链接与复制兜底；依赖：T001、T003；完成判据：`worktree_tests.rs` 覆盖创建、撞名重试、复用、创建失败回滚、删除顺序、孤儿对账、手删 worktree 转 unavailable、单文件链接（忽略才链接 / 未忽略跳过 / 原子替换后读到新值 / 失败退复制）；`npm run test:core` 绿
- [x] **T005**（FR-008）：`core-rs/src/branch/state.rs`——`branchStateChanged.view` 三态组装（`plain` / `ready` / `unavailable`）与窄口径断言；依赖：—；完成判据：`state_tests.rs` 断言三种 view 的字段集，且**不含** `commits` / `dirty` / `peers` / `deps`
- [x] **T006**（FR-001、FR-002、FR-004、FR-005）：`engine.rs` 工作根改向（`tool_root_of` 单点派生 + `ToolContext.cwd`）、系统提示增补（`prompt.rs` 分支段）、自毁命令拦截、`meta.json` 的 `branch` 字段读写、删除时的计数诊断日志与清理；依赖：T002、T004；完成判据：`engine_tests.rs` 覆盖全部工具跟随 worktree、主工作区零改动、提交推进分支指针、拦截 `git worktree remove` / `git branch -D` 自身、删除清理顺序与计数日志；既有 `engine_tests` 全绿
- [x] **T007**（FR-008）：契约面——`src/shared/AssistantEventBus.ts` 补 1 CoreEvent（`branchStateChanged`）+ 1 UiEvent（`branchModeChanged`）+ 2 UiRequest（`branchTreeRequested` / `branchPrecheckRequested`），`sessionConfigChanged` 的 change 联合补 `branchMode`；Rust 侧 `main.rs` 的 `dispatch_ui_event` / `dispatch_ui_request` 分支与 emit 位点；`core-rs/fixtures/eventTypes.json` 登记；依赖：T005、T006；完成判据：`npm run check-types` 绿、`eventTypeParity` 与 `npm run test:core`（事件词汇双向锁定）绿
- [x] **T008**（FR-006、FR-007、FR-008）：宿主侧翻译与路由——`src/host/webviewMessages.ts` 的 `startNewConversation` 形态标记、`WebviewMessageHandler` 翻译 `branchModeChanged`、`WebViewUI` 的 `branchStateChanged` 映射与 `conversationLoaded` 带 `branch`、`coreFacts` 两条 `UiRequest` 封装、`Client` 的 `branchPrecheckRequested` 工作区路由、`UIHost` 分支事实出口；依赖：T007；完成判据：`npm run check-types && npm run lint` 绿，`branchContract` / `branchTreeRequested` 单测绿
- [x] **T009**（FR-006）：webview——新对话 split button（主「+」+ 下拉两项、无选中态）、草稿页脏工作区一行提示、会话标题**前**分支名（无图标无字样）、对话列表标题前分支名与悬停 tip；依赖：T008；完成判据：`npm run check-types && npm run lint` 绿，`branchModeEntry` 单测与 `e2e/webview/branchConversation.spec.ts` 绿
- [x] **T010**（FR-007）：Electron 侧栏文件资源管理器跟随活动对话——标题带分支名、树经 `branchTreeRequested` 读 worktree、`branch` 失效原因重读、普通对话回落主工作区；**不做差异标记**；依赖：T008；完成判据：`npm run check-types && npm run lint` 绿，`branchTreeRequested` 的 `not-branch` 回落用例绿
- [x] **T011**（FR-001 ~ FR-011）：测试收尾——`core-rs/src/test_support.rs` 新增 `GitSandbox` 夹具（本地 `user.email` / `user.name`、`GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` 指向空文件、`core.hooksPath` 指向空目录）、`src/test/standaloneBranch.test.ts` 驱动真实 Core 二进制；依赖：T006、T007、T009；完成判据：`npm run test:core` 与 `npm run test:unit -- standalone-branch`（缺产物走 `markSkipped`）绿

> T011 的实施备注：`GitSandbox` 包住既有 `Sandbox`（复用它的进程级串行锁与 HOME / PATH
> 隔离），仓库放在沙箱根的 `git-repo/`；`repo_tests` / `worktree_tests` / `deps_tests` /
> `state_tests` / `naming_tests` 全部用真实 git 仓库，无桩。overlay 真挂载用例在
> `userns` 内 root（`unshare -Urm`）下车道真跑，非特权进程打印
> `skip: overlayfs 不可用（Core 进程无 CAP_SYS_ADMIN 或内核不支持）`。
- [x] **T012**（FR-008、FR-009、FR-010）：文档同步——`docs/architecture/events.md`（事件表 + 载荷列）、`docs/core/standalone-core.md`（业务范围 + 事实归属 + `UiRequest`）、`docs/core/standalone-core-boundaries.md`（`UiRequest` 表与宿主读事实）、`docs/architecture/principles.md`（事实表）、新增 `docs/features/branch-conversation.md`、`docs/README.md` 地图、`docs/architecture/open-questions.md` 四项待定；依赖：T007、T009、T010；完成判据：`npm run test:unit -- docs-lint` 绿
- [x] **T013**（FR-006、FR-007）：需求基线与 e2e 映射——`docs/features/user-stories/dialog-core.md` 收录 US-76、`tools.md` 收录 US-74 / US-75、`desktop.md` 补侧栏分支树、`docs/features/user-stories.md` 附录登记三条 US 的 e2e 落点与豁免理由；依赖：T012；完成判据：`npm run test:unit -- docs-lint` 绿（FR ↔ e2e 测试名双向对照）
- [x] **T014**（FR-001 ~ FR-011）：全量回归与提交；依赖：T011 ~ T013；完成判据：`npm run check-types && npm run lint && npm run test:core && npm run test:all` 全绿，提交信息带 `Flow: L3` + `Spec: 037`
