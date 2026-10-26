---
status: 已修
---

# 缺陷：core 的 `${SKILL_DIR}` 归一被门控在 Windows，Linux 上反斜杠原样透出

`Skill` 工具把技能正文里的 `${SKILL_DIR}` 替换为技能所在目录；对照表
（`core-rs/fixtures/skills.json` 的 `builtinVariables`）与平台无关地约定：路径形态
统一成正斜杠（`C:\skills\x` → `C:/skills/x`，进 prompt 的形态跨平台一致）。实现却把
归一门控在 `cfg!(windows)`——Linux 上反斜杠原样透出，parity 用例在 ubuntu 即红
（smoke 车道首轮实证）。

## 现状

- `core-rs/src/skills.rs` 的 `substitute_builtin_variables`：
  `let normalized = if cfg!(windows) { dir.replace('\\', "/") } else { dir.to_string() }`。
- 对照表用例：`skillDir: "C:\\skills\\x"` → 期望 `"Both C:/skills/x s"`，与平台无关；
  Linux 实际得到 `"Both C:\skills\x s"`。
- 实证：PR #1 smoke run 40373536895（ubuntu），`skills::tests::parity_tests::builtin_variables_parity`
  FAILED（left `C:\skills\x` / right `C:/skills/x`）。

## 期望

- `${SKILL_DIR}` 的归一与平台无关：反斜杠一律替换为正斜杠（对照表即契约）。

## 不变量

- 无 `${SKILL_DIR}` 占位的内容原样返回；`${SESSION_ID}` 替换行为不变。
- `js_replace_all` 的全局替换语义不变。
- Windows 上的替换结果不变（此前只在此平台归一，行为一致）。

## 回归测试

- **RT-1**：对照表 parity 用例本身（`core-rs/src/skills_tests.rs` 的
  `builtin_variables_parity`）——Linux 上反斜杠样例归一后与对照表一致。现状红
  （CI 实证），本机 win32 修复前后均绿（此前已在归一分支内）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前，Linux） | PR #1 smoke run 40373536895 | 红 | `builtin_variables_parity` FAILED：left `Both C:\skills\x s` / right `Both C:/skills/x s` |
| 回归用例（修复后，win32 本机） | `cargo test skills::tests::parity_tests` | 绿 | 3 项 parity 用例通过；win32 上行为与修复前一致（本就在归一分支内） |
| 回归用例（修复后，Linux） | 随本修复所在 PR 的 smoke 重跑 | not-run | 本机无 Linux；由 CI 的 ubuntu 车道验证，结果见 PR #1 的后续 smoke run |
| 既有回归 | `npm run test:core` | 绿 | 全量 cargo test 本机通过（见提交） |
