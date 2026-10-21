---
status: 已修
---

# 缺陷：Core 的 pdb 调试符号从未随产物部署

Windows（MSVC）产物目录里从来没有 `<core.binaryName>.pdb`：`scripts/build-core.mjs` 的
`copyDebugSymbols` 按 exe 名推导 pdb 名（连字符 `standalone-core.pdb`），而 MSVC 工具链
实际产出的 pdb 用下划线（`standalone_core.pdb`），探测永远落空且按设计静默跳过。结果是
[docs/core/standalone-core.md 第 3.3 节](../../docs/core/standalone-core.md#33-构建与目标平台)
声明的「行号表在产物旁的 .pdb 里、由构建脚本一并部署」没有发生——崩溃诊断与 asan 报告
拿不到符号，只剩地址。release 与 asan profile 都受影响。

## 现状

- `core-rs/target/<triple>/<profile>/` 里 cargo 产出 `standalone_core.pdb`（下划线，
  两种 profile 一致；exe 是连字符 `standalone-core.exe`）。
- `copyDebugSymbols` 用 `built.replace(/\.exe$/, '.pdb')` 推导出 `standalone-core.pdb`，
  `existsSync` 为假，走「工具链没产出 pdb 时不阻塞构建」的静默跳过分支。
- `resources/core/x64-win32/`（本机最近一次构建后）只有 exe / fingerprint / ripgrep，
  没有 pdb。

## 期望

- `copyDebugSymbols` 按工具链实际命名（连字符 → 下划线）探测 pdb，命中即复制为产物目录
  里的 `<core.binaryName>.pdb`；探测两个命名变体只是容忍工具链命名漂移， pdb 缺失仍不
  阻塞构建（自定义 profile 关掉 debuginfo 时合法）。
- Windows 本机目标构建后，`resources/core/<dir>/<core.binaryName>.pdb` 存在
  （release / asan / debug profile 均带行号表，pdb 必然产出）。

## 不变量

- pdb 缺失不阻塞构建的语义不变（非 win32 平台无 pdb，依旧直接返回）。
- 产物目录里 pdb 的落位名保持 `<core.binaryName>.pdb`（对外名字取 `core.binaryName`，
  与 exe 同口径），不引入工具链内部命名。
- Linux（musl / ELF）产物不新增任何文件。

## 回归测试

- **RT-1**：宿主为 Windows 时，平台矩阵里本机目录除 exe / ripgrep / fingerprint 外还必须
  有 `<core.binaryName>.pdb`（落点：`src/test/corePlatformMatrix.test.ts` 的
  `x64-win32 已产出调试符号（pdb）` 断言；宿主非 Windows 时该断言不适用，不检查）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npm run test:all -- core-platform-matrix` | 红 | `x64-win32 已产出调试符号（pdb）` 不存在（61 通过 / 1 失败） |
| 回归用例（修复后） | `npm run test:all -- core-platform-matrix` | 绿 | asan 与 release 本机重建后 pdb 均落位，断言通过 |
| 既有回归 | `npm run test:all -- docs-lint` | 绿 | — |
| arm64-win32 交叉产物 | — | not-run | 交叉产物未单独重建；同一函数路径，下次全量 `npm run build:core` 自然覆盖 |
