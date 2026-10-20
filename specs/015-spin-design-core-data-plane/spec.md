---
status: 已收敛
---

# 改动规格：Spin 设计器数据面经 Core

把 Spin 设计器的 `spin.json` 读取 / 写入与技能清单从宿主进程的本地磁盘迁到 Core：设计器按
`sessionId` 路由到会话所属 Connection，由 Core 在**自己所在的机器**解析会话工作目录并读写
`spin.json`。目标是远程工作区的保存落到远端 Core 的数据目录，宿主本地不再产生该会话的
`spin.json` / `workspace.meta.json`；`spin.json` 的格式与 SpinLoop 的执行语义不变。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/architecture/events.md](../../docs/architecture/events.md) | [第 2 节 事件词汇表](../../docs/architecture/events.md#2-事件词汇表) | 修改 | `UiRequest` 数量 9→11、事件总数 60→62；成员清单在 [standalone-core.md 第 4 节](../../docs/core/standalone-core.md#4-契约) |
| [docs/core/standalone-core.md](../../docs/core/standalone-core.md) | [第 4 节 契约](../../docs/core/standalone-core.md#4-契约) | 修改 | `UiRequest` 成员清单与数量补 `spinDesignRequested` / `spinDesignSaveRequested` 的语义 |
| [docs/core/standalone-core.md](../../docs/core/standalone-core.md) | [第 7 节 事实归属](../../docs/core/standalone-core.md#7-事实归属) | 修改 | `spin.json` 登记为 Core 事实（会话数据的一部分） |
| [docs/core/standalone-core-boundaries.md](../../docs/core/standalone-core-boundaries.md) | [第 2 节 宿主侧的 core 事实读取](../../docs/core/standalone-core-boundaries.md#2-宿主侧的-core-事实读取) | 修改 | Spin 设计器数据列入 Core 事实；本地磁盘例外表不再适用于该链路 |
| [docs/architecture/contracts.md](../../docs/architecture/contracts.md) | [第 2 节 Spin 设计器契约：SpinDesign](../../docs/architecture/contracts.md#2-spin-设计器契约spindesign) | 修改 | `open` 入参改为 `sessionId`；数据源经 Core；读写与技能清单不再由宿主直接取 |
| [docs/architecture/principles.md](../../docs/architecture/principles.md) | [第 4 节 core 的资源跟 core 的事实走](../../docs/architecture/principles.md#4-core-的资源跟-core-的事实走) | 修改 | Spin 设计器内容的 owner 与触发点改为「Core 的 spin.json 事实 + UI 决定何时索取」 |
| [docs/architecture/principles.md](../../docs/architecture/principles.md) | [第 7 节 一份事实只有一个写入点](../../docs/architecture/principles.md#7-一份事实只有一个写入点) | 修改 | `spin.json` 登记为 Core 唯一写入点 |
| [docs/hosts/host-matrix.md](../../docs/hosts/host-matrix.md) | [第 4 节 SpinDesign 实现对照表](../../docs/hosts/host-matrix.md#4-spindesign-实现对照表) | 修改 | 两个宿主的读取 / 保存落点改为 `UiRequest`，不再经本地 `fs` |
| [docs/architecture/core-ui-separation.md](../../docs/architecture/core-ui-separation.md) | [第 5 节 Core 的部署形态](../../docs/architecture/core-ui-separation.md#5-core-的部署形态) | 修改 | 会话数据（含 `spin.json`）的读写都在 Core 所在机器 |
| [docs/core/client-connection.md](../../docs/core/client-connection.md) | [第 4.1 节 与 Core 数据目录的关系](../../docs/core/client-connection.md#41-与-core-数据目录的关系) | 修改 | 补充 `spin.json` 随会话数据落在各 Core 实例的数据目录 |
| [docs/features/user-stories.md](../../docs/features/user-stories.md) | [US-39 Spin 设计器](../../docs/features/user-stories.md#us-39-spin-设计器) | 修改 | 验收 2 明确保存写回会话所属 Core 所在机器的会话目录（远程工作区即远端） |

## 用户场景与验收标准

- 场景 1：远程工作区打开设计器
  - **AC-1**（FR-001）：GIVEN 远程会话的 `spin.json` 位于远端 Core 的数据目录 WHEN 用户打开设计器 THEN 画布显示远端内容，技能列表为远端该会话工作目录下的用户可主动触发技能
  - **AC-2**（FR-001）：GIVEN 会话在 Core 侧没有 `spin.json` WHEN 用户打开设计器 THEN 显示空画布（新设计），不显示读取失败
- 场景 2：保存
  - **AC-3**（FR-002）：GIVEN 远程会话 WHEN 用户保存设计 THEN 远端 `<conversations>/<project>/spin.json` 更新，宿主本地不存在该会话的 `spin.json` 与 `workspace.meta.json`，设计器收到成功回执
  - **AC-4**（FR-002）：GIVEN Core 返回保存错误 WHEN 设计器收到失败回执 THEN 显示失败提示，远端文件保持原内容
- 场景 3：设计器绑定与切换
  - **AC-5**（FR-003）：GIVEN 设计器已绑定会话 A WHEN 从会话 B 打开 THEN 先读 B 成功再切换绑定，画布显示 B 的内容
  - **AC-6**（FR-003）：GIVEN 设计器已绑定会话 A WHEN 从会话 B 打开但读取失败 THEN 保持绑定 A、画布不变并显示错误
  - **AC-7**（FR-003）：GIVEN `sessionId` 为 `null` WHEN 打开设计器 THEN 显示空态且保存不可用
- 场景 4：`/spin` 的存在性判断
  - **AC-8**（FR-004）：GIVEN 会话在 Core 侧已有 `spin.json` WHEN 用户输入 `/spin` THEN 不打开设计器，由 Core 继续执行
  - **AC-9**（FR-004）：GIVEN 会话在 Core 侧没有 `spin.json` WHEN 用户输入 `/spin` THEN 打开设计器并显示空画布
  - **AC-10**（FR-004）：GIVEN 存在性请求失败 WHEN 用户输入 `/spin` THEN 不打开设计器并显示错误提示
- 场景 5：失败与并发
  - **AC-11**（FR-005）：GIVEN SpinLoop 正在更新节点 meta WHEN 用户保存设计 THEN 两次写入按 Core 的串行顺序完成，文件不是半写状态，最终内容为后完成的那次
  - **AC-12**（FR-005）：GIVEN 远程 Core 不可达 WHEN 用户保存设计 THEN 设计器显示失败提示，宿主本地不产生 `spin.json` 与 `workspace.meta.json`
  - **AC-13**（FR-005）：GIVEN 设计器已显示内容 WHEN 刷新请求失败 THEN 画布保持原内容并显示错误，不清空

## 功能需求

### FR-001：设计器读取经 Core

- `SpinDesign.open` / `refresh` 得到的 `spin.json` 内容与技能清单由 Core 提供；设计器不再用
  宿主本地路径（`getProjectConversationDir`）或宿主本地 `fs` 读取 `spin.json`，也不再在宿主
  本地扫描工作目录技能。
- 新增 `UiRequest.spinDesignRequested`，载荷 `{ sessionId }`，结果为判别联合：
  - `{ status: 'ok'; data: SpinDesign | null; skills: { name: string; description: string }[] }`；
  - `{ status: 'error'; message: string }`。
- `data: null` 表示该会话在 Core 侧没有设计文件（新设计）；读取 / 解析失败用
  `status: 'error'` 表达，两者不混用。
- 技能集合是该会话工作目录下的用户可主动触发技能（`!isHidden && userInvocable`），在
  Core 所在机器解析；内置斜杠命令不进设计器技能列表（与现状一致）。
- 设计器只在 Core 返回 `status: 'ok'` 后创建或替换画布。

### FR-002：设计器保存经 Core

- 新增 `UiRequest.spinDesignSaveRequested`，载荷 `{ sessionId; data: SpinDesign }`，结果为
  判别联合：`{ status: 'ok' }` 或 `{ status: 'error'; message: string }`。
- Core 按会话工作目录解析目标路径，把 `spin.json` 写到 Core 所在机器的
  `<CONFIG_DIR_NAME>/conversations/<encoded-project>/spin.json`；会话目录与
  `workspace.meta.json` 由 Core 创建，宿主不参与。
- 保存与 SpinLoop 的节点 meta 更新在 Core 内串行：同一份 `spin.json` 只有一个写入点，写入
  失败时旧文件保持可用（不出现半写文件）。
- 宿主进程不写该会话的 `spin.json` 或 `workspace.meta.json`；设计器的保存结果经既有
  `spinSaveResult` 消息回传（成功 / 失败 + Core 的错误文案）。
- 保存成功不广播 `spinDesignDataChanged`；该事件仍只由 SpinLoop 的 meta 更新触发。

### FR-003：设计器按会话绑定与路由

- `SpinDesign.open` 的入参从 `workspacePath?: string` 改为 `sessionId: string | null`；
  `null` 表示没有会话（空态、保存不可用）。`refresh()` 不变。
- 设计器窗口仍是每宿主单例：同一 `sessionId` 复用并聚焦；不同 `sessionId` 先读取成功，再
  切换绑定并替换画布。
- 设计器不以宿主活动工作目录兜底，也不按路径猜目标机器；请求按 `sessionId` 路由到该会话
  所属 Connection。
- `sessionId` 无法路由到 Connection 时，打开 / 刷新 / 保存都返回明确错误，不写任何文件。

### FR-004：`/spin` 的存在性判断来自 Core

- `/spin` 在会话没有设计时打开设计器、有设计时不打开；判断数据源是 Core 的
  `spinDesignRequested` 结果，不是宿主本地的 `existsSync`。
- 存在性请求失败时不打开设计器并显示错误提示，不把失败当作「没有设计」。
- `/spin design` 直接打开设计器，不做存在性预判（与现状一致）。

### FR-005：失败路径不落宿主本地盘

- 读取、保存、刷新的任何失败都不允许回退到宿主本地路径；宿主本地不产生该会话的
  `spin.json` 或 `workspace.meta.json`。
- 刷新失败时保留当前画布与绑定并提示错误；保存失败时远端文件不变。
- Core 未就绪时请求按既有就绪门禁挂起，不在宿主侧降级成本地读写。
- 设计器绑定的会话被关闭 / 删除后，窗口不自动关闭；后续刷新 / 保存返回错误并提示。

## 边界与错误路径

- `sessionId` 未登记工作目录：Core 返回 `status: 'error'`，宿主提示；不写盘。
- `spin.json` 存在但 JSON 非法：读取返回 `status: 'error'`，设计器不显示空画布（避免用户
  保存时覆盖坏文件）。
- 保存载荷的结构校验仍在设计器侧（`buildDesignData`）；Core 按收到的数据原样落盘，不新增
  结构校验语义。
- 同一会话连续保存：按 Core 的请求顺序串行，后完成者胜；不出现两个写入点。
- 无会话（`sessionId` 为 `null`）：设计器保存不可用，宿主侧也拒绝保存请求。
- 设计器单例：同一宿主不并行开多个设计窗口，因此不做跨窗口编辑冲突合并。
- 远程连接断开：请求 reject，按保存 / 刷新失败处理；不产生本地文件。

## 非目标

- 不改变 `spin.json` 的 JSON 结构与字段语义。
- 不改变 SpinLoop 的执行、验收判定、变量替换与进度语义。
- 不新增通用文件读写 `UiRequest` 或远程文件浏览器；只加 Spin 设计器所需的两条请求。
- 不改变设计器 HTML 的渲染与交互（除数据来源、技能来源与错误提示）。
- 不改变导出（另存为）：导出仍走宿主 `saveTextFile`，写用户选择的本地文件。
- 不在本 spec 内清理 `src/shared/spin/` 的其余纯函数；死代码审计留给实施阶段。
- VS Code 本地的可观察行为不变（数据面换成 Core 请求，结果等价）。

## 对需求基线的影响

- 修改 US-39 验收 2：保存写回**会话所属 Core 所在机器**的会话目录（远程工作区即远端），
  「执行完成后窗口数据自动刷新」不变。
- 无新增 US；US-39 的 e2e 映射沿用 `e2e/electron/desktopShell.spec.ts`，并补「保存经 Core」
  的断言。远程真实 SSH 的保存不在 e2e 中稳定覆盖，登记为「无自动覆盖 + 理由」，由宿主级
  假 Core 测试覆盖请求路由与「宿主本地零落盘」。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `UiRequest.spinDesignRequested`；`SpinDesign.open` / `refresh`；`ElectronSpinDesign` / `VSCodeSpinDesign` | `src/test/spinDesignCore.test.ts`「读取走 spinDesignRequested 且带 sessionId」+ `core-rs/src/main_tests.rs`「ui_request_spin_design_reads_and_saves_in_core_data_dir」 | 自动 |
| FR-002 | `UiRequest.spinDesignSaveRequested`；Core 的 spin 写锁与原子落盘 | `src/test/spinDesignCore.test.ts`「保存走 spinDesignSaveRequested 且带 sessionId / data」「宿主保存不在本地创建 conversations 目录」+ `core-rs/src/main_tests.rs`「ui_request_spin_design_reads_and_saves_in_core_data_dir」 | 自动 |
| FR-003 | `SpinDesign.open(sessionId)`；`planSpinDesignSessionSwitch`；`WebViewUI.openSpinDesign` / `onCommandSend` | `src/test/spinDesignCore.test.ts`「异会话先读成功再切绑定」「读取失败保持原绑定」「请求 reject 保持原绑定」 | 自动 |
| FR-004 | `WebViewUI.onCommandSend`；`src/shared/history/spinCommand.ts` 的本地存在性判断退出 | `src/test/spinDesignCore.test.ts`「无设计文件 → 打开设计器」「有设计文件 → 不打开设计器」「读取失败 → 不当作没有设计」 | 自动 |
| FR-005 | 失败路径统一处理；宿主侧本地读写路径退出 | `src/test/spinDesignCore.test.ts`「读取失败结果原样返回」「宿主保存不在本地创建 conversations 目录」「错误提示不清空画布」 | 自动 |

## 待澄清

无。

## 收敛记录

- 已满足：
  - FR-001 / AC-1、AC-2：设计器读取走 `UiRequest.spinDesignRequested`，Core 用
    `config::session_workspace(sessionId)` 在自己所在机器读 `spin.json` 并返回技能清单；
    `data: null` 与 `status: 'error'` 分开。证据：`core-rs/src/main.rs` 的
    `spin_design_read_payload`、`src/host/coreFacts.ts` 的 `requestSpinDesign`、
    `src/test/spinDesignCore.test.ts`「读取走 spinDesignRequested 且带 sessionId」、
    `core-rs/src/main_tests.rs`「ui_request_spin_design_reads_and_saves_in_core_data_dir」。
  - FR-002 / AC-3、AC-4：保存走 `UiRequest.spinDesignSaveRequested`，Core 复用
    `write_spin_json` 的进程级写锁与原子落盘，宿主不再写本地 `spin.json` /
    `workspace.meta.json`；保存成功不广播 `spinDesignDataChanged`。证据：
    `core-rs/src/main.rs` 的 `spin_design_save_payload`、`core-rs/src/spin.rs` 的
    `write_spin_json`、`src/test/spinDesignCore.test.ts`「保存走
    spinDesignSaveRequested 且带 sessionId / data」「宿主保存不在本地创建
    conversations 目录」、`core-rs/src/main_tests.rs`「ui_request_spin_design_reads_and_saves_in_core_data_dir」、
    e2e `desktopShell.spec.ts` US-39「保存后沙箱 home 的会话目录出现 spin.json」。
    远程真实 SSH 的保存与本地同一条请求链，未单独做 e2e（spec 已登记为无自动覆盖）。
  - FR-003 / AC-5、AC-6、AC-7：`SpinDesign.open(sessionId: string | null)` 按会话绑定；
    `src/host/spinDesignSession.ts` 的 `planSpinDesignSessionSwitch` 统一「同会话不读、
    异会话先读成功再切、读失败 / reject 保持原绑定」；两个宿主实现共用它。证据：
    `src/VSCodeSpinDesign.ts` / `electron/ElectronSpinDesign.ts` 的 `open`、
    `src/test/spinDesignCore.test.ts`「同会话不触发读取」「null 会话不切换」「异会话先读
    成功再切绑定」「读取失败保持原绑定」「请求 reject 保持原绑定」。
  - FR-004 / AC-8、AC-9、AC-10：`/spin` 的存在性判断来自 `requestSpinDesign` 结果；
    `src/shared/history/spinCommand.ts` 已删除本地 `fs` / `getProjectConversationDir`，
    只剩纯判定。证据：`src/host/WebViewUI.ts` 的 `onCommandSend`、
    `src/test/spinDesignCore.test.ts`「无设计文件 → 打开设计器」「有设计文件 → 不打开
    设计器」「读取失败 → 不当作没有设计」。
  - FR-005 / AC-11、AC-12、AC-13：失败路径不落宿主本地盘；刷新失败只推
    `spinDesignError`、不替换画布；保存失败回 `spinSaveResult` 失败；`sessionId` 为
    `null` 时 `saveEnabled=false`。证据：`src/host/ui/spinDesignHtml.ts` 的
    `__spinCanSave` / `spinDesignError`、`src/test/spinDesignCore.test.ts`「读取失败
    结果原样返回」「宿主保存不在本地创建 conversations 目录」「错误提示不清空画布」。
  - 验证记录：`npm run check-types` 0 错、`npm run lint` 干净、
    `npm run build:core:host` 成功、`npm run test:all` 58 通过 / 0 失败、
    `npm run test:core` 880 passed / 0 failed、`desktopShell.spec.ts` 6 passed
    （含 US-39 保存落盘）、`docsLint` 46 组全过。
- 偏差：无产品行为偏差。收敛时按实际测试落点对齐了追溯矩阵的用例名，并新增
  `src/host/spinDesignSession.ts` 作为两个宿主共用的会话切换判定（为可测试性抽取，
  不改变行为）；两项均已回写 spec / plan。
- 未做：无。

