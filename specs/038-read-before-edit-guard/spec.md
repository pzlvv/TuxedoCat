---
status: 起草
---

# 改动规格：Edit / Write 的读后失效守卫

Edit / Write 在「文件在当前会话最后一次 Read 之后被改过」时拒绝执行并报错，要求模型
重新 Read 拿最新内容——对齐业界工具实现（Claude Code / Cline / Roo 等的
`file has been modified since read` 守卫）。当前实现只在 `old_string` 匹配不上时报
`Please read the file first`，那是**事后**提示；文件被外部改写后 `old_string` 仍可能
匹配到旧内容（或写回整份陈旧内容），改动会静默覆盖掉别人刚写的东西。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| `docs/architecture/events.md` | 2.1 CoreEvent 汇总表 | 修改 | `toolResult` 的触发点列补「读后失效拒绝」这一条来源；不改载荷 |
| `docs/core/standalone-core.md` | 7. 工具 | 新增 | 新增一节「Read 与 Edit / Write 的时效契约」：什么算「读过」、什么算「已失效」、拒绝文案与解除方式 |
| `docs/features/user-stories/tools.md` | EP-7 工具与技能 | 修改 | 新增 US（读后失效的编辑被拒绝并提示重新读取） |

## 用户场景与验收标准

- 场景 1：外部改动后编辑被拒
  - **AC-1**（FR-001）：GIVEN 模型 Read 了 `a.ts` WHEN 文件在磁盘上被外部进程改写后再 Edit THEN 工具返回错误、点名「文件在该次读取后被修改」并提示重新 Read，磁盘内容不变
  - **AC-2**（FR-001）：GIVEN 同一情形（Read 后文件被外部改写）WHEN Write 覆盖 THEN 同样返回错误、磁盘内容不变
  - **AC-3**（FR-002）：GIVEN 工具被拒 WHEN 模型重新 Read 同一文件 THEN 随后的 Edit / Write 正常执行
- 场景 2：本会话自己的改动不算失效
  - **AC-4**（FR-002）：GIVEN 模型 Read 了 `a.ts` WHEN 它自己用 Edit 改了同一个文件、未再 Read 就再次 Edit THEN 照常成功（本会话自己的写入更新读取记录，不自我阻塞）
- 场景 3：从未读过
  - **AC-5**（FR-003）：GIVEN 本会话从未 Read 过 `a.ts`（文件已存在） WHEN Edit THEN 返回错误并要求先 Read
  - **AC-6**（FR-003）：GIVEN 本会话从未 Read 过 `a.ts` WHEN Write **新建**它 THEN 照常成功（新建没有「旧内容」可踩）
- 场景 4：读的是片段
  - **AC-7**（FR-003）：GIVEN 模型只 Read 了 `a.ts` 的 10–20 行 WHEN 文件此后未变、Edit 命中该窗口内的文本 THEN 成功；WHEN 同一文件被外部改写 THEN 按 FR-001 拒绝

## 功能需求

### FR-001：读后失效即拒绝

Core 为每个会话维护「文件 → 最近一次 Read 时的内容指纹」，Read 成功（文本文件、非图片、
非 xlsx）即记录。Edit / Write 执行前比对磁盘当前内容：

- 磁盘内容指纹 ≠ 记录 → 拒绝，错误文案点名路径与「该文件在你上次读取之后被修改，
  请重新读取后再编辑」，不改盘。
- 记录缺失（从未 Read）且目标文件已存在 → 拒绝，文案要求先 Read。
- 记录缺失且目标文件不存在（Write 新建）→ 放行：新建没有可踩的旧内容。

拒绝是**工具错误**（`ToolOutcome::Error`），不是权限拒绝：不走 `userChoice`、不弹确认框。
`offset` / `limit` 的片段 Read 同样建立记录（指纹是整份文件内容的指纹，不是窗口的）。

### FR-002：自己的写入会更新记录

Edit 成功后的文件内容成为该文件的新记录（等价于「刚读过写入后的结果」），因此同一会话里
连续的多次 Edit 不需要插一次 Read。Write 成功同理。

这样「自己改的文件不阻塞自己」与「外部改的文件一定拦住」两条不冲突：判断依据是内容指纹
而不是修改时间戳——时间戳在同秒写入、时钟回拨、网络盘上都不可靠。

### FR-003：记录的生命周期与归属

- 记录按**会话**隔离：会话 A 里 Read 过不影响会话 B（子代理 / 跨工作区对话各自独立）。
- 记录在会话关闭 / 删除时清除，不跨进程持久化——Core 重启后第一次 Edit 会要求先 Read
  （保守方向：宁可多一次 Read，也不拿陈旧认知覆盖文件）。
- 记录只覆盖文本路径；图片与 xlsx 的 Read 不建立记录（它们本来就不能被 Edit / Write
  按文本编辑）。

## 边界与错误路径

- 文件在 Read 之后被删除 → Edit 仍按既有 `ENOENT` 文案（读盘失败），不叠加本守卫。
- 文件在 Read 之后被改为二进制 / 不可解码 → `fs::read_to_string` 失败按既有
  `Edit: read failed` 收尾。
- 只 Read 了片段、之后无人改动 → 放行：指纹按整份文件算，片段 Read 也拿得到整份内容。
- 权限层（`permission.rs`）**不**复刻该守卫：它在授权前跑，此时拒绝会让「确认框都不弹」
  与「工具执行报错」两种观感混在一起；守卫只在 `run_edit` / `run_write` 一处判定
  （一份事实一个写入点）。
- 同一文件在会话内被 Read 多次时，后一次覆盖前一次（记录只有一条，按路径索引）。

## 非目标

- 不做跨会话 / 跨进程的读取记录（重启后要求重新 Read）。
- 不引入修改时间戳比较、不引入文件系统监视（`docs/features/` 的查看器刷新另有链路）。
- 不改 Edit / Write 的工具入参 schema（不新增「强制覆盖」开关；要覆盖就先 Read）。
- 不对 Bash 命令造成的改动做「谁改的」归因——只要内容变了就要求重新 Read。
- 不做 `MultiEdit` 之类的批量编辑工具。

## 对需求基线的影响

新增 US（`docs/features/user-stories/tools.md` 的 EP-7）：读后失效的编辑被拒绝并提示
重新读取。e2e 覆盖：`e2e/electron/assistant.spec.ts` 补一条（Read → 外部改写 →
Edit 被拒 → 重新 Read → Edit 成功）。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `core-rs/src/tools.rs` 的 `run_edit` / `run_write`（读后失效守卫）；`core-rs/src/tools.rs` 的读取记录表 | `core-rs/src/tools_tests.rs`（外部改写后 Edit / Write 被拒、磁盘不变） | 自动 |
| FR-002 | 同上（Edit / Write 成功后刷新记录） | `core-rs/src/tools_tests.rs`（连续两次 Edit 不插 Read 仍成功） | 自动 |
| FR-003 | `core-rs/src/tools.rs` 的记录表生命周期；`core-rs/src/engine.rs` 的会话关闭清理 | `core-rs/src/tools_tests.rs`（未 Read 新建 Write 放行、会话隔离、片段 Read 建立记录） | 自动 |

## 待澄清

（无）

## 收敛记录

（待 /converge 填写）
