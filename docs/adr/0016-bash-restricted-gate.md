# ADR-0016：Bash 的 restricted 定为模型面收紧开关，缺省为真

- 状态：被取代（`sed` 分支由 [ADR-0021](0021-bash-sed-reminder-instead-of-gate.md) 取代）
- 日期：2026-11
- 规格：[docs/features/background-bash.md](../features/background-bash.md)（闸门判据 / 文案 / 边界），随 specs/049 落地

## 背景（Context）

模型有两类顺手写法会把工具能力用歪：

1. **拿 `sleep` 当等待器**：写 `sleep 30 && cat <输出文件>` 等后台任务。core 在后台任务
   完成时本来就会注入通知并接续消费循环（[FR-003](../features/background-bash.md#fr-003查询结束兜底提醒)），
   自己 sleep 只是白等一轮、再补一条迟到结果。
2. **拿 `cd` + `sed` 当文件读取器**：`sed -n '1,40p' f`。`Read` 工具才对得上读文件的语义
   （行号、范围、xlsx / 图片分支、读后失效守卫，见
   [docs/core/tool-read-guard.md](../core/tool-read-guard.md)）。

此前的做法是一条「首段 `sleep` + 后续命令」的无条件闸门（specs/043）。它有两个问题：
覆盖不全（`cat f; sleep 30`、单条 `sleep 5` 都放过，因为文案曾把「往 sleep 前加任意命令」
当出路）；且没有关闭通道——模型手上没有参数能表达「我确实要延时」。

## 决策（Decision）

Bash 新增布尔参数 `restricted`，**缺省 `true`**：

- 缺省为真时拒绝「含 `sleep` 命令」与「去掉所有 `cd` 段后只剩 `sed`」两类写法，判据在
  `permission.rs` 的 `base_check` Bash 分支、只读判定之前用 **deny**（不是 ask）——ask 在
  `auto` 模式会被放行，三档一致性就没了。
- 只有显式 `restricted: false` 才关闭这两条限制；关闭后无其它残留闸门（specs/043 的无条件
  闸门随本次一并收进这个开关）。
- `restricted` 与 `detach` **互不豁免**：`detach: true` 不解除本闸门，`restricted: false`
  也不豁免后台化构造闸门——两个字段各自管一件事。
- 字段说明最小披露：schema 与系统提示词各一句「默认 `true`、通常传 `true`」，模型可见文本
  用英文，且不提前点明它限制哪两类写法——判据细节只在失败文案里给（与
  [ADR-0014](0014-bash-detach-escape-hatch.md) 的 detach 口径一致）。

默认值只在 `core-rs/src/tools.rs` 的 `bash_restricted` 一处定义
（[principles.md 第 9 节](../architecture/principles.md#9-同一字段的默认值只有一处)）。

## 替代方案（被否决）与后果（Consequences）

- **闸门放在 `run_bash`（与 detach 闸门同处）**：权限层在它之前跑，`manual` / `risk` 会先弹
  一次确认框再拒绝、`auto` 直接放行，三档语义不一致。
- **`restricted: false` 降级为 ask（用户确认）**：ask 在 `auto` 下等于放行、在 `manual` 下变成
  每次都问，同一开关在三档间给出三种语义；用户明确要的是「显式关闭即放开」。
- **保留旧的无条件闸门与之并存**：会出现「关了 `restricted` 仍被旧闸门拦住」的双开关，模型
  手上的开关与实际生效的限制不对应（违背
  [principles.md 第 7 节](../architecture/principles.md#7-一份事实只有一个写入点)）。
- **缺省 `false`（显式收紧）**：与目的相反——忘记传参的模型正好绕过限制。
- **扩成三态枚举（`off` / `no-sleep` / `full`）**：当前只有「全开 / 全关」两种可观察状态，
  三态会引入不可测组合；需要细分时再版本化。
- **新写一套 sleep / sed 首词判定**：会与 `extract_command_name`（剥环境变量前缀）形成第二套
  口径，判据必然漂移；本决策只抽出共用切段 `gate_segments`。
- **把 `contains_sleep_command` 一并收进新判据**：它服务前台死线后移与兜底提醒，语义不同
  （不认换行、不屏蔽 heredoc），合并会让超时估算随闸门漂移。

**代价**：模型必须显式关掉限制才能做真正的延时（例如远端断连探针、长任务保活），已有 e2e 与
单测因此都补了 `restricted: false`；判定仍是纯词法扫描，不识别绝对路径（`/usr/bin/sleep`）与
包裹写法（`timeout 30 sleep 5`），这是与既有 `sleep` 口径一致的已知边界。
