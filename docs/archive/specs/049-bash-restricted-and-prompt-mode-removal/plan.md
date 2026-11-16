# 实施方案：Bash 的 restricted 闸门 + 删除提示词模式控制

需求见 [spec.md](spec.md)。技术路线一句话：**两条新判据进 `core-rs/src/permission.rs` 的 Bash
分支（在读只读判定之前 deny），判据本体收成 `tools.rs` 的两个纯函数并把 `restricted` 缺省
`true` 收在一处读取；提示词模式从内到外逐层拆（webview → host wire → `UiEvent` /
`CoreEvent` → Core 会话状态与预设组装 → 落盘字段 → 三端快照与宿主菜单），旧数据按「保留
不读」处理。**

## 技术方案

### 1. `restricted` 的读取口径

字段是「缺省为真」的布尔，与既有 `detach` / `run_in_background`（缺省为假）方向相反，
因此**不能**直接把 `js_coerce_bool` 当默认值用。唯一读取点放在 `core-rs/src/tools.rs`：

```text
bash_restricted(input) =
  match input.get("restricted") {
      None => true,                       // 字段缺省 = 收紧
      Some(value) => js_coerce_bool(Some(value)),   // 与既有布尔字段同一套 JS 真值语义
  }
```

语义对齐 spec 的边界表：`null` / `0` 归一成 `false`（视为显式关闭），字符串 `"false"` 归一
成 `true`（JS 真值），不另造一套布尔解析。`tool_input.rs` 的 Bash 字段表用
`Kind::CoerceBool` 登记该字段（`strict` 校验放行；缺省不补默认值），默认值仍只在
`bash_restricted` 一处定义（[架构原则第 9 节](../../docs/architecture/principles.md#9-同一字段的默认值只有一处)）。

### 2. 判据：两个纯函数，共用一份切段

现有的 `is_sleep_wait_command`（首段 sleep + 后续命令）被 FR-002 取代，它的切段逻辑
（屏蔽 heredoc 正文 → 按行切 → `split_by_separators` → 丢纯注释段）保留成共用基座：

```text
gate_segments(command) -> Vec<String>      // mask_heredoc_bodies + 按行 + split_by_separators + 丢注释段
has_sleep_command(command) -> bool         // gate_segments 里任一段 extract_command_name == "sleep"
is_cd_sed_only_command(command) -> bool    // 去掉 extract_command_name == "cd" 的段后，非空且全部 == "sed"
```

三条既有辅助原样复用，不新写首词口径：`mask_heredoc_bodies` / `is_comment_segment` /
`extract_command_name`（剥环境变量前缀、首尾各至多去一个引号）。`is_sleep_wait_command`
删除；`contains_sleep_command` **保留不动**——它是前台超时死线后移
（`default_bash_timeout_ms`）与后台兜底提醒（`bash_task::qualifies_fallback_reminder`）
的判据，不是闸门，语义与新闸门不同（不认换行、不屏蔽 heredoc）。

`cd` 段的识别用 `extract_command_name == "cd"`（而非 `permission::first_word`）——后者不剥
环境变量前缀，`FOO=1 sed -n 1p f` 会得到 `FOO=1`；同一次判定里不能有两套首词口径。

### 3. 闸门落点与 `permission.rs` 的改动

`base_check` 的 `"Bash"` 分支当前顺序是「command 合法性 → sleep 等待闸门 → 只读判定 →
ask」。改成：

```text
command 合法性
  → if bash_restricted(args) {
        if has_sleep_command(command)      → deny(BASH_RESTRICTED_SLEEP_MESSAGE)
        if is_cd_sed_only_command(command) → deny(BASH_RESTRICTED_SED_MESSAGE)
    }
  → is_read_only_command → allow_with_input
  → ask
```

三点必须保持：

- **deny 而不是 ask**：ask 在 `auto` 模式会被放行，三档一致性就没了（与既有 sleep 闸门同一
  理由）。被拦的调用不弹确认框、不产生后台任务。
- **在只读判定之前**：`sed` 不在只读白名单，若先判只读会先弹 ask；`sleep` 同理。
- **与 `detach` 互不豁免**：detach 闸门在 `run_bash`（权限之后）、本闸门在权限层，两者顺序
  天然是「先用 restricted 判 sleep / sed，再用 detach 判后台化构造」，不需要额外互斥代码；
  `restricted` 也不参与 `is_detach_escape`。

### 4. 两条失败文案

各自一个常量，逐字锁定、不插值（对齐 `BASH_SLEEP_GATE_MESSAGE` / `BASH_DETACH_GATE_MESSAGE`
的既有形态：`Bash: <问题>` + `- <出路>` 列表）：

| 常量 | 内容要点 |
| --- | --- |
| `BASH_RESTRICTED_SLEEP_MESSAGE` | 不要用 `sleep` 来 poll；可以条件 poll，或直接停止、等结果返回时收到通知 |
| `BASH_RESTRICTED_SED_MESSAGE` | 请改用 `Read` 工具读取文件 |

`BASH_SLEEP_GATE_MESSAGE` 随旧判据一起删除（`restricted: false` 的出路取代了它的
「往 sleep 前加任意命令」）。

### 5. 说明面：schema 一行 + 系统提示词一行

- `core-rs/src/tools.rs` 新增 `BASH_RESTRICTED_FIELD`（中文、一句话）：默认 `true`，通常传
  `true`；不展开用法与案例（同 `BASH_DETACH_FIELD` 的最小披露口径）。
- `core-rs/src/prompt.rs` 的 `TOOL_DETAILS_BEFORE_TRANSFER` Bash 段在 `**Background
  Execution**` 之后补一行同等口径的说明；`core-rs/fixtures/systemPrompt.json` 的
  `toolUsage` 逐字同步（该 fixture 是 `tool_usage_section` 的完整产物，手工精确替换）。

### 6. 删除提示词模式：由外向内七层

按依赖方向拆，每层删完下一层才编译：

1. **webview 呈现**：`InputArea.tsx` 的 `PromptModeSegmentControl`、菜单项
   `key: 'promptMode'`、`webSearchDisabled` 里的 `promptMode === 'minimal'`、
   `handleWebSearchChange` 的早退；`LLMConfigPanel.tsx` 的「默认提示词模式」分段控件与
   `presetPayload.defaultPromptMode`；`inputAreaState.ts` 的 `resolvePromptModeLocked`；
   `App.tsx` / `sessionState.ts` / `types.ts` / hooks 里的状态、下发 effect、`applyDefaults`
   分支与日志；i18n 的中英文条目（`inputArea.promptMode*`、
   `inputArea.webSearchMinimalHint`、`inputArea.remotePromptModeLockedHint`、
   `llmConfig.defaultPromptModeLabel/Hint`、`applyDefaults.changePromptMode`）。
2. **host wire 与翻译**：`webviewMessages.ts` 的 `setPromptMode` 与六处载荷字段、`WebViewUI.ts`
   的 `case 'promptMode'`、`webviewMessageHandler.ts` 的分发表条目 / `conversationLoaded`
   补齐 / `settingsDefaults` / `defaultsChanged` / `llmConfigSaved` 载荷、
   `settingsRead.ts` 的 `readDefaultPromptMode`、`llmConfigSave.ts` 的 `PROMPT_MODES` 与写盘
   分支、`SettingsStore.ts` 的 `KNOWN_TOP_LEVEL_KEYS`（见第 7 节）。
3. **shared 契约**：`AssistantEventBus.ts` 的 `UiEvent.promptModeChanged` 与
   `sessionConfigChanged.change` 的 `{ key: 'promptMode' }` 判别成员；`settingsSnapshot.ts` 的
   `PromptPresetId` / `DEFAULT_PROMPT_PRESET` / `isPromptPresetId` / `defaultPromptMode` 字段；
   `history/Conversation.ts` 的 `ConversationContext.promptMode`。
4. **Core 会话状态**：`engine.rs` 的 `SessionState.prompt_mode` 与其初始化、`ensure_loaded`
   的恢复、`on_session_config_changed` 的 `"promptMode"` 分支、本地 / 跨工作区子代理的继承
   与「恒 normal」赋值与 `persist_context`、`announce_message_appended` 传给 `touch_metadata`
   的参数。
5. **Core 预设组装**：`prompt.rs` 删除 `normalize_prompt_mode` / `active_preset` /
   `preset_tool_names` / `filter_tools_by_preset` / `preset_core_prompt`，把
   `build_system_prompt_with_preset` 收成单一 `build_system_prompt(cwd, tools,
   transfer_counterpart)`（恒组装核心原则 + `## Tool Usage` + `## Tool Details` + 环境段 +
   AGENTS.md；旧的 `build_system_prompt(cwd, agent_mode, metadata)` 测试便利包装一并删除）；
   `engine.rs` 的查询循环去掉 preset / `filter_tools_by_preset` / `minimal 强制关联网搜索`，
   角色白名单（Explorer）与联网搜索 / MCP 名单两条既有过滤链保持原样。
6. **落盘与快照**：`history.rs` 的 `touch_metadata` 删 `prompt_mode` 参数与补写块；
   `core-rs/src/settings.rs` 删 `default_prompt_mode` 字段（**必选字段，必须与三端
   `settings_payload` 同一提交删**，否则 Core 因快照缺字段永远不就绪）；`test_support.rs` 与
   `main_tests.rs` / `settings_tests.rs` 的 fixture 同步。
7. **另两端宿主**：`tui-rs`（`Menu::PromptMode`、`Ctrl+K` 菜单项与二级菜单、`host.rs` 的键翻译
   与 `settingsDefaults` / `conversationLoaded` 补齐、`settings.rs` 与 `store.rs` 的字段）；
   `pycharm-plugin`（`SettingsSnapshot.kt` 的解析与键集合、`HostUi.kt` 的双向翻译与三处载荷、
   `LlmConfigSave.kt` 的字段合并与 `defaultsChanged`）。

### 7. 旧数据的落位

- **`meta.json`**：`history.rs` 用 `serde_json::Value` 读-改-写，未知键原样保留。删掉
  `promptMode` 的读取点后，旧会话里的 `context.promptMode` 自动变成惰性字段——不加清洗任务、
  不加迁移。对应新用例锁「带 `context.promptMode` 的旧 meta 加载成功且字段仍在」。
- **`settings.json`**：`SettingsStore.ts` 的 `KNOWN_TOP_LEVEL_KEYS` 把 `defaultPromptMode`
  从「快照覆盖的字段」移到「历史遗留字段」（与 `theme` / `shortcut` 同组），因此旧配置不触发
  unknown warning、不删键、不进快照。
- **`setPromptMode` 消息**：webview 删干净后不会再发；`dispatchWebviewMessage` 的兜底
  （未知类型记 warn 后忽略）是既有行为，不需要新增代码。

### 8. 测试改动清单（真实链路上的 `sleep` 必须显式关闭限制）

闸门在**权限层**，因此「直接调 `tools::execute`」的单测（`core-rs/src/tools_tests.rs` 的
`sleep` 超时 / 自动转后台 / `detach` 用例）不经过闸门、照常绿；凡是走
engine → permission 的真实链路，命令里带 `sleep` 就必须补 `restricted: false` 或改写成等价
形态：

| 落点 | 现状 | 改法 |
| --- | --- | --- |
| `src/test/standaloneCorePermission.test.ts` | `risk` / `manual` 用 `sleep 1` 断言「只上架卡片不弹框」 | 改用非 `sleep` 的普通写命令（如 `echo probe > out.txt`），断言不变；另加一档 `restricted: false` 的 `sleep 1` 回归 |
| `src/test/coreRequestWaiting.test.ts` | `runRoundtrip({ command: 'sleep 1' })` | 同上换普通命令；保持「权限等待中」的被测语义 |
| `e2e/electron/backgroundBash.spec.ts` | `sleep 60` / `sleep 6` 造长任务 | 补 `restricted: false`（要的是「长命令」，不是「绕过闸门」的表达） |
| `e2e/electron/assistant.spec.ts` | `sleep 30, run_in_background: true` | 补 `restricted: false` |
| `e2e/electron/remoteSshExecution.spec.ts` | `printf ...; sleep 2; uname -s`、`sleep 45` | 补 `restricted: false` |
| `e2e/electron/remoteTaskSurvival.spec.ts` | `printf probe; sleep 180 && ...` | 补 `restricted: false` |
| `e2e/webview/bashBackgroundButton.spec.ts` | `toolArgs: { command: 'sleep 30' }`（纯前端假消息，不入 core） | 不动 |

提示词模式侧删断言：`src/test/settingsSnapshot.test.ts`、`src/test/hostSettings.test.ts`、
`src/test/settingsConcurrency.test.ts`、`src/test/inputAreaState.test.ts`（六条
`resolvePromptModeLocked`）、`src/test/webviewFacts.test.ts`（`literalPatterns` 与两处状态初值
循环里的 `promptMode`）、`core-rs/src/prompt_tests.rs`（预设两组 + `minimalPrompt` 对照）、
`core-rs/src/engine_tests.rs`（`minimal_prompt_mode_*` / `mixed_prompt_mode_*` /
`prompt_mode_is_restored_from_metadata` / `explorer_fixes_session_config_while_master_inherits`
的预设断言改写为「配置全量继承」口径）、`core-rs/src/history_tests.rs`（`touch_metadata` 两条
断言）、`core-rs/src/main_tests.rs` / `settings_tests.rs` 的 fixture、
`tui-rs/src/settings_tests.rs` / `store_tests.rs`、
`pycharm-plugin/.../SettingsAndLockTest.kt`（键集合断言）、
`e2e/webview/inputMenu.spec.ts` / `settings.spec.ts` / `subagentOptionsLock.spec.ts`、
`e2e/electron/subagentExplorer.spec.ts` / `subagentInheritance.spec.ts` /
`crossWorkspaceAgent.spec.ts` 的 `context.promptMode` 断言。

### 9. 施工顺序

1. Core 数据面（第 6 节第 3～6 层 + `tool_input` 字段登记）→ `cargo test` 绿。
2. `restricted` 判据与闸门 + 文案 + schema / 提示词说明 → `cargo test` 绿。
3. e2e / TS 侧「真实链路里带 `sleep`」的用例改写成 `restricted: false` 或等价命令。
4. host wire 与 webview（第 6 节第 1～2 层）→ `check-types` / `lint` 绿。
5. TUI / PyCharm。
6. 文档与缺陷规格；最后跑 `docs-lint`、`test:unit`、`test:core`。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `core-rs/src/tools.rs` | 新增 `bash_restricted` / `gate_segments` / `has_sleep_command` / `is_cd_sed_only_command` / 两个文案常量 / `BASH_RESTRICTED_FIELD`；Bash `input_schema` 增 `restricted`；删 `is_sleep_wait_command` 与 `BASH_SLEEP_GATE_MESSAGE` | 工具入参见 `restricted`（LLM 可见 schema） |
| `core-rs/src/tool_input.rs` | Bash 字段表增 `restricted: Kind::CoerceBool` | 无总线契约变化 |
| `core-rs/src/permission.rs` | `base_check` Bash 分支：`restricted` 为真时两条 deny，取代旧 sleep 闸门 | 无（决策口径变化，不改载荷） |
| `core-rs/src/prompt.rs` | 删五个预设函数与 `build_system_prompt_with_preset`，收成单一 `build_system_prompt`；Bash 详情段补 `restricted` 一行 | 无总线契约变化（提示词文本变化） |
| `core-rs/src/engine.rs` | 删 `SessionState.prompt_mode` 及其全部读写（初始化 / 恢复 / 配置分支 / 子代理继承与恒 normal / 查询循环 preset 与 minimal 关联网搜索） | 删 `sessionConfigChanged.change` 的 `promptMode` 键的生产点 |
| `core-rs/src/history.rs` | `touch_metadata` 删 `prompt_mode` 参数与补写块；`update_context` 文档注释同步 | 落盘格式：`context.promptMode` 不再写入（旧值保留） |
| `core-rs/src/settings.rs` / `test_support.rs` | 删 `default_prompt_mode` 字段与测试快照键 | 快照契约删 `defaultPromptMode`（三端同步） |
| `core-rs/src/main.rs` | `dispatch_ui_event` 删 `"promptModeChanged"` 分支 | 删 `UiEvent.promptModeChanged` |
| `core-rs/fixtures/toolSchema.json` / `toolInputValidation.json` | 增 `restricted` 属性与校验用例 | 对照表 |
| `core-rs/fixtures/systemPrompt.json` | `toolUsage` 增 `restricted` 一行；删 `minimalPrompt` | 对照表 |
| `core-rs/fixtures/permission.json` | 重写 sleep 闸门 7 条为 `restricted` 语义；补 `cd + sed` 与 `restricted: false` 用例 | 对照表 |
| `core-rs/fixtures/eventTypes.json` | `uiEvents` 删 `promptModeChanged` | 事件词汇表 |
| `src/shared/AssistantEventBus.ts` | 删 `UiEvent.promptModeChanged`、`sessionConfigChanged.change` 的 `promptMode` 成员 | `UiEvent` 29 → 28；`CoreEvent` 33 不变（只删判别成员） |
| `src/shared/settingsSnapshot.ts` | 删 `PromptPresetId` / `DEFAULT_PROMPT_PRESET` / `isPromptPresetId` / `defaultPromptMode` / `resolvePromptMode` | 快照字段删 `defaultPromptMode` |
| `src/shared/history/Conversation.ts` | 删 `ConversationContext.promptMode` | 落盘类型（只读视图）删字段 |
| `src/host/webviewMessages.ts` | 删 `setPromptMode` 与六处 `promptMode` / `defaultPromptMode` 载荷 | wire 消息类型 48 → 47 |
| `src/host/WebViewUI.ts` / `ui/webviewMessageHandler.ts` | 删 `case 'promptMode'`、分发表条目、`conversationLoaded` 补齐、`settingsDefaults` / `defaultsChanged` / `llmConfigSaved` 载荷 | 无（`CoreEvent` 映射表不变） |
| `src/host/settingsRead.ts` / `llmConfigSave.ts` / `SettingsStore.ts` | 删 `readDefaultPromptMode`、`PROMPT_MODES` 与写盘分支；`defaultPromptMode` 归入历史遗留字段 | 无 |
| `src/webview/{App.tsx,InputArea.tsx,LLMConfigPanel.tsx,inputAreaState.ts,sessionState.ts,types.ts,components/SegmentControl.tsx}` | 删状态、控件、锁定判定与注释 | 无 |
| `src/webview/hooks/**`、`src/webview/i18n/{zh,en}.ts` | 删 `setPromptMode` 分发、`applyDefaults` 分支、默认值补齐、14 条文案键 | 无 |
| `tui-rs/src/{app,host,settings,store}.rs` | 删 `Menu::PromptMode`、菜单项与二级菜单、键翻译、快照字段与投影 | `UiEvent` / 快照同步 |
| `pycharm-plugin/src/main/kotlin/pycharm/host/{settings/SettingsSnapshot.kt,ui/HostUi.kt,llm/LlmConfigSave.kt}` | 删字段解析、双向翻译、三处载荷、`defaultsChanged` 比对 | `UiEvent` / 快照同步 |
| `src/test/**`、`core-rs/src/*_tests.rs`、`tui-rs/src/*_tests.rs`、`pycharm-plugin/src/test/**`、`e2e/**` | 删预设相关断言；真实链路带 `sleep` 的用例补 `restricted: false`；新增 `restricted` 判据与旧数据用例 | 无 |
| `docs/**`（见 spec 影响基线表）与 `specs/defects/` 五个已修缺陷规格 | 按 spec 影响基线逐条同步 | 事件表 / 快照字段表 / 消息数量 / US |

## 宪章检查

- [x] **分层与依赖**：新判据全在 `core-rs/`（`tools.rs` 纯函数 + `permission.rs` 决策），不引入
      宿主 API、不做宿主嗅探；提示词模式的删除是「删」不是「迁」，webview 侧不 import
      配置默认值模块（`webviewFacts.test.ts` 继续守卫）、host 侧只做 wire 翻译。
- [x] **架构铁律**：`restricted` 是可选的布尔**工具入参**（不是总线契约成员），默认值只在
      `bash_restricted` 一处（铁律「同一字段的默认值只有一处」）；不新增 fallback——`restricted`
      缺省即 `true` 是显式默认语义，不是静默降级；每个判据只有一份实现、每条文案只有一个常量
      （铁律「一份事实只有一个写入点」）；`sed` 的只读归属、`sleep` 的死线后移都不动。
- [x] **Core 行为与落盘格式同步义务**：行为改动落在 `core-rs/`，`tools_tests` / `permission_tests`
      同步补用例；落盘面删的是 `context.promptMode` 的**写入**（读-改-写保留旧值），
      `history_tests` 补「旧 meta 带 `promptMode` 仍可加载」用例；快照字段删除必须
      TS / tui-rs / pycharm 三端与 `core-rs/src/settings.rs` 同一提交完成，否则 Core 就绪握手失败。
      **两套 Core parity：不涉及 + 理由**——仓库只有 Rust Core（[ADR-0007](../../docs/adr/0007-single-core-rust-only.md)），
      Embedded TS Core 已退役，`src/core/**` 与 `toolSchemaParity` 对照表不复存在。
- [x] **文档同步义务**：同提交改 spec 影响基线列出的全部规格（`background-bash.md` FR-005 重写、
      `bash-detach.md` 豁免边界补一句、`events.md` 删行并重算数量、`core-ui-separation.md` 4.3 删行、
      `host-ui-modules.md` 消息数、`webview-facts.md` / `tui.md`、US-8 / US-24 / US-51 / US-56 /
      US-76 / 新增 US-78 与索引附录）与五个已修缺陷规格的失效不变量；`events.md` 体积棘轮按新行数
      下调；跑 `npm run test:unit -- docs-lint` 必须绿。**ADR**：本次「`restricted` 作为模型面
      收紧开关、缺省为真」具备决策分量，建议另立 `docs/adr/0016-*.md` 记录（决策 + 被否决的
      「永久生效」「按危险操作 ask」两条线），编号递增、不阻塞实施。

## 被否决的替代方案

1. **闸门放在 `run_bash` 里（与 detach 闸门同处）**：权限层在 `run_bash` 之前跑，放在
   `run_bash` 会让 `manual` / `risk` 先弹一次确认框再拒绝、`auto` 直接放行——违背三档一致
   （与既有 sleep 闸门被否决的同一理由）。
2. **`restricted: false` 降级为 ask（用户确认）**：用户已明确选「完全放开」，且 ask 在
   `auto` 下等于放行、在 `manual` 下变成每次都问，语义在三档间不一致。已记入 spec FR-004。
3. **保留「首段 sleep + 后续命令」旧闸门无条件生效**：会出现「关了 `restricted` 仍被旧闸门
   拦住」的双开关，模型手上的开关与实际生效的限制不对应（铁律「一份事实只有一个写入点」）。
4. **`restricted` 缺省为 `false`（显式收紧）**：与需求相反（默认服务端收紧才是目的），且会让
   忘记传参的模型绕过限制。
5. **把 `restricted` 扩成枚举（`off` / `no-sleep` / `full`）**：本次只有「全开 / 全关」两种
   可观察状态，三态枚举会引入不可测的组合；需要细分时再版本化。
6. **新写一套 sleep / sed 首词判定**：会与 `extract_command_name`（剥环境变量前缀）和
   `permission::first_word`（不剥）形成第三套口径，判据必然漂移；本方案只抽出共用切段。
7. **删除 `contains_sleep_command` 一并收进新判据**：它服务于前台死线后移与兜底提醒，
   语义（不认换行、不屏蔽 heredoc、单条也算）与新闸门不同；合并会让 `sleep` 的超时估算随
   闸门口径漂移。
8. **把 `detach` 一并补进入参校验**：`detach` 未登记进 `tool_input.rs` 是现存缺陷，修它会改变
   「带 `detach` 的真实链路行为」并需要独立回归；本次只为 `restricted` 补登记，不夹带（spec 已
   写进边界与非目标）。
9. **旧数据一次性清洗**（删 `meta.json` 的 `context.promptMode`、删 `settings.json` 的
   `defaultPromptMode`）：写盘权限归 Core，一次全库扫描会跨越历史存档与远程工作区，收益只是
   「文件更干净」；保留不读符合「读-改-写保留未知键」的既有口径。
10. **把 `promptMode` 保留为死字段（只删 UI）**：会留下「契约成员无人消费」「Core 仍按预设裁剪
    工具清单」的隐性行为，实测会剥夺 `Reply`；需求要求的是删除该控制。
11. **保留极简提示词改造为「省 token 模式」**：属于新特性，且与本次「删除该控制」的目标冲突；
    将来的同类需求重新走 spec。
