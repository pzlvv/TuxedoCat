---
status: 已收敛
---

# 改动规格：文档体系重组——DEVELOPMENT.md 拆解散尽、docs/ 目录结构化与特性规格层

DEVELOPMENT.md（1236 行，已顶到体积棘轮）承载了架构总览、总线契约、事件词汇表、
架构原则与待定事项五类主题，检索困难且无法继续扩充。本改动把该文件**整体拆解散尽**
（文件删除），内容按主题分散到重组后的 `docs/` 四个子目录（architecture / core /
hosts / features）；存量特性文档改写为 spec 形态（用户场景 / FR / AC / 追溯矩阵）的
as-built 特性规格；docsLint 重锚事件表校验、递归扩展 frontmatter 与地图覆盖、新增
特性规格结构组；全仓约 98 处 `DEVELOPMENT.md 第 N 节` 引用与 docs 互链同步重指向。
specs/ 的改动规格生命周期（ADR-0004）语义不变。决策背景见 ADR-0005。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| `DEVELOPMENT.md` | 全文 | 删除 | 六章全部迁入 docs/ 四子目录，文件用 git rm 删除 |
| `docs/README.md` | 分类法、地图 | 修改 | 「架构总纲」行删除，新增「架构规格」「特性规格」行；地图按子目录归置 |
| `docs/architecture/contracts.md` 等 19 篇 | 全文 | 移动 | git mv 进 architecture / core / hosts / features；互链改写外内容不动，features/ 五篇的 spec 化改写见 FR-004 |
| `docs/adr/README.md` | ADR 索引 | 修改 | 登记 ADR-0005 |
| `AGENTS.md` | `第 0 节` 等 | 修改 | 权威口径从 DEVELOPMENT.md 改为 docs/ 规格；引用重指向 |
| `src/test/docsLint.test.ts` | 组 1/7/11/14/4a/23 | 修改 | 重锚与递归扩展；新增特性规格结构组 |
| `docs/features/user-stories.md` | — | 无内容变更 | 仅移动进 features/；e2e 映射不变 |
| [docs/core/standalone-core.md](../../docs/core/standalone-core.md) | 全文 | 移动 | 移入 core/；内容不动 |

## 用户场景与验收标准

- 场景 1：仓库文档结构
  - **AC-1**（FR-001）：GIVEN 重组完成 WHEN 查看 docs/ THEN 顶层只剩 README.md，其余规格分布于 architecture / core / hosts / features 四个子目录，git 历史经 git mv 保留
  - **AC-2**（FR-002）：GIVEN 重组完成 WHEN 查看仓库根 THEN 无 DEVELOPMENT.md，原六章内容在八篇新文档中各有唯一落点，无内容丢失
- 场景 2：事件词汇表与 lint 守卫
  - **AC-3**（FR-003）：GIVEN docs/architecture/events.md WHEN 运行 docs-lint THEN 事件词汇表、触发点、载荷三组校验对照 src/core/AssistantEventBus.ts 全绿，事件表列序与原`第 4.1 节`一致
  - **AC-4**（FR-005）：GIVEN docs/ 子目录中的任意规格 WHEN 运行 docs-lint THEN frontmatter 组与地图覆盖组递归覆盖全部文件，漏登或缺字段即红
- 场景 3：特性规格
  - **AC-5**（FR-004）：GIVEN features/ 的五篇特性规格 WHEN 运行 docs-lint THEN 特性规格结构组逐篇校验用户场景 / FR / AC / 追溯矩阵通过
- 场景 4：引用完整性
  - **AC-6**（FR-006）：GIVEN 全仓 WHEN 检索 DEVELOPMENT.md 字面量 THEN 活文档（docs/ 除 archive）、specs/、代码注释零残留，docsLint 章节引用组全绿
  - **AC-7**（FR-007）：GIVEN docs/README.md WHEN 查分类法与地图 THEN 含架构规格与特性规格行、四个子目录全部登记；ADR-0005 存在且记录被否决方案；AGENTS.md 权威口径指向 docs/ 规格
- 场景 5：门禁
  - **AC-8**（FR-005）：GIVEN 全仓 WHEN 运行 check-types、lint 与 test:all THEN 全绿（docsLint 含新特性规格结构组）

## 功能需求

### FR-001：docs/ 四域子目录结构

docs/ 重组为四个子目录：`architecture/`（总纲类规格：overview / layering / contracts /
core-ui-separation / events / principles / repo-map / class-diagrams / open-questions）、
`core/`（Core 实现与
进程模型：standalone-core / core-parity / core-daemon / client-connection /
session-runtime）、`hosts/`（宿主与 UI：host-matrix / webview-ui / webview-facts / tui /
electron-multi-workspace / vscode-idle-close / product-identity）、`features/`（特性规格
与需求基线：user-stories / user-message-pipeline / compaction / abort-button /
background-bash / tui-installer）。存量文档一律 git mv 保历史；子目录不建 README.md，
docs/README.md 仍是唯一索引；docs/archive/ 与 docs/adr/ 不动。

### FR-002：DEVELOPMENT.md 拆解散尽

DEVELOPMENT.md 六章全部迁出、文件删除：1.1+1.2 → architecture/overview.md；1.3 →
repo-map.md；1.4+1.5 → class-diagrams.md；`第 2 章` → layering.md；`第 3 章` + `第 4 章`
`4.1–4.4` → events.md；`4.5` → core/session-runtime.md；`第 5 章` → principles.md（每原则一节，
编号即原尾号）；`第 6 章` → open-questions.md。头部声明与「章节编号对应」告示并入
docs/README.md 写作规则段。事件表汇总表收敛为 events.md 一处。

### FR-003：事件词汇表规格

docs/architecture/events.md 承载总线契约与四组事件词汇表：## 1 总线契约（原 3.1+3.2）、
## 2 事件词汇表（### 2.1 CoreEvent / ### 2.2 CoreRequest / ### 2.3 UiEvent，表列序
`# | type | 载荷 | 触发点 | …` 与原 4.1 一致）、## 3 两侧订阅（原 3.3+3.6）、
## 4 命名约定（原 3.4）、## 5 全局注册与 bootstrap 顺序（原 3.5，接线项明细与
docs/hosts/host-matrix.md 去重）、## 6 边界语义（原 3.7）、## 7 新增事件检查清单（原 4.4）。
内容与 src/core/AssistantEventBus.ts 的对照关系由 docsLint 校验，语义零变化。

### FR-004：as-built 特性规格层

docs/features/ 下五篇特性规格（user-message-pipeline / compaction / abort-button /
background-bash / tui-installer）改写为统一 spec 形态，七节骨架依次为：用户场景与验收
标准（AC 一行式 GIVEN/WHEN/THEN 回指 FR）、功能需求（FR-nnn 逐条）、行为规格
（原散文 as-built 细节）、边界与错误路径、非目标、对需求基线的影响、追溯矩阵
（逐 FR 一行：实现落点 / 测试落点 / 覆盖）。frontmatter 用 owner +
last_reviewed（非改动规格的 status）；追溯矩阵落点复用既有行为锁测试；US-xx 关联沿用
user-stories.md 基线。

### FR-005：docsLint 重锚与扩展

组 1（事件词汇表）、组 11（触发点）、组 14（载荷列）的切片源从 DEVELOPMENT.md 改为
docs/architecture/events.md（节锚 2.1/2.2/2.3）；组 7 体积棘轮目标改为 events.md；
组 4a（地图覆盖）与组 23（frontmatter）从 docs/ 顶层扩展为递归扫描（仍排除各 README.md
与 archive/）；新增组 24 特性规格结构组（features/ 五篇必填 H2、FR 唯一、AC 一行式回指
FR 且含 GIVEN/WHEN/THEN、追溯矩阵逐 FR 一行与覆盖语义，复用 specs 结构组正则）；组
8/17/18 的 readText 路径换新落点。docsLint 内 DEVELOPMENT.md 字面量清零。

### FR-006：引用全量重指向

全仓约 98 处引用按拆解映射重指向：代码注释 30+ 处（src/、electron/、core-rs/）与 docs
互链、AGENTS.md 各节、specs/README.md 与 _templates、scripts/docs-freshness.mjs（扫描
改递归）、src/test/brandLiteral.test.ts、根 README.md。分层规则引用 → layering.md、
总线与事件引用 → events.md、原则引用 → principles.md、待定事项引用 →
open-questions.md；活文档与代码注释零 DEVELOPMENT.md 残留。

### FR-007：文档地图、权威口径与决策记录

docs/README.md 重写：分类法删「架构总纲」行、新增「架构规格」（architecture/）与
「特性规格」（features/）行、地图按四个子目录归置并登记全部新文档；AGENTS.md 开头权威
口径改为「架构细节一律以 docs/ 各 as-built 规格为准」；docs/adr/0005 记录本次决策
（含被否决的替代方案：保留薄总纲 / specs/ 常驻容器 / 只重排不改写）。

## 边界与错误路径

- git mv 期间 docsLint 中间态红属预期：按任务顺序一次收敛，最终门禁全绿才算完成。
- docs/archive/ 冻结不扫不引；specs/ 编号 002 与已归档 001 查重不冲突。
- 事件表列序保持不变，仅换文件与节锚点；docsLint 改动限于定位锚，不改对照逻辑。
- 移动文档的既有内部标题（如 contracts.md `## 2. Spin`、webview-ui.md `## 4. 对外方法`、
  user-stories.md `## 附录`）不改，组 8/17/18 只换路径。
- spec 模板里「待澄清去向」的举例链接指向 open-questions.md，不留死链。

## 非目标

- 不改任何运行时代码行为（只动文档、注释、docsLint 与脚本；Core 行为零改动）。
- 不改 specs/ 生命周期语义（不引入常驻规格容器，specs/ 仍只装未落地改动）。
- 不为 docs/ 子目录建 README.md（地图唯一索引）。
- docs/archive/ 内容冻结，不参与重组与重扫。
- 不做文档站渲染。

## 对需求基线的影响

无新增 US：文档体系类改动，不产生产品用户故事；docs/features/user-stories.md 与 e2e
映射（组 18）不变。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `docs/` 四子目录与 git mv 落点 | `src/test/docsLint.test.ts`（地图覆盖组、frontmatter 组、章节引用组） | 自动 |
| FR-002 | `docs/architecture/` 八篇文档、`DEVELOPMENT.md` 删除 | `src/test/docsLint.test.ts`（章节引用组逐锚点校验） | 自动 |
| FR-003 | `docs/architecture/events.md` | `src/test/docsLint.test.ts`（事件词汇表组、触发点组、载荷列组） | 自动 |
| FR-004 | `docs/features/` 五篇特性规格 | `src/test/docsLint.test.ts`（特性规格结构组） | 自动 |
| FR-005 | `src/test/docsLint.test.ts` | `src/test/docsLint.test.ts`（本文件即测试） | 自动 |
| FR-006 | 全仓引用重指向（注释、docs、AGENTS.md、specs、脚本） | `src/test/docsLint.test.ts`（章节引用组、行内代码路径组、常量组） | 自动 |
| FR-007 | `docs/README.md`、`AGENTS.md`、`docs/adr/0005-*.md` | `src/test/docsLint.test.ts`（地图覆盖组、ADR 完整性组） | 自动 |

## 待澄清

无——落法分歧（特性规格放哪、套多细、DEVELOPMENT.md 保留多少）已在评审阶段裁决并落入
ADR-0005 的被否决方案。

## 收敛记录

- 已满足：
  - FR-001 容器：docs/ 四子目录实存，19 篇存量文档 git mv 全部为 rename（git status R），子目录无 README；地图覆盖组与 frontmatter 组递归绿。
  - FR-002 拆解：DEVELOPMENT.md 已 git rm，六章在八篇新文档各有唯一落点；章节引用组全绿（锚点逐个校验）。
  - FR-003 事件词汇表：events.md 第 2 节汇总表 + 2.1/2.2/2.3 三张表，列序与原 4.1 一致；词汇表 / 2.1 触发点 / 载荷列三组对照 src/core/AssistantEventBus.ts 全绿。
  - FR-004 特性规格：features/ 五篇均为七节骨架 + FR/AC/追溯矩阵；特性规格结构组（组 24）全绿。
  - FR-005 docsLint：组 1/11/14 切片源改 events.md（节锚 2.1/2.2/2.3）、组 7 棘轮 1237→434（events.md）、组 4a/23 递归、新组 24、组 8/17/18 换路径；docsLint 42 组全绿（2026-10-11）。
  - FR-006 引用：三遍脚本 + 人工修复共约 486 处重指向（259 文件）；src/ electron/ core-rs/ tui-rs/ scripts/ e2e/ 与 docs/ 活文档 DEVELOPMENT.md 字面量清零。
  - FR-007 地图与口径：docs/README.md 重写（分类法 + 四子目录地图）、AGENTS.md 权威口径改 docs/ 规格、ADR-0005 与索引登记。
  - 门禁：check-types / lint / build:core:host / test:all（121 项，coreEventParity 真实运行）/ test:core（812 项）/ docs:freshness 报告全部通过。
- 偏差：两处实施中的必要调整——①组 4a/23 递归扫描额外豁免 docs/adr/（ADR 用「状态：」行而非 frontmatter，索引由组 5 与地图 4b 覆盖）；②组 3 的 QUALIFIED_REF 文件名正则从单段路径扩为多段（docs/core/x.md 须整体匹配），裸文件名 fallback 扩四子目录。均已注释留痕。
- 未做：无——tasks.md 八条全部完成。
