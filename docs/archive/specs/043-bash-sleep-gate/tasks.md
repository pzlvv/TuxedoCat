# 任务分解：Bash 的 sleep 等待闸门

执行顺序：判定纯函数 → 闸门与文案接线 → 单测 → 既有 e2e 口径调整 → 文档同步 → 收敛。
每条回指 [spec.md](spec.md) 的 FR 与 [plan.md](plan.md) 的实现落点。

## 任务清单

- [x] **T001**（FR-001）：在 `core-rs/src/tools.rs` 新增 `is_sleep_wait_command`（按行切开后再走 `permission::split_by_separators`，过滤空段与纯注释段，首段命令名用 `extract_command_name` 判定）与 `BASH_SLEEP_GATE_MESSAGE` 常量；依赖：—；完成判据：`cargo build` 通过，常量文本与 spec「失败文案（逐字锁定）」节逐字一致
- [x] **T002**（FR-001、FR-002）：在 `core-rs/src/permission.rs` 的 `base_check` Bash 分支、`is_read_only_command` 之前插入 deny；依赖：T001；完成判据：`cargo test` 编译通过，`permission_tests` 既有用例全绿
- [x] **T003**（FR-001、FR-003）：`core-rs/src/tools_tests.rs` 新增判定用例组——`sleep 30 && cat a.txt` / `sleep 10\ncat a.txt` / `sleep 5 | cat` / `FOO=1 sleep 5 && x` 命中；`cat a.txt; sleep 30`、`sleep 30`、`sleep 10 & cat a.txt`、`echo 'sleep 10 && cat a.txt'`、`sleep 10 # wait`、`/usr/bin/sleep 10 && x`、`timeout 30 sleep 5 && x` 放行；依赖：T001；完成判据：`npm run test:core` 全绿
- [x] **T004**（FR-002、FR-004）：`core-rs/src/permission_tests.rs` 新增三档模式一致（manual / risk / auto 同一个 deny 文案）、detach 不解除闸门、双闸门命中顺序（报 sleep 闸门文案）、不弹 ask 用例；依赖：T002、T003；完成判据：`npm run test:core` 全绿
- [x] **T005**（FR-004）：调整命中新闸门的既有 e2e 命令——`e2e/electron/remoteSshExecution.spec.ts` 的 manual 探针改 `printf 'manual-perm-ok\n'; sleep 2; uname -s`，`e2e/electron/remoteTaskSurvival.spec.ts` 的长任务改 `printf 'probe'; sleep 180`；依赖：T002；完成判据：`npm run check-types:e2e` 通过，两处命令文本以 sleep 不在首段
- [x] **T006**（FR-001～FR-004）：文档同步——`docs/features/background-bash.md` 新增「sleep 等待闸门」需求条目 + AC-12～AC-16 + 实现对照行 + 逐字文案 + 边界行 + 追溯矩阵行，开篇范围句扩到含本闸门；`docs/features/bash-detach.md` FR-002 补一句豁免边界；`docs/features/user-stories/tools.md` 新增 US-76；`docs/features/user-stories.md` 的「未覆盖 e2e 的 US」段登记 US-76；依赖：T002；完成判据：`npm run test:unit -- docs-lint` 全绿
- [x] **T007**（FR-001～FR-004）：收敛——逐条核对 spec 的 AC-1～AC-13 与实现 / 测试证据，写「收敛记录」；依赖：T003、T004、T005、T006；完成判据：spec frontmatter status 改为「已收敛」，`npm run check-types && npm run lint && npm run test:core && npm run test:unit -- docs-lint` 全绿
