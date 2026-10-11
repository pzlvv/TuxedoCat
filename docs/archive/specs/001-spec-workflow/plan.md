# 实施方案：SPEC 驱动开发的改动规格工作流

按 [spec.md](spec.md) 的 FR-001…FR-011 实施：全部是文档、测试守卫与 skill 文案改动，
不触及 `src/core/`、`core-rs/`、`src/host/` 的任何行为代码。

## 技术方案

- **容器与约定**（FR-001 / FR-002）：`specs/README.md` 承载目录约定、生命周期、ID 体系、
  闸门与守卫口径（唯一事实点）；决策与被否决方案进 ADR-0004；模板集中在
  `specs/_templates/`（保留目录名，docsLint 跳过）。
- **文档体系登记**（FR-003）：`docs/README.md` 分类法加「改动规格」行、地图加节并登记
  `specs/README.md`（子目录导读登记规则会强制这一点）；`AGENTS.md` 文档要求补例外；
  `TODO.md` 重写为新口径。
- **守卫**（FR-005 / FR-006 / FR-007 / FR-008）：`src/test/docsLint.test.ts` 扩两组——
  specs 结构组（三件套齐全、H1、章节、FR/AC/T 编号与覆盖、追溯矩阵、status、澄清标记）
  与 docs frontmatter 组；`listFiles()` 跳过 `_templates`；groups 9/13/15/19 的 TODO.md
  豁免扩展为「TODO.md 与 specs/」同口径（描述尚未落地的改动）。
- **新鲜度**（FR-009）：`scripts/docs-freshness.mjs` 用 git 最后提交时间对比文档与行内
  代码引用的仓库路径，输出过时排行；只出报告恒退出 0；`package.json` 加 `docs:freshness`。
- **技能入口**（FR-010）：``<configDir>`/skills/` 新增 spec / plan / tasks / implement /
  converge 五个 SKILL.md（frontmatter 格式与既有 `doc` skill 一致），闸门写进各自步骤；
  `doc` skill 重写为两层分工的写作约定。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `specs/`（新增） | README、四模板、本 spec 三件套 | 无 |
| `docs/adr/0004-spec-driven-change-workflow.md`（新增）、`docs/adr/README.md` | 新增决策与索引行 | 无 |
| `docs/README.md` | 分类法 + 地图 + 开篇守卫说明 | 无 |
| `AGENTS.md` | 文档要求补 specs/ 例外 | 无 |
| `docs/*.md`（顶层，README.md 除外） | 加 frontmatter | 无 |
| `src/test/docsLint.test.ts` | 扩两组 + 豁免口径 + `_templates` 跳过 | 无（纯测试） |
| `scripts/docs-freshness.mjs`（新增）、`package.json` | 报告脚本与 npm 入口 | 无 |
| ``<configDir>`/skills/`（六个 SKILL.md） | 新增 / 重写 | 无（configDir 不在 docsLint 扫描范围） |
| `TODO.md` | 口径重写 | 无 |

## 宪章检查

- [x] 分层与依赖（AGENTS.md「分层与依赖」一节）：不触及 core / host / 宿主实现任何一层；
      新增代码只有测试（`src/test/`）与独立脚本（`scripts/`），不引入新的跨层 import——
- [x] 架构铁律（AGENTS.md「架构铁律」一节）：不改变任何契约、事件、默认值与写入点；spec 模板
      遵循「不过度 fallback」（闸门缺失直接红，不静默降级）——
- [x] 两套 Core parity 义务（AGENTS.md「两套 Core 必须同步改」一节）：不涉及 Core 行为；skill 不进
      `src/core/skills/bundled/`，Embedded（`src/core/`）与 Standalone（`core-rs/`）
      均无改动，无 parity 义务——
- [x] 文档同步义务（AGENTS.md「文档同步是硬约束」一节）：本改动即文档改动；docsLint 新组与文档同步落地，
      收敛前 `npm run test:all -- docs-lint` 必须绿——

## 被否决的替代方案

- **整包引入 GitHub Spec Kit / Kiro / OpenSpec**：外部 CLI、英文模板、产物不进 docsLint
  体系；delta 全文复制与「同一事实只写一处」冲突。只借鉴阶段划分（见 ADR-0004）。
- **把 specs/ 的路径 / 标识符存在性检查也全量开启**：spec 描述尚未落地的改动，新路径
  与新脚本是常态，全量开启会把每份起草中的 spec 都变红；与 TODO.md 同口径豁免，
  落地后由 docs/ 全量对照兜底。
- **frontmatter 铺到 AGENTS.md / DEVELOPMENT.md / 根 README**：TODO 只要求主题规格；
  AGENTS.md / 总纲的腐化由 docsLint 既有组兜底，铺开反而稀释「last_reviewed = 人核过」
  的语义。
- **新鲜度直接进 CI 门禁**：文档天然滞后于代码，误报率未知；先报告后决定（进 TODO）。
