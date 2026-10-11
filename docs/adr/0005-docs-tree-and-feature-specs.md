# ADR-0005：文档体系重组——拆解 DEVELOPMENT.md、docs/ 分域目录与特性规格层

- 状态：已采纳
- 日期：2026-10
- 规格：`docs/archive/specs/002-docs-restructure/`（改动规格，已收敛归档）

## 背景

`DEVELOPMENT.md`（1236 行）把架构总览、分层规则、总线契约与事件词汇表、架构原则、
待定事项五类主题装在一个文件里，行数已顶到体积棘轮（1237），无法继续扩充；单文件
承载多主题导致检索困难，任何一章改动都在同一个超大 diff 里。同时，存量特性规格
（abort 按钮、压缩、后台 Bash 等）是散文形态，没有用户场景 / FR / AC / 追溯矩阵的
spec 结构，与 specs/ 改动规格（ADR-0004）的形态割裂。

## 决策

- **拆解散尽**：`DEVELOPMENT.md` 删除，六章全部迁入 `docs/`——1.1+1.2 →
  `docs/architecture/overview.md`、1.3 → `repo-map.md`、1.4+1.5 → `class-diagrams.md`、
  `第 2 章` → `layering.md`、`第 3+4 章` → `events.md`、`4.5` → `docs/core/session-runtime.md`、
  `第 5 章` → `principles.md`、`第 6 章` → `open-questions.md`。仓库根只留 README / AGENTS /
  TODO 三个入口文件，架构细节的唯一权威是 `docs/` 各规格。
- **docs/ 分域目录**：`architecture/`（总纲类规格）、`core/`（Core 实现与进程模型）、
  `hosts/`（宿主与 UI）、`features/`（特性规格与需求基线）；`docs/README.md` 仍是唯一
  索引，子目录不建 README。存量文档 git mv 保历史。
- **特性规格层**：`docs/features/` 的特性文档改写为 as-built 的 spec 形态（用户场景 /
  FR-nnn / AC 一行式 / 追溯矩阵，frontmatter 用 owner + last_reviewed）；`specs/` 的
  改动规格生命周期（ADR-0004）语义不变，仍只装未落地改动。
- **守卫同步**：docsLint 事件表三组重锚到 `events.md`；体积棘轮改盯 `events.md`；
  地图覆盖与 frontmatter 两组递归扫 docs/；新增特性规格结构组（组 24）；全仓
  `DEVELOPMENT.md 第 N 节` 引用重指向新落点。

## 替代方案（被否决）

- **保留薄总纲（缩到 ~230 行）**：总纲与子目录规格并存仍留两套入口，「架构细节以谁
  为准」存在二义；评审裁决拆解散尽。
- **specs/ 常驻容器装存量特性**：违反 ADR-0004 生命周期（收敛后归档、编号不复用），
  改动规格与现状规格混在同一命名空间；否决，as-built 特性规格落 `docs/features/`。
- **只重排不改写**：目录整齐但特性文档仍是散文形态，SPEC 化诉求不落地；否决。
- **事件词汇表留根目录（EVENTS.md）**：与 docs/ 唯一索引冲突，多一个根入口；否决，
  落 `docs/architecture/events.md`。
