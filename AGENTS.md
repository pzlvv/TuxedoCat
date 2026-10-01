# AGENTS.md

面向 AI 协作者的开发约定。架构细节一律以 `DEVELOPMENT.md`（as-built 规格）为准，本文件只列
「必须遵守的风格与约定」。

## 0. 文档要求

适用对象：`DEVELOPMENT.md`、`docs/*.md`。

- **只写现状**：文档描述代码当前的实现（as-built），不写计划、不写演进过程。
- **直接陈述应有形态**：文档只回答「应该是什么样」，不出现「变成」「现在是」「不再是」等描述修改过程的用语。
- **与代码同步**：文档与代码不一致时，先修其中一方使二者一致。
- **章节引用对应**：代码注释用 `DEVELOPMENT.md 第 N 节` 引用章节，章节编号与引用一一对应；改编号必须同步改注释。
- **未定事项归位**：尚未确定的方向进 `DEVELOPMENT.md` 第 13 章（现状 + 待定），正文只保留已定的结论。
- **规格分册**：`DEVELOPMENT.md` 承载架构总览与事件词汇表；主题性规格落到 `docs/<topic>.md`，如 `docs/core-ui-separation.md`、`docs/webview-facts.md`、`docs/standalone-core.md`。
- **规格文件结构**：`# 规格：<主题>` → 开篇段落界定范围 → 交叉引用其他规格与 `DEVELOPMENT.md 第 N 节（标题）` → `## 1. 能力` 等分节。
- **术语与代码一致**：owner、事件名、契约名、文件路径沿用代码中的写法。

## 1. 分层与依赖（评审必查）

```
core/  ←  host/  ←  宿主实现（src/VSCode* / electron/*）
         ↑
   AssistantEventBus 是 core 与 UI 之间唯一的边
```

1. `src/core/` 不得 import `host/` 实现；core 只通过 `requireEventBus()` 发事件，不直接调 UI。
2. `src/host/` 不得 import `vscode` / `electron`；宿主差异收在 `UIHost` / `SpinDesign` / `ConversationManager` 上。
3. `host/ui/*` 不得 import 宿主 API，只经 `UIHost` / `WebViewUiPort` 注入。
4. 禁止 `host.kind === '...'` 式宿主嗅探；能力差异用字段或独立方法表达。
5. 契约按 UI surface 划分，新增面板先定 surface，不要往 `UIHost` 里塞。
6. 不同来源、不同频率的数据走不同的事件流，不用附加标记合并。
7. `host/` 可 import core 的**只读**函数与类型；改状态的请求一律翻译成 `UiEvent`。
8. 硬约束：`VSCode*Host.ts` / `VSCodeSpinDesign.ts` / `VSCodeConversationManager.ts` 不放 `src/host/`。
9. **两套 Core 同步改**：Embedded Core（`src/core/`，TS）与 Standalone Core（`core-rs/`，Rust）是同一份契约的两套实现；改任一侧的 Core 行为（引擎 / 工具 / 技能 / 权限 / 提示词 / 落盘格式 / 事件）都必须同步改另一侧，并同步 parity 对照表与两侧测试（见第 5 节）。只改一侧视为未完成。

## 2. 代码风格

- TypeScript `strict`，`module: Node16`；相对导入必须带 `.js` 后缀，类型导入用 `import type`。
- 缩进 2 空格；`@typescript-eslint/no-explicit-any` 已放开，但优先显式类型。
- **注释用中文**，解释「为什么」并引用 `DEVELOPMENT.md` 章节；用户可见文本走 i18n（`src/webview/i18n/` 的 `zh` / `en`）。
- 类内按注释分区，不为了「短」而拆类（如 `WebViewUI` 保持单类）。
- 不用 `!` 空断言；必选性由构造时序保证。

## 3. 命名约定（第 3.4 节）

| 前缀 | 语义 | 判据 |
| --- | --- | --- |
| `on*` | 事实通知，状态由别处拥有 | 存在外部 source of truth |
| 动词开头 | 命令，UI 自己拥有该状态 | 状态只在 UI 内部 |

- `CoreEvent` / `CoreRequest` 的 `type` = handler 方法名去 `on` 前缀。
- `UiEvent` 用**过去式**（`modelChanged`），描述已发生的动作，不用命令式（不叫 `setModel`）。
- 事件 `type` 全小写驼峰、不带 `on` 前缀；wire protocol 名称不受此约定约束。

## 4. 架构铁律（第 12 章）

1. **不过度 fallback**：接线缺失 / 配置漏了直接抛错，不静默降级。只有「设计允许的瞬时状态」才允许 no-op，且必须注释理由。
2. **不让接口 / 参数可选**：契约成员全必选；「没有」用 `null`，「互斥结果」用判别联合，不用 `?`。
3. **core 描述事实，UI 决定表现**：防抖、节流、刷新哪些视图、未打开时怎么办，都不写进 core。
4. **一份事实只有一个写入点**：指定唯一 owner，其余是只读投影，禁止从投影反推事实。
5. **契约只写现状，派生字段从根字段推导**；派生逻辑只有一份纯函数。
6. **同一字段的默认值只有一处**（配置默认值唯一来源是 `src/core/settingsSnapshot.ts`）。
7. **webview 不持有事实默认值**：事实未到达用 `undefined` 表示等待态（转圈），不用猜值，也不回传猜值。
8. **预览只有一份渲染实现**：每种预览只落一个渲染方，另一侧只取内容 / 发消息。
9. **共享文件写安全**：`settings.json` 等跨进程共写文件必须「跨进程锁 + 读不出拒绝写 + 原子落盘 + 内容未变不落盘」（`src/core/utils/fileLock.ts`）。

## 5. 工作流

```bash
npm run check-types   # tsc（含 webview / electron 三份配置）
npm run lint          # eslint src
npm run compile       # check-types + lint + esbuild
npm run build:all     # TS + Rust core + electron
npm run test:all      # 编译并跑全部测试
npm run test:core     # cargo test（core-rs）
npm run electron      # 启动 Electron 调试
```

- 测试在 `src/test/*.test.ts`；Rust 在 `core-rs/src/*_tests.rs`。
- **两套 Core 必须同步改**：Core 行为有两套实现——Embedded `src/core/`（TS）与 Standalone `core-rs/`（Rust）。
  改任一侧的 Core 行为都必须**同时**改另一侧；只改一侧视为未完成。对应关系如
  `CommandDispatcher` ↔ `commands.rs`、`PermissionPolicy` ↔ `permission.rs`、`QueryEngine` ↔ `engine.rs`。
- 跨语言行为靠 **parity 测试 + `src/test/fixtures/*Parity.json` 对照表**锁死；改任一侧必须同步对照表与两侧实现。
- 提交前至少跑 `npm run check-types && npm run lint`，涉及 core 的改动加 `npm run test:core`。

## 6. 常见改动清单

**新增事件**（第 4.4 节）：定方向（CoreEvent / CoreRequest / UiEvent）→ 定名 → 定载荷（必填，可选语义用 `null` / 判别联合）→ 改三组联合类型 + `WebViewUI` 映射表（漏写会编译报错）→ `UiEvent` 补 core 侧订阅与 `WebviewMessageHandler` 翻译 → 更新文档表格。

**新增启动期注入点**（第 8.11 节）：core 定写入入口 + 读取入口（未写入抛错）→ 分类（宿主环境走同步 `UiEvent` 注册，进程内进 `bootstrapCore`）→ 登记 `CoreBootstrapOptions` 与 `bootstrapSnapshot` → 更新 `bootstrapWiring.test.ts` → 同步文档。

**加新宿主 / 新面板**：实现对应契约接口，不动共享代码；差异只经契约注入。
