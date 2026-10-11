# AGENTS.md

面向 AI 协作者的开发约定。架构细节一律以 `DEVELOPMENT.md`（as-built 规格）为准，本文件只列
「必须遵守的风格与约定」。

## 0. 文档要求

适用对象：`DEVELOPMENT.md`、`docs/*.md`、`TODO.md`、`README.md`。文档分类法（哪类内容
写到哪、命名与寿命判据）见 `docs/README.md`；本节只列写作规则。

- **只写现状**：文档描述代码当前的实现（as-built），不写计划、不写演进过程。
- **直接陈述应有形态**：文档只回答「应该是什么样」，不出现「变成」「现在是」「不再是」等描述修改过程的用语。
- **与代码同步**：文档与代码不一致时，先修其中一方使二者一致。
- **章节引用对应**：文档侧跨文档章节引用一律写成相对链接 + 标题锚点（如
  `[第 5.9 节](../DEVELOPMENT.md#59-同一字段的默认值只有一处)`），不写「某文件第 N 节」的文字形式；
  裸「第 N 节」只允许同文件自引用；区间引用（如「第 1–3 节」）两端都要落在本文件。锚点按
  GitHub 的 slug 规则生成（小写、去标点、空格转 `-`、重名追加 `-1`，连续空格不折叠），与
  VS Code 预览的规则有差异时以 GitHub 为准。代码注释保留文字形式，且必须点名目标文件
  （`DEVELOPMENT.md 第 N 节` 或 `docs/<topic>.md 第 N 节`），禁止裸章节号；改章节标题 / 编号时
  同步改引用。引用有效性、事件表与聚合数字由 `src/test/docsLint.test.ts` 校验。
- **未定事项归位**：尚未确定的方向进 [DEVELOPMENT.md 第 6 章](DEVELOPMENT.md#6-待定事项)（现状 + 待定），正文只保留已定的结论。
  设计决策（决策 + 背景 + 被否决的替代方案）进 `docs/adr/`，编号递增、只增不删。
- **规格分册**：`DEVELOPMENT.md` 承载架构总览与事件词汇表；主题性规格落到 `docs/<topic>.md`，
  如 `docs/contracts.md`、`docs/core-ui-separation.md`、`docs/standalone-core.md`。
- **规格文件结构**：`# 规格：<主题>` → 开篇段落界定范围（不用引用块）→ 交叉引用其他规格与
  `DEVELOPMENT.md 第 N 节（标题）` → `## 1. 能力` 等分节；300 行以上补内部目录。
- **待办不存史**：`TODO.md` 只列未完成项，完成即删（交付物能在仓库内验证的项——产物路径已存在、
  脚本已支持——删项前先与对应规格核对口径）；已完成工作的溯源进 `docs/archive/`（冻结，不再更新）。
- **聚合数字与名单不手抄**：事件数量、契约 / 端口成员数、webview 消息类型数等可从代码推导的聚合值
  以 `docsLint.test.ts` 对照代码校验为准，不手工维护；正文叙述里不写枚举数量（写「见第 N 节清单」）。
  同一原则扩到**名单与结构**：载荷字段列、契约成员表、快照字段表、方法清单、平台集合都由 docsLint
  从代码逐项对照——新清单表进文档时必须挂对应的 lint 组，先问一句「它漂了什么会红」。
- **同一事实只写一处**：跨文档不复述事实，第二份文档只写链接——两份各写一份必然各自腐烂
  （「不经总线」「恢复语义」的双版本是实例）。
- **文档内代码块标注来源**：含 `export` / 顶层声明的 fenced 代码块必须写 ```` ```ts src=<路径> ````
  标注，docsLint 据此与真实文件比对声明名、方法调用名与 async 旗标；纯示意块在 info 里写「示意」。
- **禁行号引用**：代码注释与文档禁止「表 #N / 节 #N」式引用（事件表重编号即静默腐烂），
  一律点名事件名 / 成员名。
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
10. **分层边界由 lint 强制**：第 1–3 条由 eslint 的 `no-restricted-imports` 拦截（`import type`
    同样算耦合，一并拦截），进 `npm run lint`。

## 2. 代码风格

- TypeScript `strict`，`module: Node16`；相对导入必须带 `.js` 后缀，类型导入用 `import type`。
- 缩进 2 空格；`@typescript-eslint/no-explicit-any` 已放开，但优先显式类型。
- **注释用中文**，解释「为什么」并引用 `DEVELOPMENT.md` 章节；用户可见文本走 i18n（`src/webview/i18n/` 的 `zh` / `en`）。
- 类内按注释分区，不为了「短」而拆类（如 `WebViewUI` 保持单类）。
- 不用 `!` 空断言；必选性由构造时序保证。

## 3. 命名约定（[DEVELOPMENT.md 第 3.4 节](DEVELOPMENT.md#34-命名约定)）

| 前缀 | 语义 | 判据 |
| --- | --- | --- |
| `on*` | 事实通知，状态由别处拥有 | 存在外部 source of truth |
| 动词开头 | 命令，UI 自己拥有该状态 | 状态只在 UI 内部 |

- `CoreEvent` / `CoreRequest` 的 `type` = handler 方法名去 `on` 前缀。
- `UiEvent` 用**过去式**（`modelChanged`），描述已发生的动作，不用命令式（不叫 `setModel`）。
- 事件 `type` 全小写驼峰、不带 `on` 前缀；wire protocol 名称不受此约定约束。

## 4. 架构铁律（[DEVELOPMENT.md 第 5 章](DEVELOPMENT.md#5-架构原则)）

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
npm run build:core:host # 只重建当前平台 Core（真实双端测试的本地前置）
npm run electron      # 启动 Electron（调试用 --inspect 走 npm run electron:debug）
```

- 测试在 `src/test/*.test.ts`；Rust 在 `core-rs/src/*_tests.rs`。
- **两套 Core 必须同步改**：Core 行为有两套实现——Embedded `src/core/`（TS）与 Standalone `core-rs/`（Rust）。
  改任一侧的 Core 行为都必须**同时**改另一侧；只改一侧视为未完成。对应关系如
  `CommandDispatcher` ↔ `commands.rs`、`PermissionPolicy` ↔ `permission.rs`、`QueryEngine` ↔ `engine.rs`。
- 跨语言行为靠 **parity 测试 + `src/test/fixtures/*Parity.json` 对照表**锁死；改任一侧必须同步对照表与两侧实现。fixture 的每个数组**两侧都必须有消费者**（如 `eventTypesParity.json` 由 TS `eventTypeParity.test.ts` 与 Rust `main_tests` 双向锁定：正向查 emit / 分发位点，反向查 Rust 侧新增 `"type"` 字面量已登记）。
- **文档同步是硬约束**：改 Core 行为 / 契约 / 事件词汇表时，同步受影响的规格
  （`DEVELOPMENT.md` 事件表、对应 `docs/<topic>.md`），`npm run test:all -- docs-lint` 必须绿。
  新增 / 移动文档要更新 `docs/README.md` 的地图；守卫进 CI（`.github/workflows/docs.yml`，
  docs-lint 与 tests 两个 job 都不过滤路径——docsLint 还扫描代码注释里的章节引用，
  tests job 跑 check-types / lint / 全部测试 / `test:core`，并先构建 Linux Core 让
  `coreEventParity` 真实运行而不是 skip）。
- 提交前至少跑 `npm run check-types && npm run lint`，涉及 core 的改动加 `npm run test:core`
  （CI 会再跑一遍，本地跑只是提前暴露）。
- **涉及 core 的改动先 `npm run build:core:host` 再跑 `npm run test:all`**：`coreEventParity`
  等真实双端测试依赖 Core 产物，不构建会**静默 skip**（CI 的 tests job 先 `build:core:linux-x64`
  所以真实在跑；本地 Windows 不补这一步，事件流顺序类漂移在本地发现不了）。

## 6. 常见改动清单

**新增事件**（[DEVELOPMENT.md 第 4.4 节](DEVELOPMENT.md#44-新增事件时的检查清单)）：定方向（CoreEvent / CoreRequest / UiEvent / UiRequest）→ 定名 → 定载荷（必填，可选语义用 `null` / 判别联合）→ 改四组联合类型 + `WebViewUI` 映射表（漏写会编译报错）→ `UiEvent` 补 core 侧订阅与 `WebviewMessageHandler` 翻译 → 更新文档表格（`docsLint.test.ts` 校验数量、名单、逐事件载荷列与 4.1 触发点列）。

**新增启动期注入点**（[docs/host-matrix.md 第 11 节](docs/host-matrix.md#11-新增启动期注入点检查清单)）：core 定写入入口 + 读取入口（未写入抛错）→ 分类（宿主环境走同步 `UiEvent` 注册，进程内进 `bootstrapCore`）→ 登记 `CoreBootstrapOptions` 与 `bootstrapSnapshot` → 更新 `bootstrapWiring.test.ts` → 同步文档。

**重构 / 挪动 emit 位点**：docsLint 把 4.1 触发点列与真实 emit 位点逐事件对照、把契约成员数 /
名单与文档数字对照——重构后先跑 `npm run test:all -- docs-lint`，红在哪一项就同步哪一处文档。
新增可选契约成员会被「可选成员冻结」拦下（铁律 4.2：可选语义用 `null` / 判别联合；存量豁免
清单在 `docsLint.test.ts`，只减不增）。

**加新宿主 / 新面板**：实现对应契约接口，不动共享代码；差异只经契约注入。
