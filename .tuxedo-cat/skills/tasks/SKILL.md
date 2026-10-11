---
name: tasks
description: 为 spec 产出任务分解（tasks.md），每条回指 FR / RT，产出即停
when_to_use: plan 已评审通过、需要拆成可勾选任务时
user-invocable: true
---

产物：`specs/<NNN>-<slug>/tasks.md`。只做这一件事，产出即停等人评审。

**前置闸门（不过即拒绝）**：同目录 `spec.md`（或 `defect.md`）与 `plan.md` 存在、
plan 已评审通过、宪章检查无未通过的未决项。

步骤：

1. 复制 `specs/_templates/tasks.md` 到同一 spec 目录。
2. 每条任务一行：`- [ ] **Tnnn**（FR-nnn 或 RT-n）：做什么；依赖：Tnnn 或 —；完成判据：…`。
   完成判据必须**可验证**（测试名 / lint 组 / `npm run …` / 产物路径）。
3. 覆盖检查：spec 的每个 FR（缺陷形态的每个 RT）至少被一条任务回指；任务回指的
   FR / RT 必须在 spec 里存在（docsLint 会双向对照）。
4. 排序按依赖；文档同步、测试、docs-lint 验证作为独立任务列出不省略。
5. spec 的 status 保持「待评审」，停：交给用户确认后进入 /implement。

规则出处：`specs/README.md` 第 1 / 3 节。
