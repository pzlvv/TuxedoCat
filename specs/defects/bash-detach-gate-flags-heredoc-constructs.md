---
status: 已修
---

# 缺陷：Bash 闸门把 heredoc 体内的字面 `&` / 段首词判成后台化构造

模型用 heredoc 写文件（`cat > a.c <<'EOF' … EOF`）时，只要正文里出现 C 代码的取址
`&x`、YAML 锚点 `&base`、`1 & 2` 位运算等字面 `&`，Bash 工具就整条命令失败并回
「Bash: command uses `&`.」，引导模型改用 `run_in_background` 或 `detach`——
两条出路都与写文件的意图无关，模型只能改写命令重试。heredoc 正文里的 `nohup` / `setsid` 等词同样
会被当成段首词点名。基线是 [docs/features/bash-detach.md](../../docs/features/bash-detach.md)
FR-001：闸门拦的是**控制操作符位**的单 `&`，而 heredoc 正文对 shell 是字面文本，不在
控制操作符位。

## 现状

- 检测纯函数 `core-rs/src/tools.rs` 的 `find_detach_construct` 走两条路径：段首词
  （`permission::split_by_separators` + `extract_command_name`）与字符级
  `scan_background_ampersand`。两者都不认 heredoc：正文被当成普通命令行文本。
- 实测（`cargo test` 内直接调 `find_detach_construct`）：

  | 命令 | 返回 |
  | --- | --- |
  | `cat > a.c <<'EOF'\nint *p = &x;\nEOF` | `Some("&")` |
  | `cat > a.c <<EOF\nint *p = &x;\nEOF` | `Some("&")` |
  | `cat > a.c <<-'EOF'\n\tint *p = &x;\n\tEOF` | `Some("&")` |
  | `cat > a.yaml <<'YAML'\nbase: &base\nYAML` | `Some("&")` |
  | `git commit -F - <<'MSG'\nfeat: a & b\nMSG` | `Some("&")` |
  | `cat > a.sh <<'EOF'\necho a; nohup x\nEOF` | `Some("nohup")` |

- 影响面不止检测本身：同一判据被 `run_bash` 的闸门与 `permission::is_detach_escape`
  （`detach: true` 时的危险分级）共用，所以带 `detach: true` 重试时还会在
  `manual` / `risk` 模式弹出「请求脱离管理执行」确认框——一条纯写文件的命令被要求
  为「进程脱离管理」授权。
- 复现：模型调 `Bash` 执行 `cat > a.c <<'EOF'\nint *p = &x;\nEOF`，工具当场返回失败
  且点名为 `&`；同一命令改写为 `printf 'int *p = &x;' > a.c`（`&` 在引号内）则正常执行。

## 期望

- heredoc 正文（`<<` / `<<-`，带引号或不带引号的 delimiter）内的文本不参与任何一种
  后台化构造判定：体内的 `&` 不算控制操作符位，体内的 `nohup` / `setsid` / `disown` /
  `start /b` / `Start-Process` 不算段首词。
- 终止行之后的命令照常判定：`cat <<EOF\n&\nEOF\ntrue &` 仍点名 `&`。
- heredoc 正文的 `&` 不被闸门拦截，`detach: true` 时也不按危险操作分级
  （`risk` 不再为它弹「请求脱离管理执行」确认文案）。
- 只有 `<<` 单独出现的探针（`<<<` here-string、引号内或 `$()` 内的 `<<`）不触发
  heredoc 语义，其后的文本按原口径判定。

## 不变量

- `&&`、`&>`、`&>>`、`>&`（如 `2>&1`）、引号内 `&`、`$()` 内部、未加引号的 URL `&`
  的既有判定结果不变（`docs/features/bash-detach.md` FR-001 / AC-4）。
- heredoc 之外的段首词 `nohup` / `setsid` / `disown` / `start /b` / `Start-Process`
  仍被拦；`detach: true` 的豁免与授权分级语义不变。
- LLM 面失败文案 `BASH_DETACH_GATE_MESSAGE` 与用户面 `ask_message` 文案逐字不变。
- 检测仍是仓库内唯一实现：`permission::is_detach_escape` 继续调
  `tools::find_detach_construct`，不新增第二份判据。
- `permission::split_by_separators` 的其他消费者（只读 / 破坏性 / `sleep` 超时判定）
  行为不变——本次只在 detach 检测入口做 heredoc 屏蔽，不改公共拆分函数的语义。
- Bash 工具的其他入参与执行路径（`cwd` / `run_in_background` / `detach` / 超时）不变。

## 回归测试

- **RT-1**：`find_detach_construct` 对仅由 heredoc 正文承载构造的命令返回 `None`——
  覆盖 `<<'EOF'` / `<<EOF` / `<<-` + tab 缩进 / YAML 锚点 / `git commit -F -` 消息体 /
  同一行双 heredoc / 体内含 `; nohup x`、`&& setsid x` 的 8 个用例；同时断言终止行
  之后的真构造仍命中（`&` 与 `nohup`），以及 `<<<` here-string / 引号内 `<<` / 注释里
  的 `<<` / 反斜杠定界符 `<<\EOF` / 未闭合 heredoc 不误吞后续命令行。
  （落点：`core-rs/src/tools_tests.rs`「find_detach_construct_ignores_heredoc_bodies」）
- **RT-2**：经闸门执行 `cat > a.c <<'EOF'\nint *p = &x;\nEOF` 不报错（命令真的执行、
  文件写出），而 `cat > a.c <<'EOF'\n&\nEOF\ntrue &` 报错且点名为 `&`。
  （落点：`core-rs/src/tools_tests.rs`「bash_gate_allows_ampersand_inside_heredoc」）
- **RT-3**：`detach: true` 且 `&` 只出现在 heredoc 正文时不算危险操作
  （`is_operation_risky` 为假）、`risk` 下决策为 `Allow`、`ask_message` 不是
  「请求脱离管理执行」文案；对照用例（真构造 `nohup server`）仍在 `risk` 下 `Ask`。
  manual 模式的 `Ask` 来自「写命令逐条询问」的既有口径，与本缺陷无关，故不作断言。
  （落点：`core-rs/src/permission_tests.rs`「detach_escape_ignores_heredoc_body_ampersand」）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `cargo test --manifest-path core-rs/Cargo.toml heredoc -- --test-threads=1` | 红 | 3/3 失败：RT-1 断言「不应命中: cat > a.c <<'EOF'…」（left: Some("&") / right: None）；RT-2 断言「heredoc 正文的 & 不应拦截」失败，工具返回 command uses &；RT-3 断言 left: Ask / right: Allow |
| 回归用例（修复后） | `cargo test --manifest-path core-rs/Cargo.toml heredoc -- --test-threads=1` | 绿 | RT-1 / RT-2 / RT-3 三条全过 |
| 既有回归 | `cargo test --manifest-path core-rs/Cargo.toml` | 绿 | 1126 项全绿（修复前 1123 项 + 新增 3 条 RT），190.96s |
| docs-lint | `npm run test:unit -- docs-lint` | 绿 | 49 组全过（缺陷规格五节 + RT + 验证记录红绿行 + `docs/features/bash-detach.md` 链接与章节引用） |
| check-types / lint | `npm run check-types && npm run lint` | 绿 | 本次改动只涉及 Rust 与文档，TS 门禁确认无连带破坏 |
