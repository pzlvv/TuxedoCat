---
status: 已修
---

# 缺陷：Windows 宿主的 Core 构建被强制走 `cargo xwin`

`npm run package`（内嵌 `vscode:prepublish` → `build:core`）在 Windows 宿主机上构建
Windows x64 目标时直接失败：

```
[build-core] cargo build --manifest-path D:\git\TuxedoCat\core-rs\Cargo.toml --target x86_64-pc-windows-msvc --release (fingerprint 3601b47d…)
error: no such command: `xwin`
[build-core] cargo 构建失败（exit 101）。
 ERROR  npm failed with exit code 101
```

出包链在第一步 Core 构建就断了，`.vsix` / NSIS / TUI 安装器全部拿不到。

## 现状

`scripts/build-core.mjs` 的 `buildTarget` 对**任何** `*-pc-windows-msvc` 目标都加
`xwin` 子命令，判据只有目标三元组，不看宿主平台：

```js
const isWindowsMsvc = triple.endsWith('-pc-windows-msvc');
const runnerArgs = isWindowsMsvc ? ['xwin', ...cargoArgs] : cargoArgs;
```

`crossToolchainEnv` 同样按目标三元组返回空环境（`if (isWindowsMsvc) return {};`），
即「C 工具链归 xwin 提供」。这套选择是为**非 Windows 宿主**写的——那里没有 MSVC 的
`lib.exe` 与 Windows SDK 库，`cargo-xwin` 自带整套 SDK（见
[windows-core-build-needs-msvc-toolchain](windows-core-build-needs-msvc-toolchain.md)）。
但 Windows 宿主上本机就有 MSVC 与 Windows SDK，`cargo xwin` 反而是一份没装的外部
cargo 子命令，于是「本机能编的目标」被判成需要额外依赖。

复现（Windows 宿主，未安装 `cargo-xwin`）：

```bash
npm run package
# → vscode:prepublish → npm run build:core → error: no such command: `xwin`（exit 101）
```

同一份代码下不经 xwin 的路径在本机是通的：`cargo build --target x86_64-pc-windows-msvc
--release` 在干净的 `CARGO_TARGET_DIR` 里一次编过（ring 的 C / 汇编由 rustc 定位的
本机 MSVC 工具链编译）；`aarch64-pc-windows-msvc` 在注入 `CC=<zig> cc` +
`CFLAGS=--target=aarch64-windows-msvc` 后也在干净的 target 目录里一次编过。

## 期望

构建脚本按**宿主平台**决定 msvc 目标怎么编，而不是按目标三元组一律 xwin：

1. Windows 宿主：走本机 MSVC 工具链（rustc 经 Visual Studio 定位 `cl.exe` /
   `lib.exe`）。x64 目标不注入 C 工具链；arm64 目标的 C / 汇编部分由 `zig cc` 充当
   clang（ring 对 Windows AArch64 硬性要求 clang），不注入 `AR`（静态库仍由 VS 的
   `lib.exe` 打包）。
2. 非 Windows 宿主：msvc 目标继续经 `cargo xwin`，C 工具链也归它（不注入 `CC`，
   否则会覆盖 xwin 的 clang-cl 包装）。
3. 不静默降级：真的缺 `cargo-xwin` 时报错要给出安装方式（`cargo install cargo-xwin`），
   不是只留 `no such command: xwin`。

## 不变量

1. Linux musl / gnu 目标的构建路径不变（`zig cc` + `zig ar`，gnu 的链接经
   `zigLinkerWrapper`）。
2. 构建指纹口径不变：`CORE_FINGERPRINT` 照旧注入，`computeFingerprint` 的输入集与
   算法版本不动（[standalone-core.md 第 3.4 节](../../docs/core/standalone-core.md#34-构建指纹)）。
3. 构建失败如实报错并以非零退出码结束，不产出半成品、不跳过失败目标。
4. `PACKAGE_DIRS` 与平台矩阵不变，四个产物目录仍是要齐的集合。

## 回归测试

- **RT-1**：Windows 宿主上 msvc 目标的 cargo 调用**不带** `xwin` 子命令
  （`x86_64-pc-windows-msvc` / `aarch64-pc-windows-msvc` 两条都是）。
  （落点：`src/test/coreBuildToolchain.test.ts` 的 `RT-1`）
- **RT-2**：非 Windows 宿主上 msvc 目标仍经 `cargo xwin`（自带 Windows SDK 的路径不丢）。
  （落点：`src/test/coreBuildToolchain.test.ts` 的 `RT-2`）
- **RT-3**：Windows 宿主上的 arm64 目标注入 `zig cc` 与 zig 口径的目标三元组
  （`--target=aarch64-windows-msvc`），且不注入 `AR`；x64 目标不注入任何 C 工具链。
  （落点：`src/test/coreBuildToolchain.test.ts` 的 `RT-3`）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 复现（修复前） | `npm run package` | 红 | `vscode:prepublish → build:core` 报 `error: no such command: xwin`（exit 101） |
| 回归用例（修复前） | `npm run test:unit -- core-build-toolchain` | 红 | 8 项断言失败：`cargoInvocation` 未导出，宿主平台维度的判据不存在 |
| 回归用例（修复后） | `npm run test:unit -- core-build-toolchain` | 绿 | 11 项断言全过（RT-1 / RT-2 / RT-3 + Linux musl 不变量） |
| 既有回归 | `npm run test:unit -- core-fingerprint core-platform-matrix` | 绿 | 指纹口径与平台矩阵未受影响 |
| 出包链（修复后） | `npm run package` | 绿 | `build:core` 四个目标全部产出，`.vsix` / NSIS x64+arm64 / TUI 安装器四平台齐 |
| 文档守卫 | `npm run test:unit -- docs-lint` | 绿 | 50 项全过 |
| 类型检查 | `npm run check-types` | 绿 | — |
