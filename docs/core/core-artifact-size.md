---
owner: pzlvv
last_reviewed: 2026-11-22
---

# 规格：Core 产物体积与调试符号

本文件界定 Core / 挂载代理可执行文件的体积构成，以及「崩溃栈能符号化到什么程度」这条
取舍（函数名 vs 源码行号）。产物落位、平台矩阵与构建流程见
[docs/core/standalone-core.md](standalone-core.md#31-平台矩阵)；远端部署的上传路径见
[docs/core/core-remote.md](core-remote.md#25-连接与生命周期)。

## 1. 能力

- 两种产物（`<core.binaryName>` 与 `<core.mountProxyName>`）在 release 构建下**不携带**
  DWARF 调试信息段（`.debug_info` / `.debug_str` / `.debug_ranges` / `.debug_line` /
  `.debug_loc` 等），只保留符号表（`.symtab` / `.strtab`）。
- panic 钩子（`core-rs/src/util.rs` 的 `install_panic_hook`）捕获的调用栈能解析出
  **函数名**，不能解析出源码行号。
- ASAN 变体是例外：它保留完整 `.debug_*`，供 ASAN 报告按 PC 查源码位置。

## 2. FR

### FR-001：release profile 删除调试信息段、保留符号表

两个 crate 的 `[profile.release]` 都声明：

```toml
debug = "line-tables-only"
strip = "debuginfo"
```

不用 `strip = true`：那会连 `.symtab` / `.strtab` 一起删，栈退化成裸地址，崩溃诊断
能力真正丢失。两档的差别就是「函数名」与「源码行号」，取前者。

### FR-002：ASAN profile 保留调试信息段

`[profile.asan]` 继承 release 的优化与 `debug = "line-tables-only"`，但覆写
`strip = "none"`。ASAN 报告按 PC 查源码行号与变量位置，删了 `.debug_*` 就只剩地址。
该 profile 不进分发包、不走远端部署，体积不是约束。

### FR-003：Windows 的符号能力由 `.pdb` 承担

PE 的可执行文件本来不内嵌 DWARF，`strip = "debuginfo"` 在 MSVC 目标是空操作。
Windows 的调用栈符号化依赖构建产物旁的 `<core.binaryName>.pdb`
（`scripts/build-core.mjs` 的 `copyDebugSymbols` 落在 `resources/core/<dir>/`）。

## 3. 行为规格

### 3.1 体积构成

x64-linux 实测（`resources/core/x64-linux/`）：

| 产物 | 体积 | 构成 |
| --- | --- | --- |
| `<core.binaryName>`（x64-linux） | 8.10MB | 运行所需段 7.1MB + 符号表 1.0MB，`.debug_*` 为 0 |
| `<core.mountProxyName>`（x64-linux） | 0.73MB | 运行所需段 0.6MB + 符号表 0.13MB |
| `<core.binaryName>`（arm64-linux） | 7.32MB | 同口径 |

保留 `.debug_*` 时核心是 34.3MB——其中 26.2MB（76%）是运行时**从不加载**的数据：
DWARF 段不是可加载段，进程启动不读它。

### 3.2 为什么体积在 CI 上是硬约束

`electron-ssh` 车道的冷部署把整份产物经 SFTP 传到远端部署槽位
（[docs/core/core-remote.md 第 2.5 节](core-remote.md#25-连接与生命周期)）。上传的是
**整个文件**，因此 `.debug_*` 那 26MB 会被原样送到远端并被远端 `mv` 进槽位——它对远端
运行毫无用处（Core 不读自己的 DWARF），却决定了这条车道的部署耗时与失败面。

## 4. 边界

- **不**改变崩溃栈的可用性判据：栈仍带函数名，只是没有 `file:line`。需要行号时用 ASAN
  变体或 debug 构建（`npm run build:core:debug`，本来就不 strip）。
- **不**影响 ASAN 报告质量（FR-002 保留调试段）。
- **不**改变构建指纹的输入语义：指纹取源码树 hash + rustc 身份 + 三元组 + profile 名，
  与 strip 配置无关；改 profile 会改源码树 hash，因此指纹自然变化、旧槽位不复用。
- 分发包里始终不含 `.debug_*` 与 `.pdb`（[docs/core/standalone-core.md](standalone-core.md#31-平台矩阵)）。

## 5. 非目标

- 不做运行时按需下载符号包（崩溃后要联网解析）。
- 不引入 `split-debuginfo` / 旁挂 `.dwp`（Linux 上不存在像 `.pdb` 那样的既有落位约定）。
- 不为压缩产物而改 LTO / opt-level（体积主项是调试段，压缩它已足够）。

## 6. 基线影响

| 文档 | 章节 | 影响 |
| --- | --- | --- |
| [docs/core/standalone-core.md](standalone-core.md) | [3.1 平台矩阵](standalone-core.md#31-平台矩阵) | 补一行指向本文件的取舍指针 |
| [docs/core/standalone-core.md](standalone-core.md) | [6.1 崩溃与重启](standalone-core.md#61-崩溃与重启) | 崩溃栈能力与 profile 口径 |
| [docs/core/core-remote.md](core-remote.md) | [2.5 连接与生命周期](core-remote.md#25-连接与生命周期) | 符号化能力由「函数名与行号」改为「函数名」 |

## 7. 追溯矩阵

| 需求 | 落点 | 测试 |
| --- | --- | --- |
| FR-001 | `core-rs/Cargo.toml`、`mount-proxy-rs/Cargo.toml` 的 `[profile.release]` | `src/test/corePlatformMatrix.test.ts`：两个 crate 都声明 `strip = "debuginfo"` 且没有 `strip = true`；已构建的 Linux 产物实测 `.debug_*` 为 0、`.symtab` 非空 |
| FR-002 | `core-rs/Cargo.toml` 的 `[profile.asan]` | 同上：asan profile 覆写 `strip = "none"` |
| FR-003 | `scripts/build-core.mjs` 的 `copyDebugSymbols` | 同上：Windows 产物已产出调试符号（`pdb`），宿主非 Windows 时不检查 |
