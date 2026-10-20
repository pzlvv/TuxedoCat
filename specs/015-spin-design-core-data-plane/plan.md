# 实施方案：Spin 设计器数据面经 Core

技术路线：把 `spin.json` 的读取 / 写入与设计器技能清单收口到 Core，宿主只发两条
`UiRequest`（`spinDesignRequested` / `spinDesignSaveRequested`），由 Core 用会话工作目录在
自己所在机器解析路径并落盘；`SpinDesign.open` 改为按 `sessionId` 路由。设计器不再持有任何
本地磁盘读写路径。需求与验收见 [spec.md](spec.md)。

## 技术方案

### 1. 契约：两条 `UiRequest`

在 `src/shared/AssistantEventBus.ts` 增加：

```ts 示意
| { type: 'spinDesignRequested'; sessionId: string }
| { type: 'spinDesignSaveRequested'; sessionId: string; data: SpinDesign }
```

结果类型（同文件，放在 `UiRequestResultMap` 附近）：

```ts 示意
export interface SpinDesignSkill { name: string; description: string }
export type SpinDesignReadResult =
  | { status: 'ok'; data: SpinDesign | null; skills: SpinDesignSkill[] }
  | { status: 'error'; message: string };
export type SpinDesignSaveResult =
  | { status: 'ok' }
  | { status: 'error'; message: string };
```

`UiRequestResultMap` 增加 `spinDesignRequested: SpinDesignReadResult` 与
`spinDesignSaveRequested: SpinDesignSaveResult`。`SpinDesign` 类型从
`src/shared/spin/Types.ts` 引入（shared 叶子层，不引入宿主依赖）。

### 2. Core 侧：读 / 写 / 技能

`core-rs/src/main.rs` 的 `dispatch_ui_request` 增加两个分支：

- `spinDesignRequested`：取 `sessionId` → `config::session_workspace(session_id)`（**不用
  `project_root`**，避免回退到 `ACTIVE_WORKSPACE` 串到别的工作区）→ 读 `spin.json` →
  `{ status, data, skills }`。
- `spinDesignSaveRequested`：取 `sessionId` 与 `data` → 同一路径解析 → `spin::write_spin_json`
  （已有进程级写锁 + 临时文件 + 原子 rename）→ `{ status: 'ok' }` / `{ status: 'error', message }`。
  保存成功不广播 `spinDesignDataChanged`；该事件仍只由 SpinLoop 的 meta 更新触发。

`core-rs/src/spin.rs` 增加 `read_spin_json_state(cwd) -> Result<Option<Value>, String>`：文件
不存在 → `Ok(None)`；读取 / JSON 解析失败 → `Err`；成功 → `Ok(Some(value))`。保留现有
`read_spin_json` 的 `Option` 语义供 SpinLoop 使用。`write_spin_json` 从测试专用
（`#[cfg_attr(not(test), allow(dead_code))]`）转为生产路径，去掉该标注。

技能清单在 Core 侧组装：`skills::get_all_skills(cwd)` 过滤 `!is_hidden && user_invocable`，
映射为 `{ name, description }`；不把内置斜杠命令放进设计器技能列表（与现状一致）。

### 3. 宿主侧：统一入口与设计器编排

- `src/host/coreFacts.ts` 增加 `requestSpinDesign(sessionId)` 与
  `saveSpinDesign(sessionId, data)`，内部走 `requireEventBus().requestCore(...)`，与既有
  「core 事实统一入口」同口径。
- `src/host/SpinDesign.ts`：`open(sessionId: string | null)`（`null` = 无会话），`refresh()`
  不变；契约注释更新为「数据来自 Core，不再由宿主读盘」。
- `src/host/WebViewUI.ts`：
  - `openSpinDesign()` 取活动 `sessionId`（`undefined` → `null`）传给 `spinDesign.open`，
    失败时用 `CoreNoticeKeys.spinCannotRead` 向该会话 webview 发 `notice`。
  - `onCommandSend` 的 `/spin` 分支用 `requestSpinDesign(sessionId)` 判断存在性：
    `status === 'error'` → `notice`；`data === null` → 打开设计器；有数据 → 不打开（Core 继续执行）。
  - 删除 `workspaceForSession`（只为 Spin 存在）。
- `src/shared/history/spinCommand.ts` 改为纯判定：`shouldOpenSpinDesign(result)` 返回
  `result.status === 'ok' && result.data === null`；删除 `spinJsonPathFor`、`fs` 与
  `getProjectConversationDir` 依赖。
- `src/VSCodeSpinDesign.ts` / `electron/ElectronSpinDesign.ts`：
  - `open(sessionId)`：已打开且同一会话 → 聚焦；已打开且会话不同 → 先 `requestSpinDesign`
    成功再改绑定并推 `spinDesignData`，失败推 `spinDesignError` 并保持原绑定；未打开 →
    先请求，成功才创建窗口，失败 reject（不创建窗口）。`sessionId === null` 只在没有窗口时
    创建空态窗口（`saveEnabled=false`）；已有窗口时保持当前绑定并聚焦。
  - `refresh()`：有窗口才请求；失败推 `spinDesignError`，不清空画布、不 reject。
  - 保存：`sessionId === null` → `spinSaveResult` 失败；否则 `saveSpinDesign`，按结果回
    `spinSaveResult`。
  - 删除本地 `getProjectConversationDir` / `fs` / `getAllSkills` / `writeSpinJsonQueued` 路径。
- `src/host/ui/spinDesignHtml.ts`：新增 host → 设计器消息 `spinDesignError`
  （`{ type: 'spinDesignError'; error: string }`，显示 `toast.loadFailed` 提示）；
  `spinDesignData` 到达后允许保存。`getSpinDesignHtml` 增加必填 `saveEnabled` 参数，初始
  `__spinCanSave` 取它；`saveDesign()` 在不可保存时提示并返回。

### 4. 失败模型

| 场景 | 行为 |
| --- | --- |
| 首次打开读取失败 | `open` reject，不创建窗口；`WebViewUI` 发 `notice.spin.cannotRead` |
| 已打开窗口切换会话读取失败 | 推 `spinDesignError`，保持原绑定与画布 |
| `refresh` 失败 | 推 `spinDesignError`，保持画布；`refresh()` 不 reject |
| 保存失败 | `spinSaveResult { success:false, error }`；远端文件不变 |
| `sessionId === null` | 空态窗口，`saveEnabled=false`；保存请求被宿主拒绝并提示 |
| Core 未就绪 / 断连 | `requestCore` 按既有门禁挂起或 reject，按上表对应失败处理；不落本地盘 |

宿主侧错误提示复用 webview 翻译表已有的 `notice.spin.cannotRead` 键，不新增文案键；
设计器窗口内的错误用 `spinDesignError` 的 `toast.loadFailed` 提示。

### 5. 数据流

```
设计器窗口 → ElectronSpinDesign / VSCodeSpinDesign
  → coreFacts.requestSpinDesign / saveSpinDesign
    → Client.requestCore（按 sessionId 路由到 Connection）
      → Core dispatch_ui_request
        → config::session_workspace(sessionId) → spin.json（Core 所在机器）
```

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `src/shared/AssistantEventBus.ts` | 修改 | 新增 `UiRequest.spinDesignRequested` / `spinDesignSaveRequested` 与两个结果类型 |
| `src/shared/history/spinCommand.ts` | 修改 | 删除本地 `fs` 存在性判断，改纯判定 |
| `src/shared/spin/Engine.ts` | 修改 | 移除本地读写 / 写队列（`readSpinJson` / `writeSpinJson` / `enqueueSpinWrite` / `writeSpinJsonQueued` / `updateNodeMeta`）；纯函数按 spec 非目标保留，死代码审计另行处理 |
| `src/host/SpinDesign.ts` | 修改 | `open(workspacePath?)` → `open(sessionId: string \| null)` |
| `src/host/coreFacts.ts` | 修改 | 新增两个取数 / 写入入口 |
| `src/host/spinDesignSession.ts` | 新增 | 两个宿主共用的会话切换判定（先读后绑 / 失败保持原绑定） |
| `src/host/WebViewUI.ts` | 修改 | `/spin` 判定与设计器打开改走 Core；删除 `workspaceForSession` |
| `src/host/ui/spinDesignHtml.ts` | 修改 | 新增 `spinDesignError` 消息与 `saveEnabled` 入参 |
| `src/VSCodeSpinDesign.ts` | 修改 | 读写改 `coreFacts`；删除本地盘路径 |
| `electron/ElectronSpinDesign.ts` | 修改 | 读写改 `coreFacts`；删除本地盘路径 |
| `core-rs/src/main.rs` | 修改 | `dispatch_ui_request` 增加两个分支与 payload 组装 |
| `core-rs/src/spin.rs` | 修改 | 新增 `read_spin_json_state`；`write_spin_json` 转生产路径 |
| `src/test/spinDesignCore.test.ts` | 新增 | 宿主侧路由、零本地落盘、失败映射、存在性判定 |
| `src/test/hostCoreFacts.test.ts` | 修改 | `UiRequestHandlers` 补两条，9 类 → 11 类 |
| `core-rs/src/main_tests.rs` | 修改 | 两个请求的正常 / 缺会话 / 非法 JSON 用例 |
| `core-rs/src/spin_tests.rs` | 修改 | `read_spin_json_state` 的 missing / ok / invalid |
| `e2e/electron/desktopShell.spec.ts` | 修改 | US-39 补「设计器保存后沙箱 home 出现 spin.json」 |

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：`AssistantEventBus` 只引用 shared 叶子类型
  （`SpinDesign` / `SpinDesignSkill` 均在 `src/shared/`）；`coreFacts` 不 import
  `vscode` / `electron`；Core 不 import TS；无宿主嗅探。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：失败不降级到宿主本地盘；`open` 用 `string | null`
  而不是可选参数；`spin.json` 唯一写入点收回 Core；默认值 / 路径派生仍只有一份
  （`config::project_conversation_dir` 与 `Config.ts` 各管自己的机器，宿主不再用后者定位
  core 数据）。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：仓库只剩 Rust 单一 Core
  （ADR-0007），无 TS 侧对照实现；`spin.json` 格式不变，`src/shared/spin/Types.ts` 与
  `core-rs/src/spin.rs` 的字段集合由现有对照测试锁定；Core 侧新增行为补
  `main_tests.rs` / `spin_tests.rs`。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：按 spec「影响基线」同步
  [events.md 第 2 节](../../docs/architecture/events.md#2-事件词汇表)（数量 9→11 / 60→62）、
  [standalone-core.md 第 4 节](../../docs/core/standalone-core.md#4-契约) /
  [第 7 节](../../docs/core/standalone-core.md#7-事实归属)、
  [standalone-core-boundaries.md 第 2 节](../../docs/core/standalone-core-boundaries.md#2-宿主侧的-core-事实读取)、
  [contracts.md 第 2 节](../../docs/architecture/contracts.md#2-spin-设计器契约spindesign)、
  [principles.md 第 4 节](../../docs/architecture/principles.md#4-core-的资源跟-core-的事实走) /
  [第 7 节](../../docs/architecture/principles.md#7-一份事实只有一个写入点)、
  [host-matrix.md 第 4 节](../../docs/hosts/host-matrix.md#4-spindesign-实现对照表)、
  [core-ui-separation.md 第 5 节](../../docs/architecture/core-ui-separation.md#5-core-的部署形态)、
  [client-connection.md 第 4.1 节](../../docs/core/client-connection.md#41-与-core-数据目录的关系)、
  [user-stories.md US-39](../../docs/features/user-stories.md#us-39-spin-设计器)；
  实现与文档同一提交，`docs-lint` 绿。

## 被否决的替代方案

1. **Electron 侧用 SSH/SFTP 直写远程**：违反「宿主不直接读写 core 磁盘」，要复制一份路径
   编码逻辑，并让宿主成为 `spin.json` 的第二写入方（绕过 Rust 写锁）；还要把 endpoint 塞进
   `SpinDesign` 契约。否决。
2. **保留 `open(workspacePath)`，在 Electron 里按 endpoint 判断远程**：`workspacePath` 无法
   区分「本机 `/home/a`」与「远程 `/home/a`」，endpoint 也不应进入这个 surface；会让
   VS Code / Electron 分叉成两套数据面。否决。
3. **用 `UiEvent` + `CoreEvent` 回执替代 `UiRequest`**：保存需要拿到成功 / 失败结果，
   `UiRequest` 已支持「core 事实 + 副作用」；事件 + 回执要额外维护 pending map 与广播路由，
   复杂度更高。否决。
4. **把 `spin.json` 当 UI 数据留在宿主**：SpinLoop 在 Core 侧读写同一文件，会形成两个写入点；
   远程执行读不到宿主本地的设计。否决。
5. **在 `skillsRequested` 上加字段复用**：设计器只要用户可主动触发的技能，与通用技能清单
   （含内置斜杠命令）语义不同；复用会污染既有请求。否决。
