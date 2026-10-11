# 改动规格工作流（specs/）

本目录承载**正在进行的改动**的规格：一次改动「要做出什么样」的版本化产物（意图与验收），
是 as-built 规格（`docs/<topic>.md`，只写现状）与冻结档案（`docs/archive/`）之间的活动层。
`specs/` 不受「只写现状」约束（[AGENTS.md 第 0 节](../AGENTS.md#0-文档要求)的显式例外）；
落地后 delta 并入 `docs/`，已完成的规格不留在本目录。决策背景见
[ADR-0004](../docs/adr/0004-spec-driven-change-workflow.md)。

## 1. 目录约定

`specs/<NNN>-<slug>/`：三位编号**递增且不复用**（含 `docs/archive/specs/` 里的已归档编号）；
slug 为小写连字符，与实施分支同名。目录内固定三件套，缺陷改动把 `spec.md` 换成 `defect.md`：

| 文件 | 内容 | 产出入口 |
| --- | --- | --- |
| `spec.md` | 意图与验收：用户场景、功能需求（FR）、验收标准（AC）、非目标、影响基线 | /spec |
| `defect.md` | 缺陷形态（替代 `spec.md`）：现状 / 期望 / 不变量 / 回归测试 | /spec |
| `plan.md` | 技术方案、受影响模块与契约、宪章检查、被否决的替代方案 | /plan |
| `tasks.md` | 任务分解（T 编号）与勾选进度，勾选状态即进度 | /tasks |

`_templates/` 存放四份模板，是保留目录名，docsLint 不扫描。spec 的生命周期状态只有一个：
`spec.md`（或 `defect.md`）frontmatter 的 status，取值 起草 / 待评审 / 实施中 / 已收敛；
`plan.md` 与 `tasks.md` 不带 frontmatter。

## 2. 生命周期

起草（/spec，status 起草）→ 评审通过（人审；/plan、/tasks 依次产出，status 待评审）→
实施（/implement，status 实施中，逐任务勾 `tasks.md`）→ 收敛（/converge：逐条核对验收
标准与实现 / 测试证据，产出「已满足 / 偏差 / 未做」三分类，status 已收敛）→ delta 按
「影响基线」并入 `docs/<topic>.md` → 整目录移入 `docs/archive/specs/`（保留审计轨迹）。

- 每个 skill 只产出一个产物、产出即停等人评审；闸门写进 skill：待澄清项未清零不进
  plan；宪章检查不过不进 implement；收敛不绿不归档。
- 未完成项回写 `tasks.md`（不勾选并注明），不另立进度表。
- 放弃的改动同样归档（frontmatter status 改「放弃」），编号不复用。

## 3. 需求 ID 与追溯

| ID | 含义 | 落点 |
| --- | --- | --- |
| `US-xx` | 用户故事（已有） | [docs/user-stories.md](../docs/user-stories.md)，e2e 用例以之编号 |
| `FR-nnn` | spec 的功能需求条目 | `spec.md` 的「功能需求」节 |
| `AC-n` | 验收标准，一行式 GIVEN / WHEN / THEN，回指 FR | `spec.md` 的「用户场景与验收标准」节 |
| `Tnnn` | 任务，回指 FR，带依赖与完成判据 | `tasks.md` |

`spec.md` 的追溯矩阵逐 FR 登记实现落点（文件 / 契约成员 / 事件名）与测试落点；每条验收
标准要么有实现与测试，要么显式登记「无自动覆盖 + 理由」。落地时同步
[docs/user-stories.md](../docs/user-stories.md) 与 e2e 映射：新增 US 要有 e2e 用例，
或按既有口径登记豁免。缺陷形态（`defect.md`）以回归测试条目为追溯键，docsLint 只查
章节齐全与非空。

## 4. 澄清闸门

spec 级未决问题写入 `spec.md`（或 `defect.md`）的「待澄清」节：`[待澄清]` 标记必须同行
带去向链接——转成 ADR、转进 [DEVELOPMENT.md 第 6 章](../DEVELOPMENT.md#6-待定事项)、
或写成非目标。status 进入「实施中」前清零，docsLint 拦截残留标记。

## 5. 守卫口径（docsLint）

`specs/` 在 `src/test/docsLint.test.ts` 的扫描范围内（`docs/README.md` 开篇有索引）：

- **适用**：跨文档引用必须是链接（目标文件与锚点存在）、固化术语无别名、禁行号引用、
  文档内代码块 `src=` 来源标注、结构组——三件套必填章节齐全、H1 前缀、FR / AC / T
  编号规范、tasks 覆盖全部 FR、追溯矩阵逐 FR 登记、status 取值合法、澄清标记带去向。
- **豁免**（描述尚未落地的改动，与 TODO.md 同口径）：行内代码路径、常量 / 标识符、
  npm run 脚本名的**存在性**检查。落地后由 `docs/` 的全量对照兜底。
- **影响基线只链接已存在的章节**：新增文档在落地前写行内代码（不写链接），
  落地后改为链接。

## 6. 与 TODO.md 的分工

未排期的想法与跨 spec 的缺口留在 [TODO.md](../TODO.md)，每条带验收判据；进入实施的
改动在本目录跟踪，`tasks.md` 的勾选状态即进度。一条想法进入实施时：从 TODO.md 删除，
按第 1 节开目录。

## 7. 收敛与归档

- 收敛检查逐条核对验收标准与实现 / 测试证据，结论只分三类：已满足（附证据）、
  偏差（要么改代码、要么改 spec 并留痕）、未做（回写 `tasks.md`）。
- 收敛通过才允许把 delta 并入 `docs/`、把 spec 归档；归档执行
  `git mv specs/<NNN>-<slug> docs/archive/specs/<NNN>-<slug>`，归档件冻结
  （docsLint 不再扫描）。
