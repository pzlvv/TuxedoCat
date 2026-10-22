---
status: 已修
---

# 缺陷：目标文件缺失时监听注册被拒，断线删除后文件重建永不恢复

[specs/018](../../docs/archive/specs/018-viewer-file-refresh/spec.md) FR-006 承诺「文件被删除
……继续监听原路径，文件重新出现后清除标记并刷新」，AC-22 要求连接恢复后「重新注册监听、
补齐断线期间的修改」。当前 `validate_target` 对目标整体 `canonicalize`——目标不存在即
返回错误，断线期间文件被删后的重注册必然失败，Core 侧从此没有监听，文件重建不再触发
任何事件，查看器永久停在「自动刷新不可用」+ 最后内容。

## 现状

- `core-rs/src/file_watch.rs` 的 `validate_target`：`fs::canonicalize(path)` 对不存在的
  目标返回 `Err`，报 `watch target is not accessible`。
- 复现链：远程查看器打开 → SSH 断连 → 断线期间目标文件被删除 → 连接恢复
  （`onWorkspaceConnectionState` ready）→ 宿主 `handleConnectionReady` 重注册 → Core
  拒绝（目标不存在）→ 标记「自动刷新不可用」→ 文件重建 → 无监听、无事件、永不恢复。
- 正常打开路径不受影响（打开时文件刚被读出、必然存在）；Core 进程重启后的重注册同样命中。

## 期望

1. 目标**缺失**时注册成功：父目录可达且落在工作区根内即放行，父目录监听已在位，
   文件重新出现立即上报 `changed`（宿主补读 → 清标记并刷新）。
2. 目标**存在**时校验口径不变：解析符号链接后的真实路径必须落在根内且为普通文件
   （符号链接指向根外仍拒绝，`rejects_path_outside_workspace` / 符号链接触达用例锁定）。
3. 重注册成功后的补读在文件仍缺失时按既有「读取失败」标记处理（重建事件到达即恢复）。

## 不变量

- 工作区根越界拒绝的既有口径与错误文案不变（`escapes the workspace root`）。
- `watchId` 注册表语义（同 id 替换、unwatch 幂等、drop 停线程）不变。
- 事件载荷（`watchId` / `path` / `kind` / `mtimeMs` / `size` / `error`）与去抖行为不变。
- 契约（`UiRequest` 请求 / `CoreEvent.workspaceFileChanged`）不变，宿主侧无需改动。

## 回归测试

- **RT-1**：注册不存在的目标成功；随后创建该文件，收到 `changed` 事件（落点：
  `core-rs/src/file_watch_tests.rs` 的 `watch_missing_target_waits_for_recreate`）。
- **RT-2**：目标存在且为指向根外的符号链接时仍拒绝（落点：同文件
  `rejects_symlink_escaping_workspace`，unix-only——Windows 建符号链接需要特权；
  Windows 的越界口径由既有 `rejects_path_outside_workspace` 覆盖）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1（修复前） | `cargo test --manifest-path core-rs/Cargo.toml file_watch_tests` | 红 | `register watch on missing target: watch target is not accessible ... (os error 2)` |
| RT-1 / RT-2（修复后） | `cargo test --manifest-path core-rs/Cargo.toml` | 绿 | 906 通过 / 0 失败（RT-2 由 CI Linux 跑，本机 Windows 按 `#[cfg(unix)]` 过滤） |
| 宿主 Core 重建 | `npm run build:core:host` | 绿 | x64-win32 产物含修复；crates.io 直连被网络重置，依赖经 rsproxy 镜像取回后离线构建 |
| 全量 TS | `npm run test:all` | 部分验证 | 63/65；brandLiteral 与 docsLint 的 3 处失败来自并行会话未提交的 `specs/019-*` 草稿（编号重复 / 品牌字面量 / 验证记录缺行），与本缺陷无关，`standalone*` 全部驱动含修复的真实二进制通过 |
| 类型 / lint | `npm run check-types && npm run lint` | 绿 | 无 TS 报错、无 lint 报错 |
