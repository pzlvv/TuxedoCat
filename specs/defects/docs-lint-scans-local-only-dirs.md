---
status: 已修
---

# 缺陷：docsLint 的扫描面包含按设计不入库的本机专属目录，标识符存活检查随本机草稿变松

`src/test/docsLint.test.ts` 的 `listFiles()` 遍历仓库时只跳过硬编码的 `SKIP_DIRS`，不排除
仓库顶层「按设计不入库」的目录（典型是本机草稿目录 `exp/`，放诊断脚本与截图）。于是被
`.gitignore` 覆盖的目录照样进入扫描面，docsLint 第 15 组「反引号标识符存活」的标识符全集
（来自 `listFiles()` 产物里的非 markdown 文件）被本机草稿里的外部库符号撑大——文档里写一个
**只在草稿里出现**的名字，本机绿、干净克隆与 CI 红。

## 现状

- 扫描入口：`src/test/docsLint.test.ts` 的 `listFiles()`（顶层 `walk(REPO_ROOT)`），跳过
  条件只有 `tmp_*` 前缀、`_templates`、`SKIP_DIRS`（构建产物 / 依赖 / `.agents` / 配置目录名）
  以及 `docs/` 的特殊分支；`isLocalOnlyPath` 已在本文件 import，但只用在第 9 组「行内代码
  路径存在性」与第 15 组的同族判定上，**没有用在扫描面本身**。
- 第 15 组的标识符全集由非 markdown 的扫描文件直接喂入：其中出现的每个词都进标识符全集，
  文档行内代码里的标识符只要全集命中就算「存活」。
- 本机 `exp/` 有 55 个文件、47 个 `.mjs`（docsLint 的扫描扩展名集合覆盖 `.mjs`），
  其中大量符号在入库代码里根本不存在。
- 复现（本机，`exp/` 在）：往 `e2e/README.md` 末尾临时追加一行引用一个只出现在
  `exp/_probe_pin.mjs` 的字段名，`npm run test:unit -- docs-lint` 绿（49 通过 / 0 失败）。
  同一份代码把 `exp/` 移开（干净克隆口径）后同一命令红：

  ```text 示意
  FAIL 反引号标识符全部存活（失效 1 处）
       e2e/README.md:476 标识符在代码里不存在：`<只在 exp/ 出现的字段名>`
  ```

- 事故实证：最近两轮缺陷规格分别写了测试机 SSH 账号名（本机因 `exp/` 的 sudo 探针提到而过）
  与 `@electron/get` 的内部实现符号（本机因 `exp/` 的两个下载诊断脚本提到而过），两次都是
  本地绿、CI 红（run 45046252618 的 docs-lint job）。
- 同族问题的既有处置：`src/test/brandLiteral.test.ts` 已经按 `.gitignore` 判据排除顶层本机
  专属目录（`localOnlyTopLevelDirs()`，只在顶层判定一次），docsLint 缺同一层。

## 期望

1. 仓库顶层「按设计不入库」的目录整棵不参与 docsLint 扫描：判据取 `.gitignore`
   （`helpers/docPathExistence.ts` 的 `isLocalOnlyPath`，唯一来源），不新增人工白名单。
2. 顶层的判定只做一次（与 `brandLiteral.test.ts` 同口径）：本机专属目录下的子目录必然也在
   忽略范围内，递归判定只会给每个子目录多起一个 `git check-ignore` 进程。
3. 文件级不豁免：被忽略的**单文件**（如 `e2e/environments.json`）照常进入扫描面，宁可多报。
4. 既有跳过项与 `docs/` 特殊分支保持原样：`SKIP_DIRS` 的全部条目、`tmp_*`、`_templates`、
   `docs/` 全目录参与（`archive` 除外）都不变。
5. 第 15 组的判据本身不变：不新增豁免名单、不放宽匹配规则——这次修的是「扫描面该不该包含
   本机文件」，不是「标识符检查太严」。

## 不变量

- `SKIP_DIRS` 名单与 `docs/` 分支行为不变；`tmp_*` / `_templates` 的跳过不变。
- 入库内容的扫描结果不变：修复前后，仓库里所有**入库**文件仍然全部参与扫描（`listFiles()`
  在干净克隆上返回的集合与修复前逐项相同）。
- `isLocalOnlyPath` 的失败关闭语义不变（git 不可用 / 未命中规则按「不是本机专属」处理），
  目录专属模式（带尾斜杠的查询）仍能命中。
- 第 9 组「行内代码里的仓库路径全部存在」与第 15 组「反引号标识符全部存活」的判据、豁免
  名单与错误文案不变。
- `src/test/brandLiteral.test.ts` 与 `src/test/helpers/docPathExistence.ts` 不改（它们已经
  是正确口径）。

## 回归测试

- **RT-1**：本机专属目录里的符号不参与标识符存活判定——在仓库顶层造一个被 `.gitignore`
  覆盖的目录，里面放一份提到探针符号的 `.mjs`，同时在仓库顶层放一份引用该符号的 markdown；
  跑编译后的 docsLint，断言 exit 非 0 且输出含该符号的「标识符在代码里不存在」。修复前该
  符号被本机文件救活、docsLint 照样 exit 0（红），修复后如期报错（绿）
  （落点：`src/test/docsLintLocalOnlyPaths.test.ts` 的
  `本机专属目录里的符号不参与标识符存活判定`）。
- **RT-2**：干净克隆口径整体绿——把本机草稿目录 `exp/` 移开后跑全量单测，0 失败
  （落点：`npm run test:unit`，见验证记录）。
- **RT-3**：既有豁免与边界不回退——`npm run test:unit -- docs-lint-local-only` 原有 6 项
  断言（本机专属文件缺失时 docsLint 仍绿、判定只认 `.gitignore` 覆盖的路径、目录专属模式
  在本机缺失时仍豁免）与 `npm run test:unit -- brand-literal` 全绿（落点：
  `src/test/docsLintLocalOnlyPaths.test.ts` / `src/test/brandLiteral.test.ts`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 复现（本机草稿目录在，假绿） | `e2e/README.md` 临时追加一行引用 `exp/_probe_pin.mjs` 里的字段名，然后 `npm run test:unit -- docs-lint` | 绿 | 49 通过 / 0 失败——本机文件把符号救活了；临时代码已还原 |
| 复现（干净克隆口径，`exp/` 移开） | 同一份临时代码，先把 `exp/` 移到 `/tmp/exp-hold`（`trap` 保证回位）再跑 `node out/src/test/docsLint.test.js` | 红 | `FAIL 反引号标识符全部存活（失效 1 处）`：`e2e/README.md:476 标识符在代码里不存在`；移回后 `exp/` 55 个文件清点一致 |
| 回归用例（修复前，RT-1） | `npm run test:unit -- docs-lint-local-only`（`src/test/docsLint.test.ts` 用 `git checkout --` 回到修复前状态） | 红 | `FAIL 本机专属目录里的符号不参与标识符存活判定`：探针符号被本机专属目录里的脚本救活，docsLint 仍 exit 0（6 通过 / 1 失败） |
| 回归用例（修复后，RT-1） | `npm run test:unit -- docs-lint-local-only` | 绿 | 7 通过 / 0 失败：探针符号只在非入库目录里，docsLint 如期报「标识符在代码里不存在」且 exit 非 0 |
| 既有回归（文档守卫 / 品牌字面量 / 本机专属豁免 / CI 车道） | `npm run test:unit -- docs-lint brand-literal docs-lint-local-only e2e-ci-lane` | 绿 | 4 个用例文件全通过（docsLint 49 项、brandLiteral 12 项、docsLintLocalOnlyPaths 7 项、e2eCiLane 42 项） |
| 干净克隆口径全量单测（RT-2） | 移开 `exp/` 后 `npm run test:unit` | 绿 | 130 通过 / 0 失败 / 2 跳过（跳过的是 `sidebarDocViewGit` / `sidebarFiles`，环境前置不满足走 skip 分支，与本缺陷无关）；`docsLint` / `brandLiteral` / `docsLintLocalOnlyPaths` 三个文件在移开 `exp/` 的情形下同样绿 |
| 类型与静态检查 | `npm run check-types && npm run lint` | 绿 | 三份 tsc 配置与 eslint 无错误 |
| status 改「已修」后复跑 | `npm run test:unit -- docs-lint` | 绿 | 本文件进入落定态落点存活检查（status 为「已修」的缺陷规格不再豁免存在性检查）后仍绿 |
