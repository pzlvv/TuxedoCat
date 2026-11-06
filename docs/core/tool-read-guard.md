---
owner: pzlvv
last_reviewed: 2026-11-06
---

# 规格：Read 与 Edit / Write 的时效契约

本规格描述 Core 对「模型手上的文件内容是否还新鲜」的判定：Edit / Write 在文件于本会话最后
一次读取之后被改过时拒绝执行，要求重新 Read。Core 的形态与契约见
[docs/core/standalone-core.md](standalone-core.md)；工具清单与其余工具行为同在该规格的工具节与
`core-rs/src/tools.rs`。

## 1. 能力

Edit / Write 拒绝**基于过期内容**的改动：文件在本会话最后一次读取之后被改过时，操作返回工具
错误并要求重新 Read，不写盘。判定依据是**内容指纹**而不是修改时间戳——同秒写入、时钟回拨、
网络盘与 WSL 挂载上 mtime 不可靠，且「自己刚写的文件不该被自己拦住」只有比对内容才能成立。

## 2. 判定口径

| 项 | 口径 |
| --- | --- |
| 记录的是什么 | 会话 → 规范化路径 → 最近一次成功 Read / Write 时的**整份文件原始字节**（SHA-256） |
| 什么算读过 | `Read` 的文本分支成功（含片段）。图片、xlsx、二进制拒绝、超限拒绝、文件不存在这些分支不建立记录——它们本来就不能被 Edit / Write 按文本编辑 |
| 片段读取 | `offset` / `limit` 的窗口 Read 同样登记**整份**文件的指纹：窗口外的外部改动也必须被发现 |
| 失效判据 | 磁盘当前内容的指纹 ≠ 记录 |
| 解除方式 | 重新 `Read` 该文件 |
| 自己的写入 | Edit / Write 成功后把**从磁盘读回**的内容记成新指纹，同一会话里连续的多次 Edit 不需要插一次 Read |
| 记录的生命周期 | 按会话隔离（子代理与跨工作区会话各自独立）；会话关闭 / 删除时清除；**不跨进程持久化**——Core 重启后第一次 Edit 会要求先 Read（保守方向） |
| 不叠加守卫的边界 | Read 之后文件被删除：Edit 仍返回既有 `ENOENT` 文案；被改成不可解码内容：`Edit: read failed`。Write 新建（记录缺失 + 文件不存在）放行——新建没有可踩的旧内容 |

路径经同一个 `normalize` 处理（`canonicalize` 成功即取，失败退化为 `expand_path` 产物），
`a.ts`、`./a.ts`、`sub/../a.ts` 落到同一条记录。

## 3. 错误文案

两条文案在 `core-rs/src/read_guard.rs` 定义、单测逐字锁定：

| 情形 | 文案 |
| --- | --- |
| 指纹不等 | `File has been modified since it was last read: <file_path>` + 展开后的绝对路径 + `Read the file again before editing it.` |
| 从未读过且文件存在 | `Please read the file before editing it: <file_path>` + 绝对路径 + 要求先读取 |

拒绝是**工具错误**（`ToolOutcome::Error`），不是权限拒绝：不走 `userChoice`、不弹确认框，
因此 `manual` 模式下的 Edit 卡片 diff 照常展示。守卫只在 `run_edit` / `run_write` 一处判定，
权限层（`permission.rs`）不复刻——权限层在授权前跑，在那里拒绝会让「确认框都不弹」与「工具执行
报错」两种观感混在一起。

## 4. 事实归属

记录表是进程内的 `Mutex<Option<HashMap<..>>>`，与 `tools.rs` 的 Todo 表同款惰性初始化。

| 事实 | owner | 说明 |
| --- | --- | --- |
| 读取记录表 | Core（`core-rs/src/read_guard.rs`） | 不进总线、不落盘；宿主侧不读取 |
| 记录写入 | `record_read` / `record_write` / `clear_session` 三个函数 | `run_read` / `run_edit` / `run_write` 只做接入点，不各自维护状态 |
| 失效判定 | `read_guard::verify` | 判定矩阵只有这一处 |
| 会话释放 | `Core::drop_session` | 与压缩标记、子代理注销同一处收口 |

## 5. 测试落点

| 覆盖 | 落点 |
| --- | --- |
| 判定矩阵四行、路径归一、非法 UTF-8 指纹、两条文案 | `core-rs/src/read_guard_tests.rs` |
| 外部改写后 Edit / Write 被拒且磁盘不变、重读后放行、连续两次 Edit、从未读过的已存在文件、Write 新建、片段 Read、会话隔离 | `core-rs/src/tools_tests.rs` 的守卫专项组 |
| 会话释放清理 | `core-rs/src/engine_tests.rs` 的 `drop_session_clears_the_read_guard_records_of_that_session` |
| 端到端（Read → 外部改写 → 拒绝 → 重读 → 成功） | `e2e/electron/assistant.spec.ts`（US-74） |
