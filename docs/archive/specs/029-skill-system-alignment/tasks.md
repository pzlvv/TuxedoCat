# 任务分解：技能系统的调用语义、共享目录与优先级

执行顺序：T001 是唯一的编译面前置（字段改造会让所有构造点同时红），必须先落地；之后
T002–T004 是三个消费点、T005–T006 是根表与仲裁，可以依次推进；T007（仓库迁移）与 T008
（删 TS 遗留）与代码无依赖，可并行；T009 写的是最终形态，排在代码全绿之后；T010 是收尾验证。

需求见 [spec.md](spec.md)，方案见 [plan.md](plan.md)。

## 任务清单

- [x] **T001**（FR-001）：字段与解析改造——`SkillCommand` 删 `is_hidden`、加 `model_invocable`；
      `ParsedSkillFrontmatter` 加 `disable_model_invocation`（默认 false，解析写法对齐
      `user-invocable`）；`CreateSkillCommandParams` 加 `model_invocable`、
      `BundledSkillDefinition` 加 `disable_model_invocation`；`fixtures/skills.json` 的 `fields`
      用例补 `disable-model-invocation` 三态（缺省 / true / "no"）；`skills_tests.rs` 里所有
      `is_hidden:` 构造点改 `model_invocable:`；依赖：—；完成判据：`npm run test:core` 全绿，
      且 `parse_skill_frontmatter_fields` 的新用例覆盖三个取值。

- [x] **T002**（FR-001）：模型名单按 `model_invocable` 过滤——改
      `format_skill_listing`（`core-rs/src/skills.rs`）；把 `fixtures/skills.json` 的
      `skillListing` 用例从 `isHidden` 改成 `modelInvocable` 并按新语义重算期望串（
      `userInvocable: false` 的条目**要出现**在名单里，`modelInvocable: false` 的**不出现**）；
      删掉 `non_user_invocable_skill_is_hidden`，改为 `user_invocable_false_is_listed_for_model`
      与 `disable_model_invocation_hidden_from_listing` 两条；依赖：T001；完成判据：
      `npm run test:core` 中 `skill_listing_parity`、`available_skills_section_matches_environment_text`
      与两条新用例全绿。

- [x] **T003**（FR-001）：用户侧入口按 `user_invocable` 过滤——`main::skills_payload` 改为
      「内置命令（`isBuiltin: true`）+ `skills::get_all_skills(cwd)` 过滤 `user_invocable`
      （`isBuiltin: false`）」；`commands::dispatch` 匹配技能时要求 `user_invocable`；
      `main::spin_design_skills` 过滤条件改为 `user_invocable`；新增用例
      `skills_payload_excludes_model_only_skill`（`main_tests.rs`）与
      `dispatch_skips_non_user_invocable_skill`（`commands_tests.rs`）；依赖：T001；
      完成判据：`npm run test:core` 全绿，且 `main_tests.rs` 里同名技能不再出现两次。

- [x] **T004**（FR-001）：模型侧拒绝落在 `tools::validate_input` 的 `"Skill"` 分支——
      解析到技能后若 `!model_invocable` 返回
      `Skill '<name>' cannot be invoked by the model (disable-model-invocation: true)`；
      `run_skill` **不加**校验，并在 `engine::inject_skill_tool_use` 与 `run_skill` 各加一条注释
      说明「用户注入路径不经过 `validate_input` 是有意的来源区分」；新增用例
      `validate_input_rejects_disable_model_invocation` 与
      `run_skill_executes_disable_model_invocation_skill`；依赖：T001；完成判据：
      `npm run test:core` 全绿，两条新用例覆盖「校验拒绝 / 执行仍可」两侧。

- [x] **T005**（FR-002）：四个发现根——新增 `SkillRoot { rank, path, source }` 与
      `skill_roots(cwd)`（10 项目 `.agents` → 20 项目 `.<configDir>` → 30 用户 `.agents`
      → 40 用户 `.<configDir>`），`get_skill_dir_commands` 改为按 rank 遍历；
      新增用例 `agents_project_root_is_discovered`、`agents_user_root_is_discovered`、
      `claude_skills_root_is_ignored`（在沙箱里造 `.claude/skills/z/SKILL.md` 断言不出现）；
      依赖：T001；完成判据：`npm run test:core` 全绿，`loads_skills_from_config_dir` 的顺序断言
      改为 project 在前。

- [x] **T006**（FR-003）：去重与仲裁——realpath 去重在前（同物理文件只留 rank 最小、不打
      WARNING），`arbitrate()` 纯函数在后（name / alias 命中即丢弃后者并产出
      `被忽略路径 ← 胜出路径` 文案），`get_all_skills` 把 bundled 当 rank 50 候选一起仲裁；
      新增用例 `project_skill_shadows_bundled`、`same_name_project_wins_over_user`、
      `agents_root_wins_over_product_root`、`arbitrate_reports_both_paths`、
      `same_file_via_multiple_roots_dedupes_without_warning`；依赖：T005；完成判据：
      `npm run test:core` 全绿，且 `arbitrate` 的两条返回路径（保留清单 / WARNING 文案）都被断言。

- [x] **T007**（FR-004）：仓库迁移——`git mv <configDir>/skills .agents/skills`（9 个目录）、
      `git rm -r --cached .zcode/skills`、`.gitignore` 去掉 `!.zcode/skills/` 一行、本机把
      `.zcode/skills` 重建成指向 `.agents/skills` 的 junction、[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)改写落库路径与
      junction 约定；依赖：—；完成判据：`git ls-files .agents/skills | wc -l` 输出 9、
      `git ls-files '<configDir>/skills' .zcode/skills | wc -l` 输出 0、`.zcode/skills` 指向
      `.agents/skills`（`readlink` / `dir` 输出可核对）。

- [x] **T008**（FR-005）：删掉 TS 侧遗留——`git rm -r src/shared/skills`；
      `docs/architecture/repo-map.md` 与 `docs/architecture/overview.md` 的 `src/shared/` 描述
      去掉 `skills/`；`core-rs/src/skills_tests.rs` 顶部注明 `fixtures/skills.json` 是手工维护的
      期望值；依赖：—；完成判据：`npm run check-types && npm run lint` 全绿、
      `test -d src/shared/skills` 为假、`npm run test:all -- docs-lint` 的行内代码路径检查为 0 失效。

- [x] **T009**（FR-001、FR-002、FR-003、FR-004、FR-005）：文档同步——新增
      `docs/features/skills.md`（as-built：四个根与 rank、frontmatter 字段、两个调用开关、
      模型名单、注入路径与来源区分、同名仲裁与日志、边界与错误路径）；`docs/README.md` 地图登记
      该文；改 `docs/features/user-stories/tools.md` 的 US-27 验收标准；[docs/architecture/open-questions.md 第 1 节](../../docs/architecture/open-questions.md#1-corerust)
      加「弱化 `.<configDir>/skills`」一行；依赖：T001–T008；完成判据：
      `npm run test:all -- docs-lint` 全绿，且 `docs/README.md` 地图含 `docs/features/skills.md`。

- [x] **T010**（FR-001、FR-002、FR-003、FR-004、FR-005）：收尾验证——`npm run build:core:host`
      后跑 `npm run test:all`（standalone 系列必须真跑、不出现 skip）与 `npm run test:core`；
      手工核对 AC-15 / AC-16（索引里 9 个技能在 `.agents/skills`、ZCode 会话可用技能与迁移前一致）；
      依赖：T001–T009；完成判据：三条命令全绿、runner 汇总无「跳过」项、手工核对结果写进
      spec 的收敛记录。
