---
name: implement
description: 已评审 spec 的一次性落地：plan → tasks → 实施 → 收敛归档，中途不等人评审
when_to_use: spec 已评审通过、可以一次做到底时
user-invocable: true
---

产物：`specs/<NNN>-<slug>/` 的 `plan.md` 与 `tasks.md`、代码 / 文档改动本身、spec 的
「收敛记录」三分类，最后 delta 并入 `docs/` 并把整目录归档到 `docs/archive/specs/`。

本 skill 覆盖 spec 评审之后的全部阶段，一轮做完：中间不产出即停、不等人评审。
唯一的评审面是 `spec.md`（`/spec` 产出、人审通过才进本步），`plan.md` 与 `tasks.md`
是实施过程产物——自己写完直接往下做，不问用户。

**前置闸门（不过即拒绝，逐项指出）**：

- `specs/<NNN>-<slug>/spec.md` 存在，status 为「待评审」，且用户已明确表示评审通过；
- spec 的「待澄清」节已清零（无 `[待澄清]` 残留）；
- 评审提出的修改已在 `/spec` 里回填——本步不改 FR / AC。

步骤：

1. **plan**：复制 `specs/_templates/plan.md` 到同一目录，写技术方案、受影响模块与契约、
   被否决的替代方案；宪章检查逐条过并勾选（分层与依赖、架构铁律、Core 行为与落盘格式
   同步义务、文档同步义务），不适用的一条写「不涉及 + 理由」。有未通过项就先改方案消解，
   不带病进入实施；只有真需要用户裁决时才提问，那不是评审闸门。
2. **tasks**：复制 `specs/_templates/tasks.md` 到同一目录，每条任务一行
   `- [ ] **Tnnn**（FR-nnn 或 RT-n）：做什么；依赖：Tnnn 或 —；完成判据：…`。完成判据
   必须可验证（测试名 / lint 组 / `npm run …` / 产物路径）；spec 的每个 FR 至少被一条
   任务回指；文档同步、测试、docs-lint 验证作为独立任务列出不省略。
3. 把 spec 的 status 改为「实施中」，**实施**：按依赖顺序逐任务做；**每完成一条立即勾选
   tasks.md**——勾选状态即进度，不另立进度表。任务触到 Core 行为（引擎 / 工具 / 权限 /
   事件 / 落盘）时 `src/core/` 与 `core-rs/` 两侧同步改，同步 parity 对照表与两侧测试
   （只改一侧视为未完成）；触到契约 / 事件词汇表时同步 `docs/architecture/events.md`
   事件表与对应 `docs/<topic>.md`。
4. **收敛**：逐条核对验收标准（AC / RT）与实现、测试证据，把结论写进 spec 的「收敛记录」，
   只分三类：已满足（附证据落点）/ 偏差 / 未做。再做一遍反向对照：从实现 diff 枚举行为
   分支（错误路径、竞态、中止、边界置灰是重点）逐条找 spec 对应 AC；打开追溯矩阵的每个
   测试落点确认真的覆盖所声称内容；「影响基线」各 delta 行按实际 diff 复核（承诺的契约
   变更是否发生、有没有多出未声明的变更）。偏差能当场闭环的就闭环：实现侧偏差改代码，
   spec 侧漏写补进 spec 并留痕，矩阵虚指则修矩阵或补测试。
5. 收敛不绿时停：把未做项回写 tasks.md（不勾选并注明），向用户报告卡点——那是需要决策的
   阻塞项，不是评审。
6. 收敛绿后按「影响基线」把 delta 并入 as-built 规格（`docs/<topic>.md`、
   `docs/architecture/events.md` 事件表等），新增文档登记 `docs/README.md` 地图；影响基线里
   的行内代码改为链接。spec 承诺的新增 US 进 `docs/features/user-stories.md` 并配 e2e 用例
   或登记豁免。
7. 验证：`npm run check-types`、`npm run lint`、`npm run test:unit -- docs-lint` 全绿；
   涉及 core 的改动加 `npm run test:core`（先 `npm run build:core:host` 让 parity 测试真实
   运行）。`npm run docs:freshness` 只看一眼报告（提示，不阻塞）。
8. **归档**：先把 spec 的 status 改「已收敛」（放弃的改「放弃」）——收敛态 spec 的落点存活
   检查在此时生效，再跑 `npm run test:unit -- docs-lint` 必须绿，然后
   `git mv specs/<NNN>-<slug> docs/archive/specs/<NNN>-<slug>`；编号不复用。
9. 停：报告完成了什么、收敛记录结论、归档位置与遗留项；提交时按 `AGENTS.md` 第 5 节写
   `Flow: L3` + `Spec: <NNN>`。

边界：

- 实施中发现 spec 未覆盖的新行为、或需要改 FR / AC：停，向用户提出并回 `/spec` 补记
  （spec 是唯一评审面）；不静默扩范围，也不在实施里自定验收标准。
- 判断不了的技术选型：按 plan 的「被否决的替代方案」自行定，理由写进 plan；一旦影响到
  FR / AC 就按上一条处理。

规则出处：`specs/README.md` 第 2 / 3 / 7 节、`AGENTS.md` 第 1 / 4 / 5 节、
[ADR-0020](../../../docs/adr/0020-spec-only-review-gate.md)。
