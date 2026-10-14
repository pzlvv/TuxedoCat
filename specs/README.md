# 改动规格工作流（specs/）

本目录承载**正在进行的改动**的规格：一次改动「要做出什么样」的版本化产物（意图与验收），
是 as-built 规格（`docs/<topic>.md`，只写现状）与冻结档案（`docs/archive/`）之间的活动层。
`specs/` 不受「只写现状」约束（[AGENTS.md 第 0 节](../AGENTS.md#0-文档要求)的显式例外）；
落地后 delta 并入 `docs/`，已完成的规格不留在本目录。决策背景见
[ADR-0004](../docs/adr/0004-spec-driven-change-workflow.md)。

## 1. 目录约定

`specs/<NNN>-<slug>/`：三位编号**递增且不复用**（含 `docs/archive/specs/` 里的已归档编号）；
slug 为小写连字符，与实施分支同名。目录内固定三件套：

| 文件 | 内容 | 产出入口 |
| --- | --- | --- |
| `spec.md` | 意图与验收：用户场景、功能需求（FR）、验收标准（AC）、非目标、影响基线 | /spec |
| `plan.md` | 技术方案、受影响模块与契约、宪章检查、被否决的替代方案 | /plan |
| `tasks.md` | 任务分解（T 编号）与勾选进度，勾选状态即进度 | /tasks |

本目录另有两个入口：缺陷规格 `specs/defects/<slug>.md`（扁平单文件、不编号，见第 8 节）与
需求变更的就地修订（不新增目录，见第 9 节）。四档判据（L0 直改 / L1 缺陷修复 / L2 需求变更 /
L3 新特性）见 [AGENTS.md 第 5 节](../AGENTS.md#5-工作流)——**三件套只服务 L3**。

`_templates/` 存放四份模板（`spec.md` / `defect-report.md` / `plan.md` / `tasks.md`），是保留
目录名，docsLint 不扫描。spec 的生命周期状态只有一个：`spec.md` frontmatter 的 status，取值
起草 / 待评审 / 实施中 / 已收敛；`plan.md` 与 `tasks.md` 不带 frontmatter。

## 2. 生命周期

起草（/spec，status 起草）→ 评审通过（人审；/plan、/tasks 依次产出，status 待评审）→
实施（/implement，status 实施中，逐任务勾 `tasks.md`）→ 收敛（/converge：逐条核对验收
标准与实现 / 测试证据，产出「已满足 / 偏差 / 未做」三分类，status 已收敛）→ delta 按
「影响基线」并入 `docs/<topic>.md` → 整目录移入 `docs/archive/specs/`（保留审计轨迹）。

- 每个 skill 只产出一个产物、产出即停等人评审；闸门写进 skill：待澄清项未清零不进
  plan；宪章检查不过不进 implement；收敛不绿不归档。
- 未完成项回写 `tasks.md`（不勾选并注明），不另立进度表。
- 放弃的改动同样归档（frontmatter status 改「放弃」），编号不复用。

本节描述三件套的生命周期（L3）；缺陷规格的寿命见第 8 节，需求变更见第 9 节。

## 3. 需求 ID 与追溯

| ID | 含义 | 落点 |
| --- | --- | --- |
| `US-xx` | 用户故事（已有） | [docs/features/user-stories.md](../docs/features/user-stories.md)，e2e 用例以之编号 |
| `FR-nnn` | spec 的功能需求条目 | `spec.md` 的「功能需求」节 |
| `AC-n` | 验收标准，一行式 GIVEN / WHEN / THEN，回指 FR | `spec.md` 的「用户场景与验收标准」节 |
| `Tnnn` | 任务，回指 FR，带依赖与完成判据 | `tasks.md` |

`spec.md` 的追溯矩阵逐 FR 登记实现落点（文件 / 契约成员 / 事件名）与测试落点；每条验收
标准要么有实现与测试，要么显式登记「无自动覆盖 + 理由」。落地时同步
[docs/features/user-stories.md](../docs/features/user-stories.md) 与 e2e 映射：新增 US 要有 e2e 用例，
或按既有口径登记豁免。缺陷形态（`defect.md`）以回归测试条目为追溯键，docsLint 只查
章节齐全与非空。

## 4. 澄清闸门

spec 级未决问题写入 `spec.md`（或 `defect.md`）的「待澄清」节：`[待澄清]` 标记必须同行
带去向链接——转成 ADR、转进 [docs/architecture/open-questions.md](../docs/architecture/open-questions.md)、
或写成非目标。status 进入「实施中」前清零，docsLint 拦截残留标记。

## 5. 守卫口径（docsLint）

`specs/` 在 `src/test/docsLint.test.ts` 的扫描范围内（`docs/README.md` 开篇有索引）：

- **适用**：跨文档引用必须是链接（目标文件与锚点存在）、固化术语无别名、禁行号引用、
  文档内代码块 `src=` 来源标注、结构组——三件套必填章节齐全、H1 前缀、FR / AC / T
  编号规范、tasks 覆盖全部 FR、追溯矩阵逐 FR 登记、status 取值合法、澄清标记带去向。
- **三件套按 status 递进**：`起草` 只要求 `spec.md`，`待评审` 加 `plan.md`，`实施中` /
  `已收敛` 要求三件套齐——起草与评审期间不会因为「还没写 tasks」而红。
- **缺陷规格组**：`specs/defects/<slug>.md` 的 slug 格式、H1 前缀、status 取值、五节齐全、
  RT 编号、验证记录表四列与结果取值合法；`待修` 豁免存在性检查，`已修` 受落点存活检查
  （与 `已收敛` 的 spec 同口径）。
- **文档体积**：`docs/**/*.md` 不超过 500 行（`docs/features/user-stories.md` 与各级
  `README.md` 豁免；`docs/archive/` 是冻结档案，不参与校验）。
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

## 8. 缺陷规格（`specs/defects/`）

L1 缺陷修复的容器：`specs/defects/<slug>.md` 扁平单文件，**文件名即 slug**（小写连字符），
不编号、不参与编号查重；同一缺陷复发时新开 slug（加 `-2` / `-3` 后缀）并在正文引用原 slug，
不覆盖既有文件。

- **必填五节**：现状 / 期望 / 不变量 / 回归测试（`RT-n` 条目，带测试落点）/ 验证记录
  （四列表：检查 / 命令 / 结果 / 备注，结果取值 红 / 绿 / skipped / not-run / 部分验证）。
- **status**：`待修` / `已修` / `已放弃`；判决不是缺陷（invalid）时**不写文件**。
- **两段流程**（`/fix`，每段产出即停）：评估 + 红（只读代码，写出会先红的回归用例）→
  修复 + 绿（改代码、写验证记录）。三条硬规则：评估段禁止改源码；修复段不许改「现状 /
  期望」（它是契约，分歧记进验证记录）；验证段禁止改源码且不许自证清白——评估里列的复现
  路径没真跑过只能记「部分验证」，跑不了的检查记 `skipped` / `not-run` 加原因。
- **不归档、常驻仓库**：它是回归证据的索引，复发时要能查到当初的复现步骤与用例名。
- **提交**：`Flow: L1` + `Defect: <slug>`（见 [AGENTS.md 第 5 节](../AGENTS.md#5-工作流)）。

## 9. 需求变更与补基线

既有需求的行为要变时**不新增 spec**，就地修订 as-built 基线：改 `docs/` 里描述该行为的
FR / AC，并在同一提交里改齐代码与测试；变更理由落提交信息（`Flow: L2` + 哪条 FR / AC 从
什么变成什么），不另建 delta 文档。

**基线缺失时先补基线**：读代码反向枚举该行为的现状（正常路径之外，错误路径、竞态、中止、
边界置灰是重点），按 as-built 形态写进 `docs/`，**单独一个提交**；再基于这份基线做变更。
补基线只补本次涉及的行为，不做全量补齐——历史欠账跟着改动动态还。

落点按 `docs/README.md` 的分类法判：内容独立（跨多个 surface 或独立状态机）→ 新增
`docs/features/<feature>.md`；否则补进既有规格的一节；补完任一份不超过 500 行，超了按
surface / 状态机拆。

`docs/archive/specs/` 的归档件只作参考，不在其上改（编号不复用与冻结语义不动）。
