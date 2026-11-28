# ADR-0022：`sed` 的 Reminder 作为独立 silent 消息补发，不再混在 Bash 工具结果里

- 状态：已采纳
- 日期：2026-11
- 取代：[ADR-0021](0021-bash-sed-reminder-instead-of-gate.md) 的提醒**载体**（不改「`sed`
  不再被 `restricted` 闸门拒绝」这条决策）
- 规格：[docs/features/background-bash.md](../features/background-bash.md)
  （[FR-009](../features/background-bash.md#fr-009sed-读--改文件的-reminder-消息)）

## 背景（Context）

[ADR-0021](0021-bash-sed-reminder-instead-of-gate.md) 把 `sed` 从闸门改成提醒，落地形态是
**在 Bash 工具结果末尾追加一段文本**。跑起来后发现这段文本与命令输出混在一起，代价超出预期：

1. **污染被读取的事实**：`sed -n '230,300p' doc.md` 的输出就是那段文档，末尾多出来的提醒
   会被下一轮当成输出的一部分——模型（和用户看工具卡片时）无法区分「命令吐出的」与
   「系统附加的」。管道、脚本、把输出再贴给用户的路径都会带上这段文本。
2. **与既有提醒形态不一致**：`@` 工作区 reminder、后台任务周期提醒、查询结束兜底提醒、
   子代理未 Reply 的兜底提醒都是一条 `silent` / `origin=agent` 的 user 消息，
   `<Reminder>` 包装；`sed` 这条却挤在 tool_result 里，多一种形态就多一处腐烂点。
3. **压缩按标记分类**：`compact.rs` 的 `is_reminder_text` 靠 `<Reminder>` 标记把系统提醒
   与用户输入分开。混在 tool_result 里的提醒躲过这套分类，它在压缩里的归属由「工具结果」
   决定而不是由「它是提醒」决定。

## 决策（Decision）

提醒的内容、判据与不拦命令的立场都不变，只换**载体**：

- 命中「去掉所有 `cd` 段后只剩 `sed`」时，Bash 的 tool_result 只保留命令自己的输出；
  提醒作为该工具额外产出的一条消息，经 `ToolOutcome::SuccessWithMessages` 的
  `newMessages` 通道在该批 tool_result **之后**落盘 + 进上下文（与 Skill 技能正文、
  `Agent` 跨工作区派发的 Transfer reminder 同一条通道）。
- 消息形态与其它 reminder 同源：`{ type: 'user', silent: true, origin: 'agent' }`，正文
  `BASH_SED_READ_REMINDER` 用 `<Reminder>` 包装——构造点就是 `engine.rs` 的
  `build_reminder_message`（reminder 的形态只有一份）。模型读得到，UI 消息流与回放不展示，
  压缩按 `<Reminder>` 把它算作系统提醒。
- 挂载点仍只有一处（`tools.rs` 的 `with_sed_read_reminder`，判据 `is_cd_sed_only_command`），
  但作用对象从「结果文本」变成「工具结果」：四条**成功**返回路径
  （`run_in_background`、前台本地执行、隔离视图的代理代执行、自动转后台）共用它。
- 命令失败（非零退出 / 被中断）时不补发：`CommandFailed` 没有消息通道，不为一条提醒扩它的
  载荷；失败结果本身已经告诉模型这条写法没拿到可用内容。

## 替代方案（被否决）与后果（Consequences）

- **维持追加到工具结果末尾（ADR-0021 的原形态）**：改动最小，但「命令输出」与「系统附加
  文本」共用一个字符串，前面三条代价都留着。
- **只改系统提示词、去掉提醒**：提示词在读代码之前生效，模型执行完才可能意识到；结果之后
  的一条提醒与下一次动作直接相邻，纠正成本更低（这条理由在 ADR-0021 里成立，仍然成立）。
- **把提醒写进 `restricted` 闸门失败文案**：回到 ADR-0021 否决的路线——命令语义没错时不该
  产生失败。
- **给 `CommandFailed` 也加消息通道以覆盖失败路径**：为一个边缘情形扩工具契约的载荷，
  而失败时提醒的价值最低。
- **用 `isMeta` 而不是 `silent`（Skill / Transfer reminder 的标记）**：两种标记都能让 UI
  与回放不展示，但 `silent` / `origin=agent` 才是 reminder 的既有形态——`sub_agent_has_reply`
  判断「真正的用户输入」时读的就是 `silent`。

**代价**：一条提醒多落一条消息，计入 `messageCount` 与 `conversationListChanged`（与
Skill 注入同口径）；提醒仍是纯文本，对不读提醒的模型不具强制性。**收益**：Bash 的工具结果
回到「只有命令输出」，提醒有唯一形态、有唯一注入通道，压缩与 UI 的分类不需要为它开特例。
