---
status: 已修
---

# 缺陷：Overlay 对话里文件资源管理器看不到文件

在 Overlay 对话里展开侧栏文件资源管理器，树里不是该对话的叠加视图，而是「读取失败，点击
重试」的错误行；同样的代码路径下，Overlay 的「全部变更 / 文档视图」也一律报
`git rev-parse 失败：`（冒号后为空）。两个症状看起来无关，实际是两处独立的接线缺失：
Core 侧少了一次「取数前把视图备好」，代理侧少了一次「按请求的 PATH 解析可执行文件」。

影响面：只要用户没有先让工具跑过至少一次，资源管理器就是这个错误行——而「一进对话就展开
看看有哪些文件」是很自然的动作。变更视图则是**始终**不可用（与是否先跑过工具无关）。

## 现状

### 1. 取数不建立视图

[specs/046](../046-overlay-file-explorer/spec.md) 的 FR-004 原本规定「视图未建立时列磁盘基线」，实现在 `core-rs/src/main.rs`
的 `workViewFilesRequested` 分支里直接调 `work_view::list_view_dir`，而后者只认
`WorkViewHandle::of(session)`——视图未挂载时回 `Err("会话 <id> 没有已挂载的 Overlay 视图")`。

Overlay 对话的视图是惰性建立的（[docs/core/conversation-work-view.md 第 6 节](../../docs/core/conversation-work-view.md#6-生命周期)）：会话创建
时只登记，代理要到「第一次真正需要视图」时才拉起。资源管理器可以在任何时刻展开，于是没跑过
工具的对话里，侧栏拿到的是失败侧，渲染成错误行。

实测（真实 SSH 远端 + `electron-ssh` 车道，纯文本一轮建立 Overlay 会话、不调任何工具）：

```text
[诊断] filesListOverlay 回包： {"ok":false,"error":"会话 session_... 没有已挂载的 Overlay 视图"}
[诊断] 标题： 文件资源管理器 (overlay)
[诊断] 树 HTML：<div class="file-row file-hint file-error" ...>读取失败，点击重试</div>
```

磁盘基线也没有显示（不是「列了磁盘」而是「什么都没列」）：`list_view_dir` 的失败侧被原样
渲染成错误行，FR-004 想要的「回基线」这一侧同样没有实现。

### 2. 代理用裸名 exec 找不到可执行文件

`mount-proxy-rs/src/exec.rs` 的 `spawn_child` 用 `execve(2)` 直接执行 `argv[0]`：
`execve` 把 `argv[0]` 当**路径**，没有 `execvp(2)` 的 PATH 搜索。而
`core-rs/src/work_view_changes.rs` 的 `Runner::git` 与 `serve.rs` 的 `git_show` 传的
`argv[0]` 就是裸 `"git"`。

后果：子进程以 126 退出且 **stderr 为空**（execve 的 ENOENT 不是命令自己打的），调用方只
看到「命令失败」而没有原因。实测（同一条真实远端链路，工作区是正常 git 仓库）：

```text
[诊断] filesListOverlay：   {"ok":true,"entries":[...,".git",...]}   ← 目录列得出来
[诊断] filesDocListOverlay：{"ok":false,"error":"git rev-parse 失败："}  ← 冒号后为空
```

同一台机器上手工跑 `git rev-parse --is-inside-work-tree` 正常（`true` / `rc=0`），代理侧
的 `resolve_executable` 也证明确实是裸名解析问题：Core 侧 Bash 传的是 `shell.path`（绝对路径），
Read / Write 走的是 `readFile` 这类一次性请求，都不经过 `spawn_child`，因此只有
`workView*` 三条 git 取数受影响。

## 期望

1. **取数前把视图备好**：三个 `workView*` 只读请求（列目录 / 变更清单 / 两侧原文）在取数前
   都经与工具调用同一个入口（`Core::ensure_work_view`）确保该会话的视图已就位。用户进对话就
   展开资源管理器，树里就是该对话的叠加视图；对话内新建的文件出现、磁盘上仍没有它。
2. **建不起来就报错，不退回磁盘**：非 Overlay 归属、无工作目录、代理不可用 / 挂载失败都回
   失败侧，由宿主显示错误行——偷偷列磁盘会把「叠加视图」与「磁盘」两个事实混成一个
   （[docs/architecture/principles.md 第 1 节](../../docs/architecture/principles.md#1-不过度-fallback)）。
3. **代理按请求带来的 PATH 解析可执行文件**：`argv[0]` 不含 `/` 时在 `env` 的 `PATH` 里查
   （代理按 FR-006 不读自己的环境），找到可执行位才执行；找不到时报错并点名 `PATH` 的值，
   `argv[0]` 含 `/` 时按调用方给的原样执行。
4. **变更清单与两侧原文可用**：Overlay 对话的「全部变更 / 文档视图」能在视图里跑 git，
   对话内新建的文件进清单；git 自己的失败（非零退出且 stderr 非空）仍如实透出原因。

## 不变量

- 视图惰性建立的原意不变：纯声明性对话（只发一条消息就关、从不看文件）不产生视图目录，也不
  拉起代理进程。第一次工具调用与第一次视图取数是同一个「真正需要视图」的时机。
- 视图目录布局、overlay 挂载参数、`session_key` 派生、`release` / `remove` 语义不变。
- 三个 `UiRequest` 的应答形态不变（仍是既有判别联合）；缺参数仍走请求非法（`Err`）而不是
  失败侧。
- 代理的代执行边界不变：仍只 `execve` 传入的 `envp`、不读自己的环境、不跑 `$SHELL -lc`、
  不继承自己的 fd。
- 工具（Bash / Read / Write / Edit / Grep / Glob）的行为不变：它们传的是绝对路径或走一次性
  请求，PATH 解析对它们是恒等变换。

## 回归测试

- **RT-1**（FR-002 / FR-004）：真实 SSH 远端上建 Overlay 会话、**不调用任何工具**，展开侧栏
  文件资源管理器——标题是「文件资源管理器 (overlay)」，树里列出叠加视图的内容（含磁盘基线
  里的 `readme.md` 与 `src/`），**没有**错误行。
  （落点：`e2e/electron/overlayMountProxyRemote.spec.ts` 的
  `FR-002/FR-003 资源管理器在视图未建立时按需挂载，树与变更清单都取视图内容`）
- **RT-2**（FR-002 / AC-3）：同一用例里让模型 Write 一个只在视图里的文件——它出现在树里，
  而真实磁盘上不存在该文件。
- **RT-3**（FR-003 / specs/047）：同一用例里取 Overlay 的变更清单（`filesDocListOverlay`）——
  `ok: true`，且对话内新建的文件在 `entries` 里（代理的 PATH 解析可用）。
  （RT-1 / RT-2 / RT-3 同属一条 e2e 用例的三段断言：它们共享「建 Overlay 会话」这个昂贵前置。）
- **RT-4**：代理的 PATH 解析单测——裸名按请求的 `PATH` 解析成绝对路径；含 `/` 原样执行；
  找不到时报错并点名 `PATH`；请求不带 `PATH` 时报错而不是读代理自己的环境。
  （落点：`mount-proxy-rs/src/exec.rs` 的 `resolves_bare_program_through_request_path` 与
  `reports_missing_program_with_request_path`）
- **RT-5**：请求分发的前置判定——非 Overlay 归属回 `{ ok: false, error }`（点名「不是
  Overlay 归属」）；隔离归属但视图建不起来同样回失败侧而非退回磁盘。
  （落点：`core-rs/src/main_tests.rs` 的
  `work_view_files_request_reports_missing_arguments_and_unmounted_view`）
- **RT-6**：取数路径的越界校验在**建立视图之前**生效——绝对路径 / `..` 分量 / 反斜杠一律
  拒绝，合法相对路径放行；非法请求不触发拉起代理这类副作用。
  （落点：`core-rs/src/work_view_changes_tests.rs` 的 `relative_path_check_rejects_escapes`）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1 / RT-2 / RT-3（修复前） | `npx playwright test -c e2e/playwright.config.ts --project=electron-ssh -g "资源管理器"` | 红 | 树为空数组：`Expected value: "readme.md" / Received array: []`（侧栏停在折叠态没展开，见备注 1）；修复前用诊断脚本直击同一路径：`filesListOverlay` 回「没有已挂载的 Overlay 视图」、`filesDocListOverlay` 回 `git rev-parse 失败：` |
| RT-5（修复前） | `cargo test --bin standalone-core work_view_files_request` | 红 | 旧断言只覆盖「没有已挂载的视图」这一条；新增的「非 Overlay 归属」分支在旧实现里回的是同一句「没有已挂载的视图」，不点名归属 |
| RT-4（修复前） | `cargo test --manifest-path mount-proxy-rs/Cargo.toml` | 红 | `resolve_executable` 尚不存在（编译期失败） |
| RT-4（修复后） | `cargo test --manifest-path mount-proxy-rs/Cargo.toml` | 绿 | 9 passed / 0 failed（新增两条 PATH 解析用例：裸名解析与缺 PATH 报错） |
| RT-5（修复后） | `cargo test --bin standalone-core work_view_files_request` | 绿 | 1 passed / 0 failed |
| RT-6（修复前） | `cargo test --bin standalone-core relative_path_check` | 红 | 断言「`/etc` 必须被拒绝」失败：旧实现把绝对路径当相对路径，只是后续列目录失败才显得被拒 |
| RT-6（修复后） | `cargo test --bin standalone-core relative_path_check` | 绿 | 1 passed（绝对路径 / `..` / 反斜杠拒，合法相对路径放行） |
| 慢请求分流 | `cargo test --bin standalone-core slow_ui_requests_run_off_the_frame_loop` | 绿 | 列目录改走独立线程（视图未建立时它会拉起代理，留在帧循环里会压住后续帧） |
| 代理 Linux 目标编译 | `cargo check --manifest-path mount-proxy-rs/Cargo.toml --target x86_64-unknown-linux-musl --tests` | 绿 | — |
| Core 编译 | `cargo check --bin standalone-core --tests`（`core-rs/`） | 绿 | 仅有既有 dead_code 警告 |
| 全量 Core 回归 | `npm run test:core` | 绿 | standalone-core 1210 passed / 0 failed（194s）；mount-proxy 9 passed / 0 failed |
| 单元回归 | `npm run test:unit` | 绿 | 113 通过 / 0 失败 / 2 跳过（`sidebarDocViewGit`、`sidebarFiles` 因本机 git 前置走 skip 分支） |
| 类型检查 | `npm run check-types` | 绿 | 四份配置（main / webview / electron / e2e） |
| Lint | `npm run lint` | 绿 | — |
| 文档一致性 | `npm run test:unit -- docs-lint` | 绿 | 49 + 6 全过 |
| RT-1 / RT-2 / RT-3（修复后） | `npx playwright test -c e2e/playwright.config.ts --project=electron-ssh -g "FR-002/FR-003 资源管理器"` | 绿 | 1 passed（15.4s），见备注 2 |

备注：

1. 首次跑红时是**用例自身**的展开逻辑写错了（`expect().toHaveClass().catch()` 不构成判据，
   分区没展开，折叠态按设计不渲染也不读目录），换成 `remoteChangeList.spec.ts` 的幂等写法后
   重跑。缺陷本身的证据来自修复前的诊断脚本（`filesListOverlay` / `filesDocListOverlay`
   的实际回包，见「现状」两段实测）。
2. 修复后同一条 e2e：真实 SSH 远端、真实 Core 与代理、未调用工具就展开资源管理器——树上出现
   `readme.md` / `src`，Write 之后出现只在视图里的文件且磁盘上没有它，变更清单返回 `ok: true`
   并把该文件列进渲染行（`rows`，`plus: 1`）。
3. 过程中另有一条**用例自身的**读错字段：`filesDocListOverlay` 的回包是侧栏已组装的渲染行
   （`rows[].rel`），不是 Core 的 `entries[].path`；断言改正后转绿。
4. e2e 依赖 `dist/resources/core/` 里的二进制，而 `npm run build:core:linux-x64` 落的是
   `resources/core/`：两次跑红其实是旧二进制，`npm run copy-assets` 之后才是修复后的产物。
   验证记录里的绿跑都发生在 `copy-assets` 之后。
