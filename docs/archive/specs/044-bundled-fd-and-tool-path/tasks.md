# 任务分解：内置 fd 与工具 shell 的 PATH 前置

执行顺序按「解析层 → 消费层 → 分发链 → 提示词 → 文档 → 打包验证」递进：T001 先把内置工具
登记表与候选解析立起来（后续所有任务都消费它），T002~T004 是三个消费者（PATH 注入、TS 引导、
构建链），T005~T006 关掉提示词与文档，T007 跑完整打包闸门。需求见 [spec.md](spec.md)，技术方案见
[plan.md](plan.md)。

本次用户明确「中间不再评审」，tasks 完成后直接进入实施并在收尾跑 `npm run package`。

## 任务清单

- [x] **T001**（FR-005）：新增 `core-rs/src/bundled_tools.rs` + `bundled_tools_tests.rs`——把 `tools.rs` 的私有 `platform_dir` / `exe_name` / `core_executable_dir` / `ripgrep_candidates` 迁入，改成 `BUNDLED_TOOLS`（`ripgrep`/`rg`、`fd`/`fd`）登记表 + `tool_candidates` / `resolve_tool` / `search_path_entries` / `shell_form` 四个纯函数，`main.rs` 加 `mod bundled_tools;` 与 `mod bundled_tools_tests;`；依赖：—；完成判据：`cargo test --manifest-path core-rs/Cargo.toml bundled_tools` 绿，用例锁死四段候选顺序、`search_path_entries` 的顺序与去重、`shell_form` 的盘符 / UNC / POSIX 三种输入。
- [x] **T002**（FR-004）：`core-rs/src/shell_env.rs` 的 `apply_value` 改为「内置目录前置 + 用户 PATH 去重」；新增 `force_bundled_dirs_for_test` / `clear_bundled_dirs_for_test` 覆盖槽，`test_support.rs::Sandbox::new` 钉空列表、`Drop` 清除；依赖：T001；完成判据：`cargo test --manifest-path core-rs/Cargo.toml shell_env` 绿，用例覆盖前置顺序、用户 PATH 同名条目被移到内置之后、两种形式各用各的转换、缺目录跳过（`command not found` 由命令自身发出，注入不报错）。
- [x] **T003**（FR-004、FR-005）：`core-rs/src/tools.rs` 的 `ripgrep_path` 改为 `bundled_tools::resolve_tool` 的薄封装（找不到仍回退字符串 `"rg"`）；`tools_tests.rs` 的 `ripgrep_candidates_prefer_the_core_bundle` 改调新模块并补 fd 解析用例；依赖：T001；完成判据：`cargo test --manifest-path core-rs/Cargo.toml tools` 绿，`tools_tests` 里 `ripgrep_path_falls_back_to_path_lookup` / `ripgrep_path_prefers_the_bundled_binary` 仍通过。
- [x] **T004**（FR-002、FR-005）：`src/host/standalone/coreBinary.ts` 加 `BUNDLED_TOOLS` 登记表与 `bundledToolPath` / `bundledToolFileName` / `coreDeployToolPath` 三个通用函数，既有 `CORE_RIPGREP_DIR` / `bundledRipgrepFileName` / `bundledRipgrepPath` / `coreDeployRipgrepPath` 改为转调（签名与导出名不变），新增 `CORE_FD_DIR` / `bundledFdFileName` / `bundledFdPath` / `coreDeployFdPath`；依赖：—；完成判据：`npm run check-types` 绿，`npm run test:unit -- core-platform-matrix` 绿且新增 fd 落位与候选路径断言。
- [x] **T005**（FR-002）：`src/host/standalone/sshDaemonBootstrap.ts` 的 `ensureRemoteRipgrep` 重构为 `ensureRemoteBundledTools`（按登记表循环、缺了才传、原子上传、缺本机产物报错点名工具），`sshDaemonBootstrap.test.ts` 的全量部署断言 2→3 次上传、仅补 rg 场景 1→2 次，并补「只补 fd」与「fd 缺失报错」两个用例；`sshTransport.test.ts` 的 `warm` 场景把 fd 也标记为已部署；依赖：T004；完成判据：`npm run test:unit -- ssh-daemon-bootstrap ssh-transport` 绿。
- [x] **T006**（FR-001）：`scripts/build-core.mjs` 的 `copyBundledRipgrep` 改为 `copyBundledTools`（按登记表落位，任一缺失 `process.exit(1)` 并点名工具），`scripts/verify-core-artifacts.mjs` 的 `ripgrep` 字段改为 `tools` 数组、built 与 shipped 两侧逐工具校验，`scripts/copy-assets.mjs` 清理列表补 `fd`，`scripts/fix_vsix_permissions.py` 的 `TARGET_FILES` 补两条 `core/{x64,arm64}-linux/fd/fd`；依赖：T001；完成判据：`npm run build:core` 后四个 `resources/core/<dir>/` 各含 `ripgrep/rg[.exe]` 与 `fd/fd[.exe]`，`node scripts/verify-core-artifacts.mjs` 绿，`npm run test:unit -- core-platform-matrix` 绿。
- [x] **T007**（FR-003）：`installer-rs/build.rs` 的 `entries` 增加 `{product_dir}/fd/fd{ext}`，`scripts/build-tui-installer.mjs` 的 `coreArtifactsReady` 增加 `fd/fd<ext>` 判定，`tui-rs/src/core_root.rs` 增 `shared_fd_in`（`#[cfg(test)]`）与 `core_root_tests.rs` 断言，`e2e/tui/installer.spec.ts` 布局断言加 fd；依赖：T006；完成判据：`cargo test --manifest-path tui-rs/Cargo.toml core_root` 绿，`npm run test:e2e:tui` 的「部署布局完整」用例绿（或在无产物环境按既有口径 skip 并说明）。**实测**：在临时前缀跑 `tuxedo-cat-tui-installer-x64-win32.exe`，布局含 `<指纹>/tuxedo-cat-core.exe + fingerprint`、`fd/fd.exe`、`ripgrep/rg.exe`、`tui.exe`；装出来的 `fd --version` = 10.5.2、`rg --version` = 15.2.0，两份都可执行（755）。幂等：同一前缀连跑两次，exit 均为 0 且全部文件 mtime / 大小不变（内容未变的跳过）。
- [x] **T008**（FR-006）：`core-rs/src/prompt.rs` 的 `TOOL_DETAILS_BEFORE_TRANSFER` 按 spec FR-006 五处定稿逐字改写，重生成 `core-rs/fixtures/systemPrompt.json` 的 `toolUsage`，`prompt_tests.rs` 新增 `tool_details_do_not_ban_bash_rg` 与 `tool_details_describe_rules_not_mechanism` 两条用例；依赖：—；完成判据：`cargo test --manifest-path core-rs/Cargo.toml prompt_tests` 绿（逐字对照表一致，两个新用例通过）。
- [x] **T009**（FR-001、FR-002、FR-003、FR-004、FR-005、FR-006）：文档同步九处增量——
  [第 3.1 节](../../docs/core/standalone-core.md#31-平台矩阵) / [第 3.2.1 节](../../docs/core/standalone-core.md#321-工具命令的-path) /
  [第 3.3 节](../../docs/core/standalone-core.md#33-构建与目标平台) / [第 7 节](../../docs/core/standalone-core.md#7-事实归属) 就地改写
  （注意 493 行逼近 500 行上限）、[第 2.8 节](../../docs/core/core-remote.md#28-ssh-接入ssh-scheme)、
  [第 2 节](../../docs/features/tui-installer.md#2-功能需求)与[第 3 节](../../docs/features/tui-installer.md#3-行为规格)、
  [第 2.4 节](../../docs/hosts/tui.md#24-core-产物定位tui-rssrccore_rootrs)、[目录布局](../../docs/architecture/repo-map.md#目录布局)、
  [EP-7 工具与技能](../../docs/features/user-stories/tools.md#ep-7-工具与技能)新增 US-77、
  [附录 e2e 映射](../../docs/features/user-stories.md#附录us-与-e2e-场景用例映射)与豁免段、`docs/adr/README.md`
  补齐 0012–0015 四行索引；依赖：T001–T008；完成判据：`npm run test:unit -- docs-lint` 绿（含 US 编号、锚点、500 行上限、地图覆盖全部通过）。
- [x] **T010**（FR-001、FR-002、FR-003、FR-004、FR-005、FR-006）：收尾验证——`npm run check-types && npm run lint && npm run test:core && npm run test:unit` 全绿后跑 `npm run package`；依赖：T009；完成判据：`npm run package` 退出码 0，`release/` 下产出 .vsix 与安装包，`node scripts/verify-core-artifacts.mjs` 绿，`.vsix` 内 `extension/dist/resources/core/*-linux/fd/fd` 具可执行位。
