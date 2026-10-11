---
name: implement
description: 按已评审的 tasks.md 逐任务实施并勾选，全部完成后停
when_to_use: spec / plan / tasks 三件套齐备且用户放行实施时
user-invocable: true
---

产物：代码 / 文档改动本身 + 逐任务勾选后的 `tasks.md`。实施完所有任务即停
（收敛核对是 /converge 的事，不在本步）。

**前置闸门（不过即拒绝，逐项指出）**：

- 同目录三件套（spec / plan / tasks）齐备且用户已放行实施；
- spec 的「待澄清」节已清零；
- plan 的宪章检查四项全部勾选或写明「不涉及 + 理由」——宪章检查不过不进入实施。

步骤：

1. 把 spec 的 status 改为「实施中」。
2. 按依赖顺序逐任务实施；**每完成一条立即勾选 tasks.md**——勾选状态即进度，
   不另立进度表。
3. 任务触到 Core 行为（引擎 / 工具 / 权限 / 事件 / 落盘）时：`src/core/` 与 `core-rs/`
   两侧同步改，同步 parity 对照表与两侧测试（AGENTS.md 第 5 节；只改一侧视为未完成）。
4. 任务触到契约 / 事件词汇表时：同步 DEVELOPMENT.md 事件表与对应 `docs/<topic>.md`；
   完成判据里列了测试 / lint 组的，跑到绿为止。
5. 出现 spec 未覆盖的新问题时：停，向用户提出——要么补进 spec（留痕）要么作为新任务
   追加；不静默扩范围。
6. 全部任务勾选后停：报告完成情况，提示进入 /converge。

规则出处：`specs/README.md` 第 2 节、`AGENTS.md` 第 5 节。
