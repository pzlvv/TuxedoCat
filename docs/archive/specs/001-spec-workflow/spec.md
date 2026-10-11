---
status: 已收敛
---

# 改动规格：SPEC 驱动开发的改动规格工作流

为「一次改动要做出什么样」建立版本化落点：在 as-built 规格（`docs/`）与冻结档案
（`docs/archive/`）之间加改动规格层 `specs/`，配模板、需求 ID 与追溯、澄清 / 宪章 /
收敛三道闸门、docsLint 守卫与 skill 入口；as-built 侧（docsLint 对代码的对照）保持
既有强度。本 spec 是新流程的第一个使用者（自举）：实施本 spec 的过程本身按新流程
跟踪。决策背景见 [ADR-0004](../../docs/adr/0004-spec-driven-change-workflow.md)。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/README.md 分类法](../../docs/README.md#分类法) | 分类法、地图 | 修改 | 加「改动规格」行与地图节；TODO 行口径更新 |
| [AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求) | 文档要求 | 修改 | 补 `specs/` 不受「只写现状」约束的例外 |
| [docs/adr/README.md](../../docs/adr/README.md) | ADR 索引 | 修改 | 登记 ADR-0004（新增决策文件） |
| [docs/user-stories.md](../../docs/user-stories.md) | — | 无变更 | 流程类改动，无产品用户故事 |
| [TODO.md](../../TODO.md) | 全文 | 修改 | 口径收敛为未排期项清单 |
| `<DEVELOPMENT.md>` | — | 无变更 | 架构与事件词汇表不受影响 |

## 用户场景与验收标准

- 场景 1：起草一次新改动
  - **AC-1**（FR-001）：GIVEN specs/ 与 specs/_templates 存在 WHEN 按约定开新改动目录 THEN 编号取 specs/ 与 docs/archive/specs/ 已用编号之外的最小递增值，目录内三件套齐全
  - **AC-2**（FR-004）：GIVEN specs/_templates 的四份模板 WHEN 以其起草 spec THEN 必填章节与 docsLint 结构组的字段口径一致，复制即可被校验
- 场景 2：实施与闸门
  - **AC-3**（FR-005）：GIVEN spec.md 的 FR 清单 WHEN 运行 docs-lint THEN tasks 覆盖全部 FR、追溯矩阵逐 FR 登记，缺行即红
  - **AC-4**（FR-006）：GIVEN spec 内存在 `[待澄清]` 标记 WHEN status 为实施中 / 已收敛或标记缺去向链接 THEN docs-lint 红
  - **AC-5**（FR-007）：GIVEN spec 缺必填章节或 H1 前缀错 WHEN 运行 docs-lint THEN 结构组红并指出缺失项
  - **AC-6**（FR-010）：GIVEN 宪章检查存在未勾选项或待澄清未清零 WHEN 调 /implement THEN skill 拒绝进入实施
- 场景 3：落地与收尾
  - **AC-7**（FR-002）：GIVEN spec 已收敛 WHEN 归档 THEN 整目录位于 docs/archive/specs/ 且编号永不复用（本 spec 归档即该用例）
  - **AC-8**（FR-003）：GIVEN docs/README.md WHEN 查分类法与地图 THEN 有「改动规格」行、地图节与 specs/README.md 登记；AGENTS.md 的文档要求含 specs/ 例外；TODO.md 只含未排期口径
  - **AC-9**（FR-008）：GIVEN docs/ 顶层规格 WHEN 运行 docs-lint THEN 每篇 frontmatter 的 owner 与 last_reviewed 齐全
  - **AC-10**（FR-009）：GIVEN 仓库 WHEN 运行 npm run docs:freshness THEN 输出文档与引用源码的新鲜度报告且退出码 0，CI 门禁不含该步骤
  - **AC-11**（FR-011）：GIVEN 一项工作进入实施 WHEN 查进度载体 THEN 进度只在该 spec 的 tasks.md 勾选，TODO.md 不另立进度表

## 功能需求

### FR-001：改动规格容器

`specs/<NNN>-<slug>/` 目录约定：编号三位递增且不复用（含 docs/archive/specs/ 已归档
编号）；slug 小写连字符、与实施分支同名；目录内 spec.md / plan.md / tasks.md 三件套，
缺陷改动用 defect.md 替代 spec.md；`specs/_templates/` 为保留目录存模板，docsLint
不扫描。

### FR-002：生命周期与归档

起草 → 评审通过 → 实施（勾 tasks.md）→ 收敛（已满足 / 偏差 / 未做三分类）→ delta 并入
`docs/<topic>.md` → 整目录归档进 `docs/archive/specs/`；未完成项回写 tasks.md，不另立
进度表；放弃的改动同样归档，编号不复用。

### FR-003：文档体系登记

[docs/README.md](../../docs/README.md#分类法) 分类法加「改动规格」行、地图加「改动规格」
节并登记 specs/README.md；AGENTS.md 的文档要求补 specs/ 例外；specs/ 与 TODO.md 的分工
写明（未排期在 TODO，实施中在 specs/）。

### FR-004：规格模板

`specs/_templates/` 四份：spec.md（场景与 GIVEN / WHEN / THEN 验收、FR 条目、非目标、
边界与错误路径、需求基线影响、追溯矩阵、待澄清、收敛记录）、defect.md（现状 / 期望 /
不变量 / 回归测试）、plan.md（技术方案、受影响模块与契约、宪章检查、被否决的替代方案）、
tasks.md（T 编号、依赖、完成判据、回指 FR）。

### FR-005：需求 ID 与追溯矩阵

ID 体系 US-xx / FR-nnn / AC-n / Tnnn；spec 的追溯矩阵逐 FR 登记实现落点与测试落点，
每条验收标准要么有实现与测试、要么登记「无自动覆盖 + 理由」；docsLint 校验 tasks 覆盖
全部 FR、矩阵逐 FR 一行、AC 回指 FR。

### FR-006：澄清闸门

spec 内未决问题用 `[待澄清]` 显式标记，必须同行带去向链接（ADR / DEVELOPMENT.md 待定
事项 / 非目标）；status 进入「实施中」前清零；docsLint 拦截残留（实施中 / 已收敛的 spec
不允许出现，起草 / 待评审的标记必须带链接）。

### FR-007：specs 结构守卫

docsLint 新增 specs 结构组：三件套必填章节齐全、H1 前缀（改动规格 / 缺陷规格 /
实施方案 / 任务分解）、FR / AC / T 编号规范、plan 的宪章检查节含四项义务、status 取值
合法；`specs/` 的存在性类检查（路径 / 常量 / 标识符 / npm 脚本）与 TODO.md 同口径豁免。

### FR-008：主题规格 frontmatter

docs/ 顶层规格（README.md 地图除外）带 frontmatter：owner（负责人）与 last_reviewed
（最后核对日期，YYYY-MM-DD）；docsLint 校验字段齐全与日期格式。

### FR-009：新鲜度报告

`scripts/docs-freshness.mjs` 对比文档与其行内代码引用的仓库路径的最后提交时间，输出
过时排行报告；只出报告（退出码恒 0），不进 CI 门禁；以 `npm run docs:freshness` 提供。

### FR-010：AI 侧技能入口

``<configDir>`/skills/` 一组仓库级 skill：/spec（起草并停）→ /plan（方案与宪章检查，
待澄清未清零拒绝）→ /tasks（分解并回指 FR）→ /implement（宪章检查不过拒绝；逐任务
勾选）→ /converge（核对 + 归档，收敛不绿不归档）；每个 skill 只产出一个产物、产出即停；
`doc` skill 升级为含 specs/ 与 docs/ 分工的规格写作约定。不进内置 skill（避免 Core
parity 负担）。

### FR-011：TODO.md 口径收敛

TODO.md 只放未排期的想法与跨 spec 缺口，每条带验收判据或指向某个 spec；进行中的工作
在 spec 的 tasks.md 跟踪；完成项当场删除。

## 边界与错误路径

- specs/ 目录不存在（全新仓库态）：结构组空跑通过，不报错。
- 编号冲突（specs/ 与 docs/archive/specs/ 撞号）或目录名不合 `<NNN>-<slug>` 形：结构组红。
- 三件套缺件、spec.md 与 defect.md 同时存在：结构组红。
- status 取值超出 起草 / 待评审 / 实施中 / 已收敛：结构组红。
- tasks 引用 spec 里不存在的 FR、或 FR 无任务覆盖：结构组红。
- frontmatter 缺字段或日期格式不对：frontmatter 组红。
- docs:freshness 遇到未提交文件 / 无引用的文档：跳过该行，不报错。

## 非目标

- 不整包引入 GitHub Spec Kit / Kiro / OpenSpec（见 ADR-0004 被否决的替代方案）。
- 不进内置 skill（`src/core/skills/bundled/`），零 Core parity 负担。
- 新鲜度检查不进 CI 门禁（先出报告观察误报率，升格与否进 TODO.md）。
- 不为 specs/ 建独立 CI job，复用现有 tests job 的 docs-lint 过滤。
- 不做文档站渲染（specs/ 归档前无需对外呈现）。

## 对需求基线的影响

无新增 US：本 spec 是开发流程类改动，不产生产品用户故事；docs/user-stories.md 与 e2e
映射不变。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `specs/README.md`（目录约定）、`specs/_templates/` | `src/test/docsLint.test.ts`（specs 结构组） | 自动 |
| FR-002 | `specs/README.md`（生命周期、收敛与归档） | `src/test/docsLint.test.ts`（specs 结构组） | 自动 |
| FR-003 | `docs/README.md`（分类法与地图）、`AGENTS.md`（改动规格例外）、`specs/README.md`（与 TODO.md 的分工） | `src/test/docsLint.test.ts`（地图覆盖组） | 自动 |
| FR-004 | `specs/_templates/` 四份模板 | `src/test/docsLint.test.ts`（specs 结构组） | 自动 |
| FR-005 | `specs/README.md`（需求 ID 与追溯）、本 spec 追溯矩阵 | `src/test/docsLint.test.ts`（specs 结构组） | 自动 |
| FR-006 | `specs/README.md`（澄清闸门） | `src/test/docsLint.test.ts`（specs 结构组） | 自动 |
| FR-007 | `src/test/docsLint.test.ts`（specs 结构组与豁免口径） | `src/test/docsLint.test.ts`（本组即测试） | 自动 |
| FR-008 | `docs/*.md` frontmatter | `src/test/docsLint.test.ts`（frontmatter 组） | 自动 |
| FR-009 | `scripts/docs-freshness.mjs`、`package.json` | 无自动覆盖 + 报告类脚本，人工运行验证退出码与输出格式 | 无自动覆盖 + 报告脚本不进测试车道，验收以人工运行为准 |
| FR-010 | ``<configDir>`/skills/` 的 spec / plan / tasks / implement / converge / doc 六个 skill 目录 | 无自动覆盖 + skill 文案类产物，docsLint 不扫描 `<configDir>/` | 无自动覆盖 + skill 由人审与实际使用验证 |
| FR-011 | `TODO.md` | 无自动覆盖 + TODO.md 在 docsLint 多组豁免（描述未来时态），无自动断言 | 无自动覆盖 + 口径靠本 spec 与 specs/README.md 约定约束 |

## 待澄清

无——所有未决问题在起草阶段已裁决并落入 [ADR-0004](../../docs/adr/0004-spec-driven-change-workflow.md)
（含被否决的替代方案）。

## 收敛记录

- 已满足：
  - FR-001 容器：`specs/README.md` 与 `specs/_templates/` 四模板实存；本 spec 即第一个按约定开的目录；编号查重（specs/ 与 docs/archive/specs/ 合并）由结构组执行。
  - FR-002 生命周期：`specs/README.md` 生命周期与归档两节；本 spec 归档进 `docs/archive/specs/001-spec-workflow/` 即首个完整用例。
  - FR-003 登记：`docs/README.md` 分类法「改动规格」行与地图节（含 specs/README.md 登记）、AGENTS.md 文档要求的 specs/ 例外与待办不存史新口径、TODO.md 重写；地图覆盖组绿。
  - FR-004 模板：spec / defect / plan / tasks 四份存在，必填章节与结构组校验口径一致。
  - FR-005 ID 与追溯：`specs/README.md` 需求 ID 一节；结构组双向校验 AC 回指 FR、tasks 覆盖全部 FR、追溯矩阵逐 FR 一行——本 spec 通过即证据。
  - FR-006 澄清闸门：结构组拦「实施中 / 已收敛残留标记」与「标记缺去向链接」，specs/README.md 澄清闸门一节固化口径。
  - FR-007 结构守卫：docsLint 新增 specs 结构组（三件套 / H1 / 章节 / FR / AC / T / 矩阵 / status / 宪章四项）与 `_templates` 跳过、specs/ 存在性豁免；`npm run test:all -- docs-lint` 41 项全绿（2026-10-11）。
  - FR-008 frontmatter：19 篇 docs 顶层规格带 owner / last_reviewed；frontmatter 组绿。
  - FR-009 新鲜度：`npm run docs:freshness` 实测输出 20 篇报告、退出码 0（全 0 领先——最近提交在当日）；不进 CI 门禁，升格与否进 TODO 跟踪。
  - FR-010 技能入口：``<configDir>`/skills/` 六个 SKILL.md（spec / plan / tasks / implement / converge / doc），闸门写进步骤（待澄清未清零不进 plan、宪章不过不进 implement、收敛不绿不归档）；未进内置 skill，零 Core parity 负担。
  - FR-011 TODO 口径：TODO.md 重写为「未排期想法与跨 spec 缺口」，当前无项；进度载体收敛到各 spec 的 tasks.md。
- 偏差：无——实现与 spec 的差异为零（lint 组的检查细则按 spec 落地，无裁剪）。
- 未做：无——tasks.md 八条全部完成。
