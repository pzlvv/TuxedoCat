# 任务分解：跨工作区容器对话的状态灯与提示音策略

执行顺序：契约字段先行（T001），Core 两侧与宿主透传并行（T002–T004），文档同步随后
（T005）；状态灯纯函数与托盘用例独立并行（T006–T008）；e2e 与全量回归收尾（T009–T010）。
见同目录 `spec.md` / `plan.md`。

## 任务清单

- [x] **T001**（FR-004）：`src/shared/AssistantEventBus.ts` 给 `crossWorkspaceAgentRequested`
      与 `remoteSubAgentStarted` 各新增 7 个必选成员（`agentMode` / `thinkingEffort` /
      `promptMode` / `model` / `provider` / `webSearch` / `mcpServers`）；
      依赖：—；完成判据：`npm run check-types` 绿（漏改 `WebViewUI` 侧映射会编译报错）。
- [x] **T002**（FR-004）：`core-rs/src/engine.rs` 的 `spawn_remote_agent` 按查询路径同一
      口径解析发起方会话生效值（model / provider 成对，经 `config::resolve_provider`；
      thinking / prompt / webSearch 取会话覆盖、缺省回落全局默认；MCP 启用名单取
      `read_enabled_mcps`）写入请求载荷；依赖：T001；
      完成判据：`cargo test`（engine_tests）绿，含「载荷携带生效值与名单」新用例。
- [x] **T003**（FR-004）：`src/host/WebViewUI.ts` 的 `requestCrossWorkspaceAgent` 把请求
      新字段原样透传进 `remoteSubAgentStarted`（宿主不加工）；依赖：T001；完成判据：
      `npm run check-types` 绿；端到端透传由 T009 的 e2e 断言覆盖。
- [x] **T004**（FR-004）：`core-rs/src/engine.rs` 的 `start_remote_sub_agent` 应用继承——
      Master 全量写入、非 Master 角色固定 prompt normal / webSearch 关 / MCP 空名单而
      agentMode / 模型 provider 成对 / thinking 继承、MCP 名单经
      `mcp_config::write_session_enabled` 写子会话、载荷新字段缺失按 `Err` 拒绝；
      `persist_context` 扩展 thinkingMode / promptMode / webSearch（agentMode 已有）；
      依赖：T001；完成判据：`npm run test:core` 绿，`engine_tests.rs` 含 Master 全量 /
      非 Master 角色固定 / MCP 名单 / 缺字段报错新用例。
- [x] **T005**（FR-004）：文档同步——`docs/architecture/events.md` 两事件载荷列、
      `docs/features/cross-workspace-agent.md` FR-003 口径改写 + 3.2 契约成员表、
      [docs/hosts/electron-multi-workspace.md 第 9 节](../../docs/hosts/electron-multi-workspace.md#9-侧栏)、
      [docs/hosts/host-matrix.md 第 6 节](../../docs/hosts/host-matrix.md#6-宿主固有差异有意保留)、
      `docs/features/user-stories/desktop.md` US-56 / US-33；依赖：T002–T004；
      完成判据：`npm run test:all -- docs-lint` 绿。
- [x] **T006**（FR-001）：`src/shared/sessionRuntime.ts` 新增 `deriveContainerBusyLevel`
      纯函数（直接子代理聚合，waiting > running > idle，零 import）；依赖：—；
      完成判据：纯函数单测绿（waiting 优先 / 全 idle 无灯 / 空快照按 idle）。
- [x] **T007**（FR-001、FR-003）：`electron/sidebar/main.ts` 渲染循环对 `placeholder`
      非空行合成 state 注入现有 `runningBar` 逻辑（普通行路径不变，点击行为不变）；
      依赖：T006；完成判据：`npm run check-types` 绿 + T009 的 e2e 状态灯断言绿。
- [x] **T008**（FR-002）：`src/test/trayAttention.test.ts` 补跨工作区形态用例——
      `parentSessionId: "ph_…"` 的会话 running→idle 不进 `completedSessions`、
      running→waiting 产出 `anyNowWaiting`；依赖：—；完成判据：
      `npm run test:all -- trayAttention` 绿。
- [x] **T009**（FR-001、FR-003、FR-004）：`e2e/electron/crossWorkspaceAgent.spec.ts`
      扩展——容器行运行灯 / 无灯断言（AC-1 / AC-3），派发落定后读目标工作区子代理
      `meta.json` 断言继承值与 MCP 名单等于发起方设置（AC-7 / AC-10）；依赖：T004、T007；
      完成判据：`npm run test:e2e:electron -- -g "US-56"` 绿。
- [x] **T010**（FR-001、FR-002、FR-003、FR-004）：全量回归——`npm run check-types && npm
      run lint`、`npm run test:all`（含 docs-lint）、`npm run test:core`、
      `npm run test:e2e:electron` 全量；依赖：T005–T009；完成判据：四条命令全绿
      （既有无关失败按其记录单独说明）。
