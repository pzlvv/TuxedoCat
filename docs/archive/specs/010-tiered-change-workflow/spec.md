---
status: 已收敛
---

# 改动规格：改动分级流程（L0 直改 / L1 缺陷修复 / L2 需求变更 / L3 新特性）

现有闸门按「改了哪个路径」判，不按「改动的性质」判：`scripts/githooks/` 下的 `pre-commit` 钩子只看
暂存区是否命中 `src|electron|e2e|core-rs|tui-rs|installer-rs`，命中就要求 `specs/` 下存在
改动规格目录，否则拒绝提交；唯一出口是 `git commit --no-verify`。后果是轻量流程事实上早已
存在——它就是 `--no-verify`——但没有判据、没有留痕、没有边界：最近 60 个提交里 16 个在提交
信息里显式写明「豁免」，其中包含 `4661857` 这类同时改动两侧 Core 权限策略与 parity 对照表的
feat 改动；而 `fix:` 前缀的 32 个提交里大量是纯 UI 调整，前缀与改动性质已经脱钩。

本改动把闸门改为按改动性质分四档，每档有自己的判据、产物与闸门：L0 直改不走流程；L1 缺陷
修复走独立容器 `specs/defects/<slug>.md`，要回归用例、不归档；L2 需求变更就地修订 as-built
基线，基线缺失时先基于代码补基线、再基于它变更；L3 新特性维持现有三件套。设计参照：GitHub
Spec Kit 的缺陷修复轨道（assess → fix → test；评估段禁止改源码；评估是修复的契约；验证不许
自证清白）、Kiro 的缺陷分档判据（根因不明 / 关键路径 / 复发才写规格）、OpenSpec 的「零 delta
必须显式豁免」与 delta 就地合并、Amazon 的单向门 / 双向门。决策背景与被否决的替代方案见
ADR-0006。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求) | 0. 文档要求 | 修改 | 「只写现状」的唯一例外补上 `specs/defects/<slug>.md`（缺陷报告含未落地的期望） |
| [AGENTS.md 第 5 节](../../AGENTS.md#5-工作流) | 5. 工作流 | 修改 | 「spec 闸门」改为分档闸门：四档判据表、各档产物与闸门、提交信息 trailer 约定 |
| [specs/README.md 目录约定](../../specs/README.md#1-目录约定) | 1. 目录约定、2. 生命周期、5. 守卫口径（docsLint） | 修改 | 三件套表述加限定（缺陷形态不适用）；补缺陷规格容器与 L2 就地修订 / 补基线的规则 |
| [docs/README.md 分类法](../../docs/README.md#分类法) | 分类法 | 修改 | 加「缺陷规格」行；补文档 500 行上限口径 |
| [docs/adr/README.md](../../docs/adr/README.md) | ADR 索引 | 修改 | 登记 ADR-0006 |
| `docs/adr/0006-tiered-change-workflow.md` | — | 新增 | 分级判据与四档流程的决策、背景、被否决的替代方案 |
| [TODO.md](../../TODO.md) | — | 修改 | 登记本次不做的项（`docs/features/user-stories.md` 753 行的拆分） |
| [docs/features/user-stories.md](../../docs/features/user-stories.md) | — | 无变更 | 流程类改动，无新增 / 修改 US |

## 用户场景与验收标准

- 场景 1：动手前先定档
  - **AC-1**（FR-001）：GIVEN 一次待做的改动 WHEN 逐条对照四档判据 THEN 恰好一档成立；判不清时取较高档
  - **AC-2**（FR-001）：GIVEN 实施中才发现改动触及契约面 WHEN 重新定档 THEN 停在当前任务、按新档流程重走，不降档
  - **AC-3**（FR-005）：GIVEN 一次改动新增了 US / FR / 事件 / 契约成员 / 面板 WHEN 定档 THEN 判为 L3，走三件套与澄清 / 宪章 / 收敛三道闸门
- 场景 2：L0 直改
  - **AC-4**（FR-002）：GIVEN 只改样式 / 文案 / 依赖且不落任何 AC、不触契约面 WHEN 提交 THEN 提交信息带 `Flow: L0` 即放行，不需要任何 `specs/` 产物
  - **AC-5**（FR-002）：GIVEN 该 L0 改动新增了文件 WHEN 提交 THEN 仍按 L0 放行（判据只看效果，不看文件数）
- 场景 3：L1 缺陷修复
  - **AC-6**（FR-003）：GIVEN 一个缺陷 WHEN 走修复流程 THEN 产出 `specs/defects/<slug>.md`，含现状 / 期望 / 不变量 / 回归测试 / 验证记录五节
  - **AC-7**（FR-003）：GIVEN 评估阶段 WHEN 写 defect.md THEN 该阶段不修改任何源码，且回归用例先红（验证记录记下红的命令与断言）
  - **AC-8**（FR-003）：GIVEN 修复完成 WHEN 写验证记录 THEN 表内同时有修复前的红与修复后的绿两行；跑不了的检查记 `skipped` / `not-run` 并写原因
  - **AC-9**（FR-003）：GIVEN 缺陷已修 WHEN 提交 THEN 文件常驻 `specs/defects/<slug>.md`（不归档、不编号），且 status 为 `已修` 时落点存活检查生效
- 场景 4：L2 需求变更
  - **AC-10**（FR-004）：GIVEN 既有需求的行为要变、as-built 基线存在 WHEN 变更 THEN 同一提交内改齐 FR / AC + 代码 + 测试，不新增 spec 目录
  - **AC-11**（FR-004）：GIVEN 同一变更但基线缺失 WHEN 变更 THEN 先基于代码补基线（只补本次涉及的行为）并单独提交，再基于该基线做变更
  - **AC-12**（FR-004）：GIVEN 补基线 WHEN 选择落点 THEN 内容独立（跨多个 surface 或独立状态机）的进 `docs/features/`，否则补进既有规格的一节；补完任一份不超过 500 行
- 场景 5：分档闸门
  - **AC-13**（FR-006）：GIVEN 提交信息无 `Flow` trailer 且暂存区命中代码路径 WHEN 提交 THEN 被拒绝，并提示写档位或开规格
  - **AC-14**（FR-006）：GIVEN 声明 L1 / L2 / L3 WHEN 对应产物缺失（`specs/defects/<slug>.md` / `docs/**/*.md` 改动 / 三件套）THEN 被拒绝
  - **AC-15**（FR-006）：GIVEN merge 提交 WHEN 提交 THEN 不要求 `Flow` trailer
- 场景 6：守卫
  - **AC-16**（FR-007）：GIVEN 缺陷文件缺「验证记录」或结果取值非法 WHEN 跑 docs-lint THEN 红
  - **AC-17**（FR-007）：GIVEN 任一 `docs/**/*.md`（豁免项除外）超过 500 行 WHEN 跑 docs-lint THEN 红
  - **AC-18**（FR-007）：GIVEN status 为「起草」的 spec 目录只有 spec.md WHEN 跑 docs-lint THEN 绿
  - **AC-19**（FR-007）：GIVEN status 为「实施中」的 spec 目录缺 tasks.md WHEN 跑 docs-lint THEN 红
- 场景 7：skill 入口
  - **AC-20**（FR-008）：GIVEN 一次改动 WHEN 走 `/spec` THEN 第一步输出档位判定，判定为 L0 时明确告知「这档不走流程」并停

## 功能需求

### FR-001：四档判据与定档

改动分四档，判据按**改动性质**而非改动路径：

| 档 | 判据 | 产物 |
| --- | --- | --- |
| L0 直改 | 可观察效果不落在任何 US / FR 的验收标准（AC）上，且不触碰契约面（事件类型、载荷字段、契约成员、wire 消息、落盘字段） | 无 |
| L1 缺陷修复 | 代码与 as-built 规格 / 契约不一致——应有行为已定义，只是没做到 | `specs/defects/<slug>.md` |
| L2 需求变更 | as-built 规格已定义的应有行为本身要变 | 就地修订 `docs/` 的基线 + 代码 + 测试 |
| L3 新特性 | 新增 US / FR / 事件 / 契约成员 / 面板 / 宿主 / 文件格式 | `specs/<NNN>-<slug>/` 三件套 |

判据是正面标准，不列负例清单；判不清按较高档走；档位可升不可降（实施中发现越档即停、重新
定档）。L0 允许新增文件：判据只看效果，不看文件数。

### FR-002：L0 直改

L0 不产生任何流程产物，不需要规格目录，也不要求文档改动；改动本身加受影响的既有测试即可。
唯一的要求是提交信息里声明档位（FR-006），理由写在提交信息正文。若 as-built 规格描述了被改
的细节，同步该规格（文档与代码同步是既有硬约束，不因分档豁免）。

### FR-003：L1 缺陷修复

缺陷走独立容器 `specs/defects/<slug>.md`（扁平单文件，slug 为 kebab-case，冲突时加 `-2` /
`-3` 后缀并在文件里引用原 slug）。文件必填五节：现状 / 期望 / 不变量 / 回归测试 / 验证记录；
frontmatter status 取值 `待修` / `已修` / `已放弃`。不写 plan、不写 tasks、不设 severity。

流程分两段：

1. **评估 + 红**：读代码定位根因、写「现状 / 期望 / 不变量」、写出会先红的回归用例（RT-nnn
   条目）。**本段禁止修改任何源码**。
2. **修复 + 绿**：改代码让用例转绿、跑既有回归、写「验证记录」。

三条硬规则：评估段禁止改源码；修复段不许改「现状 / 期望」（它是契约，分歧记进「验证记录」
的偏差项）；验证段禁止改源码，且评估里列的复现路径没真跑过时只能记「部分验证」，不许记
「已修」。验证记录是一张四列表（检查 / 命令 / 结果 / 备注），必须含修复前的红与修复后的绿
两行；跑不了的检查记 `skipped` 或 `not-run` 加原因，不许编造结果。不是缺陷（判决 invalid）
时不写文件，退出流程。

缺陷文件不归档、常驻仓库——它是回归证据的索引，复发时要能查到当初的复现步骤与用例名。

### FR-004：L2 需求变更

既有需求的行为要变时，不新增 spec 目录，就地修订 as-built 基线（`docs/features/`、
`docs/core/`、`docs/hosts/`、`docs/architecture/` 中描述该行为的规格），并在同一提交里改齐
FR / AC + 代码 + 测试。变更理由落提交信息（写清哪条 FR / AC 从什么变成什么），不另建 delta
文档。

**基线缺失时先补基线**：读代码反向枚举该行为的现状（正常路径之外，错误路径、竞态、中止、
边界置灰是重点），按 as-built 形态写进 `docs/`，**单独一个提交**；再基于这份基线做变更。补
基线只补本次涉及的行为，不做全量补齐（历史欠账跟着改动动态还）。落点按既有分类法判：内容
独立（跨多个 surface 或独立状态机）→ 新增 `docs/features/<feature>.md`；否则补进既有规格
的一节；补完任一份不超过 500 行，超了按 surface / 状态机拆。`docs/archive/specs/` 的归档件
只作参考，不在其上改（冻结语义与编号不复用规则不动）。

### FR-005：L3 新特性

新增 US / FR / 事件 / 契约成员 / 面板 / 宿主 / 文件格式时，维持现有流程：`specs/<NNN>-<slug>/`
三件套（spec / plan / tasks，缺陷形态用 defect.md 的场景不存在于本档）、生命周期四态、澄清
与宪章与收敛三道闸门、收敛后 delta 并入 `docs/` 并整目录归档。

### FR-006：分档闸门

闸门从 `pre-commit` 移到 `commit-msg`（`pre-commit` 阶段读不到提交信息），`pre-commit` 里的
「`specs/` 下有任意目录就放行」这条粗判据删除。档位由提交信息的标准 trailer 声明：
`Flow: L0|L1|L2|L3`，L3 另带 `Spec: <NNN>`、L1 另带 `Defect: <slug>`。

判据：暂存区未命中代码路径 → 不要求档位；命中但无 `Flow` 行 → 拒绝；`L0` → 放行；`L1` →
要求 `specs/defects/<slug>.md` 存在；`L2` → 要求暂存区含 `docs/**/*.md` 改动；`L3` → 要求
`specs/<NNN>-<slug>/` 三件套齐；`Flow` 取值不在四档内 → 拒绝（不猜、不降级）。档位由产物
决定，只有 L0 需要声明。

### FR-007：docsLint 守卫

`src/test/docsLint.test.ts` 增加与调整：

- **缺陷规格组**：`specs/defects/<slug>.md` 的 slug 格式、H1 前缀、status 取值、五节齐全、
  RT 编号、验证记录表四列与结果取值合法。
- **落点存活检查**：从「已收敛」的 spec 扩到 status 为 `已修` 的缺陷（RT 的测试落点、路径与
  标识符必须真实存在）；`待修` 仍豁免存在性检查。
- **改动规格结构组按 status 递进要求**：`起草` 只要求 spec.md；`待评审` 要求 spec + plan；
  `实施中` / `已收敛` 要求三件套齐（现状是任何 status 都要求三件套，导致起草与评审期间必然红）。
- **文档体积上限**：`docs/**/*.md` ≤ 500 行；`docs/features/user-stories.md`（需求基线）与各级
  `README.md`（地图 / 导读）豁免。
- 缺陷文件不参与编号查重（编号体系只服务 `specs/<NNN>-<slug>/`）。

### FR-008：skill 入口

新增 `/fix` skill（缺陷修复流程：产出 `specs/defects/<slug>.md`，两段各自产出即停，三条硬规则
写进步骤）；`/spec` 的第一步改为定档：L0 → 告知「这档不走流程」并停；L1 → 转 `/fix`；L2 → 定位
基线，缺失则先补基线再变更；L3 → 走现有三件套。`/plan` `/tasks` `/implement` `/converge` 保持
不变，只服务 L3。skill 编辑落在 `<configDir>/skills/`，提交时以 `.zcode/skills/` 路径落库。

## 边界与错误路径

- **提交信息里多条 `Flow` trailer**：拒绝（歧义不静默降级），要求只留一条。
- **merge 提交**：不要求档位（`.git/MERGE_HEAD` 存在时跳过）；`--amend` 按普通提交判。
- **声明与改动面矛盾**（如声明 L0 却新增了事件）：钩子只查有限指纹，矛盾由人工评审裁决，钩子
  不猜、不静默放行。
- **缺陷 slug 冲突**：加 `-2` / `-3` 后缀并在文件里引用原 slug，不覆盖既有文件。
- **补基线时发现代码才是错的**：那是缺陷（L1），停下重新定档，不在 L2 里顺手修。
- **L1 写不出会先红的用例**：不落 AC 的笔误级归 L0；其余说明根因尚未定位，评估段继续，不许
  跳过红直接修。
- **`--no-verify`**：git 自带开关，无法根治；目标是让常规路径都有合法出口，绕过成为显式例外。
- **体积上限的存量**：`docs/architecture/contracts.md` 等四份超长文档的拆分另行执行（见非目标），
  上限守卫落地前必须先完成拆分，否则该组必然红。

## 非目标

- 不引入 Spec Kit / OpenSpec 的容器、CLI 与命令文件（只借鉴其流程思想）。
- 不改 L3 的三件套、四态生命周期与三道闸门。
- 不拆 `docs/features/user-stories.md`（753 行）——去向：`TODO.md`。
- 不给缺陷加 severity / 优先级字段。
- 不把归档 spec 提回活动层（编号不复用规则不动）。
- 不触两套 Core 的行为（引擎 / 工具 / 权限 / 事件 / 落盘），无 parity 义务。
- 不做 500 行上限之外的文档体积治理（`docs/architecture/events.md` 的既有棘轮保持）。

## 对需求基线的影响

无新增 US。本改动只改研发流程（闸门、容器、守卫、skill 入口），不改变任何产品用户可见行为；
`docs/features/user-stories.md` 的 US 条目与 e2e 映射均不变。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | [AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)判据表 | — | 无自动覆盖 + 判据是人的判断，机器只能查产物（FR-006 / FR-007） |
| FR-002 | [AGENTS.md 第 5 节](../../AGENTS.md#5-工作流) L0 行 | — | 无自动覆盖 + L0 无产物可查，只有提交信息 trailer 留痕 |
| FR-003 | `specs/defects/<slug>.md`、`specs/README.md` 缺陷规格节、`<configDir>/skills/fix/SKILL.md` | `src/test/docsLint.test.ts` 缺陷规格组 | 自动 |
| FR-004 | `specs/README.md` 补基线与就地修订节、[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流) | — | 无自动覆盖 + 基线落点由人工判断（是否独立成篇） |
| FR-005 | `specs/README.md` 生命周期节（现状保持） | `src/test/docsLint.test.ts` 改动规格结构组 | 自动 |
| FR-006 | `scripts/githooks/commit-msg` | `src/test/gitHookGate.test.ts` | 自动 |
| FR-007 | `src/test/docsLint.test.ts` 新增与扩展组 | `src/test/docsLint.test.ts` 新组本身即断言 | 自动 |
| FR-008 | `<configDir>/skills/fix/SKILL.md`、`<configDir>/skills/spec/SKILL.md` | — | 无自动覆盖 + skill 是指令文本，靠人工按流程走一遍验证 |

## 待澄清

无——判据、容器形状、闸门机制、留痕口径与体积上限在起草阶段已逐条裁决（会话记录见
ADR-0006 的背景节）。

## 收敛记录

- 已满足（逐条对证据）：
  - FR-001 / AC-1 / AC-2：[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)四档判据表（L0 效果不落 AC 且不触契约面 / L1
    应有行为已定义没做到 / L2 应有行为本身要变 / L3 新增能力）与「判不清取较高档、可升不可降」；
    `<configDir>/skills/spec/SKILL.md` 第 1 步定档分支。
  - FR-002 / AC-4 / AC-5：[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流) L0 行（无产物、可新增文件、理由写正文）；钩子对
    L0 只查 trailer——`gitHookGate` 用例「L0 声明放行」+ 真实仓库手工验证「L0 声明 + 代码 → 放行」。
  - FR-003 / AC-6～AC-9：`specs/_templates/defect-report.md`（五节 + 验证记录四列表）；
    `<configDir>/skills/fix/SKILL.md`（两段流程 + 三条硬规则）；docsLint 缺陷规格组经负例实测
    （缺「验证记录」→ 红 4 处；结果取值「大概率绿」→ 红 2 处）；`settledSpec()` 让 `已修` 退出
    存在性豁免。
  - FR-004 / AC-10～AC-12：[specs/README.md 第 9 节](../../specs/README.md#9-需求变更与补基线)（就地修订 + 补基线单独提交 + 落点判据 +
    500 行上限）；[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流) L2 行。
  - FR-005 / AC-3：`AGENTS.md` 判据表 L3 行 + [specs/README.md 第 2 节](../../specs/README.md#2-生命周期)生命周期；三件套与三道
    闸门原样保留（`/plan` `/tasks` `/implement` `/converge` 未改）。
  - FR-006 / AC-13～AC-15：`scripts/githooks/commit-msg`；`src/test/gitHookGate.test.ts` 14 条
    用例全绿（四档放行与拒绝、多条 Flow、未知取值、纯文档提交、merge 豁免）；真实仓库手工 9 例
    与判据表逐行一致。
  - FR-007 / AC-16～AC-19：docsLint 45 组全绿；三组负例实测（缺验证记录 / 非法结果取值 /
    509 行文档 → 各红）；`起草` 只有 spec.md → 绿、`实施中` 缺 plan + tasks → 红 2 处（临时
    探针目录，验证后即删）。
  - FR-008 / AC-20：`<configDir>/skills/spec/SKILL.md` 第 1 步四档分支（L0 停 / L1 转 `/fix` /
    L2 定位基线 / L3 继续）；`/fix` 经 `.zcode/skills` junction 可见。
- 反向对照（从实现 diff 反查 spec 未接的行为）：
  - 正常路径：四档放行 / 拒绝、merge 豁免、纯文档提交放行——均有 AC 承接。
  - 错误路径：无 Flow、多条 Flow、未知取值、L1 缺 trailer、L1 产物不存在、L2 无 docs 改动、
    L3 无规格目录、L3 三件套不齐——除「未知取值」外均有 AC 或边界条目；已补进 FR-006 判据表。
  - 追溯矩阵落点逐个打开验证存在：`scripts/githooks/commit-msg`、
    `src/test/gitHookGate.test.ts`、`src/test/docsLint.test.ts`、`specs/README.md`、
    `docs/adr/0006-tiered-change-workflow.md`、`<configDir>/skills/fix/SKILL.md`、
    `<configDir>/skills/spec/SKILL.md` 全部实存且覆盖所声称内容。
  - 影响基线逐行复核：[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)与[第 5 节](../../AGENTS.md#5-工作流)、[specs/README.md 第 1 节](../../specs/README.md#1-目录约定) / [第 2 节](../../specs/README.md#2-生命周期) / [第 5 节](../../specs/README.md#5-守卫口径docslint)与新增的[第 8 节](../../specs/README.md#8-缺陷规格specsdefects) / [第 9 节](../../specs/README.md#9-需求变更与补基线)、
    `docs/README.md` 分类法、`docs/adr/README.md` 索引、`TODO.md` 均已改；
    `docs/features/user-stories.md` 无变更（无新增 US）——与实际 diff 一致。
  - 契约面复核：事件词汇表 / 契约成员 / wire 消息 / 落盘格式零变化，两套 Core 零改动（无 parity
    义务），无未声明的变更。
- 偏差（改 spec / 留痕）：
  - **trailer 解析机制**：`plan.md` 写的是 `git interpret-trailers --parse`，实现改为**行首锚定**
    解析。理由：`interpret-trailers` 只认末尾连续的 trailer 块，`git commit -m A -m "Flow: L1"
    -m "Defect: x"` 这类多段写法会漏掉中间那段（造成假拒绝）。档位仍是标准 trailer 行，解析口径
    已写进钩子注释。
  - **`Flow` 未知取值**：实现与用例都有（拒绝），spec 原文只写了「无 Flow 行 → 拒绝」；已补进
    FR-006。
  - **品牌字面量**：spec / plan / tasks / ADR 里写 `<configDir>` 的真实目录名触发 `brandLiteral`
    守卫，已按 `docs/hosts/product-identity.md` 的占位符口径改为 `<configDir>`；顺带移除
    `brandLiteral.test.ts` 放行清单里随 `pre-commit` 删除而失效的条目。
  - **超出影响基线描述的两处同口径同步**（收敛时留痕）：[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)的「待办不存史」行补
    「缺陷规格以 status 跟踪」；`docs/README.md` 待办清单行同步同一口径。
- 未做：无——`tasks.md` 20 条全部勾选。
