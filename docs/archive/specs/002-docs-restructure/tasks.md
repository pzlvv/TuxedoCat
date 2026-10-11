# 任务分解：文档体系重组

执行顺序：先骨架后内容、先文档后守卫、引用清剿贯穿收尾；中间态 docsLint 必红属预期，
T008 一次收敛。需求见 [spec.md](spec.md)，方案见 [plan.md](plan.md)。

## 任务清单

- [x] **T001**（FR-001）：建 docs/ 四子目录并 git mv 19 篇存量文档（含 user-stories.md）；同步 docsLint 组 8/17/18 与其他硬编码路径；依赖：—；完成判据：git status 全部为 rename，目录树与 spec FR-001 清单一致
- [x] **T002**（FR-002、FR-003）：落八篇新文档（overview / layering / repo-map / class-diagrams / events / principles / open-questions / session-runtime），正文零语义改动、章内自引用改跨文档链接；依赖：T001；完成判据：拆解映射逐章有唯一落点，events.md 表列序与原 4.1 一致
- [x] **T003**（FR-002）：git rm DEVELOPMENT.md；依赖：T002；完成判据：仓库根无 DEVELOPMENT.md，全仓检索活文档与代码注释零残留
- [x] **T004**（FR-004）：五篇特性规格 spec 化（用户场景 / FR / AC / 追溯矩阵，原散文收进行为规格节）；依赖：T001；完成判据：五篇均含七节骨架与 frontmatter，矩阵逐 FR 一行
- [x] **T005**（FR-005）：docsLint 改造（组 1/7/11/14 重锚 events.md、4a/23 递归、新组 24、8/17/18 换路径），清文件内 DEVELOPMENT.md 字面量；依赖：T002、T003、T004；完成判据：docsLint 全部组在重组后的树上可运行
- [x] **T006**（FR-006）：引用清剿——代码注释 30+ 处、docs 互链、AGENTS.md、specs/README 与 _templates、docs-freshness.mjs 递归、brandLiteral、根 README；依赖：T002、T003；完成判据：grep DEVELOPMENT.md 活文档与代码零残留，docsLint 章节引用组绿
- [x] **T007**（FR-007）：docs/README.md 重写（分类法 + 四子目录地图）、ADR-0005 与索引登记、AGENTS.md 权威口径；依赖：T006；完成判据：地图覆盖组与 ADR 完整性组绿
- [x] **T008**（FR-005、FR-006、FR-007）：全量门禁（check-types / lint / test:all / test:core、docs:freshness 报告）并收敛本 spec 归档；依赖：T005、T006、T007；完成判据：门禁全绿，spec 002 归档进 docs/archive/specs/
