---
status: 已修
---

# 缺陷：勾选「对话隔离视图」不生效，改动照样写磁盘

新建对话时勾选「对话隔离视图」入口，写文件后磁盘仍能看到、Bash 与 Read 读到的也是真实
磁盘内容。隔离视图从未建立。

## 现状

`ensure_work_view`（`core-rs/src/engine.rs`）只对 `session_storage` 为 `Isolated` 的会话
建立视图，而归属在两处断链。

### 一、webview 勾选从未通知 Core

勾选框在「新建对话」**之后**才渲染（`MessagesView` 的 `showWorkViewOption` 要求
`messages.length === 0`），而 `startNewConversation` 在新建对话时就已发出，带着初始值
`storage: 'workspace'`。用户随后勾选只改了 `App.tsx` 的本地状态：

```ts
onWorkViewChange={setWorkViewSelected}
```

没有任何消息发往宿主或 Core。用户发消息时 Core 仍按 `workspace` 执行，勾选完全没生效。

### 二、归属不落盘，Core 重启后丢失

`conversationStarted` 只登记内存态。`meta.json` 由首条消息创建（`touch_metadata`），而
该函数的兜底建档只写 `sessionId` / `project` / `creator`——没有 `storage`。同时
`session_storage` 只读内存态：

```rust
pub fn session_storage(&self, session_id: &str) -> WorkViewStorage {
    self.session(session_id).lock().map(|state| state.storage).unwrap_or(WorkViewStorage::Workspace)
}
```

于是 Core 重启（或会话被 `drop_session` 后重开）时归属读不回来，隔离视图的对话退回真实
磁盘。`work_view_storage_text` 已定义却从未被调用，正是这处遗漏的痕迹。

### 三、建判据用「文件是否存在」

新建对话时宿主立刻推送默认配置（model / provider），`update_context` 当场建档。于是用户
点勾选那一刻 `meta.json` **必然已存在**，而 `set_session_storage` 拿「文件存在」当「已有
消息」的判据，每一次勾选都被拒绝。改为按 `messageCount > 0` 判断。

### 四、工具层没真正接入视图

归属修好后图标出现，但编译产物仍落真实磁盘。三处叠加：

- `WorkViewHandle::map_into_view` 在路径越界时 `unwrap_or_else(|_| real.to_path_buf())`
  静默退回真实路径——隔离对话的读写绕过视图写磁盘，工具仍报成功。
- `run_read` 的存在性与类型判断用真实路径 `path.exists()`，实际读取用 `io_path`：
  视图里刚写出的文件在磁盘上不存在，Read 报 `File not found`。
- `run_grep` / `run_glob` 的搜索目录取自 `expand_path`（真实路径），搜的是磁盘。

### 测试框架掩盖了第四处

`in_namespace` 用 `fork` 起子进程跑断言，子进程里的 panic 只在自己进程里 unwind，父进程
拿到的退出码仍是 0。`work_view_tools_and_bash_share_the_overlay` 因此一直失败却显示
`ok`（实测 0.00s 完成、`--nocapture` 下能看到 panic）。改用 `catch_unwind` 把 panic 转成
非零退出码后才暴露。

## 期望

- 勾选状态必须到达 Core，视图在该会话首次工具调用时建立。
- 归属落进 `meta.json`，Core 重启后能读回。
- 归属仍是一次写定：已有消息落盘后不再接受变更。

## 不变量

- 隔离视图对话的 `Write` / `Edit` 只落 `upperdir`，磁盘对应路径不变。
- 同一对话的所有工具与 Bash 看到同一份叠加结果。
- 存量会话（没有 `storage` 字段）按 `workspace` 处理，行为不变。
- `meta.json` 已存在时归属拒绝变更，历史文件能解释自己读的是哪份存储。

## 回归测试

- **RT-1**：首条消息之前接受归属补发（含取消勾选）。落点
  `core-rs/src/engine_tests.rs` 的 `storage_change_applies_before_the_first_message`。
- **RT-2**：`meta.json` 已存在但还没有消息（真实新建态）时勾选必须生效。落点
  `core-rs/src/engine_tests.rs` 的
  `storage_change_applies_to_a_fresh_conversation_that_already_has_meta`。
- **RT-2b**：已有消息（`messageCount > 0`）时忽略变更。落点 `core-rs/src/engine_tests.rs`
  的 `storage_change_is_ignored_once_messages_exist`。
- **RT-3**：重启后能从 `meta.json` 恢复归属。落点 `core-rs/src/engine_tests.rs` 的
  `session_storage_restores_from_meta_after_restart`。
- **RT-4**：存量 / 未知会话回 `workspace`。落点 `core-rs/src/engine_tests.rs` 的
  `session_storage_defaults_to_workspace_without_meta_field`。
- **RT-5**：建档写入 `storage`。落点 `core-rs/src/history_tests.rs` 的
  `touch_metadata_persists_isolated_storage`。
- **RT-6**：已有归属不被覆盖。落点 `core-rs/src/history_tests.rs` 的
  `touch_metadata_keeps_existing_storage`。
- **RT-7**：读侧缺省按 `workspace`。落点 `core-rs/src/history_tests.rs` 的
  `storage_of_session_defaults_to_workspace_when_absent`。
- **RT-8**：工具与 Bash 共用同一视图——`Write` 写的文件 `Read` 能读回、磁盘上不存在、
  Bash 里可见基线与改动。落点 `core-rs/src/work_view_tests.rs` 的
  `work_view_tools_and_bash_share_the_overlay`。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-2（修复前） | `standalone_core storage_change_is_ignored_once_meta_exists` | 红 | 首次红：`metadata_exists` 错用 `project_of_session`（它要求先查到 project 登记），沙箱与重启场景下查不到 meta，拒绝逻辑整体失效——`left: Isolated, right: Workspace` |
| 装包实测（第一版修复） | 应用内新建对话 → 勾选隔离 → 发消息 | 红 | 仍不生效、侧栏无图标，`meta.json` 的 `storage` 是 `workspace`。两个原因：判据用「meta 文件是否存在」，而新建对话时宿主立刻推送默认配置就建了档，勾选必然被拒；`update_context` 兜底建档不写 `storage` |
| 真实链路复现 | 真实 Core：`conversationStarted` → `conversationContextUpdated` → `storageChanged` | 红 → 绿 | 复现了装包现象（`meta.storage = undefined`）；改成「已有 meta 就地补写 + 按 `messageCount` 判已有消息」后得 `meta.storage = isolated` |
| RT-1 / RT-2 / RT-3 / RT-4 / RT-5 / RT-6 / RT-7（修复后） | `standalone_core storage` | 绿 | 8 条全过。新增 `storage_change_applies_to_a_fresh_conversation_that_already_has_meta` 覆盖真实时序（`messageCount: 0` 的 meta） |
| 装包实测（第二版修复） | 应用内新建对话 → 勾选隔离 → 让 AI 编译 | 红 | 图标出现（归属已落盘），但 `main` 仍在真实磁盘，`work-views/<key>/upper/` 是空的 |
| RT-8（修复前） | `standalone_core work_view_tools_and_bash --nocapture` | 假绿 | 0.00s 完成、报 `ok`，但 `--nocapture` 下能看到 `File not found` 的 panic——`fork` 后子进程 panic 未转成退出码 |
| RT-8（修复后） | `standalone_core work_view_` | 绿 | 6 条全过（0.04s 真实执行）。同时修好 `map_into_view` 静默降级、Read 存在性判据、Grep/Glob 搜索目录 |
| 全量 Core | `cargo test --release` | 绿 | 见提交 `d17b605` 后的全量结果 |
| 文档一致性 | `npm run test:unit -- docs-lint` | 绿 | 事件表数量 / 载荷列 / 体积棘轮全部同步 |
