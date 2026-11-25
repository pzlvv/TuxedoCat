# 任务分解：压缩后重挂本会话已调用的技能正文

执行顺序：先把「记录 → 渲染 → 章节 → 剥离 → 注入标记」这条核心链路做完（T001–T005）并让
纯函数测试绿，再做引擎级与 e2e（T006–T008），最后同步文档与收敛归档（T009–T012）。
需求见同目录 [spec.md](spec.md)，方案见 [plan.md](plan.md)。

## 任务清单

- [x] **T001**（FR-001）：`core-rs/src/compact.rs` 新增 `compactLoadedSkills` 派生与读取（`Skill` `tool_use` → `{name,args}`，三段合并且同名取最近）；依赖：—；完成判据：`cargo test -p core-rs skill_load` 全绿，含 `loaded_skill_records_merge_region_and_persisted` / `loaded_skill_records_dedupe_by_name_keeping_latest`
- [x] **T002**（FR-003）：`core-rs/src/skills.rs` 抽出 `render_skill_body`，`core-rs/src/tools.rs` 的 `run_skill` 改为复用它并在注入消息上加 `skillName`；依赖：—；完成判据：`cargo test -p core-rs skill` 全绿，含 `run_skill_injects_skill_name_marker`，`skills_tests` 的既有渲染用例不回归
- [x] **T003**（FR-002）：`core-rs/src/util.rs` 加 `take_prefix_within_tokens`；`core-rs/src/compact.rs` 加 `COMPACT_SKILL_MAX_TOKENS` / `COMPACT_SKILL_TOTAL_TOKENS` 与 `build_loaded_skills_section`（填充顺序、单项截断、总量点名、失败点名、空集不出章节）；依赖：T001、T002；完成判据：`cargo test -p core-rs loaded_skills_section` 全绿，含单项截断与总量溢出两条
- [x] **T004**（FR-002、FR-004）：`generate_compact_user_message` 接 `loaded_skills` 入参并把章节插在尾注前；`compact_conversation` / `compact_conversation_inner` 加 `cwd`，`compact_and_apply_messages` 传 `project`；摘要消息写 `compactLoadedSkills`；保留区已含同名正文的技能不重挂；依赖：T003；完成判据：`cargo test -p core-rs compact` 全绿，`compact_engine_tests` 的既有用例不回归
- [x] **T005**（FR-005）：`format_messages_for_compact` 对 `isCompactSummary` 剥掉「已加载技能」章节，尾注提成 `COMPACT_FOOTER` 常量与生成侧共用；依赖：T004；完成判据：`cargo test -p core-rs strip_loaded_skills` 全绿，含 `strip_keeps_footer` / `strip_absent_section_returns_text_unchanged`
- [x] **T006**（FR-001～FR-006）：`core-rs/fixtures/compact.json` 补 `compactUserMessages` 的 `loadedSkills` 变体与新增 `loadedSkills` 段；`core-rs/src/compact_tests.rs` 补纯函数用例（含字段损坏按无记录处理）；依赖：T003、T004、T005；完成判据：`npm run test:core` 全绿且 `cargo test -p core-rs parity` 全绿
- [x] **T007**（FR-003、FR-004）：`core-rs/src/compact_engine_tests.rs` 补引擎级用例：一次压缩重挂、二次压缩仍重挂（跨代继承）、保留区已含不重复、磁盘改动取新版、技能被删后缺席；依赖：T006；完成判据：`cargo test -p core-rs` 中新增 5 条用例全绿
- [x] **T008**（FR-001～FR-006）：新增 `e2e/electron/skillReloadAfterCompact.spec.ts`：真实 Core + mock LLM，走「调用技能 → 压缩 → 下一轮请求含正文」与**重复压缩**（第二代仍重挂、第一代章节不进摘要输入、磁盘改动取新版、技能删除后缺席并点名）；依赖：T007、`npm run build:core:host`；完成判据：`npx playwright test e2e/electron/skillReloadAfterCompact.spec.ts --project=electron-app` 全绿（本地 Windows 车道）
- [x] **T009**（FR-001、FR-002、FR-004、FR-005）：`docs/features/compaction.md` 补场景 7 / as-built 的新增 FR 节 / 3.1 数据流 / 边界 / 追溯矩阵；依赖：T008；完成判据：`npm run test:unit -- docs-lint` 绿
- [x] **T010**（FR-003、FR-006）：`docs/features/skills.md` 补 3.4 注入路径的重挂、4 边界、5 非目标删一条、7 追溯矩阵；依赖：T009；完成判据：同上
- [x] **T011**（FR-006）：`docs/features/user-stories/tools.md` 的 US-27 加验收标准 5；`TODO.md` 缩窄「技能名单的上下文经济」；依赖：T009；完成判据：`npm run test:unit -- docs-lint` 的 US 闭合校验绿
- [x] **T012**（无 FR，收敛）：逐条核对 AC 与测试证据写入 spec「收敛记录」，`npm run check-types` / `npm run lint` / `npm run test:unit -- docs-lint` / `npm run test:core` 全绿，status 改「已收敛」后归档到 `docs/archive/specs/`；依赖：T009、T010、T011；完成判据：`git mv specs/057-skill-reload-after-compact docs/archive/specs/` 完成且归档后 docs-lint 仍绿
