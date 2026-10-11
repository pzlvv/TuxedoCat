# 任务分解：SPEC 驱动开发的改动规格工作流

按依赖顺序执行；每个任务完成即勾选，全部勾选后进 /converge。完成判据均可验证
（lint 组名 / 命令 / 文件存在）。

## 任务清单

- [x] **T001**（FR-003）：决策入档——写 ADR-0004 并登记 `docs/adr/README.md` 索引行；依赖：—；完成判据：ADR-0004 存在且索引可链接
- [x] **T002**（FR-001、FR-004）：容器与模板——写 `specs/README.md` 与 `specs/_templates/` 四份模板；依赖：T001；完成判据：四模板 + README 存在，口径与 ADR 一致
- [x] **T003**（FR-003、FR-011）：文档体系登记——`docs/README.md` 分类法与地图、`AGENTS.md` 文档要求补例外、TODO.md 口径重写；依赖：T002；完成判据：三处文档更新且互链有效
- [x] **T004**（FR-007、FR-005、FR-006）：守卫扩容——docsLint 跳过 `_templates`、specs/ 存在性豁免、新增 specs 结构组与 docs frontmatter 组（FR-008 的校验半）；依赖：T002；完成判据：`npm run test:all -- docs-lint` 全绿且含两个新组
- [x] **T005**（FR-008）：主题规格 frontmatter——docs/ 顶层规格（README.md 除外）补 owner / last_reviewed；依赖：T004；完成判据：frontmatter 组绿
- [x] **T006**（FR-009）：新鲜度报告——`scripts/docs-freshness.mjs` 与 `package.json` 的 `docs:freshness` 入口；依赖：T004（引用口径对齐）；完成判据：`npm run docs:freshness` 输出报告且退出码 0
- [x] **T007**（FR-010）：技能入口——``<configDir>`/skills/` 新增 spec / plan / tasks / implement / converge，重写 `doc`；依赖：T002；完成判据：六个 SKILL.md 存在且闸门写进步骤
- [x] **T008**（FR-002）：收敛与归档——逐条核对验收标准、填收敛记录、整目录移入 `docs/archive/specs/`；依赖：T001–T007 全勾且 check-types / lint / docs-lint 全绿；完成判据：specs/ 只余 `_templates/`，归档件完整
