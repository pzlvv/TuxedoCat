---
status: 已收敛
---

# 改动规格：Bash 的 sleep 等待闸门

模型等一条后台任务时爱写 `sleep 30 && cat <输出文件>` 或 `sleep 60; npm test`：命令以
`sleep` 开头、后面还跟着真正要做的事。这类写法把等待交给计时器，而 core 在后台任务完成时
本来就会通知并接续，模型白等一轮、还多拿一条迟到结果。本次改动在 Bash 调用入口加一道闸门：
**命令以 `sleep` 开头且后面还有其它命令**时直接失败、不执行，失败文案给出「不要主动 sleep
等结果」的提醒与「确实需要延时就往 sleep 前面加任意命令」的逃逸写法。

交叉引用：后台任务的完成通知与接续见 [docs/features/background-bash.md 第 2 节](../../docs/features/background-bash.md#2-功能需求)；
既有 Bash 后台化构造闸门与 detach 逃逸见 [docs/features/bash-detach.md 第 2 节](../../docs/features/bash-detach.md#2-功能需求)；
`sleep` 子命令与 `sleep` 时长口径见 [docs/core/standalone-core.md 第 3 节](../../docs/core/standalone-core.md#3-core-形态)；
「不过度 fallback」见 [principles.md](../../docs/architecture/principles.md)。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/features/background-bash.md](../../docs/features/background-bash.md#2-功能需求) | [用户场景与验收标准](../../docs/features/background-bash.md#1-用户场景与验收标准) / [功能需求](../../docs/features/background-bash.md#2-功能需求) / [行为规格](../../docs/features/background-bash.md#3-行为规格) / [边界与错误路径](../../docs/features/background-bash.md#4-边界与错误路径) / [追溯矩阵](../../docs/features/background-bash.md#7-追溯矩阵) | 修改 | 新增 FR-005（sleep 等待闸门）与对应 AC；开篇范围句从「手工转后台 + 提醒」扩到含本闸门；[行为规格](../../docs/features/background-bash.md#3-行为规格) 补一条实现对照行与逐字锁定的失败文案 |
| [docs/features/bash-detach.md](../../docs/features/bash-detach.md#2-功能需求) | [功能需求](../../docs/features/bash-detach.md#2-功能需求) | 修改 | `detach: true` 的豁免语义补一句：豁免只作用于后台化构造闸门，不解除 sleep 等待闸门（只留链接，不复述判据） |
| [docs/features/user-stories/tools.md](../../docs/features/user-stories/tools.md#ep-7-工具与技能) | EP-7 工具与技能 | 修改 | 新增 US-76（后台等待不靠 sleep 轮询） |
| [docs/features/user-stories.md](../../docs/features/user-stories.md#附录us-与-e2e-场景用例映射) | 目录收录 / 未覆盖 e2e 的 US | 修改 | 分册收录表加 US-76；豁免段登记理由 |
| `core-rs/fixtures/permission.json` | 权限决策对照表 | 修改 | 补 7 条 sleep 闸门用例（三档 deny、换行、`&` 放行、单条 sleep、逃逸写法） |

## 用户场景与验收标准

- 场景 1：拦截前导 sleep 的等待写法
  - **AC-1**（FR-001）：GIVEN Bash 调用（前台 / `run_in_background` / `detach` 任一形态）WHEN 命令按 `;` / `&&` / `||` / 换行切分后首段命令名是 `sleep` 且后面还有非空、非纯注释的命令 THEN 工具结果为失败态（`is_error`），命令不执行
  - **AC-2**（FR-001）：GIVEN 命令是 `sleep 30 && cat a.txt` WHEN 调用 THEN 被拦；`cat a.txt; sleep 30` 与 `sleep 30` 两种写法不被拦，照常执行
  - **AC-3**（FR-001）：GIVEN 命令是 `sleep 10` 后接换行再跟 `cat a.txt` WHEN 调用 THEN 被拦——换行不是逃逸口
  - **AC-4**（FR-001）：GIVEN 命令是 `echo 'sleep 10 && cat a.txt'`（整段在引号内） WHEN 调用 THEN 不被拦
- 场景 2：失败文案
  - **AC-5**（FR-002）：GIVEN 调用被拦 WHEN 读取工具结果 THEN 文本等于[失败文案](#失败文案逐字锁定)锁定的那段提醒，逐字一致
  - **AC-6**（FR-002）：GIVEN 调用被拦 WHEN 观察本轮 THEN 不弹权限确认框、不产生后台任务、不产生 taskId、不发完成通知与提醒
- 场景 3：逃逸与放行
  - **AC-7**（FR-003）：GIVEN 命令是 `echo anything; sleep 10` WHEN 调用 THEN 不被拦，正常执行（文案给出的逃逸写法本身可用）
  - **AC-8**（FR-003）：GIVEN 首段不是 `sleep`（`npm run build && sleep 5`、`printf x; sleep 1`） WHEN 调用 THEN 不被拦
  - **AC-9**（FR-003）：GIVEN 命令是 `sleep 5`（无后续命令） WHEN 调用 THEN 不被拦，照常执行并按既有 sleep 口径后移前台死线
- 场景 4：与既有闸门和模式的边界
  - **AC-10**（FR-004）：GIVEN `detach` 缺省且命令是 `sleep 10 && nohup x &`（两条闸门都命中） WHEN 调用 THEN 报本闸门的文案（不是后台化构造闸门的文案）
  - **AC-11**（FR-004）：GIVEN 命令是 `sleep 10 # wait` 且没有其它非注释命令 WHEN 调用 THEN 不被拦——只有单段加注释，不构成「先等再干」
  - **AC-12**（FR-004）：GIVEN `manual` / `risk` / `auto` 三种工作模式 WHEN 同一命令被拦 THEN 三种模式下的失败文案与行为完全相同（闸门不是权限分级，不受 agentMode 影响）
  - **AC-13**（FR-004）：GIVEN 会话处于 spin、子代理或跨工作区派发路径 WHEN 命令命中闸门 THEN 与主会话同样失败

## 功能需求

### FR-001：判定

Bash 工具的每次调用在执行前过一道 sleep 等待闸门。命中条件（全部成立）：

1. **首段命令名是 `sleep`**：与既有 sleep 识别同一口径——按 `;` / `&&` / `||` / `|` 切分、
   剥掉环境变量前缀、剥掉首尾各至多一个引号后取首词，等于 `sleep`。
2. **首段之后还有其它命令**：切分后的非空段多于一段。除上述四种分隔符外，**换行**同样算命令
   分隔（换行不是逃逸口）。只含空白的段与以 `#` 开头的纯注释段都不计入后续命令。

控制操作符 `&`（`sleep 10 & cat a.txt`）不算「首段之后还有后续命令」：shell 会立刻执行后续
命令，不存在「先等再干」，因此不拦。`&&` / `&>` / `&>>` / `>&` 里的 `&` 本就不是分隔。

管道形态 `sleep 5 | cat` 段数多于一段因此命中；单段多参数 `sleep 5 10` 只有一段因此放行。

判定只看命令文本，不看 `run_in_background` / `detach` / `timeout` 等参数：**三种调用形态
一视同仁**。判定不读文件系统、不识别 sleep 时长、不判断后续命令是否引用了某个后台任务的
输出路径。

### FR-002：失败结果与文案

命中即失败：命令不执行、不进后台任务注册表、不产生 taskId、不弹权限确认框、不发完成通知或
提醒。工具结果是失败态（`is_error`），文本为[失败文案](#失败文案逐字锁定)锁定的那段提醒，
逐字一致、不随命中形态插值。

闸门在**权限决策之前**生效：被拦的命令不进入权限分级，因此 `manual` / `risk` / `auto`
三种工作模式下行为一致，也不消耗用户的一次确认。

### FR-003：放行范围

以下写法不被拦，照常执行（前两条正是文案给出的两条出路）：

- **首段不是 `sleep`**：`echo anything; sleep 10`、`npm run build && sleep 5`——
  模型确实需要延时（等服务端口、等文件生成）时，往 sleep 前面加任意命令即可。
- **只有 sleep、没有后续命令**：`sleep 5`。这类命令按既有口径执行，含 `sleep` 子命令时前台
  死线后移到 `max(默认超时, sleep 时长总和)`。
- **引号 / 注释内的 sleep 字样**：`echo 'sleep 10 && x'` 里的 sleep 不是子命令。

### FR-004：与既有闸门和模式的边界

- 与后台化构造闸门（`BASH_DETACH_GATE_MESSAGE`）相互独立：两条都命中时**先报本闸门的
  文案**——该命令的主因是用 sleep 等结果，后台化构造是附带写法。
- `detach: true` 不解除本闸门（[bash-detach.md FR-002](../../docs/features/bash-detach.md#fr-002detachtrue-的豁免语义)
  的豁免只覆盖后台化构造）。`run_in_background: true` 同样不解除。
- 不受工作模式（`manual` / `risk` / `auto`）与会话形态（主会话 / spin / 子代理 / 跨工作区
  派发）影响：所有路径走同一个工具入口，判定与文案只有一份。
- 系统提示词与工具描述不因本闸门改动：模型只在命中时从失败文案得知约束（与后台化构造闸门
  同口径，不改提示词里的 Background Execution 段落）。

## 边界与错误路径

- **命令是 `sleep 10 && cat <某后台任务的输出路径>`**：仍然拦。后台任务完成时 core 会通知并
  接续，工具结果里也已给出输出路径与完成通知的承诺，不需要再 poll。
- **`sleep` 写成绝对路径**（`/usr/bin/sleep 10 && x`）：首词不是 `sleep`，不拦——与既有
  `contains_sleep_command` / `sleep_duration_ms` 的首词口径一致。
- **`sleep` 被其它命令包裹**（`timeout 30 sleep 5 && x`、`bash -c 'sleep 5 && x'`）：首段
  命令名分别是 `timeout` / `bash`，不拦；这是既有首词口径的已知边界，不为此扩判定。
- **`sleep` 前有环境变量前缀**（`FOO=1 sleep 5 && x`）：剥前缀后首词是 `sleep`，命中。
- **首段是 `sleep` 但后面只有重定向或分号尾巴**（`sleep 5 > out`、`sleep 5;`）：切分后只有
  一段，不拦，照常执行。
- **命令为空或只有空白**：不命中本闸门，走既有「command 必填」校验。
- **后续段只有注释**（`sleep 10 # wait`）：注释段不构成后续命令，不拦——这是保守近似，
  宁可放行也不误拦。
- **控制操作符 `&` 接后续命令**（`sleep 10 & cat a.txt`）：不拦——shell 立刻执行后续命令，
  不是「先等再干」。
- **同一命令串里多处 sleep**（`echo a; sleep 5; echo b; sleep 5`）：首段不是 sleep，不拦。
- **被拦后模型换写法重试**：`echo anything; sleep 10` 与单条 `sleep 5` 都能过；重复命中只会
  重复同一条失败文案，不会升级为权限询问或会话中止。
- **既有用例受影响**（实施时同步改口径，不是行为回退）：`core-rs/src/tools_tests.rs` 的进程树
  中止用例（`sleep 3 && touch late.marker` 等）与 `e2e/electron/remoteSshExecution.spec.ts`
  的 manual 权限探针（`sleep 2; printf ...; uname -s`）、
  `e2e/electron/remoteTaskSurvival.spec.ts` 的远端长任务（`sleep 180 && printf ...`）会被本
  闸门拦下，需改成「sleep 不在首段」的等价写法（如 `printf ...; sleep 2`）以继续覆盖原行为。

## 失败文案（逐字锁定）

LLM 面失败文案（英文，与既有 `BASH_DETACH_GATE_MESSAGE` 及系统提示词同语言），不插值：

```text
Bash: do not sleep to wait for results — you will be notified when the background task completes and the turn continues.
If you really need a sleep for another reason, put any command before it, e.g. `echo anything; sleep 10`.
```

## 非目标

- 不拦「只有 sleep、没有后续命令」的调用：模型可能确实只想等一段时间。
- 不拦「sleep 不在首段」的写法：那正是文案给出的逃逸通道，也是模型表达「先做 X 再等 Y」
  的正常写法。
- 不识别「在等某个后台任务」的语义：判定只看命令文本形态，不解析输出路径、不做跨任务关联
  （自动跳越 / 剥 sleep 续跑的方向见 [TODO.md](../../TODO.md)）。
- 不动系统提示词的 Background Execution 段落与工具描述。
- 不新增 UI：被拦的调用就是一张失败的 Bash 卡片，与既有工具失败渲染一致。
- 不新增事件、契约成员、配置项或 UI 开关；闸门不可关闭。

## 对需求基线的影响

新增 US-76（后台等待不靠 sleep 轮询），登记在
[docs/features/user-stories/tools.md](../../docs/features/user-stories/tools.md#ep-7-工具与技能) 的 EP-7；
e2e 按既有口径登记豁免（纯 core 侧命令文本判定，由 core-rs 单测锁定判定、放行范围与文案），
`docs/features/user-stories.md` 的「未覆盖 e2e 的 US」段记录理由——既有
`e2e/electron/backgroundBash.spec.ts` 与 `e2e/webview/bashBackgroundButton.spec.ts` 的
`sleep 30` / `sleep 60` 均无后续命令，不受本闸门影响。既有 US-45（命令转入后台）的验收
标准不变。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | Bash 调用执行前的闸门（切分复用 `core-rs/src/permission.rs` 的 `split_by_separators`，首词复用 `core-rs/src/tools.rs` 的 `extract_command_name` 同口径） | `core-rs/src/tools_tests.rs` 的闸门判定用例组（分隔符 / 换行 / `&` 放行 / 管道 / 引号 / 环境变量前缀 / 纯注释） | 自动 |
| FR-002 | `core-rs/src/permission.rs` 的 `base_check` Bash 分支（`Decision::Deny`，不是 `ask`）；文案 `core-rs/src/tools.rs` 的 `BASH_SLEEP_GATE_MESSAGE` | `core-rs/src/permission_tests.rs` 的 `sleep_wait_gate_denies_in_every_agent_mode`；对照表 `core-rs/fixtures/permission.json` 的三档 deny 用例 | 自动 |
| FR-003 | `core-rs/src/tools.rs` 的 `is_sleep_wait_command` 放行分支 | `core-rs/src/tools_tests.rs` 的 `sleep_wait_gate_detects_leading_sleep_with_trailing_commands`（放行部分）；`core-rs/src/permission_tests.rs` 的 `sleep_wait_gate_leaves_allowed_forms_untouched` | 自动 |
| FR-004 | `core-rs/src/permission.rs` 的 gate 顺序（在 `is_read_only_command` 之前）与 detach 判定的独立性 | `core-rs/src/permission_tests.rs` 的 `sleep_wait_gate_wins_over_detach_gate` / `sleep_wait_gate_is_not_lifted_by_detach` | 自动 |

## 待澄清

无。

## 收敛记录

- 已满足：
  - AC-1 / AC-2 / AC-3 / AC-4（FR-001，判定）：`core-rs/src/tools.rs` 的 `is_sleep_wait_command`
    （按行切开 + `split_by_separators` + 纯注释段过滤 + `extract_command_name`），用例
    `core-rs/src/tools_tests.rs` 的 `sleep_wait_gate_detects_leading_sleep_with_trailing_commands`。
  - AC-5 / AC-6（FR-002，失败与文案）：`core-rs/src/permission.rs` 的 `base_check` Bash 分支
    在只读判定前 `CheckResult::deny`；文案 `BASH_SLEEP_GATE_MESSAGE` 与第「失败文案」节逐字一致
    （脚本比对代码字面量与 docs、spec 三处相同）。三档一致由
    `permission_tests.rs` 的 `sleep_wait_gate_denies_in_every_agent_mode` 与
    `core-rs/fixtures/permission.json` 的三条 deny 用例锁定。
  - AC-7 / AC-8 / AC-9（FR-003，放行）：`permission_tests.rs` 的
    `sleep_wait_gate_leaves_allowed_forms_untouched`。
  - AC-10 / AC-11 / AC-12 / AC-13（FR-004，与既有闸门和模式）：`sleep_wait_gate_wins_over_detach_gate`
    与 `sleep_wait_gate_is_not_lifted_by_detach`；闸门在 `resolve_tool_permission` 之前，
    spin / 子代理 / 跨工作区都走 `execute_tool` 同一入口。
  - 整体验证：`npm run test:core`（1131 passed）、`npm run check-types`、`npm run lint`、
    `npm run test:unit -- docs-lint`、`npm run check-types:e2e` 全绿。
- 偏差：无。
- 未做：无。
