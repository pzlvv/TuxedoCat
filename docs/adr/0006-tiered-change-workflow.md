# ADR-0006：改动分级流程（L0 直改 / L1 缺陷修复 / L2 需求变更 / L3 新特性）

- 状态：已采纳
- 日期：2026-10
- 规格：`specs/010-tiered-change-workflow/`（改动规格）
- 相关：[ADR-0004](0004-spec-driven-change-workflow.md)（`specs/` 容器与生命周期）保持有效，
  本决策只把「什么改动需要走那套容器」按性质分档

## 背景

ADR-0004 建立的改动规格层按「改了哪个路径」设闸门：`scripts/githooks/` 下的 `pre-commit`
钩子只要看到暂存区命中 `src|electron|e2e|core-rs|tui-rs|installer-rs`，就要求 `specs/` 下
存在改动规格目录，否则拒绝提交；唯一出口是 `git commit --no-verify`。它没有区分改动性质，于是：

- 改一个菜单边框与新增一个事件受同一套三件套约束，成本与改动规模不成比例；
- 轻量流程事实上已经存在——它就是 `--no-verify`，但没有判据、没有留痕、没有边界：最近 60 个
  提交里 16 个在提交信息里显式写明「豁免」，其中包含 `4661857` 这类同时改动两侧 Core 权限策略
  与 parity 对照表的 feat 改动；
- `fix:` 前缀与改动性质已经脱钩（最近 60 个提交里 32 个 `fix:`，大量是纯 UI 调整），靠前缀
  推断档位不可行；
- 需求变更没有落点：spec 收敛即归档、`docs/archive/` 冻结，而 49 条 US 里只有 9 次改动留有
  归档规格，绝大多数需求变更只能新开 spec 或直接改 `docs/` 而无人对照。

外部实践给出的对应参照：Amazon 的单向门 / 双向门（可逆性决定流程重量）、GitHub Spec Kit 的
缺陷修复轨道（assess → fix → test，与 feature 流程并列而非其子集）、Kiro 的缺陷分档判据
（根因不明 / 关键路径 / 复发才写规格）、OpenSpec 的「零 delta 必须显式豁免」与 delta 就地合并。

## 决策

**按改动性质分四档，档位由产物决定、由提交信息声明。**

| 档 | 判据 | 产物 |
| --- | --- | --- |
| L0 直改 | 可观察效果不落任何 US / FR 的验收标准，且不触契约面（事件类型、载荷字段、契约成员、wire 消息、落盘字段） | 无 |
| L1 缺陷修复 | 代码与 as-built 规格 / 契约不一致——应有行为已定义，只是没做到 | `specs/defects/<slug>.md` |
| L2 需求变更 | as-built 规格定义的应有行为本身要变 | 就地修订 `docs/` 基线 + 代码 + 测试 |
| L3 新特性 | 新增 US / FR / 事件 / 契约成员 / 面板 / 宿主 / 文件格式 | `specs/<NNN>-<slug>/` 三件套 |

配套决定：

- **判据是正面标准，不列负例清单**；判不清取较高档；档位可升不可降。L0 允许新增文件——判据
  只看效果，不看文件数。
- **闸门从 `pre-commit` 移到 `commit-msg`**：git 跑 `pre-commit` 时提交信息尚未生成
  （`.git/COMMIT_EDITMSG` 不存在），只有 `commit-msg` 拿得到消息文件。档位用标准 trailer 声明
  （`Flow: L0|L1|L2|L3`，配 `Spec: <NNN>` / `Defect: <slug>`），钩子按档查产物：L1 查缺陷文件、
  L2 查暂存区是否含 `docs/` 规格改动、L3 查三件套。merge 提交与纯文档提交不要求档位；未知取值
  与多条 `Flow` 一律拒绝（歧义不静默降级）。
- **L1 用独立容器**：`specs/defects/<slug>.md` 扁平单文件，文件名即 slug，不编号、不归档、不写
  plan / tasks、不设 severity。流程两段（评估 + 红 → 修复 + 绿），三条硬规则：评估段禁止改源码；
  修复段不许改「现状 / 期望」（它是契约）；验证段禁止改源码且不许自证清白（复现路径没真跑过
  只能记「部分验证」）。三件套里的 `defect.md` 形态随之下线。
- **L2 就地修订，基线缺失先补基线**：不新增 spec、不写 delta 文档。补基线＝读代码把现状写成
  as-built 规格（只补本次涉及的行为），单独一个提交，再基于它变更；`docs/archive/specs/` 的
  归档件只作参考，不在其上改（编号不复用与冻结语义不动）。
- **文档体积上限 500 行**（`docs/**/*.md`，`user-stories.md` 与各级 `README.md` 豁免）：
  「不要有巨型规格」的可执行形态，超限即拆。

## 替代方案（被否决）

- **整包引入 GitHub Spec Kit**（`uv tool install specify-cli` + `specify init` + `/speckit.*`）：
  与本仓 `specs/<NNN>-<slug>/` 撞车（本仓命名正来自它）；英文模板与 H1 / 章节名不进 docsLint；
  `.specify/memory/constitution.md` 与 AGENTS.md 铁律重复；`.specify/feature.json` 是全局活动
  状态，并行会话互踩；其 SDD 主干被同行评价为 heavyweight。只借鉴 bug 扩展的三段与三条硬规则。
- **档位标记文件**（`<configDir>/flow` 之类）：全局可变状态，本仓有并行会话，必然互相踩。
- **靠 `fix:` / `feat:` 前缀推断档位**：前缀与改动性质已脱钩（数据见背景）。
- **闸门降级为软提醒**：等于回到没有闸门；现行闸门本来就是为「AI 不遵守流程」加的。
- **L2 从 `docs/archive/specs/` 提回原编号修订**：破「编号不复用」与冻结语义，且适用面只有 9 次
  改动。
- **L2 写 delta 文档**（OpenSpec 形态）：信息与 `git diff` 重复，多一层容器与归档动作。
- **L1 沿用三件套里的 `defect.md` 形态**：缺陷不需要 plan / tasks 与三道闸门。
- **给缺陷加 severity 字段**：本仓无优先级需求，为抄而抄是维护负担。
