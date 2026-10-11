---
name: converge
description: 逐条核对验收标准与证据，收敛通过才并入 docs 并归档 spec
when_to_use: spec 的 tasks.md 全部勾选后，核对与收尾时
user-invocable: true
---

产物：spec 的「收敛记录」三分类 + delta 并入 `docs/` + 整目录归档。收敛不绿不归档。

**前置闸门（不过即拒绝）**：tasks.md 全部勾选；`npm run check-types`、`npm run lint`、
`npm run test:all -- docs-lint` 全绿（涉及 core 的改动加 `npm run test:core`，且先
`npm run build:core:host` 让 parity 测试真实运行）。

步骤：

1. 逐条核对验收标准（AC / RT）与实现、测试证据，把结论写进 spec 的「收敛记录」，只分
   三类：已满足（附证据落点）/ 偏差（要么改代码、要么改 spec 并留痕）/ 未做（回写
   tasks.md，不勾选）。
2. 存在偏差或未做时停：与用户裁决后再继续；收敛不绿不归档。
3. 收敛绿后按「影响基线」把 delta 并入 as-built 规格（`docs/<topic>.md`、DEVELOPMENT.md
   事件表等），新增文档登记 `docs/README.md` 地图；影响基线里的行内代码改为链接。
4. 落地时同步需求基线：spec 承诺的新增 US 进 `docs/user-stories.md` 并配 e2e 用例或
   登记豁免。
5. 跑 `npm run docs:freshness` 看一眼报告（只提示，不阻塞）；`npm run test:all --
   docs-lint` 必须绿。
6. 归档：`git mv specs/<NNN>-<slug> docs/archive/specs/<NNN>-<slug>`，spec 的 status 改
   「已收敛」（放弃的改「放弃」）；编号不复用。停：报告归档位置与遗留项。

规则出处：`specs/README.md` 第 2 / 3 / 7 节。
