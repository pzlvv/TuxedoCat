---
status: 实施中
---

# 改动规格：Bash 工具 detach 字段——后台化构造闸门与脱离管理授权

Bash 工具新增 `detach` 字段（默认 `false`）。缺省时，命令中出现「会让进程脱离工具
追踪」的写法（`nohup`、控制操作符位的单 `&`、`setsid`、`disown`、`start /b`、
`Start-Process`）直接失败并给出路由判据；模型确需脱离管理（如装系统级服务）时带
`detach: true` 重试，此时命令放行且按危险操作走权限确认。`detach: true` 是**管辖
豁免开关**而非执行模式：豁免后进程不进后台任务事实、无完成通知、abort 不杀。
文案分两面：LLM 面只写场景路由（不写 agent 内部机制），用户弹窗面写场景 + 代价。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| `<docs/features/bash-detach.md>` | — | 新增 | detach 字段的行为规格（闸门 / 豁免语义 / 授权 / 双面文案）。Bash 工具执行面契约，[background-bash.md](../../docs/features/background-bash.md) 的后台任务范围装不下 |
| `<docs/adr/0014-bash-detach-escape-hatch.md>` | — | 新增 | 「豁免开关而非执行模式」「auto 模式同破坏性命令待遇且零模态可见」的决策背景与被否方案 |
| [docs/core/standalone-core.md](../../docs/core/standalone-core.md) | [第 4 节](../../docs/core/standalone-core.md#4-契约) | 修改 | `risk` 模式的「危险操作」判据扩入：Bash 携带 `detach: true` 且命令命中后台化构造 |
| [docs/features/background-bash.md](../../docs/features/background-bash.md) | [第 4 节](../../docs/features/background-bash.md#4-边界与错误路径) | 修改 | 补交叉引用：`detach: true` 的进程不属于后台任务事实（只留链接，不复述） |
| [docs/features/user-stories/tools.md](../../docs/features/user-stories/tools.md) | [EP-7](../../docs/features/user-stories/tools.md#ep-7-工具与技能) | 修改 | 新增 US-67 |
| [docs/features/user-stories.md](../../docs/features/user-stories.md) | 附录 | 修改 | US-67 的 e2e 映射（豁免登记） |

## 用户场景与验收标准

- 场景 1：模型误用后台化写法，被闸门拦下并教学
  - **AC-1**（FR-001）：GIVEN `detach` 缺省 WHEN 命令含 `nohup` 段首词 THEN 工具返回失败，文案点名 `nohup` 并给出「前台 / `run_in_background: true` / `detach: true`」三条出路
  - **AC-2**（FR-001）：GIVEN `detach` 缺省 WHEN 命令在控制操作符位含单 `&`（如 `server &`）THEN 失败并点名 `&`
  - **AC-3**（FR-001）：GIVEN `detach` 缺省 WHEN 命令含 `setsid` / `disown` / `start /b` / `Start-Process` 段首词 THEN 失败并点名对应构造
  - **AC-4**（FR-001）：GIVEN `detach` 缺省 WHEN `&` 只出现在引号内或 `&&` 中 THEN 命令正常执行，不误拦
  - **AC-5**（FR-001）：GIVEN `detach` 缺省 WHEN 命令含未加引号 URL 的 `&`（如 `curl http://x?a=1&b=2`）THEN 失败并点名 `&`——它对 shell 就是后台控制操作符，不算误报
- 场景 2：模型显式申请脱离管理
  - **AC-6**（FR-002）：GIVEN `detach: true` 且权限放行 WHEN 命令含后台化构造 THEN 命令照常执行；不产生后台任务记录、完成时不注入通知、会话 `background` 事实不置位
  - **AC-7**（FR-002）：GIVEN `detach: true` WHEN 命令不含任何后台化构造 THEN 照常执行（字段惰性，不报错）
  - **AC-8**（FR-002）：GIVEN `detach: true` WHEN 命令为未自我脱离的前台长命令且到前台超时 THEN 仍按既有自动转后台路径处理，转入后台后按既有后台任务事实处理（登记、完成通知、`background` 事实置位）
- 场景 3：脱离管理前经用户授权
  - **AC-9**（FR-003）：GIVEN `risk` 模式 WHEN Bash 携带 `detach: true` 且命中构造 THEN 弹确认框（⚠️ 文案含场景与代价，选项「允许执行 / 拒绝」）；拒绝则命令不执行
  - **AC-10**（FR-003）：GIVEN `manual` 模式 WHEN Bash 携带 `detach: true` 且命令命中构造 THEN 弹 ⚠️ 确认框，选项「允许执行 / 拒绝」
  - **AC-11**（FR-003）：GIVEN `auto` 模式 WHEN Bash 携带 `detach: true` 且命令命中构造 THEN 不弹窗、不做任何非模态标记，命令直接执行（零可见是明示决策，见 ADR-0014）
  - **AC-12**（FR-003）：GIVEN `risk` 模式 WHEN Bash 携带 `detach: true` 但命令不含构造 THEN 不弹窗放行
- 场景 4：闸门与权限判据同源
  - **AC-13**（FR-004）：GIVEN 同一命令串 WHEN 分别经工具闸门与权限分级判定 THEN 判定一致——闸门命中的构造在权限判据下同样命中，反之亦然

## 功能需求

### FR-001：后台化构造闸门

Bash 工具的 `detach` 字段为布尔、缺省 `false`。缺省或为 `false` 时，命令中出现
后台化构造——控制操作符位的单 `&`（`&&` 与引号内不算）、段首词 `nohup` / `setsid` /
`disown` / `start /b` / `Start-Process`——工具返回失败，不执行。失败文案点名命中的
构造，且只写模型可感知的路由判据（本会话要结果走前台或 `run_in_background: true`；
会话结束后仍要存活——如系统级服务、守护进程——带 `detach: true` 重试），不写
完成通知、追踪注册表等 agent 内部机制。

### FR-002：detach=true 的豁免语义

`detach: true` 表示该命令的进程脱离工具管辖：命令原样执行，不进后台任务注册表、
完成时不注入通知、会话 `background` / `idle` 事实不因它变化、中止会话不杀它。
豁免只作用于闸门，不改变前台生命周期：命令若未自我脱离（如裸 `nohup` 不带 `&`），
管道持有、前台超时、自动转后台等既有行为照旧。`detach: true` 但命令不含任何构造时
字段惰性，正常执行。

### FR-003：脱离管理的授权分级

Bash 调用携带 `detach: true` 且命令命中后台化构造时，按危险操作参与权限分级：
`manual` 弹确认框（⚠️ 前缀）、`risk` 询问（此前放行）、`auto` 放行（与现有破坏性
命令同待遇）。确认文案写场景与代价（进程在本会话结束后继续运行；脱离工具追踪：
无完成通知、中止会话不会杀掉它），选项沿用「允许执行 / 拒绝」。`auto` 模式下
不弹窗也不做任何非模态标记（徽标 / 结果回显），零可见是该模式下的明示决策——
与现有破坏性命令的处理一致，理由记录于 ADR-0014。

### FR-004：检测与文案的唯一来源

后台化构造的检测逻辑仓库内只有一份实现，闸门（FR-001）与权限分级（FR-003）共用
同一判据。LLM 面失败文案与用户面确认文案逐字锁定（对等测试）。system prompt 与
工具 schema 的 `detach` 描述保持最小防护性口径，不展开用法与案例——详细用法只出现
在失败报错与确认弹窗里。

## 边界与错误路径

- **字符串检测的边界**（以下情形均放行，写入 as-built 文档）：脚本内藏构造
  （`bash deploy.sh` 内部的 `nohup`）；`$()` / 反引号命令替换内部整体跳过
  （`echo $(nohup x &)` 可穿过）；`eval` / `sh -c` 的字符串参数内部不展开；
  `ssh` 远端命令串；换行不是分隔符，非首段的段首词不参与段首词判定。威胁模型是
  非对抗性误用——检测拦的是模型的顺手写法，不防御有意绕过。
- **检测误报**：引号感知与控制操作符位判定之外的残余误报，表现为工具失败报错，
  模型可改写重试——温和失败，无数据损失，不做白名单。未加引号 URL 中的 `&` 不算
  误报：它对 shell 就是后台控制操作符，拦截并点名是正确行为。
- **检测不区分 shell 类型**：bash 下无意义的 `start /b` 同样被点名；多拦无害，
  不做按 shell 的构造集合。
- **闸门与权限的时序**：权限确认先于执行，闸门失败发生在工具执行期。`risk` 模式
  的完整体验是「第一轮报错教学 → 带 `detach: true` 重试 → 弹窗授权」。
- **豁免进程持有前台管道**：与现状同口径，不因 `detach: true` 改变管道 EOF 判据。

## 非目标

- **不追踪 detach 进程**：进程脱离 shell 后工具没有 owned 句柄，扫进程表按命令行
  反推归属违反[架构原则第 7 节](../../docs/architecture/principles.md#7-一份事实只有一个写入点)——
  设计结论，不做。
- **不做工具级 detach 执行模式**（由工具代为 detached spawn 并持句柄）：被否决的
  替代方案，决策与理由见 ADR-0014。
- **不做持久授权 / 白名单**（「本会话总是允许」）：如需要另起 spec。
- **auto 模式豁免的非模态可见性**（Bash 卡片徽标、结果回显等）：零可见是明示决策
  （ADR-0014）；如需要，另起 spec。
- **system prompt 不新增 detach 用法说明**：保持现有「Do not use `&` or `nohup`」
  一行不变。
- **不动既有后台任务行为**：`run_in_background`、自动 / 手工转后台、提醒、完成
  通知全部不变。

## 对需求基线的影响

新增 **US-67**（命令脱离工具管理前须用户确认，登记在 EP-7）：闸门、豁免语义与
权限判据由 Rust 单测锁定；确认弹窗复用既有权限确认组件（US-18 的 e2e 已覆盖渲染
与提交链路），按 user-stories 附录既有口径登记 e2e 豁免。无其他 US 变更。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `core-rs/src/tools.rs`（`run_bash` 入口闸门与失败文案） | `core-rs/src/tools_tests.rs` | 自动 |
| FR-002 | `core-rs/src/tools.rs` | `core-rs/src/tools_tests.rs` | 自动 |
| FR-003 | `core-rs/src/permission.rs`（危险操作判据、确认文案与选项） | `core-rs/src/permission_tests.rs`（权限对照表） | 自动 |
| FR-004 | `core-rs/src/tools.rs`（检测纯函数 + 两面文案常量） | `core-rs/src/tools_tests.rs`（对等测试） | 自动 |

## 待澄清

（无）

## 收敛记录

收敛时由 /converge 填写，结论只分三类。

- 已满足：<FR / AC → 证据（实现与测试落点）>
- 偏差：<与 spec 的差异；改代码或改 spec 并留痕>
- 未做：<回写 tasks.md 的未完成项>
