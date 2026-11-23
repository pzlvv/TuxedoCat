---
status: 已修
---

# 缺陷：`test:core` 绕过构建脚本的工具链注入，Windows arm64 宿主上一条 Rust 单测都跑不起来

`package.json` 的 `test:core` 直接调 `cargo test`，绕过了 `scripts/build-core.mjs` 为宿主目标
注入 `CC` / `CFLAGS` 的那一步。于是「本机能编 Core」与「本机能跑 Core 单测」分成两种状态：
前者走构建脚本、注入齐全；后者裸跑 cargo、`cc-rs` 找不到 clang 而失败。

## 现状

- 复现（Windows arm64 宿主，`npm run test:core`）：

  ```text
  error occurred in cc-rs: failed to find tool "clang": program not found
  ```

  失败点在 `ring` 的 C / 汇编编译阶段（build script 走 `cc` crate），不是任何一条用例。
  首条失败即整条 `test:core` 中止，两个 crate 的单测一条都没跑。
- 判据本身是现成的且只此一处：`scripts/build-core.mjs` 的 `toolchainKind` 对
  `aarch64-pc-windows-msvc` 在 Windows 宿主上返回 `'zig'`——ring 对 Windows AArch64
  硬性要求 clang，由 `zig cc` 充当；`crossToolchainEnv` 据此给出
  `{ CC_aarch64_pc_windows_msvc: 'zig cc', CFLAGS_aarch64_pc_windows_msvc: '--target=aarch64-windows-msvc' }`。
- 构建入口用得上这套判据：`npm run build:core:host` 在同一台机器上正常编过。差别只在
  「测试入口没走它」。
- `mount-proxy-rs` 没有 C 依赖，不受影响；受影响的是 `core-rs`（`ring`）。
- 影响面：Windows arm64 与任何需要 zig 提供 C 工具链的宿主上，`test:core` 恒失败，
  Rust 侧回归只能推给 CI，本机改 Core 时拿不到即时反馈。CI 跑在 Linux x64 上，
  `toolchainKind` 对该宿主 + 本机架构返回 `'none'`，所以 CI 一直是绿的——缺陷只在
  「本机工具链与 CI 不同」的组合下暴露。
- 与既有缺陷的关系：
  [windows-core-build-forces-cargo-xwin](windows-core-build-forces-cargo-xwin.md) 修的是
  「构建入口按宿主选工具链」，
  [core-toolchain-criteria-requires-local-zig](core-toolchain-criteria-requires-local-zig.md)
  修的是「判据函数不要因缺 zig 而算不出来」。两者都在 `build-core.mjs` 内；本缺陷是
  **第三个入口**（测试）没有接上去。

## 期望

- `test:core` 与构建入口共用同一份工具链判据：启动 Rust 单测前按宿主三元组取
  `crossToolchainEnv` 的结果注入环境，不各写一套分支。
- 判据的来源只有一处（`scripts/build-core.mjs`）：新增的启动脚本 import 它，
  不复制 `toolchainKind` 的表。
- 宿主不在平台矩阵内时不注入、原样跑单测——`hostTarget()` 对这种情况会报错退出，
  那是**构建**入口的口径；测试入口不该因为平台不在矩阵内就拒绝跑单测。
- 注入与否在日志里可见，本机跑不通时第一眼能确认「到底注入了什么」。
- 两个 crate 都经同一入口启动。
- 入口在 Windows 上不经 cmd.exe 中转：脚本自己给出带后缀的可执行名（`cargo.exe`），
  不设 `shell: true`。这样 PATH 的格式要求与调用方一致：经 `npm run` / `npm exec` 调用时
  PATH 是 Windows 格式，天然满足；从 Git Bash 直接 `node scripts/test-core.mjs` 时
  PATH 是 POSIX 格式（`/c/.../.cargo/bin`），spawn 找不到 cargo——那不是入口的缺陷，
  文档写明走 npm 入口即可。

## 不变量

1. `scripts/build-core.mjs` 的判据与导出签名不变：`toolchainKind` / `crossToolchainEnv` /
   `cargoInvocation` / `requiresZig` 的行为与既有单测（`src/test/coreBuildToolchain.test.ts`）不变。
2. 构建入口的行为不变：`build:core:*` 的产物、指纹、`copy-assets` 与 `verify-core-artifacts`
   口径不动（[standalone-core.md 第 3.3 节](../../docs/core/standalone-core.md#33-构建与目标平台)）。
3. CI（Linux x64）上 `test:core` 的行为等价：该宿主 `toolchainKind` 返回 `'none'`，
   注入集合为空，命令与原先一致。
4. 构建失败 / 单测失败照旧以非零退出码结束，不吞错、不跳过。
5. `test:core` 覆盖的 crate 集合不变（`core-rs` + `mount-proxy-rs`）。

## 回归测试

- **RT-1**：`test:core` 经 `scripts/test-core.mjs` 启动，不再裸调 `cargo test`，且两个
  crate 都在覆盖范围内。（落点：`src/test/coreTestScript.test.ts` 的
  `test:core 经 test-core.mjs 启动（不再裸调 cargo test）` 与
  `test:core 覆盖 core-rs 与 mount-proxy-rs 两个 crate`）
- **RT-2**：工具链判据从 `build-core.mjs` 复用而不是复制一份（脚本 `import` 它、按宿主
  三元组调 `crossToolchainEnv`）。（落点：同上文件的
  `工具链判据从 build-core.mjs 复用（不各写一套分支）` 与
  `脚本按宿主查表后调 crossToolchainEnv（键名不手抄）`）
- **RT-3**：`scripts/test-core.mjs` 语法合法（ESM 下可被 node 解析）。（落点：同上文件的
  `test-core.mjs 语法合法（node --check）`）
- **RT-4**：Windows arm64 宿主上 `npm run test:core` 真跑通（`subagent::tests` 含
  `waiters_wake_in_fifo_order` 全绿）。（落点：人工验证记录，见下）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 复现（修复前） | `npm run test:core` | 红 | `error occurred in cc-rs: failed to find tool "clang": program not found`；首条失败即中止，两个 crate 一条用例都没跑 |
| 归因（修复前） | `CC="zig cc" CFLAGS="--target=aarch64-windows-msvc" cargo test --manifest-path core-rs/Cargo.toml --release subagent` | 绿 | 手动注入后 15 个 `subagent::tests` 全过（含 `waiters_wake_in_fifo_order`）——证明缺的只是注入，不是代码 |
| 回归用例（修复后） | `npm run test:unit -- coreTestScript` | 绿 | 5 通过 / 0 失败（RT-1 / RT-2 / RT-3） |
| 真实入口（注入生效） | `npm exec -- node scripts/test-core.mjs --manifest-path core-rs/Cargo.toml subagent` | 绿 | 日志报出注入 `CC_aarch64_pc_windows_msvc` / `CFLAGS_aarch64_pc_windows_msvc`；`test result: ok. 15 passed; 0 failed`（含 `waiters_wake_in_fifo_order`） |
| 真实入口（全量） | `npm run test:core` | 绿 | exit 0：core-rs `1228 passed; 0 failed`（268.89s）、mount-proxy-rs `9 passed; 0 failed`；注入日志见上一行 |
| 入口形态（Windows） | 上述两条 + `npm run test:core` | 绿 | 脚本自给 `cargo.exe`、不设 `shell: true`：`shell: true` 会走 cmd.exe，而 cmd 只认 Windows 格式 PATH——本机实测在 Git Bash 下报「'cargo' 不是内部或外部命令」 |
| 既有回归（构建判据） | `npm run test:unit -- core-build-toolchain` | 绿 | 16 项全过：`build-core.mjs` 的判据与导出未受影响 |
| 类型检查 | `npm run check-types` | 绿 | — |
| 代码风格 | `npm run lint` | 绿 | — |
| 文档守卫 | `npm run test:unit -- docs-lint` | 绿 | 50 项全过 |
