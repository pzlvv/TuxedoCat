# 实施方案：文档体系重组

技术路线是「先移骨架、再落内容、后清引用」：git mv 建立四子目录骨架并同步全部硬编码
路径 → 把 DEVELOPMENT.md 六章内容按拆解映射落入八篇新文档后删除原文件 → 特性规格
spec 化 → docsLint 重锚与扩展 → 引用全量清剿 → 地图与 ADR 收口 → 全量门禁。中间态
docsLint 必红属预期，最终一次收敛。需求与验收见同目录 [spec.md](spec.md)。

## 技术方案

### 目录骨架（FR-001）

`mkdir docs/architecture docs/core docs/hosts docs/features` 后逐一 `git mv`：contracts、
core-ui-separation 进 architecture/；standalone-core、core-parity、core-daemon、
client-connection 进 core/；host-matrix、webview-ui、webview-facts、tui、
electron-multi-workspace、vscode-idle-close、product-identity 进 hosts/；user-stories、
user-message-pipeline、compaction、abort-button、background-bash、tui-installer 进
features/。子目录不建 README.md（lint 组 4b 只在有 README 时才要求登记）。

### 新文档与拆解映射（FR-002 / FR-003）

| DEVELOPMENT.md 原章节 | 新落点 | 新编号 |
| --- | --- | --- |
| 1.1 架构概述 + 1.2 分层结构 | docs/architecture/overview.md | ## 1 / ## 2 |
| 1.3 目录布局 | docs/architecture/repo-map.md | 全文 |
| 1.4 类图 + 1.5 图注 | docs/architecture/class-diagrams.md | ## 1 / ## 2 / ## 3 |
| `第 2 章` 分层与依赖规则 | docs/architecture/layering.md | 全文 |
| 3.1+3.2 | docs/architecture/events.md | ## 1 总线契约 |
| 4.1/4.2/4.3 + 汇总 | events.md | ## 2（### 2.1/2.2/2.3，列序不变） |
| 3.3+3.6 | events.md | ## 3 两侧订阅 |
| 3.4 / 3.5 / 3.7 / 4.4 | events.md | ## 4 / ## 5 / ## 6 / ## 7 |
| 4.5 sessionRuntime | docs/core/session-runtime.md | 全文 |
| `第 5 章` 11 原则 | docs/architecture/principles.md | ## 1.–## 11.（编号即原尾号） |
| `第 6 章` 待定事项 | docs/architecture/open-questions.md | ## 1 / ## 2 |

原文中的章内自引用（如`第 3.7 节`）改写为跨文档相对链接 + 锚点；正文文字零语义改动。
汇总表收敛为 events.md 一处。

### 特性规格化（FR-004）

五篇统一骨架（用户场景与验收标准 / 功能需求 / 行为规格 / 边界与错误路径 / 非目标 /
对需求基线的影响 / 追溯矩阵）；FR-nnn 从既有散文行为归纳，AC 回指 FR；追溯矩阵复用
既有测试（abortButtonState、abortPhaseParity、compactAgentMode、userMessageQueue、
queuedMessageDiscard、backgroundFallbackReminder、sessionRuntime、corePlatformMatrix
等）；无自动覆盖的 FR 按既有口径带理由。

### docsLint 改造（FR-005）

- 组 1：`readText('DEVELOPMENT.md')` → `docs/architecture/events.md`；汇总表正则对准
  单份表；成员名 corpus 换 events.md；UiRequest 仍查 `docs/core/standalone-core.md`。
- 组 7：棘轮目标改 events.md，上限 = 落地后实际行数。
- 组 11：切片源改 events.md，节锚 `### 4.1`/`### 4.2` → `### 2.1`/`### 2.2`。
- 组 14：sections 改 `[['CoreEvent','### 2.1'],…]` @ events.md。
- 组 4a / 23：docs/ 扫描从顶层改递归（排除各 README.md；archive/ 全局已排除）。
- 新组 24：特性规格结构组（复用组 22 的 FR/AC/矩阵正则与覆盖语义）。
- 组 8/17/18：readText 五处换新路径，内部标题锚点不动。

### 引用清剿（FR-006）

按拆解映射逐类重指向：`第 2 章` → layering.md；`3.x/4.x` → events.md；`4.5` →
session-runtime.md；`5.x` → principles.md；`1.3` → repo-map.md；`1.4/1.5` →
class-diagrams.md；`第 6 章` → open-questions.md。docs 互链换子目录相对路径；
AGENTS.md、specs/README.md、_templates、docs-freshness.mjs、brandLiteral.test.ts、
根 README.md 逐一处理；以 docsLint 组 2/3 为兜底验收。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `DEVELOPMENT.md` | 删除 | 无（事件词汇表语义不变，仅落点变） |
| `docs/*.md` 19 篇 | git mv + 互链改写；features/ 五篇 spec 化 | 无 |
| `docs/` 八篇新文档（architecture/ 七篇 + core/session-runtime） | 新增 | 无 |
| `docs/README.md` | 重写 | 无 |
| `AGENTS.md` | 权威口径与引用重指向 | 无 |
| `src/test/docsLint.test.ts` | 组 1/7/11/14/4a/23 修改 + 新组 24 | 无 |
| `scripts/docs-freshness.mjs` | 扫描改递归、清 DEVELOPMENT.md 假设 | 无 |
| `src/test/brandLiteral.test.ts` | product-identity.md 新路径核查 | 无 |
| `specs/README.md`、`specs/_templates/` | 待澄清去向举例改指 open-questions.md | 无 |
| `docs/adr/` | 新增 0005、索引登记 | 无 |
| 运行时代码（src/core、src/host、electron、core-rs） | 仅注释引用重指向，行为零改动 | 无 |

## 宪章检查

- [x] 分层与依赖（`AGENTS.md 第 1 节`）：core 不 import host 实现、host 不 import 宿主 API、
      不做宿主嗅探——不涉及代码分层，运行时零改动；注释引用重指向不触碰 import 边界。
- [x] 架构铁律（`AGENTS.md 第 4 节`）：不过度 fallback、契约成员全必选、一份事实一个
      写入点、默认值单源——不涉及；文档层面「同一事实只写一处」由汇总表收敛与互链改写落实。
- [x] 两套 Core parity 义务（`AGENTS.md 第 5 节`）：涉及任一侧 Core 行为必须同步另一侧、
      对照表与两侧测试——Core 行为零改动，仅两侧注释引用同步重指向，parity 对照表内容不变。
- [x] 文档同步义务（`AGENTS.md 第 0 节`）：受影响规格清单与同步时机——本 spec 即文档同步
      本体；docs/README.md 地图、ADR 索引、AGENTS.md 在 T7 一并收口，docsLint 全绿为闸门。

## 被否决的替代方案

- **保留薄总纲（DEVELOPMENT.md 缩到 ~230 行）**：总纲与子目录规格并存仍留两套入口，
  「架构细节以谁为准」存在二义；评审裁决为拆解散尽。
- **specs/ 常驻容器装存量特性**：违反 ADR-0004 生命周期（specs/ 收敛后归档、编号不复用），
  改动规格与现状规格混在同一命名空间；否决，as-built 特性规格落 docs/features/。
- **只重排不改写**：目录整齐但特性文档仍是散文形态，无场景 / FR / AC / 追溯结构，
  SPEC 化诉求不落地；否决。
- **事件词汇表留在根目录新文件（如 EVENTS.md）**：与 docs/ 唯一索引冲突，多一个根入口；
  否决，落 docs/architecture/events.md。
