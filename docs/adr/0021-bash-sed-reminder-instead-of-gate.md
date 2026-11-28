# ADR-0021：`sed` 读 / 改文件改为工具结果提醒，不再被 `restricted` 闸门拒绝

- 状态：被取代（提醒载体由 [ADR-0022](0022-sed-reminder-as-silent-message.md) 取代；
  「`sed` 不再被 `restricted` 闸门拒绝」的决策仍生效）
- 日期：2026-11
- 取代：[ADR-0016](0016-bash-restricted-gate.md) 的 `sed` 分支
- 规格：[docs/features/background-bash.md](../features/background-bash.md)
  （[FR-005](../features/background-bash.md#fr-005restricted-闸门sleep) /
  [FR-009](../features/background-bash.md#fr-009sed-读--改文件的-reminder-消息)）

## 背景（Context）

[ADR-0016](0016-bash-restricted-gate.md) 把「去掉所有 `cd` 段后只剩 `sed`」交给
`restricted` 闸门拒绝，理由是 `Read` 工具才对得上读文件的语义。落地后发现两个问题：

1. **拒绝的代价大于收益**：`sed -i 's/a/b/' f`、`sed -n '1,40p' f` 这类写法在
   「批处理一次改多行」「只取一段做快速确认」时完全正当，闸门把它们一并挡掉，模型只能
   改写命令或向用户解释，命令本身的意图没有错。
2. **判据与意图不完全对齐**：闸门只认「去掉 `cd` 后只剩 `sed`」，加一个管道就绕过；
   真正决定该不该用 `Read` 的是「要结构化结果」而不是「命令恰好只有 `sed`」。

`restricted` 闸门的目标仍然成立：用计时器轮询等结果是明确有害的写法（完成时 core 会
注入通知并接续消费循环），这一条继续 `deny`。

## 决策（Decision）

`sed` 从 `restricted` 闸门移出，改为**工具结果里的提醒**：

- 命令**照常执行**，权限判定回到既有路径（`sed` 不在只读白名单 → `manual` 询问、
  `risk` / `auto` 放行），`restricted` 的取值不参与这条判定。
- 命中「去掉所有 `cd` 段后只剩 `sed`」时，在 Bash 工具结果末尾追加一条
  `BASH_SED_READ_REMINDER`，点名读文件用 `Read`（行号、`offset` / `limit` 窗口、
  xlsx / 图片分支）、改文件用 `Edit`，并保留「内容要流进另一条命令时照常用 `sed`」的例外。
- 判据仍是 `tools.rs` 的 `is_cd_sed_only_command`（共用 `gate_segments`），生成函数
  只有 `with_sed_read_reminder` 一处，四条返回路径共用。
- 系统提示词补 `**Prefer the Grep and Glob tools**` 块：单个搜索用 `Grep` / `Glob` 工具，
  需要组合时才用 Bash 的 `rg` / `fd`——`Grep` / `Glob` 的优先级高于 `rg` / `fd`。

`restricted` 闸门因此收窄为「只拦 `sleep`」，默认值与逃生口不变；schema 与系统提示词的
最小披露口径（只声明默认值与常规取值）也不变。

## 替代方案（被否决）与后果（Consequences）

- **保留闸门、只放宽判据（例如只在 `-n` 读形态拦）**：读形态与写形态都可能是正当用法，
  按形态细分只会让判据更难解释，且仍要靠失败文案教会模型。
- **把 `sed` 降级为 `ask`（用户确认）**：`ask` 在 `auto` 下等于放行、`manual` 下变成每次
  都问，同一写法在三档模式间给出三种语义（与 [ADR-0016](0016-bash-restricted-gate.md)
  否决过的 `restricted: false` 降级是同一问题）。
- **只在系统提示词里写规则、不加结果提醒**：提示词在读代码前生效，模型已经执行完才可能
  意识到；结果里的一条提醒与下一次动作直接相邻，纠正成本更低。
- **把提醒写成失败**：会让「有上下游的文本加工」与「拿 sed 读文件」共用一条失败文案，
  而前者根本不该被拦；命令语义没错时不该产生失败。

**代价**：`sed` 读文件仍然会发生（有一次工具调用的成本），换来的是正当写法不被挡；
提醒是纯文本，对不读提醒的模型不具强制性。因此 `Read` / `Edit` 的引导由「提示词 +
结果提醒」两层承担，而不是单靠一道闸门。
