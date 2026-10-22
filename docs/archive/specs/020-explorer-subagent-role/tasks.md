# 任务分解：子代理角色 explorer（文件浏览专用，只读工具集）

执行顺序：先 core-rs（角色注册表 → 引擎三处接线 → 提示词 → 测试），再 webview
（角色事实接线 → 置灰判定 → 选项置灰 → i18n → 测试），然后 e2e，最后闸门与文档收敛。
指向同目录 `spec.md` / `plan.md`。

## 任务清单

- [x] **T001**（FR-001）：core-rs 角色注册表——`tools.rs` 新增 `SUB_AGENT_ROLES` 常量与 `sub_agent_role_tools` 白名单函数（explorer → Read/Glob/Grep/Reply），`run_agent` 校验与 Agent schema description 改走注册表；依赖：—；完成判据：`tools_tests` 新增用例覆盖两角色合法、非法值错误文案、白名单映射，`cargo test` 绿
- [x] **T002**（FR-001）：入参与权限两处接注册表——`tool_input.rs` `agent_fields` 枚举改引 `SUB_AGENT_ROLES`，`permission.rs` 空 role deny 文案从常量拼接；依赖：T001；完成判据：入参校验对非法 `agentRole` 返回多值枚举文案（`Invalid option: expected one of "Master"|"explorer"`），引擎测试断言通过
- [x] **T003**（FR-002、FR-003）：引擎接线——`create_sub_agent` 对非 Master 固定 `prompt_mode=None`、`web_search=Some(false)`；`run_query_loop` 按白名单过滤工具清单并强制 normal 预设；`execute_tool` 入口按白名单拒绝（含 `mcp__*`），文案点名角色与可用工具；依赖：T001；完成判据：`engine_tests` 新增用例——explorer 首轮请求工具恰为四件套、白名单外调用被拒且会话不中止、创建者 minimal/mixed + 联网搜索下 explorer 仍固定口径、Master 继承不回归，`cargo test` 绿
- [x] **T004**（FR-001）：`prompt.rs` Agent 角色表新增 explorer 条目；依赖：T001；完成判据：`prompt_tests` 断言角色表含 Master 与 explorer 条目，绿
- [x] **T005**（FR-005）：webview 角色事实接线——`conversationHandlers.ts` 读 `conversationLoaded.metadata.role`，App 级 `subAgentRole` 状态下发至 `InputArea`；依赖：—；完成判据：`npm run check-types` 绿
- [x] **T006**（FR-005）：`inputAreaState.ts` 新增 `resolveSessionOptionsLocked` 纯函数（role 存在且 ≠ Master 时锁定）；依赖：T005；完成判据：`src/test/inputAreaState.test.ts` 新增用例——explorer 锁定、Master / Spin / 无 role 不锁定，`npm run test:all -- inputAreaState` 绿
- [x] **T007**（FR-005）：`InputArea.tsx` 三个选项接锁定判定（联网搜索复用既有置灰渲染、提示词模式 onChange 早退 + 降透明、MCP 行 onMcpToggle 早退 + 降透明）+ i18n 置灰提示键（zh / en）；依赖：T006；完成判据：`npm run check-types && npm run lint` 绿
- [x] **T008**（FR-002、FR-004、FR-005）：新增 `e2e/electron/subagentExplorer.spec.ts`——断言子代理首请求 tools 恰为四件套、Bash 被拒文案、explorer 视图选项菜单三项置灰；依赖：T003、T007；完成判据：`npx playwright test e2e/electron/subagentExplorer.spec.ts` 绿（需先 `npm run build:core:host` 与构建产物）
- [x] **T009**（FR-001～FR-005）：全量闸门——`npm run build:core:host` 后跑 `npm run test:all`（含 docs-lint）、`npm run test:core`；依赖：T004、T007、T008；完成判据：全部绿
- [x] **T010**（FR-001～FR-005）：/converge——US-51 并入需求基线（分册 + 附录 e2e 映射行）、填 `spec.md` 收敛记录、status 改「已收敛」、spec 整目录归档 `docs/archive/specs/020-explorer-subagent-role/`、提交（`Flow: L3` + `Spec: 020`）；依赖：T009；完成判据：归档后 `npm run test:all -- docs-lint` 绿，提交过 `scripts/githooks/commit-msg` 闸门
