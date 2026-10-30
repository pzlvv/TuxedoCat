# 实施方案：Bash 工具 detach 字段——后台化构造闸门与脱离管理授权

技术路线：全部代码改动落在 core-rs 两个文件——`tools.rs`（检测纯函数 + 闸门 +
两面文案 + schema 字段）与 `permission.rs`（危险判据扩展 + 确认文案/选项）；
授权弹窗复用既有 `CoreRequest.userChoice` 链路，**无总线契约、事件、wire、落盘
变更**。需求口径见同目录 [spec.md](spec.md)。

## 技术方案

### 1. 检测纯函数（`tools.rs`，与 `contains_sleep_command` 同区）

`pub fn find_detach_construct(command: &str) -> Option<&'static str>`——返回命中的
构造名（`"nohup"` / `"&"` / `"setsid"` / …）供两面文案点名，仓库内唯一实现，
闸门与权限分级共用（spec FR-004）。两类判定：

- **段首词**：`permission::split_by_separators`（引号感知拆段）→ `extract_command_name`
  取首词 → 匹配 `nohup` / `setsid` / `disown`（精确）；`Start-Process` 按 PowerShell
  惯例小写比对；`start` 仅当第二 token 以 `/b` 开头才命中（bash 下裸 `start` 不误拦）。
- **控制操作符 `&`**：引号感知逐字符扫描（复用 `split_by_separators` 的 `scan_quoted`
  扫描思路）：`&&` 跳过两字符；`&>` / `&>>`（bash 双流重定向，前台语义）不命中；
  其余位置的 `&` 命中。未加引号 URL 的 `&` 因此被拦——spec AC-5 锁定为正确行为。

### 2. Bash 工具 schema（`tools.rs` 的 TOOLS 数组，`run_in_background` 旁）

新增 `"detach": { "type": "boolean", "description": BASH_DETACH_FIELD }`，可选成员
（工具入参非总线契约，缺省性与 `run_in_background` 同口径）。`BASH_DETACH_FIELD`
一句防护性口径，不展开用法与案例（spec FR-004）。读取统一 `js_coerce_bool`——
缺省即 `false`，无第二处默认值定义。

### 3. 闸门（`run_bash` 入口）

位置在 `command` 提取之后、`run_in_background` 分支**之前**：后台调用同样受闸门
约束（FR-001 不限前台——`run_in_background: true` 里再写 `nohup x &` 的孙进程
同样逃出任务追踪）。判定：`detach` 判假 **且** `find_detach_construct` 命中 →
`ToolOutcome::Error(失败文案)`。失败文案常量逐字锁定（对等测试），构造名插值：

```text
Bash: command uses `{construct}`.
- Need the result in this session: run in the foreground, or use run_in_background: true (notifies on completion).
- Need it to keep running after this session ends — e.g. installing/starting a system-level service or daemon: re-run the same command with detach: true.
```

### 4. 权限分级（`permission.rs`）

- `is_operation_risky`：Bash 且（`is_destructive_command(command)` **或**
  （`js_coerce_bool(args.get("detach"))` 且 `find_detach_construct(command)` 命中））。
  `permission.rs → tools.rs` 的依赖方向与既有 `SUB_AGENT_ROLES` 引用一致。
- `ask_message` / `ask_choices` 的 Bash 分支：判定条件从 `is_destructive_command`
  换成 `is_operation_risky(tool_name, args)`（危险清单此后单源）；detach 逃生用
  **专用文案**（区别于 `⚠️ 请求执行：`）：

  ```text
  ⚠️ 请求脱离管理执行：{command}
  （进程将脱离工具追踪：无完成通知、中止会话不会杀掉它、会话结束后继续运行；适用于系统级服务等常驻场景）
  ```

  选项沿用危险分支的「允许执行 / 拒绝」。
- `decide` 的 auto 分支**不改**：现状即无条件放行，零可见是明示决策（spec AC-11、
  ADR-0014），无代码落点。

### 5. 数据流（risk 模式完整体验）

模型发 `detach:false` + `nohup` → 权限放行（不算危险）→ 闸门 `Error` 教学 →
模型带 `detach: true` 重试 → `is_operation_risky = true` → `ask` →
`CoreRequest.userChoice` 弹窗（专用文案）→ 允许 → 闸门放行执行。manual 模式
每一步本就询问；auto 模式两步都静默。

### 6. 文档（与代码同一提交收敛）

新增 `docs/features/bash-detach.md`（七节骨架：场景 / FR / 行为规格 / 边界 /
非目标 / 基线影响 / 追溯矩阵）并登记 `docs/README.md` 地图；新增
`docs/adr/0014-bash-detach-escape-hatch.md`（豁免开关 vs 执行模式、auto 零可见、
业界对照——Claude Code 30min/2h 封顶推nohup 逃逸、dsh job 自始注册、OpenCode
无模型侧字段）；修改 `docs/core/standalone-core.md` 第 4 契约的 agentMode bullet
（危险判据扩入 detach 逃生，并点明与 `is_destructive_command` 首词口径的差异）、
`docs/features/background-bash.md` 第 4 节交叉引用（detach 进程不属于后台任务
事实）、`docs/features/user-stories/tools.md` 新增 US-67、
`docs/features/user-stories.md` 附录登记 e2e 豁免。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `core-rs/src/tools.rs` | 新增 `find_detach_construct`、闸门、两面文案常量、`BASH_DETACH_FIELD`、schema `detach` 成员 | 无（工具入参，非总线契约） |
| `core-rs/src/permission.rs` | `is_operation_risky` / `ask_message` / `ask_choices` | 无（复用 `CoreRequest.userChoice` 既有载荷，无新成员） |
| `core-rs/src/tools_tests.rs` | 闸门 / 豁免 / 惰性 / 回流 / 文案对等测试 | — |
| `core-rs/src/permission_tests.rs` | 权限对照表三模式 × detach 用例、确认文案测试 | — |
| `core-rs/src/prompt.rs` | **不改**（非目标：system prompt 保持一行禁令） | — |
| docs 六处 + `docs/README.md` | 见技术方案第 6 节 | — |

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：改动全部在 core-rs 内；`permission.rs →
      tools.rs` 依赖方向与既有 `SUB_AGENT_ROLES` 引用一致；无 TS / host / webview
      改动，不触 `no-restricted-imports` 约束面。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：不过度 fallback——闸门显式拒绝 + 教学，无静默
      降级；铁律 2 约束的是总线契约成员，工具入参的省略语义与 `run_in_background`
      同口径；检测一份实现、闸门与权限两处消费（原则 7：一份事实只有一个写入点）；
      `detach` 缺省 `false` 的读取口径唯一（`js_coerce_bool`），无第二处默认值定义。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：Core 行为改动与测试同步落在
      `core-rs/`（tools_tests / permission_tests）；不触 `src/shared/history/` 共享
      落盘格式——两套 Core parity 不涉及（remote 与 standalone 是同一二进制的传输
      形态，无第二套实现需同步）。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：第 6 节清单与代码同一提交收敛；
      `npm run test:unit -- docs-lint` 为闸门（spec 阶段已验证链接锚点与结构检查覆盖
      specs/ 文件）。

## 被否决的替代方案

1. **工具级 detach 执行模式**（由工具代为 detached spawn 并持句柄登记）：用户决策
   为「管辖豁免开关」——豁免即声明脱离管理，工具不假装追踪；→ ADR-0014。
2. **进程表扫描追踪 detach 进程**（按命令行反推归属）：违反[架构原则第 7 节](../../docs/architecture/principles.md#7-一份事实只有一个写入点)（一份
   事实只有一个写入点，禁止从投影反推事实），不做。
3. **闸门只覆盖前台路径**：否——`run_in_background` 分支里写 `nohup x &` 的孙进程
   同样逃出任务追踪，闸门必须在分支之前（技术方案第 3 节）。
4. **真 shell 解析器做检测**（OpenCode `ShellParse.scan` 路线）：解析器引入成本与
   词法检测的收益不成比例；威胁模型是非对抗性误用，`$()` / 换行等残余盲区已按
   spec 边界声明放行。留后续，视实际误报 / 绕过报告立项。
5. **auto 模式做徽标 / 结果回显**：零可见为明示决策（与破坏性命令同待遇），→
   ADR-0014；如需要另起 spec。
6. **持久授权白名单**（「本会话总是允许」）：范围外，如需要另起 spec。
