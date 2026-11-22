---
status: 已修
---

# 缺陷：e2e/README.md 违反品牌字面量与反引号标识符存活两条守卫，CI 的 docs-lint 与 tests 双红

`e2e/README.md` 的两处散文同时踩了两条 as-built 守卫：一处写出产品配置目录的字面量
（[docs/hosts/product-identity.md 第 3 节](../../docs/hosts/product-identity.md#3-占位符约定)
要求文档一律用 `<configDir>` 占位符），一处把只在测试机存在的 SSH 账号名写进反引号
（docsLint 的反引号标识符须在代码里存活）。于是
`smoke / docs-lint` job 与 `smoke / tests` job 都红，`test:all` 的 `&&` 链断在单测段、
永远跑不到 e2e。

## 现状

- 品牌字面量：`e2e/README.md` 第 20 条已知坑里用 `~/.<配置目录字面量>/run/` 直接写出
  配置目录名。`src/test/brandLiteral.test.ts` 扫描由 `extensionName` / `productName` 派生的
  变体，放行清单只有两个定义处与 `package-lock.json`，该行命中扩展名变体。
- 反引号标识符：同文件「自托管 runner 的部署口径」第 3 条把测试机第二个 SSH 账号写成
  行内代码（即 CI 报出的那个标识符）。docsLint 第 15 组要求反引号里的小驼峰 / 大字头
  标识符在代码里存在，而该账号名只出现在 `.gitignore` 排除的 `e2e/environments.json` 与
  缺陷规格的实测输出里，不在受扫代码中。
- 复现（干净克隆 / CI 与开发机同现象）：

  ```text 示意
  $ npm run test:unit -- brand-literal
  FAIL 全仓无散落品牌字面量（扫 1164 个文本文件）
    e2e/README.md:434 命中扩展名变体

  $ npm run test:unit -- docs-lint
  FAIL 反引号标识符全部存活（失效 1 处）
       e2e/README.md:175 标识符在代码里不存在：测试机账号名
  FAIL 缺少本机专属文件时 docsLint 仍绿
  ```

- 连锁面：`src/test/docsLintLocalOnlyPaths.test.ts` 的 RT-1 直接跑编译后的
  `docsLint.test.js` 并断言 exit 0，docsLint 一变红它就跟着红；`smoke / tests` job 的
  `test:unit` 因此红在 docsLint 与 docsLintLocalOnlyPaths 两组。
- CI 实证：run `45027408803`，`smoke / docs-lint` 红于「反引号标识符全部存活（失效 1 处）」，
  `smoke / tests` 红于 brandLiteral 与上述两组。

## 期望

- 文档里的产品配置目录一律写占位符 `.<configDir>`（与同文件第 11 / 14 条已知坑、以及
  `docs/` 全部规格同口径），Core 二进制名同样不写实：清场命令按
  `src/config/project.ts` 取值（该文件已有 `CORE_PROCESS_PATTERN` 先例）。
- 测试机专属的 SSH 账号名不作为反引号标识符出现在入库文档：改为指向
  `e2e/environments.json` 的 `ssh.sudoPasswordRequired.user` 字段说明来源，
  读者按字段取真实值，文档本身不含账号字面量。
- 两条守卫的判据本身不改：品牌仍只允许出现在两个定义处；反引号里的标识符仍必须能在代码里
  找到。修的是文档，不是守卫。

## 不变量

- [docs/hosts/product-identity.md 第 1 节](../../docs/hosts/product-identity.md#1-定义处)的两个
  定义处与 `brandLiteral` 的放行清单不变（不新增放行文件）。
- docsLint 第 15 组（反引号标识符存活）与第 9 组（行内代码路径存在）的判据与豁免面不变；
  `docsLintLocalOnlyPaths` 的六条断言（含 `e2e/environments.json` 与 `resources/core`
  两条本机专属豁免）不变。
- 已知坑 20 的排障结论（沙箱累积导致 Electron 启动即崩、cron 清理口径、
  `pgrep` 全 uid 口径陷阱）逐条保留，只改指称方式。

## 回归测试

- **RT-1**：全仓无散落品牌字面量——`npm run test:unit -- brand-literal`，断言
  「全仓无散落品牌字面量」通过且命中数为 0（落点：`src/test/brandLiteral.test.ts` 的
  `全仓无散落品牌字面量（扫 N 个文本文件）`）。
- **RT-2**：反引号标识符全部存活——`npm run test:unit -- docs-lint`，断言
  「反引号标识符全部存活（失效 0 处）」通过（落点：`src/test/docsLint.test.ts`）。
- **RT-3**：docsLint 整跑 exit 0（含本机专属文件缺失场景）——`npm run test:unit --
  docs-lint-local-only` 的「缺少本机专属文件时 docsLint 仍绿」（落点：
  `src/test/docsLintLocalOnlyPaths.test.ts`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前，RT-1） | `npm run test:unit -- brand-literal` | 红 | `FAIL 全仓无散落品牌字面量（扫 1164 个文本文件）`：`e2e/README.md:434 命中扩展名字面量`，11 通过 / 1 失败 |
| 回归用例（修复前，RT-2 / RT-3） | `npm run test:unit -- docs-lint` | 红 | `FAIL 反引号标识符全部存活（失效 1 处）`：`e2e/README.md:175 标识符在代码里不存在：测试机账号名`；连带 `FAIL 缺少本机专属文件时 docsLint 仍绿`（RT-1 整跑 exit 1） |
| 回归用例（修复后，RT-1） | `npm run test:unit -- brand-literal` | 绿 | 12 通过 / 0 失败 |
| 回归用例（修复后，RT-2 / RT-3） | `npm run test:unit -- docs-lint` | 绿 | docsLint 49 通过 / 0 失败（`反引号标识符全部存活（失效 0 处）`），docsLintLocalOnlyPaths 6 通过 / 0 失败 |
| 干净克隆口径（移开 `exp/` 与 `e2e/environments.json`） | `npm run test:unit` | 绿 | 模拟 CI 检出全量单测：130 通过 / 0 失败 / 2 跳过（`sidebarDocViewGit`、`sidebarFiles` 为环境前置缺失的 skip 分支，与本次改动无关） |
| 既有回归（单测全量） | `npm run test:unit` | 绿 | 130 通过 / 0 失败 / 2 跳过（同上两条 skip）；三个守卫用例三条全绿 |
| 类型与静态检查 | `npm run check-types` / `npm run check-types:e2e` / `npm run lint` | 绿 | 四份 tsconfig 与 eslint 无输出 |
| CI 实证（修复前） | run `45027408803` | 红 | `smoke / docs-lint` 与 `smoke / tests` 两 job 红于本缺陷 |
| CI 实证（修复后） | 下一次 push 的 smoke run | not-run | 待推送后由 CI 复核 |
