---
status: 实施中
---

# 改动规格：Overlay 对话的文件资源管理器视图

「Overlay 对话」（此前叫「对话隔离视图」）的改动只落本对话私有的叠加视图，磁盘是唯一基线。
侧栏的文件资源管理器此前始终列磁盘，Overlay 对话里看到的树因此与工具 / Bash 看到的不一致：
新建的文件不出现、删掉的文件还在、改过的内容显示旧值。

本规格让文件资源管理器在活动对话是 Overlay 对话时列**该对话的叠加视图**，并在标题上注明。
同时把用户可见措辞统一成「Overlay 对话」。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/core/conversation-work-view.md](../../docs/core/conversation-work-view.md) | [第 1 节](../../docs/core/conversation-work-view.md#1-能力) | 修改 | 新增「按会话列视图目录」的请求与应答形态 |
| [docs/core/conversation-work-view.md](../../docs/core/conversation-work-view.md) | [第 2 节](../../docs/core/conversation-work-view.md#2-归属) | 修改 | 用户可见措辞统一为「Overlay 对话」 |
| [docs/core/standalone-core.md](../../docs/core/standalone-core.md) | [第 4 节](../../docs/core/standalone-core.md#4-契约) | 修改 | `UiRequest` 增 `workViewFilesRequested` |
| [docs/hosts/electron-multi-workspace.md](../../docs/hosts/electron-multi-workspace.md) | [第 9 节](../../docs/hosts/electron-multi-workspace.md#9-侧栏) | 修改 | 文件资源管理器的取数来源随活动对话的归属切换 |

## 用户场景与验收标准

- 场景 1：在 Overlay 对话里看文件树
  - **AC-1**（FR-001）：GIVEN 活动对话是 Overlay 对话 WHEN 查看文件资源管理器 THEN 标题显示「文件资源管理器 (overlay)」，树内容来自该对话的叠加视图
  - **AC-2**（FR-001）：GIVEN 活动对话是普通对话 WHEN 查看文件资源管理器 THEN 标题是「文件资源管理器」，树内容来自磁盘
  - **AC-3**（FR-002）：GIVEN Overlay 对话在对话内新建了 `a.txt` WHEN 展开文件资源管理器 THEN `a.txt` 出现且磁盘上不存在该文件
  - **AC-4**（FR-002）：GIVEN Overlay 对话删除了磁盘上已有的 `f.txt` WHEN 展开文件资源管理器 THEN `f.txt` 不出现且磁盘上的文件仍在
- 场景 2：在 Overlay 对话里打开文件
  - **AC-5**（FR-003）：GIVEN Overlay 对话修改了 `f.txt` WHEN 在文件资源管理器里打开它 THEN 显示对话内的新内容
  - **AC-6**（FR-003）：GIVEN Overlay 对话在对话内新建了 `a.txt` WHEN 在文件资源管理器里打开它 THEN 能打开并显示内容
- 场景 3：视图未建立与切换
  - **AC-7**（FR-004）：GIVEN 活动对话是 Overlay 对话但视图尚未建立 WHEN 查看文件资源管理器 THEN 显示磁盘基线且标题仍注明 overlay
  - **AC-8**（FR-005）：GIVEN 从普通对话切到 Overlay 对话 WHEN 切换完成 THEN 文件资源管理器按新来源重读，不复用另一来源的缓存
- 场景 4：失败路径
  - **AC-9**（FR-006）：GIVEN Core 不可用或请求失败 WHEN 查看文件资源管理器 THEN 显示错误文案且不回退成磁盘内容

## 功能需求

### FR-001：标题标注与措辞

文件资源管理器的分区标题在活动对话是 Overlay 对话时显示「文件资源管理器 (overlay)」，
否则显示「文件资源管理器」。用户可见措辞统一为「Overlay 对话」（英文 `Overlay conversation`）：
会话列表标记的 tooltip、新建对话的勾选框、能力不可用时的说明。

### FR-002：树内容来自活动对话的视图

文件资源管理器的目录列举在活动对话是 Overlay 对话时取自该对话的叠加视图（磁盘基线 +
本对话改动），否则取自磁盘。两者对同一路径的呈现必须一致：`kind` / 名称排序 / `mtimeMs`
同一份口径，渲染层不区分来源。

宿主不直接读 Core 的磁盘数据，且 Core 的视图挂载在它私有的挂载命名空间里——宿主进程看不到
那个挂载（实测：Core 侧 `/proc/self/mountinfo` 有该挂载、宿主侧没有，宿主读挂载点是空目录）。
因此列目录经 Core 新增的 `UiRequest.workViewFilesRequested`。

### FR-003：打开文件读视图内容

从文件资源管理器打开 Overlay 对话里的文件时，编辑器显示视图内容而不是磁盘内容。磁盘上没有
的文件（对话内新建）也能打开。编辑器标签仍以真实工作区路径标识，与工具输出的口径一致。

### FR-004：视图未建立时回基线

视图是惰性建立的（第一次工具调用才挂载）。尚未建立时列磁盘基线并照常标注 overlay——这与
工具的降级口径一致（工具此时也操作磁盘）。

### FR-005：跟随活动对话

取数来源由活动对话的归属决定，随活动对话切换。切换后整树按新来源重读，不复用另一来源的
缓存。

### FR-006：失败明确

请求失败（Core 不可用 / 会话已关闭）时显示错误文案，不回退成磁盘内容——那会把两个事实混成
一个（[docs/architecture/principles.md 第 1 节](../../docs/architecture/principles.md#1-不过度-fallback)）。

## 边界与错误路径

| 情形 | 预期 |
| --- | --- |
| 非 Overlay 对话 | 完全走既有磁盘通道，行为不变 |
| Overlay 对话 + 视图未建立 | 列磁盘基线，标题仍注明 overlay |
| 远程（SSH）工作区 + Overlay 对话 | Core 在远端、视图也在远端；列目录经同一请求 |
| Windows Core | 能力恒回不可用，不存在 Overlay 对话，本规格全部路径都不进入 |
| Core 不可用 | 显示错误文案，不回退磁盘 |
| 会话在列举过程中被删除 | 该次请求报错，渲染层显示错误 |
| `dir` 越界（`..` / 绝对路径） | 拒绝，返回错误而不是列根目录 |

## 非目标

- 不在文件资源管理器里写入 / 删除 Overlay 对话的文件：改动仍只经工具与 Bash 产生。
- 不做「overlay 与磁盘」并排对比视图。
- 不改视图的生命周期与回收语义。
- 不改变更清单（`mode: 'changes'`）的取数口径。

## 对需求基线的影响

无新增 US 条目：本改动扩展现有侧栏文件浏览器的能力，验收落点在侧栏渲染与 Core 请求的单元 /
e2e 用例，不引入新的用户故事编号。措辞统一是用户可见文案的改动，落在 `src/webview/i18n/`
与侧栏。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | 侧栏标题渲染（`electron/sidebar/main.ts`） | 待 plan 细化 | 自动 |
| FR-002 | `UiRequest.workViewFilesRequested` + Core 列目录 | 待 plan 细化 | 自动 |
| FR-003 | 打开文件的读取通道 | 待 plan 细化 | 自动 |
| FR-004 | 视图未建立时回基线 | 待 plan 细化 | 自动 |
| FR-005 | 活动对话切换时的取数来源切换 | 待 plan 细化 | 自动 |
| FR-006 | 失败文案 | 待 plan 细化 | 自动 |

## 待澄清

无未决问题。

## 收敛记录

收敛时由 /converge 填写，结论只分三类。

- 已满足：<FR / AC → 证据（实现与测试落点）>
