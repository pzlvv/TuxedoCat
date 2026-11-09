# 实施方案：Bash 的 sleep 等待闸门

技术路线：把闸门放进权限决策的**拒绝**分支（`permission::base_check` 的 Bash 分支），而不是
放在 `tools::run_bash` 里。理由是 spec FR-002 要求「闸门在权限决策之前生效，三种 agentMode
行为一致」：`base_check` 产出的 `Deny` 在三档模式下都被 `decide` 原样返回，既不弹确认框也
不受 auto 放行影响；`run_bash` 在它之后执行，天然满足「与后台化构造闸门的先后顺序」。
需求见同目录 [spec.md](spec.md)。

## 技术方案

1. **判定纯函数**（`core-rs/src/tools.rs`）：新增 `pub(crate) fn is_sleep_wait_command(&str) -> bool`。
   - 按行切开命令文本（换行是命令分隔符，但不能进 `permission::split_by_separators` 的公共
     口径——那会同时改变只读判定、破坏性判定与 detach 扫描，属于越档改动）。
   - 每行再交给既有的 `permission::split_by_separators`，摊平成段列表。
   - 过滤空段与以 `#` 开头的纯注释段。
   - 命中判据：非空段多于一段，且**第一段**的命令名（`extract_command_name`，与
     `contains_sleep_command` / `sleep_duration_ms` 同一口径）是 `sleep`。
   - 管道形态 `sleep 5 | cat` 摊平后是两段，命中；`sleep 5` 只有一段，放行。

2. **失败文案**（`core-rs/src/tools.rs`）：`pub const BASH_SLEEP_GATE_MESSAGE: &str`，与
   `BASH_DETACH_GATE_MESSAGE` 并列，逐字取 spec 第「失败文案（逐字锁定）」节，不插值。

3. **闸门落点**（`core-rs/src/permission.rs`）：`base_check` 的 `"Bash"` 分支在
   `is_read_only_command` 判定之前插入
   `if crate::tools::is_sleep_wait_command(&command) { return CheckResult::deny(BASH_SLEEP_GATE_MESSAGE.to_string()) }`。
   用 `deny` 而非 `ask`：`ask` 在 auto 模式下会被放行，四档一致性无从谈起。

4. **既有用例改写**（行为回退之外的必要口径调整）：e2e 里命中新闸门的命令改成「sleep 不在
   首段」的等价写法，覆盖目标（长时间任务、manual 权限询问）不变。core-rs 单测直接调
   `tools::execute`，不过权限层，不受影响。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `core-rs/src/tools.rs` | 新增 `is_sleep_wait_command` 与 `BASH_SLEEP_GATE_MESSAGE` | 无（内部函数与常量，不进工具 schema、不进事件） |
| `core-rs/src/permission.rs` | `base_check` 的 Bash 分支加一条 deny | 无（`Decision` 枚举与 `CheckResult` 形态不变；`toolPermissionRequested` 载荷结构不变） |
| `core-rs/src/permission_tests.rs` | 三档模式一致性、detach 不解除、放行范围用例 | 无 |
| `core-rs/src/tools_tests.rs` | 判定纯函数用例组（分隔符 / 换行 / `&` 放行 / 管道 / 引号 / 环境变量前缀 / 纯注释） | 无 |
| `e2e/electron/remoteSshExecution.spec.ts` | manual 权限探针改为 `printf ...; sleep 2; uname -s` | 无 |
| `e2e/electron/remoteTaskSurvival.spec.ts` | 远端长任务改为 `printf 'probe'; sleep 180` | 无 |
| `docs/features/background-bash.md` | 新增 FR-005、AC-14～AC-21、实现对照行、逐字文案、边界与追溯矩阵 | 无 |
| `docs/features/bash-detach.md` | FR-002 补一句：detach 豁免不解除 sleep 等待闸门 | 无 |
| `docs/features/user-stories/tools.md` | 新增 US-76 | 无 |
| `docs/features/user-stories.md` | 「未覆盖 e2e 的 US」段登记 US-76 的豁免理由 | 无 |

## 宪章检查

- [x] **分层与依赖**（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：改动全在 `core-rs/`，闸门与文案都在 core 内部；
      不涉及 host / webview / shared，也不引入宿主 API 或宿主嗅探。不涉及 + 理由：没有新增
      跨层调用。
- [x] **架构铁律**（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：不新增可选项、不加 fallback；闸门是唯一写入点的
      拒判，判定只有一份实现（`is_sleep_wait_command`），文案只有一个常量；没有新增默认值。
      不涉及 + 理由：不引入契约成员与派生字段。
- [x] **Core 行为与落盘格式同步义务**（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：行为改动落在 `core-rs/`，
      `permission_tests` / `tools_tests` 同步补用例；不触碰落盘格式（会话 JSONL、meta.json、
      输出文件布局都不变），因此不需要 `history_tests` 对照。
- [x] **文档同步义务**（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：同提交更新 `docs/features/background-bash.md`
      （FR-005 + AC + 逐字文案 + 追溯矩阵）、`docs/features/bash-detach.md`（豁免边界）、
      `docs/features/user-stories/tools.md`（US-76）与 `docs/features/user-stories.md`
      （e2e 豁免段）；跑 `npm run test:unit -- docs-lint`。

## 被否决的替代方案

- **把闸门放在 `tools::run_bash` 里**（与 detach 闸门同处）：会落在权限决策之后，`manual` /
  `risk` 模式先弹一次确认框再拒绝，auto 模式直接放行——违背 FR-002 的三档一致，且浪费用户
  一次确认。
- **用 `is_destructive_command` 挂到 risk 判据上**：那只影响 risk 模式，auto 仍放行。
- **扩展 `permission::split_by_separators` 支持换行**：影响面远超本改动——只读判定、
  破坏性判定、detach 扫描、`contains_sleep_command`、前台 sleep 死线解析会同时改变行为，
  属于另一个量级的变更；本次在闸门内部按行切开。
- **在 `tools.rs` 里做闸门 + 在 `permission.rs` 里再判一次**：两份判据必然漂移，违背铁律
  「同一事实只有一个写入点」。
- **自动跳越 / 剥掉前导 sleep 续跑**（本轮更早的草案）：用户明确改为「拦下并给 reminder」，
  跳越方案不再是本次目标。
