---
owner: pzlvv
last_reviewed: 2026-10-30
---

# 规格：Bash 命令的 detach 豁免

Bash 工具的 `detach` 字段是**管辖豁免开关**：命令的进程需要脱离工具追踪（会话结束
后继续存活的系统级服务等场景）时，模型必须显式声明。缺省（`false`）下命令出现会让
进程脱离追踪的写法（后台化构造）直接失败并被引导到正确通道；`true` 时命令放行且
脱离后台任务事实，是否要用户授权由权限分级决定（manual / risk 弹确认框、auto 静默
放行）。后台任务自身的登记、提醒与完成通知见
[background-bash.md](background-bash.md)。

## 1. 用户场景与验收标准

- 场景 1：模型误用后台化写法，被闸门拦下并教学
  - **AC-1**（FR-001）：GIVEN `detach` 缺省 WHEN 命令含 `nohup` 段首词 THEN 工具返回失败，文案点名 `nohup` 并给出「前台 / `run_in_background: true` / `detach: true`」三条出路
  - **AC-2**（FR-001）：GIVEN `detach` 缺省 WHEN 命令在控制操作符位含单 `&`（含未加引号 URL 中的 `&`）THEN 失败并点名 `&`
  - **AC-3**（FR-001）：GIVEN `detach` 缺省 WHEN 命令含 `setsid` / `disown` / `start /b` / `Start-Process` 段首词 THEN 失败并点名对应构造
  - **AC-4**（FR-001）：GIVEN `detach` 缺省 WHEN `&` 只出现在引号内或 `&&` / `&>` / `>&` 中 THEN 命令正常执行，不误拦
- 场景 2：模型显式申请脱离管理
  - **AC-5**（FR-002）：GIVEN `detach: true` 且权限放行 WHEN 命令含后台化构造 THEN 命令照常执行；不产生后台任务记录、完成时不注入通知、会话 `background` 事实不置位
  - **AC-6**（FR-002）：GIVEN `detach: true` WHEN 命令不含任何后台化构造 THEN 照常执行（字段惰性，不报错）
  - **AC-7**（FR-002）：GIVEN `detach: true` WHEN 命令为未自我脱离的前台长命令且到前台超时 THEN 仍按既有自动转后台路径处理，转入后台后按既有后台任务事实处理
- 场景 3：脱离管理前经用户授权
  - **AC-8**（FR-003）：GIVEN `risk` / `manual` 模式 WHEN Bash 携带 `detach: true` 且命中构造 THEN 弹 ⚠️ 确认框（场景 + 代价，选项「允许执行 / 拒绝」）；拒绝则命令不执行
  - **AC-9**（FR-003）：GIVEN `auto` 模式 WHEN Bash 携带 `detach: true` 且命中构造 THEN 不弹窗、不做任何非模态标记，命令直接执行（零可见是明示决策，见 [ADR-0014](../adr/0014-bash-detach-escape-hatch.md)）
  - **AC-10**（FR-003）：GIVEN `risk` 模式 WHEN Bash 携带 `detach: true` 但命令不含构造 THEN 不弹窗放行
  - **AC-11**（FR-004）：GIVEN 同一命令串 WHEN 分别经工具闸门与权限分级判定 THEN 判定一致——闸门命中的构造在权限判据下同样命中，反之亦然

## 2. 功能需求

### FR-001：后台化构造闸门

`detach` 为布尔、缺省 `false`。缺省或 `false` 时，命令出现后台化构造——控制操作符位
的单 `&`（`&&` / 引号内 / `&>` / `&>>` / `>&` 不算）、段首词 `nohup` / `setsid` /
`disown` / `start /b` / `Start-Process`——工具返回失败、不执行（闸门在
`run_in_background` 分支之前：后台调用里写 `nohup x &` 的孙进程同样逃出任务追踪）。
失败文案点名命中的构造，只写模型可感知的路由判据（见第 3.2 节），不写 agent 内部
机制。

### FR-002：detach=true 的豁免语义

`detach: true` 表示该命令的进程脱离工具管辖：命令原样执行，不进后台任务注册表、
完成时不注入通知、会话 `background` / `idle` 事实不因它变化、中止会话不杀它。豁免
只作用于闸门，不改变前台生命周期：命令若未自我脱离，管道持有、前台超时、自动转
后台等既有行为照旧（转后台后按既有后台任务事实处理）。`detach: true` 但命令不含
任何构造时字段惰性，正常执行。

### FR-003：脱离管理的授权分级

Bash 调用携带 `detach: true` 且命令命中后台化构造时按危险操作参与权限分级
（[standalone-core.md 第 4 节](../core/standalone-core.md#4-契约)）：`manual` 弹
⚠️ 确认框、`risk` 询问、`auto` 放行且零模态可见（与破坏性命令同待遇，
[ADR-0014](../adr/0014-bash-detach-escape-hatch.md)）。确认文案写场景与代价，
选项沿用「允许执行 / 拒绝」（见第 3.2 节）。

### FR-004：检测与文案的唯一来源

后台化构造的检测仓库内只有一份实现（`tools.rs` 的 `find_detach_construct`），闸门
与权限分级共用同一判据。LLM 面失败文案与用户面确认文案逐字锁定（对等测试）。
system prompt 与工具 schema 的 `detach` 说明保持一句防护性口径，不展开用法与案例
——详细用法只出现在失败报错与确认弹窗里。

## 3. 行为规格

### 3.1 实现对照

- 检测纯函数：`tools.rs` 的 `find_detach_construct` 返回命中的构造名供两面文案点名。
  段首词经 `permission::split_by_separators`（引号感知拆段）+ `extract_command_name`
  取首词；`&` 走独立的引号感知扫描，`&&` / `&>` / `&>>` / `>&` 不算后台化。段首词
  优先于 `&`（`nohup server &` 点名 `nohup`）。`Start-Process` 按 PowerShell 大小写
  不敏感口径比对；`start` 仅当第二 token 恰为 `/b`（大小写不敏感）才命中。
- 闸门：`run_bash` 入口、`run_in_background` 分支之前；`detach` 读取经
  `js_coerce_bool`（缺省即 `false`）。
- 权限分级：`permission.rs` 的 `is_detach_escape`（`detach: true` **且**命中构造）
  并入 `is_operation_risky`；`ask_message` / `ask_choices` 以同一谓词分流专用文案
  与「允许执行 / 拒绝」选项。

### 3.2 文案（逐字锁定）

LLM 面失败文案（`tools.rs` 的 `BASH_DETACH_GATE_MESSAGE`，`{}` 处插构造名）：

```text
Bash: command uses `nohup`.
- Need the result in this session: run in the foreground, or use run_in_background: true (notifies on completion).
- Need it to keep running after this session ends — e.g. installing/starting a system-level service or daemon: re-run the same command with detach: true.
```

用户面确认文案（`permission.rs` 的 `ask_message` Bash 分支）：

```text
⚠️ 请求脱离管理执行：{command}
（进程将脱离工具追踪：无完成通知、中止会话不会杀掉它、会话结束后继续运行；适用于系统级服务等常驻场景）
```

## 4. 边界与错误路径

- **字符串检测的边界**（以下情形均放行）：脚本内藏构造（`bash deploy.sh` 内部的
  `nohup`）；`$()` / 反引号命令替换内部整体跳过；eval / `sh -c` 的字符串参数内部
  不展开；`ssh` 远端命令串；换行不是分隔符，非首段的段首词不参与段首词判定。
  威胁模型是非对抗性误用——检测拦的是模型的顺手写法，不防御有意绕过。
- **误报口径**：未加引号 URL 中的 `&` 对 shell 就是后台控制操作符，拦截并点名是
  正确行为、不算误报；其余残余误报表现为工具失败报错，模型可改写重试——温和失败，
  无数据损失，不做白名单。
- **判据口径差异**：`is_destructive_command`（`dd` / `mkfs` 等）只看第一个子命令，
  detach 逃生判据扫描全命令——两者并存于 `is_operation_risky`，口径差异是刻意的。
- **豁免进程持有前台管道**：与现状同口径，`detach: true` 不改变管道 EOF 判据。

## 5. 非目标

- **不追踪 detach 进程**：进程脱离 shell 后工具没有 owned 句柄，扫进程表按命令行
  反推归属违反[架构原则第 7 节](../architecture/principles.md#7-一份事实只有一个写入点)。
- **不做持久授权 / 白名单**（「本会话总是允许」）。
- **不做 auto 模式的非模态可见性**（徽标 / 结果回显）：零可见是明示决策
  （[ADR-0014](../adr/0014-bash-detach-escape-hatch.md)）。
- **system prompt 不变**：保持现有「Do not use `&` or `nohup`」一行，不展开 detach
  用法。

## 6. 对需求基线的影响

新增 **US-67**（命令脱离工具管理前须用户确认，见
[user-stories/tools.md](user-stories/tools.md) EP-7），e2e 豁免登记见
[user-stories.md](user-stories.md) 附录。

## 7. 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `core-rs/src/tools.rs`（`run_bash` 闸门 + `BASH_DETACH_GATE_MESSAGE`） | `core-rs/src/tools_tests.rs`（`bash_gate_*`） | 自动 |
| FR-002 | `core-rs/src/tools.rs` | `core-rs/src/tools_tests.rs`（`bash_detach_true_*`） | 自动 |
| FR-003 | `core-rs/src/permission.rs`（`is_detach_escape` / `ask_message` / `ask_choices`） | `core-rs/src/permission_tests.rs`（`detach_escape_*` 等） | 自动 |
| FR-004 | `core-rs/src/tools.rs`（`find_detach_construct` + `BASH_DETACH_FIELD`） | `core-rs/src/tools_tests.rs`（`find_detach_construct_*`）与 `fixtures/toolSchema.json` 对照表 | 自动 |
