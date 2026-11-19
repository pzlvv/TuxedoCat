---
status: 已修
---

# 缺陷：隔离会话的改动落到真实磁盘（三处 fail-open）

勾选 Overlay 的对话里，Write 与 Bash 的改动出现在**真实工作区**上——用户在磁盘上
看得到本该只存在于叠加层的文件。影响面覆盖 specs/051 FR-010 的全部内容：
「隔离归属但视图不可用」必须报错，不能退回磁盘。

## 现状

三处各自独立地把「视图不可用」当成「没有视图」处理，任何一处的触发条件成立就
退回真实磁盘：

### 1. 视图目录的父链没人建，代理起不来

Core 不再自己建视图目录（改成代执行后那一步没人接手），而代理的 `make_dir` 是
**单层** `mkdir(2)`（它要精确报 errno，刻意不做递归）：

```ts src=mount-proxy-rs/src/sys.rs
    let rc = unsafe { mkdir(path_c.as_ptr(), 0o755) };
```

`<configHome>/work-views/<key>/{upper,work,mount}` 这串在首次使用时不完整存在，
代理以「父目录不存在」失败。视图因此从未挂上——此后每一条工具 IO 都不是「写进了
视图」，而是根本没有视图可写。

### 2. 前台 Bash 按「有没有代理」判断

```ts src=core-rs/src/tools.rs
    if ctx.proxy().is_some() {
        return run_bash_through_proxy(&shell, &command, &cwd, ctx, timeout_ms);
    }
```

`proxy()` 在 `ViewUnavailable` 时回 `None`，于是隔离会话**落到本机 `cmd.spawn()`**，
命令在 Core 自己的（无命名空间的）进程树里跑，写的是真实磁盘。

### 3. 后台 Bash 从登记表反查视图

`spawn_background` 内部用 `WorkViewHandle::of(session_id).is_some()` 判断，同一个
问题：代理缺失时返回 `None`，后台命令同样落到本机 spawn。

### 附：git 取数临时目录落在工作区外层

`scratch_dir()` 写成 `<工作区>/../.tc-view-scratch`，取数会往用户的目录外层丢文件
（不在视图里，也不在预期位置）。

## 期望

1. 视图目录的父链由 Core 在拉起代理**之前**建好；
2. 前台与后台 Bash 都按 `ToolContext.work_view` 的**三态**判断：`View` 走代执行，
   `ViewUnavailable` 直接报错，只有 `Workspace` 才本机 spawn；
3. 后台命令的视图状态由调用方显式传入，不接受「默认没有视图」的入口；
4. git 取数临时目录落在 `<configHome>/work-views/.scratch/<session>`。

## 不变量

- 「该会话不是隔离归属」（`Workspace`）与「隔离归属但视图不可用」
  （`ViewUnavailable`）是两件事，前者正常走磁盘；
- `ViewUnavailable` 下所有工具路径解析返回错误，改动不落真实磁盘；
- 不把会话自动改成 `workspace` 归属：归属一次写定，不随能力变化改写；
- 代理缺失 / 被杀只让能力回 `absent`，Core 照常服务帧通道。

## 回归测试

- **RT-1**：`mount_proxy::linux::client::tests` 的落点判据用例——槽位里 0755 产物但
  未安装时回「未部署」，能力回 `absent`、Core 正常启动。
- **RT-2**：`WorkViewState::ViewUnavailable` 下 Read / Write / Edit / Grep / Glob /
  Bash 全部报错且不写磁盘（`work_view_tests` / `tools_tests`）。
- **RT-3**：代理侧 `writeFile` / `spawn` 走真机端到端，断言改动只出现在视图
  `upper`，真实工作区只有基线文件。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 复现（修复前） | 真机驱动代理：`writeFile` 到工作区 | 红 | `created.txt` 出现在真实磁盘而非只在 `upper` |
| 视图目录父链（修复前） | 真机 `ensure_mounted` 首次使用 | 红 | 代理回「父目录不存在」，视图从未挂上 |
| 视图目录父链（修复后） | 同上 | 绿 | 代理正常挂载，`probeOverlay -> ok` |
| 端到端隔离（修复后） | `python3 repro.py`（`8.136.22.171`） | 绿 | `created.txt` 只在 `upper`；真实磁盘只有 `base.txt` |
| 前台 Bash fail-open | `cargo check` + 三态分支走查 | 绿 | `ViewUnavailable` 回错误，不再本机 spawn |
| 后台 Bash | 同上 | 绿 | 视图状态由调用方显式传入 |
| 全量门禁 | `check-types` / `lint` / `fmt:rust:check` / `test:unit` | 绿 | 115 通过 / 2 跳过 |

修复落点：`core-rs/src/work_view_linux.rs`（目录父链 + scratch 位置）、
`core-rs/src/tools.rs`（前台 Bash 三态 + 后台传视图）、
`core-rs/src/bash_task.rs`（`spawn_background_with_view`，旧入口标记为测试专用）。
