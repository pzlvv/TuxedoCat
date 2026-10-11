---
owner: pzlvv
last_reviewed: 2026-10-11
---

# 规格：产品身份

本规格界定产品身份（显示名、扩展名、配置目录、环境变量前缀、命令 / 面板 id、产物名）
的唯一来源与去字面化契约：产品名只允许出现在**两个定义处**，其余源码、构建脚本、用例、
文档一律经变量引用或占位符表达，因此改产品名不需要全仓搜索替换。

交叉引用：[DEVELOPMENT.md 第 1.3 节](../DEVELOPMENT.md#13-目录布局)（目录布局）、[第 5.9 节](../DEVELOPMENT.md#59-同一字段的默认值只有一处)（同一字段的默认值只有一处）、
`docs/standalone-core.md`（Core 产物名与部署目录）、`docs/tui-installer.md`（安装器分发名）。

## 1. 定义处

产品身份只有两个定义处，二者必须一致：

| 定义处 | 承载 | 内容 |
| --- | --- | --- |
| `src/config/project.json` | 工程变量 | `productName` / `extensionName` / `publisher` / `author` / `repositoryUrl` / `appId` / `configDir` / `commandPrefix` / `viewContainerId` / `viewId` / `outputChannelName` / `envPrefix` / `envMaxOutputTokens` / `logFileName` / `tmpTaskDirName` / `taskOwner` / `core.*` / `schemes.*` / `panelIds.*` |
| `package.json` | VS Code 扩展清单 | `name`（= `extensionName`）、`displayName`（= `productName`）、`publisher`、`author`、`repository.url`、`contributes` 里的 command id（`<commandPrefix>.open`）、viewContainer id（`viewContainerId`）、view id（`viewId`） |

`package.json` 之所以是定义处而不是消费方：VS Code 只读 `package.json`，扩展 ID、command id、
view id 都必须是字面量，无法用变量表达。`package-lock.json` 由 `package.json` 的 `name`
生成，随定义处变化。

`src/test/brandLiteral.test.ts` 做两件事：校验两个定义处的身份字段一致；全仓扫描由
`extensionName` / `productName` 派生的分隔符变体（`foo-bar` / `foo_bar` / `foo bar` / `foobar`），
除定义处与 `package-lock.json` 外零命中。

## 2. 消费方式

| 消费方 | 取值途径 |
| --- | --- |
| TS 源码 / 用例 | `src/config/project.ts` 导出的常量（`PRODUCT_NAME` / `EXTENSION_NAME` / `CONFIG_DIR_NAME` / `ENV_PREFIX` / `CORE_ENV_VAR` / `CORE_BINARY_NAME` / `CORE_DEPLOY_PREFIX` …） |
| Node 构建脚本（`.mjs` / `.cjs` / `.js`） | `project.config.cjs`（在 `src/config/project.json` 之上补路径解析） |
| Rust（`core-rs` / `tui-rs` / `installer-rs`） | 各自 `build.rs` 在构建期把 `project.json` 字段烧成 `TC_*` 编译期环境变量，源码经 `env!` 取值 |
| Python（`scripts/fix_vsix_permissions.py`） | 直接读 `src/config/project.json` |
| e2e（`e2e/**`） | 直接 import `src/config/project.ts` |
| 文档 / 注释 | 占位符（第 3 节） |

crate / 二进制名（`core-rs`、`tui-rs`、`installer-rs`）保持中性：cargo 不认变量，产品名由
构建脚本在落位分发产物时套上（Core 二进制名取 `core.binaryName`，TUI 安装器分发名取
`<extensionName>-tui-installer`）。

## 3. 占位符约定

文档与注释里的产品身份写成占位符，不写具体值：

| 占位符 | 含义 |
| --- | --- |
| `<product-name>` | 产品显示名（`productName`），也用作「产品名」的统称 |
| `<extensionName>` | 扩展名（`extensionName`） |
| `<configDir>` | 配置目录名（`configDir`） |
| `<envPrefix>` | 环境变量前缀（`envPrefix`） |
| `<core.binaryName>` / `<core.deployPrefix>` / `<core.resourceDir>` / `<core.envVarSuffix>` | `project.json` 的 `core.*` 字段 |
| `<tmpTaskDirName>` | 后台任务输出目录名 |

## 4. 改名步骤

1. 改 `src/config/project.json` 的身份字段；
2. 同步改 `package.json` 的身份字段与 `contributes` 里的 id；
3. `npm install --package-lock-only` 重新生成 `package-lock.json`；
4. 跑 `npm run check-types && npm run lint`，再跑 `npm run test:all -- brand-literal`。

三步之外不需要动任何源码：Core 二进制名、部署目录、TUI 安装器分发名、配置目录、
环境变量前缀都由构建脚本从定义处派生。
