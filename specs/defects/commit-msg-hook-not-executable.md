---
status: 已修
---

# 缺陷：commit-msg 闸门无执行位，git 静默跳过分档校验

`scripts/githooks/commit-msg` 在仓库里被跟踪为 `100644`（无可执行位），而同一目录的
其它四个钩子都是 `100755`。按 [AGENTS.md 第 5 节](../../AGENTS.md#5-工作流) 的启用方式
（`git config core.hooksPath scripts/githooks`）装上之后，git 找不到可执行的钩子文件，
只打一行 hint 就跳过：

```
hint: The 'scripts/githooks/commit-msg' hook was ignored because it's not set as executable.
```

后果：L0–L3 四档的产物校验（`Flow` trailer 有无、`Defect:` / `Spec:` 指向的文件是否
存在、L2 是否带 `docs/` 改动）在本机与任何克隆上都不生效，任何提交都能进 main——
闸门形同不存在，而它与 CI 的 docs-lint / tests 是两道独立的门。

## 现状

- `git ls-files -s scripts/githooks/`：`commit-msg` 为 `100644`，
  `post-checkout` / `post-commit` / `post-merge` / `pre-push` 均为 `100755`。
- 复现（修复前）：`git archive HEAD` 解包到临时仓库 → 设 `core.hooksPath` → 造一次
  「触及 `src/` 且不带任何 `Flow` trailer」的提交 → `git commit` 退出码 0，输出里是上面
  那行 hint；提交被直接放行。
- 钩子脚本本身是对的：直接 `sh scripts/githooks/commit-msg <msgfile>` 跑，判据按
  `AGENTS.md` 第 5 节执行（合规提交 exit 0，缺 trailer 时 exit 1 并打印提示）。

## 期望

- `scripts/githooks/commit-msg` 与同目录其余钩子一致：index 里是 `100755`。
- 干净的克隆 / 解包产物按 `AGENTS.md` 第 5 节装上 `core.hooksPath` 后，闸门真的运行：
  触及代码路径但缺 `Flow` trailer 的提交被拒。
- 回归测试锁住这个可执行位，避免再次退化成静默跳过。

## 不变量

- 钩子的判据与提示文案不变（merge 豁免、纯文档提交豁免、四档产物校验）。
- `gitHookGate.test.ts` 现有的放行 / 拒绝用例语义不变；它在临时仓库里显式
  `chmod 0o755` 装钩子，因此一直是绿的——**它测的是脚本逻辑，测不到仓库里的文件模式**，
  这正是本缺陷能潜伏至今的原因。
- 其余四个钩子的模式与内容不变。

## 回归测试

- **RT-1**：`git ls-files -s scripts/githooks/commit-msg` 的模式是 `100755`；扩展为
  同目录全部钩子都为 `100755`（新增钩子若忘加执行位同样会红）（落点：
  `src/test/gitHookGate.test.ts` 的 `hooks are tracked as executable`）。
- **RT-2**：不用工作树里的 `chmod`，而是从 index 取出的真实模式装进临时仓库，跑一次
  「触及 `src/` 但缺 `Flow` trailer」的提交，断言 `git commit` 非零退出且提示里出现
  `Flow`（落点：`src/test/gitHookGate.test.ts` 的
  `gate rejects code commit without flow trailer when installed from index mode`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 复现（修复前） | `sh /tmp/repro_hook_gate.sh`（`git archive HEAD` 解包 + `core.hooksPath`） | 红 | `commit-msg hook was ignored because it's not set as executable`，本次提交被放行 |
| 仓库模式（修复前） | `git ls-files -s scripts/githooks/commit-msg` | 红 | `100644` |
| 仓库模式（修复后） | `git ls-files -s scripts/githooks/` | 绿 | 五个钩子全为 `100755` |
| RT-1 / RT-2（修复后） | `npm run test:unit -- gitHookGate` | 绿 | 模式断言与「按 index 模式装钩子后拒绝缺 trailer 的代码提交」都通过 |
| 钩子判据（未受改动） | `sh scripts/githooks/commit-msg <msgfile>`（合规消息） | 绿 | exit 0 |
| docs-lint | `npm run test:unit -- docs-lint` | 绿 | 本规格落笔后复跑通过 |
