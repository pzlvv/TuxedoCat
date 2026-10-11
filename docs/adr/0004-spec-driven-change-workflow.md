# ADR-0004：SPEC 驱动开发的改动规格层（`specs/`）

- 状态：已采纳
- 日期：2026-10
- 规格：`specs/README.md`（工作流约定）、`docs/README.md`（分类法与地图登记）

## 背景

「记忆库」与 as-built 规格两层已经完备：`AGENTS.md` 是协作约定与铁律，`DEVELOPMENT.md`
与 `docs/*.md` 是现状规格，`docsLint` 把规格与代码逐项对照——as-built 侧已达到
spec-anchored 的强度。缺的是 spec-first 那一层：一次改动「要做出什么样」的版本化产物
没有落点。意图只活在 `.zcode/plans/`（被 `.gitignore` 忽略）与根目录 `tmp_*`（落地即删）
里，不进仓库、不可评审、实施后无法与结果比对；历史上唯一一次成体系的任务分解
（Standalone Core 的 M0–M16 清单）在冻结后才进 `docs/archive/`，做法有效但没有制度化。

## 决策

在 as-built 规格（`docs/`，只写现状）与冻结档案（`docs/archive/`）之间加一层**改动规格**：

- **容器**：`specs/<NNN>-<slug>/`，编号三位递增、不复用（含已归档编号）；目录内三件套
  `spec.md`（意图与验收）/ `plan.md`（技术方案 + 宪章检查）/ `tasks.md`（T0xx 分解与
  勾选进度）；缺陷改动用 `defect.md`（现状 / 期望 / 不变量 / 回归测试）替代 `spec.md`。
  模板集中在保留目录 `specs/_templates/`。
- **生命周期**：起草（/spec）→ 评审通过（人审）→ 实施（/implement，勾 `tasks.md`）→
  收敛（/converge，产出「已满足 / 偏差 / 未做」三分类）→ delta 并入 `docs/<topic>.md` →
  整目录归档进 `docs/archive/specs/`（保留审计轨迹）。每个入口产出即停等人评审。
- **需求 ID 与追溯**：`US-xx`（用户故事，已有）/ `FR-nnn`（功能需求条目）/ `AC-n`
  （验收标准，GIVEN / WHEN / THEN）/ Tnnn（任务）；spec 的追溯矩阵逐 FR 登记实现
  落点与测试落点，由 docsLint 校验覆盖关系。
- **闸门**：spec 内未决问题用 `[待澄清]` 显式标记且必须带去向链接，实施前清零；
  `plan.md` 的宪章检查（分层、铁律、两套 Core parity 义务、文档同步义务）不过不进实施；
  收敛不绿不归档。
- **守卫**：docsLint 新增 specs 结构组（必填章节、H1、FR/AC/T 编号与覆盖、status 取值、
  澄清标记）与主题规格 frontmatter 组（`owner` / `last_reviewed`）；`specs/` 描述尚未
  落地的改动，路径 / 常量 / 标识符 / npm 脚本的存在性检查豁免（与 TODO.md 同口径）。
- **入口**：``<configDir>`/skills/` 提供 `/spec` `/plan` `/tasks` `/implement` `/converge`
  五个仓库级 skill，每个只产出一个产物；不进内置 skill（`src/core/skills/bundled/`）。
- **新鲜度**：主题规格（`docs/*.md` 顶层）带 `owner` / `last_reviewed` frontmatter；
  `scripts/docs-freshness.mjs` 对比文档与其引用源码的最后提交时间出报告——只出报告，
  不进 CI 门禁。

## 替代方案（被否决）

- **整包引入 GitHub Spec Kit**：外部 CLI 与英文模板，产物不进 docsLint 体系；
  其 constitution / charter 概念与 `AGENTS.md` 的铁律重复。只借鉴其阶段划分
  （specify → plan → tasks → implement → converge）。
- **Kiro 的三件套命名（requirements / design / tasks）**：requirements 与 design 的语义
  和 `docs/` 的 as-built 规格重叠，容易把「意图」写成「现状」；沿用 spec / plan 命名并
  显式区分意图与现状两层。
- **OpenSpec 的 change 目录 + delta spec 全文复制**：把受影响章节整段复制进 change 再
  合并，与「同一事实只写一处」冲突；改为「影响基线」声明改动落点 + 落地时就地合并，
  as-built 与代码的一致由 docsLint 继续兜底。
- **只加写作约定、不给容器**（只改 `AGENTS.md`）：意图仍无版本化落点，不可评审、
  不可追溯，等于没改。
- **规格产物与新鲜度全量进 CI 门禁**：误报率未知（文档天然滞后于代码），先出报告观察，
  是否升格为门禁留待数据支持（进 `TODO.md`）。
