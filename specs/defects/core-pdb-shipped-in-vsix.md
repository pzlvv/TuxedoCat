---
status: 已修
---

# 缺陷：Core 的 .pdb 调试符号被打进 vsix

`scripts/build-core.mjs` 的 `copyDebugSymbols` 把 Windows 目标的调试符号落成
`resources/core/<dir>/<core.binaryName>.pdb`（本地崩溃诊断用），`scripts/copy-assets.mjs`
再把整个 `resources/` 复制进 `dist/`。`.vscodeignore` 的打包白名单是
`!dist/resources/**`（negate 命中即入包），于是 `.pdb` 随下一次 `npm run package:ext`
进入 vsix：单个 Windows 架构约 22MB，四个目标里带两个，分发包白胖约 45MB。

## 现状

- 复现：`node scripts/copy-assets.mjs` 之后 `dist/resources/core/arm64-win32/` 出现
  `<core.binaryName>.pdb`（22,876,160 字节，与 `resources/` 下的符号同源）。
- `.vscodeignore` 只有 `!dist/resources/**` 一条放行规则；`@vscode/vsce` 的打包收集逻辑
  判定是 `!ignore.some(…) || negate.some(…)`（negate 命中即入包），
  所以 `dist/resources/core/<dir>/<core.binaryName>.pdb` 被放行。
- `release/<extensionName>-<version>.vsix` 是 2026-10-20 构建的，早于符号落位缺陷
  [core-pdb-not-deployed](core-pdb-not-deployed.md) 的修复，当时 `dist/resources/` 里
  没有 `.pdb`，旧包里看不到；下一次 `package:ext` 就会带上。
- Electron 侧没有这个问题：electron-builder 的默认文件匹配规则在
  `includePdb !== true` 时追加 `!**/*.{…,pdb}`，`electron-builder.config.js` 未打开该开关。
- TUI 安装器没有这个问题：`installer-rs/build.rs` 只 `include_bytes!` 可执行文件 /
  `ripgrep/rg[.exe]` / `fingerprint` / TUI 二进制。

## 期望

- vsix 不含 `dist/resources/core/<dir>/<core.binaryName>.pdb`。
- vsix 仍含运行时产物：可执行文件、`fingerprint`、`ripgrep/rg[.exe]`、webview 产物
  （白名单不能收窄过头）。
- `.pdb` 继续落在 `resources/core/<dir>/`（[core-pdb-not-deployed](core-pdb-not-deployed.md)
  的 RT-1 不变），并继续随 `copy-assets` 进入 `dist/` 供本地崩溃诊断；它只是不进分发物。
- Electron 安装包保持默认排除 `.pdb`（不打开 `includePdb`）。
- 文档同步：[docs/core/standalone-core.md 第 3.1 节](../../docs/core/standalone-core.md#31-平台矩阵)
  的打包边界写明 `.pdb` 不随分发包走，与 `resources/ripgrep/<dir>/` 的既有口径一致。

## 不变量

- `resources/core/<dir>/<core.binaryName>.pdb` 的落位名与存在性不变（Windows 目标）。
- `copy-assets` 继续把可执行文件 / `fingerprint` / `ripgrep/` 复制进 `dist/resources/`，
  并继续清理 `dist/resources/ripgrep/`。
- `copy-assets` 不删除 `resources/` 下的 `.pdb`（本地诊断仍要用）。
- 打包白名单对 `dist/` 下其余运行时文件的放行不受影响。

## 回归测试

- **RT-1**：按 vsce 自己的打包过滤（`@vscode/vsce` 的 `collect`）跑仓库真实的
  `.vscodeignore`：`dist/resources/core/<dir>/<core.binaryName>.pdb` 不进 vsix，而
  可执行文件 / `fingerprint` / `ripgrep/` / webview 产物仍在包内（落点：
  `src/test/pdbPackaging.test.ts` 的 `vsix 不含 Core 的调试符号（.pdb）` 与
  `vsix 仍含运行时产物（可执行文件 / fingerprint / ripgrep / webview）`）。
- **RT-2**：`electron-builder.config.js` 不打开 `includePdb`（落点：
  `src/test/pdbPackaging.test.ts` 的 `Electron 安装包不打开 electron-builder 的 includePdb`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npm run test:all -- pdb-packaging` | 红 | `FAIL vsix 不含 Core 的调试符号（.pdb）`（2 通过 / 1 失败） |
| 回归用例（修复后） | `npm run test:all -- pdb-packaging` | 绿 | 3 通过 / 0 失败 |
| 真实仓库打包清单 | `npx vsce ls` | 绿 | `dist/` 里已有 `.pdb` 的前提下，输出不含 `.pdb`，四个目标的 exe / fingerprint / ripgrep 全在 |
| 既有回归：白名单没误伤 | `npm run test:all -- tray-sound-assets` | 绿 | 同一份 `.vscodeignore` 的 vsce 过滤用例 |
| 既有回归：文档守卫 | `npm run test:all -- docs-lint` | 绿 | 章节引用、500 行上限、缺陷规格结构 |
| 既有回归：品牌字面量 | `npm run test:all -- brand-literal` | 绿 | 新用例只经 `core.binaryName` 引用二进制名 |
| 既有回归：产物落位 | `npm run test:all -- core-platform-matrix` | 绿 | `resources/` 下的 `.pdb` 仍存在（RT-1 不变） |
| 静态检查 | `npm run lint` | 绿 | — |
