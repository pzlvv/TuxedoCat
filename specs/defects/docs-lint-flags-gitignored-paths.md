---
status: 已修
---

# 缺陷：docsLint 的存在性检查把按设计不入库的本机文件判为失效引用

`src/test/docsLint.test.ts` 第 9 组要求 markdown 行内代码里的仓库路径在本机文件系统上存在，
但仓库里有一类**按设计不入库、每台机器自备**的文件（`e2e/environments.json`，含 SSH 凭证）。
三处入库文档引用它，于是「docsLint 绿不绿」取决于这台机器有没有恰好准备那份凭证文件——
干净克隆与 CI 上必红。

## 现状

- 检查位置：`src/test/docsLint.test.ts` 第 9 组「行内代码里的仓库路径全部存在」，判据是
  `fs.existsSync(path.join(REPO_ROOT, filePart))`；豁免只有两类——TODO.md 与未落定的 specs，
  以及 `docs/adr/`（冻结的历史决策）。
- `e2e/environments.json` 的定位由仓库自己写定：`.gitignore` 里单列一行、`e2e/README.md`
  第 36–37 行说明「该文件**不入库**（gitignore，内容含 SSH 凭证）」，首次使用从
  `e2e/environments.example.json` 复制。
- 三处入库文档在行内代码里引用它：`e2e/README.md` 第 36、37 行，
  `specs/defects/first-message-preempts-view-registration.md` 第 60 行（该缺陷 `status: 已修`，
  按已落定规格的口径不再豁免）。
- 复现（没有该文件的机器 / 干净克隆）：

  ```text 示意
  $ node scripts/run-tests.mjs docs-lint
  FAIL 行内代码里的仓库路径全部存在（失效 3 处）
       e2e/README.md:36 路径不存在：`e2e/environments.json`
       e2e/README.md:37 路径不存在：`e2e/environments.json`
       specs/defects/first-message-preempts-view-registration.md:60 路径不存在：`e2e/environments.json`
  # 48 通过 / 1 失败
  ```

  同一份代码在本机（有该文件）上是 49 通过 / 0 失败 —— 红绿由本机是否准备了凭证决定，
  与仓库内容无关。
- 影响面：CI 的 docs-lint job 在干净检出上必红（`.github/workflows/docs.yml` 的 docs job），
  任何新克隆的本地守卫同样红；而且这条红是「假红」，会把真实的失效引用淹掉。

## 期望

1. 存在性检查只约束**入库的**引用：路径若按 `.gitignore` 属于本机专属文件（如
   `e2e/environments.json`），本机缺失不算失效引用。
2. 判据取 `.gitignore`（唯一来源），不新增人工白名单；`.gitignore` 没覆盖的路径仍然必须存在，
   拼错的路径照旧报错。
3. `git` 不可用或判定失败时按「不是本机专属」处理（失败关闭），不让豁免退化成静默放行。

## 不变量

- 第 9 组既有豁免（TODO.md 与未落定的 specs、`docs/adr/`）与通配 / 占位符过滤（`*`、`<...>`、`...`）
  不变；`path::symbol` 与 `path.md#锚点` 只校验文件部分的口径不变。
- 三处现有引用保持原样：修的是检查口径，不是把文档里的路径改掉。
- 其他 docsLint 组（事件表、聚合数字、章节引用、常量 / 标识符存活等）行为不变。
- 本机已准备 `e2e/environments.json` 的环境仍绿。

## 回归测试

- **RT-1**：缺少本机专属文件时 docsLint 仍绿 —— 临时把 `e2e/environments.json` 移开（模拟干净
  克隆；文件本就不存在时直接跑），跑编译后的 `docsLint.test.js` 期望 exit 0，结束后还原
  （落点：`src/test/docsLintLocalOnlyPaths.test.ts` 的
  `缺少本机专属文件时 docsLint 仍绿`）。
- **RT-2**：豁免只覆盖 `.gitignore` 覆盖的路径 —— `e2e/environments.json` 判为本机专属，
  同目录入库的 `e2e/environments.example.json` 与不存在的 e2e/does-not-exist.json 都判为
  不是（落点：`src/test/docsLintLocalOnlyPaths.test.ts` 的
  `本机专属判定只认 .gitignore 覆盖的路径`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前，RT-1） | `npm run compile-tests && node scripts/run-tests.mjs docs-lint-local-only` | 红 | `FAIL 缺少本机专属文件时 docsLint 仍绿`：把 `e2e/environments.json` 移开后 docsLint exit 1，`行内代码里的仓库路径全部存在（失效 3 处）`，三处全指向该文件 |
| 回归用例（修复前，RT-2） | 同上 | 红 | `FAIL 本机专属判定模块存在`：`src/test/helpers/docPathExistence.ts` 尚不存在 |
| 回归用例（修复后，RT-1 + RT-2） | 同上 | 绿 | 4 项断言通过：移开 `e2e/environments.json` 后 docsLint exit 0；`e2e/environments.json` 判为本机专属，`e2e/environments.example.json` 与不存在的 e2e/does-not-exist.json 都不豁免 |
| 既有回归（文档守卫全量） | `node scripts/run-tests.mjs docs-lint` | 绿 | 49 项通过；第 9 组「行内代码里的仓库路径全部存在」失效 0 处（有 / 无本机文件两种情形都绿） |
| 既有回归（打包链与边界） | `node scripts/run-tests.mjs packaging-chain pdb-packaging tray-sound` | 绿 | 3 + 3 + 4 项断言全通过 |
| 静态检查 | `npm run check-types && npm run lint` | 绿 | 三份 tsconfig 与 eslint 均无输出 |
