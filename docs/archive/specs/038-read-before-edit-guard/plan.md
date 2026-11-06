# 实施方案：Edit / Write 的读后失效守卫

技术路线：新增一个进程内「会话 → 文件 → 内容指纹」记录表（`core-rs/src/read_guard.rs`），
Read 成功时登记、Edit / Write 执行前比对；判定与文案集中在守卫模块一处，`run_read` /
`run_edit` / `run_write` 只做三个接入点。指纹用内容哈希而不是时间戳，因此本会话自己的
写入可以就地刷新记录、外部改动一定拦住。需求口径见同目录 [spec.md](spec.md)。

## 技术方案

### 1. 守卫模块（`core-rs/src/read_guard.rs`，新增）

```rust
pub(crate) struct FileFingerprint(String);   // SHA-256 十六进制，64 字符

/// 记录一次成功读取：`path` 已由调用方展开为绝对路径。
pub(crate) fn record_read(session_id: &str, path: &Path, bytes: &[u8]);

/// Edit / Write 执行前的比对。`current` 是刚读到的磁盘字节。
/// 返回 `None` = 放行，`Some(message)` = 工具错误文案。
pub(crate) fn verify(session_id: &str, path: &Path, current: Option<&[u8]>) -> Option<String>;

/// Write 成功 / Edit 成功之后刷新（等价「刚读过写入后的结果」，spec FR-002）。
pub(crate) fn record_write(session_id: &str, path: &Path, bytes: &[u8]);

/// 会话释放（spec FR-003 的记录生命周期）。
pub(crate) fn clear_session(session_id: &str);
```

- 记录表：`static RECORDS: Mutex<Option<HashMap<String, HashMap<String, FileFingerprint>>>>`，
  外层键是 `session_id`、内层键是规范化路径。用 `Option<HashMap>` 而不是 `HashMap`：与
  `tools.rs` 的 `TODOS` 同款惰性初始化，单测清零时整体置 `None`（`reset_for_test`）。
- 哈希复用已有依赖 `sha2`（`core-rs/src/config.rs` 已在用，不新增 crate）。对**原始字节**
  求哈希，不走 `String::from_utf8_lossy`——`run_read` 的展示层是 lossy 的，但指纹必须能
  区分磁盘上的真实字节（否则两个不同的非法 UTF-8 文件会得到同一指纹）。
- 路径规范化：新增内部 `fn normalize(path: &Path) -> String`——先 `std::fs::canonicalize`
  （成功即得），失败（文件不存在 / 权限）退化为 `expand_path` 产物按平台分隔符归一。
  Read 与 Edit / Write 都经同一个 `normalize`，`a.ts`、`./a.ts`、`sub/../a.ts` 落到同一条
  记录。不用 `to_string_lossy` 之外的第二套比较逻辑。

### 2. 判定矩阵（`verify`）

| 记录 | `current` | 结论 |
| --- | --- | --- |
| 存在，指纹相等 | 有 | 放行 |
| 存在，指纹不等 | 有 | 拒绝：「该文件在你上次读取之后被修改，请重新读取后再编辑」，点名 `file_path` 原文与展开后的绝对路径 |
| 不存在 | 有 | 拒绝：「请先读取该文件再编辑」，点名路径 |
| 不存在 | 无（文件不存在） | 放行（只有 Write 新建会走到） |

拒绝是 `ToolOutcome::Error`，文案常量 `READ_STALE_MESSAGE` / `READ_MISSING_MESSAGE` 由
守卫模块导出、单测逐字锁定。**不进 `permission.rs`**：权限层在授权前跑，在那里拒绝会让
「确认框都不弹」与「工具执行报错」两种观感混在一起（spec 边界已定，一份事实一个写入点）。

### 3. 三个接入点

- `run_read`：文本分支成功时（`ToolOutcome::Success(format_read_output(..))` 之前）调
  `record_read(&ctx.session_id, &path, &bytes)`。`bytes` 是整份文件的原始字节，与
  `offset` / `limit` 无关（spec FR-001「片段 Read 也建立整份指纹」）。
  **不记录**的分支：图片、xlsx、二进制拒绝、超限拒绝、文件不存在——它们没有建立「文本
  内容认知」，本来也不能被 Edit / Write 按文本编辑（spec FR-003 最后一条）。
- `run_write`：在 `before_content` 读取之后、`std::fs::write` 之前调 `verify`。文件不存在
  时 `before_content` 为 `None`，交给 `verify(None)` 走「新建放行」。写成功后
  `record_write`（读回磁盘字节，而不是直接用 `content.as_bytes()`，保证与真实落盘一致）。
- `run_edit`：在 `std::fs::read_to_string` 成功后立即 `verify`（此时 `current` 必然是
  `Some`）。写成功后 `record_write`。放在读盘之后而不是之前：`foo` 不存在时仍要保留既有
  `ENOENT` 文案（spec 边界第 1 条）。

### 4. 会话生命周期

`core-rs/src/engine.rs` 的 `drop_session` 里调 `read_guard::clear_session(session_id)`，
与 `compact::unmark_pending_compact` / `subagent::unregister` 同一处收口——所有释放路径
（关闭、删除、崩溃后重新装载前的清理）都经过 `drop_session`。`on_conversation_closed`
已经调 `drop_session`，不重复接入（一份事实一个写入点）。

子代理与跨工作区会话各有自己的 `session_id`，键天然隔离（spec FR-003 第 1 条）；Core
重启后静态表为空，第一次 Edit 必然要求 Read（spec FR-003 第 2 条）。

### 5. 存量用例迁移（实施风险，先红后绿）

`core-rs/src/tools_tests.rs` 现有 25 处 `Sandbox::write_file` 与 14 处 Edit / Write 直调，
其中「对已存在文件 Edit / Write 但没走过 Read」的用例会在守卫落地后变红。迁移策略：

1. 给 `Sandbox::write_file` 保持原样（它只是造场景）；新增
   `Sandbox::seed_read(session_id, rel)`：读一次盘并 `record_read`，语义是「模型读过」。
2. 受影响用例逐个判定：验证 Edit / Write 本身行为的补一行 `seed_read`；验证守卫的用例
   用**不 seed** 的写法（守卫专项用例在测试文件末尾新开一组，与 `detach` 那组同位置）。
3. 新增 `read_guard_reset_for_test()`，在每个守卫用例开头调（静态表跨用例可见，与
   `bash_task::reset_for_test` 同款），避免用例间串味。

完成判据：`cargo test --bin standalone-core tools::` 全绿，且守卫专项用例在未加
`seed_read` 的情况下覆盖 AC-1 ～ AC-7。

### 6. 文档落点

- [docs/core/standalone-core.md 第 7 节](../../docs/core/standalone-core.md#7-事实归属)（事实归属）后新增一节「Read 与 Edit / Write 的
  时效契约」：什么算读过、失效判据、拒绝文案、解除方式、不跨会话 / 不跨重启。
- [docs/architecture/events.md 第 2.1 节](../../docs/architecture/events.md#21-coreeventcore--ui单向) `toolResult` 行的「core 侧触发点」补一句
  「读后失效拒绝」——载荷不变，只是多一条产出路径。
- `docs/features/user-stories/tools.md` EP-7 新增 US-68（读后失效的编辑被拒绝并提示重新
  读取），`docs/features/user-stories.md` 附录登记 e2e 映射（`e2e/electron/assistant.spec.ts`
  补一条）。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `core-rs/src/read_guard.rs` | 新增 | 无（进程内状态，不进总线） |
| `core-rs/src/main.rs` | 新增 `mod read_guard;` | 无 |
| `core-rs/src/tools.rs` | `run_read` / `run_write` / `run_edit` 三处接入 | 无（工具入参 schema 不变，spec 非目标） |
| `core-rs/src/engine.rs` | `drop_session` 调 `clear_session` | 无 |
| `core-rs/src/tools_tests.rs` | 存量迁移 + 守卫专项用例 | 无 |
| `docs/core/standalone-core.md` | 新增一节 | 无 |
| `docs/architecture/events.md` | `toolResult` 触发点补一句 | 无载荷变化 |
| `docs/features/user-stories/tools.md` / `user-stories.md` | 新增 US-68 + e2e 映射 | 需求基线 |
| `e2e/electron/assistant.spec.ts` | 补一条 Read → 外部改写 → Edit 拒 → 重读 → Edit 成功 | 无 |

## 宪章检查

- [x] 分层与依赖（`AGENTS.md` 第 1 节）：改动全部在 `core-rs/` 内，不 import 宿主实现、
      不做宿主嗅探；守卫是 core 的执行期事实。
- [x] 架构铁律（`AGENTS.md` 第 4 节）：不过度 fallback——失效即工具错误、不静默放行、
      不自动重读；契约成员全必选（不改工具入参 schema）；一份事实一个写入点（记录表只有
      `read_guard.rs` 一处写入，判定只有 `verify` 一处）；默认值单源（无新默认值）；
      时间戳不参与判定。
- [x] Core 行为与落盘格式同步义务（`AGENTS.md` 第 5 节）：Core 行为落点在 `core-rs/` 并
      同步 `tools_tests.rs`；落盘格式（JSONL / meta.json）零变更，不需要 `src/shared/history/`
      同步。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：第 6 节三处文档与代码同一提交；spec 收敛时
      delta 并入 `docs/core/standalone-core.md`。

## 被否决的替代方案

1. **比较 mtime / inode**：同秒写入、时钟回拨、网络盘与 WSL 挂载上不可靠（spec FR-002
   已写明用内容指纹）。否决。
2. **在 `permission.rs` 的 `checkPermissions` 里拦**：权限阶段是「弹不弹确认框」的判据，
   在那里拒绝会让 manual 模式下的 Edit 卡片 diff 都不显示，用户看到的是「工具没跑」而
   不是「文件变了」。否决，保留守卫在 `run_edit` / `run_write`（spec 边界已定）。
3. **记录落盘（跨重启保留）**：需要新的落盘格式与 Core / TS 两侧同步，且重启后仍拿陈旧
   认知覆盖文件的风险更大。spec FR-003 明确不跨进程持久化。否决。
4. **自动重读一次再重试 Edit**：把「模型该重新决策」变成 core 的隐式重试，会在 `old_string`
   命中旧内容的场景下产生难以解释的结果。spec 要求拒绝并让模型重新 Read。否决。
5. **给 Edit 加 `force` 入参**：扩大工具面且给模型一条绕过守卫的捷径。spec 非目标明确
   不做。否决。
