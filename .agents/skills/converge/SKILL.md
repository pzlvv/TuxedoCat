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
2. **反向对照**（上一条方向反过来再核一遍，拦「实现里有、spec 没接」的分歧）：从实现
   diff 枚举行为分支——正常路径之外，错误路径、竞态、中止、边界置灰是重点——逐条找
   spec 对应 AC；追溯矩阵的测试落点逐个打开，验证存在且真的覆盖所声称的内容；影响基线
   各 delta 行按实际 diff 复核（承诺的契约变更是否真的发生、有没有多出未声明的变更）。
   发现 spec 没有的行为：补进 spec（留痕）或登记偏差；矩阵虚指（落点不存在 / 未覆盖
   声称）：修矩阵或补测试。结论同样进「收敛记录」三分类。
3. 存在偏差或未做时停：与用户裁决后再继续；收敛不绿不归档。
4. 收敛绿后按「影响基线」把 delta 并入 as-built 规格（`docs/<topic>.md`、`docs/architecture/events.md`
   事件表等），新增文档登记 `docs/README.md` 地图；影响基线里的行内代码改为链接。
5. 落地时同步需求基线：spec 承诺的新增 US 进 `docs/features/user-stories.md` 并配 e2e 用例或
   登记豁免。
6. 跑 `npm run docs:freshness` 看一眼报告（只提示，不阻塞）；`npm run test:all --
   docs-lint` 必须绿。
7. 归档：先把 spec 的 status 改「已收敛」（放弃的改「放弃」）——收敛态 spec 的落点存活
   检查在此时生效，再跑 `npm run test:all -- docs-lint` 必须绿，然后
   `git mv specs/<NNN>-<slug> docs/archive/specs/<NNN>-<slug>`；编号不复用。停：报告
   归档位置与遗留项。

规则出处：`specs/README.md` 第 2 / 3 / 7 节。
