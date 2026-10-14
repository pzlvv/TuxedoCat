# 任务分解：改动分级流程（L0 / L1 / L2 / L3）

执行顺序：先落闸门与容器（T001–T005），再扩守卫（T006–T010），然后 skill（T011–T012），
最后文档同步（T013–T019）与全量验证（T020）。守卫与闸门必须同批改——中间态会出现「闸门已按
新档判、守卫还按旧形态查」的口径分叉。需求见同目录 `spec.md`，技术方案见 `plan.md`。

文档拆分（`docs/architecture/contracts.md` 等四份压到 500 行内）由并行的独立改动执行，不属本
任务清单；T009 的体积组落地后要等它完成才能跑绿。

## 任务清单

- [x] **T001**（FR-006）：新增 `scripts/githooks/commit-msg`——`git interpret-trailers --parse` 解析 `Flow` / `Spec` / `Defect`，实现六类判据（merge 豁免、非代码路径放行、无 Flow 拒绝、多条 Flow 拒绝、L0 放行、L1 查缺陷文件、L2 查 docs 改动、L3 查三件套、未知取值拒绝）；依赖：—；完成判据：手工在临时仓库对六类提交各跑一次，退出码与提示符合判据表（记录附报告）
- [x] **T002**（FR-006）：删除 `scripts/githooks/pre-commit`（旧闸门无其它职责）；依赖：T001；完成判据：`ls scripts/githooks/` 无 `pre-commit`，且 `commit-msg` 在 `core.hooksPath` 下可执行
- [x] **T003**（FR-006）：新增 `src/test/gitHookGate.test.ts`——临时 git 仓库 + 只装 `commit-msg`，用真实 `git commit` 断言放行 / 拒绝；依赖：T001；完成判据：`npm run test:all -- gitHookGate` 全绿
- [x] **T004**（FR-003）：新增 `specs/_templates/defect-report.md`（frontmatter `status: 待修`，五节：现状 / 期望 / 不变量 / 回归测试 / 验证记录；验证记录为四列表）；依赖：—；完成判据：产物存在，章节与结果取值口径与 T007 的守卫一致
- [x] **T005**（FR-003）：删除 `specs/_templates/defect.md`（三件套缺陷形态下线）；依赖：T004；完成判据：文件不存在，且归档 `docs/archive/specs/009-*/defect.md` 不受影响（`docs/archive/` 不参与校验）
- [x] **T006**（FR-007）：docsLint 组 22 分档——改动规格目录按 status 递进要求（起草 → spec.md；待评审 → spec.md + plan.md；实施中 / 已收敛 → 三件套），并移除 `specs/<NNN>/defect.md` 分支；依赖：T005；完成判据：`npm run test:all -- docs-lint` 绿，且只有 spec.md 的起草目录不再报「缺 plan.md」
- [x] **T007**（FR-007）：docsLint 组 22 新增缺陷文件校验（slug 格式、H1 `# 缺陷：`、status ∈ 待修 / 已修 / 已放弃、五节齐全、RT 编号、验证记录表四列与结果取值合法）；依赖：T004；完成判据：临时造缺「验证记录」与非法结果取值的缺陷文件各一，组红；删除后绿
- [x] **T008**（FR-007）：docsLint 组 25 的 `convergedSpec()` 扩成 `settledSpec()`——`specs/defects/<slug>.md` 的 `已修` 退出存在性豁免；依赖：T007；完成判据：造一个 `已修` 且测试落点悬空的缺陷文件，落点存活检查红
- [x] **T009**（FR-007）：新增文档体积组（docsLint 扫描范围内的 `docs/**/*.md` ≤ 500 行；排除 `docs/archive/` 冻结档案；豁免 `docs/features/user-stories.md` 与各级 `README.md`）；依赖：—；完成判据：`npm run test:all -- docs-lint` 该组绿（需并行文档拆分落地）
- [x] **T010**（FR-007）：同步 docsLint 文件头的守卫清单注释；依赖：T006、T007、T008、T009；完成判据：注释条目与实际组一一对应，`npm run lint` 干净
- [x] **T011**（FR-003、FR-008）：新增 `<configDir>/skills/fix/SKILL.md`——两段产出即停、三条硬规则、产物路径与 slug 规则；依赖：T004；完成判据：产物存在，`.zcode/skills/fix/SKILL.md` 经 junction 同步可见，frontmatter 四字段齐
- [x] **T012**（FR-008）：改 `<configDir>/skills/spec/SKILL.md` 插入定档分支（L0 停 / L1 转 `/fix` / L2 定位基线、缺失先补基线 / L3 走三件套）；依赖：T011；完成判据：skill 第 1 步含四档分支且与 AGENTS.md 判据表一致
- [x] **T013**（FR-001、FR-002）：重写 [AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)闸门段——四档判据表、各档产物与闸门、`Flow` / `Spec` / `Defect` trailer 约定、L0 行（无产物 / 可新增文件 / 理由写提交信息正文）；依赖：—；完成判据：章节引用组绿，判据表与 spec FR-001 逐行一致
- [x] **T014**（FR-003）：[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)的「只写现状」例外补上 `specs/defects/`；依赖：T013；完成判据：该节表述与容器实际形态一致，锚点可解析
- [x] **T015**（FR-003、FR-004）：`specs/README.md` 新增「缺陷规格」与「需求变更与补基线」两节，并修正 [第 1 节](../../specs/README.md#1-目录约定)目录约定 / [第 2 节](../../specs/README.md#2-生命周期)生命周期 / [第 5 节](../../specs/README.md#5-守卫口径docslint)守卫口径的三件套表述；依赖：T005、T013；完成判据：`npm run test:all -- docs-lint` 绿，新章节锚点可解析
- [x] **T016**（FR-005）：`specs/README.md` 生命周期节加限定——三件套只服务 L3，缺陷形态不在其列；依赖：T015；完成判据：生命周期表述与四档流程无矛盾
- [x] **T017**（FR-001）：新增 `docs/adr/0006-tiered-change-workflow.md`（决策 / 背景 / 被否决的替代方案）并在 `docs/adr/README.md` 索引登记；依赖：—；完成判据：ADR 组绿（编号连续唯一、状态取值合法）
- [x] **T018**（FR-003）：`docs/README.md` 分类法加「缺陷规格」行、补文档 500 行上限口径；依赖：—；完成判据：分类法表含该行且与 T009 的守卫范围一致
- [x] **T019**（FR-001）：`TODO.md` 登记 `docs/features/user-stories.md` 753 行的拆分（带验收判据）；依赖：—；完成判据：TODO 项存在且写明验收判据
- [x] **T020**（FR-001、FR-006）：全量验证与手工验证——`npm run check-types && npm run lint && npm run test:all` 全绿；手工对 L0 / L1 / L2 / L3 四类提交各走一次，确认放行与拒绝符合判据表；依赖：T003、T010、T016、T017、T018、T019；完成判据：命令全绿 + 四类提交的实测记录附报告（本次零 Core 改动，无需 `npm run build:core:host` 与 `npm run test:core`）
