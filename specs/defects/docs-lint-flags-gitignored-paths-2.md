---
status: 已修
---

# 缺陷：docsLint 的本机专属豁免不认目录专属 gitignore 模式，路径缺失时误报失效引用

[docs-lint-flags-gitignored-paths](docs-lint-flags-gitignored-paths.md) 修掉了「gitignore 的
本机专属**文件**被存在性检查误报」，但豁免判定 `isLocalOnlyPath` 在**目录专属模式**上仍有
同族漏洞：`.gitignore` 的 `resources/core/`（`build-core.mjs` 的产物落点，行内代码正当引用于
`docs/architecture/repo-map.md` 的工作区表行）是**带尾斜杠的目录专属模式**——`git check-ignore` 对
「本机不存在的无斜杠路径」按文件解读，目录专属模式永不命中。于是本地（路径存在，existsSync
通过，豁免分支根本不走）绿、干净克隆与 CI（路径不存在，豁免判定失效）红——红绿依旧取决于
本机有没有构建过，与仓库内容无关。smoke 车道首跑在 CI 实证：docs-lint job 报
「行内代码里的仓库路径全部存在（失效 1 处）：docs/architecture/repo-map.md:31 路径不存在：
`resources/core/`」，而带 `lfs: true` 且先构建 Core 的 tests job 同一检查通过。

## 现状

- `src/test/helpers/docPathExistence.ts` 的 `isLocalOnlyPath` 只做一次
  `git check-ignore --quiet --no-index -- <relPath>`（无尾斜杠）。
- `git check-ignore` 的目录判定依赖 lstat：路径在本机存在为目录时，`resources/core/` 这类
  目录专属模式照常命中（本机探针 no-slash=0）；路径不存在时按文件解读，永不命中
  （本机改名探针 no-slash=1、带斜杠=0）——豁免判定随本机文件系统翻转。
- 复现（路径缺失的环境，如 CI docs-lint job / 临时把 `resources/core` 移开）：
  `node scripts/run-tests.mjs docs-lint` →
  `FAIL 行内代码里的仓库路径全部存在（失效 1 处）`，指向 `docs/architecture/repo-map.md`
  里引用 `resources/core/` 的那一行。
- 实证：PR #1 的 smoke run 40366255086，docs-lint job 红于该断言；tests job（先
  `build:core:linux-x64` 落出 `resources/core/`）同一断言绿。

## 期望

- `isLocalOnlyPath` 对「gitignore 目录专属模式覆盖的路径」不依赖本机存在性：无斜杠查询
  未命中时补一次**带尾斜杠**的查询（目录语义显式化），任一命中即豁免。失败关闭语义
  不变：两次都未命中（git 不可用 / 模式不覆盖）仍按「不是本机专属」处理。
- 文件形态的判定行为不变：`e2e/environments.json` 照旧豁免；入库文件与拼错路径照旧不豁免。

## 不变量

- [docs-lint-flags-gitignored-paths](docs-lint-flags-gitignored-paths.md) 的三条期望原样保持
  （判据取 `.gitignore`、不扩成整目录豁免、失败关闭）；本修复只是把「目录专属模式」纳入
  同一口径，不是新开豁免面。
- 存在性检查的其余豁免（TODO.md / 未落定 specs / `docs/adr/`、通配与占位符过滤）不变。
- 路径**存在**的本机（开发机常态）判定结果不变（本就命中，只是换了一条更稳的查询路径）。

## 回归测试

- **RT-1**：目录专属模式在本机缺失时仍豁免——`resources/core` 本机存在则临时移开（模拟
  干净克隆 / CI，结束后还原），断言 `isLocalOnlyPath('resources/core') === true`（落点：
  `src/test/docsLintLocalOnlyPaths.test.ts` 的「目录专属 gitignore 模式在本机缺失时仍豁免」）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npm run compile-tests && node scripts/run-tests.mjs docs-lint-local-only` | 红 | `FAIL 目录专属 gitignore 模式在本机缺失时仍豁免`：`resources/core` 移开后 `isLocalOnlyPath` 返回 false（无斜杠查询 status 1）；同场景下 RT-1 的整跑 docsLint 也 exit 1（repo-map.md:31 被误报） |
| 回归用例（修复后） | 同上 | 绿 | 移开 `resources/core` 后 `isLocalOnlyPath('resources/core') === true`（补带斜杠查询命中），RT-1 整跑 docsLint exit 0；`e2e/environments.json` 豁免与「入库文件 / 拼错路径不豁免」两条既有断言不受影响 |
| 既有回归（docs 守卫全量） | `node scripts/run-tests.mjs docs-lint` | 绿 | 行内代码路径失效 0 处；`resources/core/` 在本机存在与移开两种情形下都绿 |
| 类型与静态检查 | `npm run check-types && npm run lint` | 绿 | 三份 tsc 配置与 eslint 无错误 |
| CI 实证（修复前） | PR #1 smoke run 40366255086 | 红 | docs-lint job 红于本缺陷（`resources/core/` 误报）；tests job 因先构建 Core 落出该目录而绿——修复后 smoke run 40380622290（本 PR）docs-lint job 绿 |
