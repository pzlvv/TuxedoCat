# 实施方案：改动分级流程（L0 直改 / L1 缺陷修复 / L2 需求变更 / L3 新特性）

技术路线：闸门从 `pre-commit` 搬到 `commit-msg`（`pre-commit` 阶段读不到提交信息，实测
`.git/COMMIT_EDITMSG` 尚不存在），档位由提交信息的标准 trailer 声明、由产物兜底；L1 用新的
扁平容器 `specs/defects/<slug>.md`，三件套里的缺陷形态随之下线；docsLint 相应扩四组守卫。
零 Core 改动、零契约改动——本方案只动钩子、测试守卫、skill 与文档。需求见同目录
`spec.md`。

## 技术方案

### 1. 闸门：`pre-commit` → `commit-msg`

新增 `scripts/githooks/commit-msg`（POSIX sh，与既有钩子同风格），`$1` 是消息文件：

```text
git interpret-trailers --parse < 消息文件   → 取 Flow / Spec / Defect
存在 .git/MERGE_HEAD                       → 直接放行（merge 提交豁免）
暂存区不含 ^(src|electron|e2e|core-rs|tui-rs|installer-rs)/ → 放行
Flow 缺失                                  → 拒绝（提示写档位或开规格）
Flow 出现多条                              → 拒绝（歧义不静默降级，铁律 1）
Flow: L0                                   → 放行
Flow: L1  + Defect: <slug>                 → 查 specs/defects/<slug>.md 存在
Flow: L2                                   → 查暂存区含 docs/**/*.md 改动
Flow: L3  + Spec: <NNN>                    → 查 specs/<NNN>-<slug>/ 三件套齐全
其它取值                                   → 拒绝（不猜、不降级）
```

删除 `scripts/githooks/pre-commit`：现内容只有旧闸门、无其它职责，git-lfs 不占用该钩子
（它只用 post-checkout / post-commit / post-merge / pre-push）。

### 2. 缺陷容器 `specs/defects/`

- 新增 `specs/_templates/defect-report.md`：frontmatter `status: 待修`，五节——现状 / 期望 /
  不变量 / 回归测试（RT-nnn 条目）/ 验证记录（四列表：检查 / 命令 / 结果 / 备注）。
- 删除 `specs/_templates/defect.md`：三件套里的缺陷形态随 L1 独立容器废弃；归档
  `docs/archive/specs/009-*/defect.md` 不受影响（`docs/archive/` 不参与校验）。
- 缺陷文件不进编号体系，`specs/defects/` 不参与编号查重。

### 3. docsLint 守卫（`src/test/docsLint.test.ts`）

| 组 | 改动 |
| --- | --- |
| 22 | **改动规格目录按 status 递进**：`起草` 只要 spec.md；`待评审` 要 spec.md + plan.md；`实施中` / `已收敛` 要三件套（现状是任何 status 都要三件套，起草期必然红） |
| 22 | **新增缺陷文件校验**：slug 格式、H1 `# 缺陷：`、status ∈ 待修 / 已修 / 已放弃、五节齐全、RT 编号、验证记录表四列且结果取值 ∈ 红 / 绿 / skipped / not-run / 部分验证 |
| 22 | 移除 `specs/<NNN>/defect.md` 分支（H1 前缀与 DEFECT_SECTIONS）——该形态随 L1 独立容器下线 |
| 25 | `convergedSpec()` 扩成 `settledSpec()`：`specs/<NNN>-<slug>/(spec\|defect).md` 的 `已收敛` 与 `specs/defects/<slug>.md` 的 `已修` 都退出 `FUTURE_WORK_DOC` 豁免（落点存活检查生效） |
| 新 | **文档体积上限 500 行**：范围为 docsLint 已扫描的 docs（天然排除 `docs/archive/` 冻结档案与 `tmp_*`）；豁免 `docs/features/user-stories.md`（需求基线）与各级 `README.md`（地图 / 导读） |

文件头的守卫清单注释同步（它自身是文档，清单与实际组必须一致）。

### 4. skill

- 新增 `<configDir>/skills/fix/SKILL.md`：两段产出即停（评估 + 红 → 修复 + 绿）、三条硬规则
  （评估段禁改源码 / 不许改「现状·期望」/ 验证段禁改源码且不许自证清白）、产物路径与
  slug 规则。`.zcode/skills` 是指向 `<configDir>/skills` 的 junction，新目录自动可见。
- 改 `<configDir>/skills/spec/SKILL.md`：第 1 步插入定档分支（L0 停、L1 转 `/fix`、L2 定位
  基线 / 缺失先补基线、L3 走三件套）。
- `/plan` `/tasks` `/implement` `/converge` 不动，只服务 L3。

### 5. 文档

见下表。落地顺序：文档拆分（另行执行中）先落地 → 钩子与守卫同批改 → 文档同批同步 →
`npm run test:all -- docs-lint` 绿。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `scripts/githooks/commit-msg` | 新增 | 无 |
| `scripts/githooks/pre-commit` | 删除 | 无 |
| `specs/defects/` | 新增（目录；模板另见） | 无 |
| `specs/_templates/defect-report.md` | 新增 | 无 |
| `specs/_templates/defect.md` | 删除 | 无 |
| `src/test/docsLint.test.ts` | 修改（组 22 分档 + 缺陷校验、组 25 扩 `settledSpec`、新增体积组） | 无 |
| `src/test/gitHookGate.test.ts` | 新增（临时仓库跑四类提交，断言放行 / 拒绝） | 无 |
| `<configDir>/skills/fix/SKILL.md` | 新增 | 无 |
| `<configDir>/skills/spec/SKILL.md` | 修改（定档分支） | 无 |
| `AGENTS.md` | 修改（[第 0 节](../../AGENTS.md#0-文档要求)例外口径、[第 5 节](../../AGENTS.md#5-工作流)分档闸门） | 无 |
| `specs/README.md` | 修改（[第 1 节](../../specs/README.md#1-目录约定)、[第 2 节](../../specs/README.md#2-生命周期)、[第 5 节](../../specs/README.md#5-守卫口径docslint)，新增缺陷规格与 L2 两节） | 无 |
| `docs/README.md` | 修改（分类法加缺陷规格行、补 500 行上限口径） | 无 |
| `docs/adr/0006-tiered-change-workflow.md` | 新增 | 无 |
| `docs/adr/README.md` | 修改（索引登记 ADR-0006） | 无 |
| `TODO.md` | 修改（登记 `user-stories.md` 753 行的拆分） | 无 |

事件词汇表、契约成员、wire 消息、落盘格式零变化；两套 Core（`src/core/` 与 `core-rs/`）
零改动，parity 对照表不涉及。

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：不涉及——改动只在
      钩子、测试守卫、skill 与文档，不新增 core↔host 依赖、不碰宿主嗅探。守卫代码在
      `src/test/`，本来就不受分层规则约束（它不 import 任何生产模块）。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：
      **不过度 fallback**——未知 `Flow` 取值、多条 `Flow`、产物缺失一律拒绝，不静默放行；
      **契约成员全必选**——无契约变化；
      **一份事实一个写入点**——档位由产物决定（L1 / L2 / L3），只有无产物的 L0 需要提交信息
      声明；不引入工作区档位文件（并行会话会互相踩，这是否决方案之一）；
      **默认值单源**——不涉及。
- [x] 两套 Core parity 义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：**不涉及**——零 Core
      行为改动（引擎 / 工具 / 技能 / 权限 / 提示词 / 落盘 / 事件均不动），因此无对照表与两侧
      测试义务。本改动也不新增 `CoreEvent` / `UiEvent`。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：受影响规格与时机见
      「受影响模块与契约」表；完成判据是 `npm run test:all -- docs-lint` 全绿，其中章节引用组
      会校验 AGENTS.md / specs/README.md / docs/README.md 的新章节锚点。

## 被否决的替代方案

1. **整包引入 GitHub Spec Kit**（`uv tool install specify-cli` + `specify init` + `/speckit.*`
   命令）——否决：与本仓 `specs/<NNN>-<slug>/` 撞车（本仓命名正来自它，ADR-0004）；英文模板
   与 H1 / 章节名不进 docsLint；`.specify/memory/constitution.md` 与 AGENTS.md 铁律重复；
   `.specify/feature.json` 是全局活动状态，并行会话互踩；其 SDD 主干被同行（OpenSpec）评价为
   heavyweight，与"给轻改动减负"相反。**只借鉴**其 bug 扩展的 assess → fix → test 三段与三条
   硬规则。
2. **档位标记文件**（`<configDir>/flow` 之类，钩子读它）——否决：全局可变状态，本仓有并行
   会话（`5938ed2` 提交信息里明写"工作区里其它会话并行改的…"），必然互相踩。
3. **靠 `fix:` / `feat:` 前缀推断档位**——否决：实测最近 60 个提交里 `fix:` 32 个、大量是纯
   UI 调整，前缀与改动性质已脱钩。
4. **闸门降级为软提醒（只警告不拦）**——否决：等于回到没有闸门；现行闸门本来就是为"AI 不
   遵守流程"加的（提交 `8f18444`）。
5. **L2 从 `docs/archive/specs/` 提回原编号修订**——否决：破"编号不复用"与 `docs/archive/`
   的冻结语义；且 49 条 US 里只有 9 次改动有归档 spec，适用面太窄。
6. **L2 写 delta 文档**（OpenSpec 形态）——否决：信息与 `git diff` 重复，多一层容器与归档
   动作；本仓的 `docs/` 就是 source of truth，就地改即可。
7. **L1 沿用三件套里的 `defect.md` 形态**——否决：缺陷不需要 plan / tasks 与三道闸门，
   三件套是给 L3 的；Spec Kit 的缺陷轨道也独立于 feature 流程。
8. **给缺陷加 severity 字段**——否决：本仓无优先级需求，为抄而抄是维护负担。

够分量的决策（四档判据、闸门位置、L1 容器形状、L2 补基线口径）进
`docs/adr/0006-tiered-change-workflow.md`（编号递增，ADR-0004 的 `specs/` 容器决策保持有效，
不取代）。
