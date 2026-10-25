# AGENTS.md

面向 AI 协作者的开发约定。架构细节一律以 `docs/` 下的 as-built 规格为准（地图见
`docs/README.md`），本文件只列「必须遵守的风格与约定」。

## 0. 文档要求

适用对象：`docs/**/*.md`、`specs/*.md`（例外见下）、`TODO.md`、`README.md`。
文档分类法（哪类内容写到哪、命名与寿命判据）见 `docs/README.md`；本节只列写作规则。

- **只写现状**：文档描述代码当前的实现（as-built），不写计划、不写演进过程。
- **直接陈述应有形态**：文档只回答「应该是什么样」，不出现「变成」「现在是」「不再是」等描述修改过程的用语。
- **与代码同步**：文档与代码不一致时，先修其中一方使二者一致。
- **改动规格与缺陷规格例外**：`specs/<NNN>-<slug>/` 描述尚未落地的意图与验收、
  `specs/defects/<slug>.md` 描述缺陷的现状与期望，两者是「只写现状」的例外（目录约定、
  生命周期与闸门见 [specs/README.md](specs/README.md)）；实施完成后 delta 并入
  `docs/<topic>.md`，改动规格整目录归档进 `docs/archive/specs/`，缺陷规格常驻仓库不归档。
  spec 内未决问题用 `[待澄清]` 标记（必须带去向链接），实施前清零；其存在性类对照（路径 /
  常量 / 标识符 / npm 脚本）与 TODO.md 同口径豁免。
- **章节引用对应**：文档侧跨文档章节引用一律写成相对链接 + 标题锚点（如
  `[第 9 节](docs/architecture/principles.md#9-同一字段的默认值只有一处)`），不写「某文件第 N 节」的文字形式；
  裸「第 N 节」只允许同文件自引用；区间引用（如「第 1–3 节」）两端都要落在本文件。锚点按
  GitHub 的 slug 规则生成（小写、去标点、空格转 `-`、重名追加 `-1`，连续空格不折叠），与
  VS Code 预览的规则有差异时以 GitHub 为准。代码注释保留文字形式，且必须点名目标文件
  （`docs/<path>.md 第 N 节`），禁止裸章节号；改章节标题 / 编号时
  同步改引用。引用有效性、事件表与聚合数字由 `src/test/docsLint.test.ts` 校验。
- **未定事项归位**：尚未确定的方向进 [docs/architecture/open-questions.md](docs/architecture/open-questions.md)（现状 + 待定），正文只保留已定的结论。
  设计决策（决策 + 背景 + 被否决的替代方案）进 `docs/adr/`，编号递增、只增不删。
- **规格分册**：架构总纲类规格在 `docs/architecture/`（总览、分层规则、总线契约与事件
  词汇表、架构原则、待定事项）；主题规格按域分目录——`docs/core/`（Core 实现与进程模型）、
  `docs/hosts/`（宿主与 UI）、`docs/features/`（spec 形态的特性规格与需求基线），
  如 `docs/architecture/contracts.md`、`docs/core/standalone-core.md`。
- **规格文件结构**：`# 规格：<主题>` → 开篇段落界定范围（不用引用块）→ 交叉引用其他规格
  （相对链接 + 锚点）→ `## 1. 能力` 等分节；300 行以上补内部目录。特性规格（`docs/features/`）
  用固定七节骨架（场景 / FR / 行为规格 / 边界 / 非目标 / 基线影响 / 追溯矩阵）。
- **待办不存史**：`TODO.md` 只列未排期的想法与跨 spec 的缺口（每条带验收判据或指向某个
  spec），完成即删；进行中的工作在 spec 的 `tasks.md` 勾选跟踪、缺陷规格以 frontmatter 的
  status 跟踪（见 `specs/README.md`）；
  已完成工作的溯源进 `docs/archive/`（冻结，不再更新）。
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
src/shared/（TS 共享叶子层：总线契约 / 类型 / 会话落盘格式 / 纯工具）
   ←  src/host/  ←  宿主实现（src/VSCode* / electron/*）
   ←  src/webview/（WebView UI）
core-rs/（Core，Rust 独立进程）只经 AssistantEventBus 帧通道与 TS 侧通信
```

1. `src/shared/` 是共享叶子层：不得 import `host/` 实现与宿主 API（`vscode` / `electron`）；总线契约（`AssistantEventBus`）只在这一层定义，core 与 UI 之间唯一的边。
2. `src/host/` 不得 import `vscode` / `electron`；宿主差异收在 `UIHost` / `SpinDesign` / `ConversationManager` 上。
3. `host/ui/*` 不得 import 宿主 API，只经 `UIHost` / `WebViewUiPort` 注入。
4. 禁止 `host.kind === '...'` 式宿主嗅探；能力差异用字段或独立方法表达。
5. 契约按 UI surface 划分，新增面板先定 surface，不要往 `UIHost` 里塞。
6. 不同来源、不同频率的数据走不同的事件流，不用附加标记合并。
7. `host/` 可 import core 的**只读**函数与类型；改状态的请求一律翻译成 `UiEvent`。
8. 硬约束：`VSCode*Host.ts` / `VSCodeSpinDesign.ts` / `VSCodeConversationManager.ts` 不放 `src/host/`。
9. **落盘格式双侧一致**：会话落盘格式（meta.json / 对话 JSONL）由 core-rs 写入、
   `src/shared/history/` 是同一格式的宿主侧读写库（删除闭包、工具 diff 元数据等宿主
   直接读写场景）；改格式必须两侧同步，Rust 侧对照表测试锁定。
10. **分层边界由 lint 强制**：第 1–2 条由 eslint 的 `no-restricted-imports` 拦截（`import type`
    同样算耦合，一并拦截），进 `npm run lint`。

## 2. 代码风格

- TypeScript `strict`，`module: Node16`；相对导入必须带 `.js` 后缀，类型导入用 `import type`。
- 缩进 2 空格；`@typescript-eslint/no-explicit-any` 已放开，但优先显式类型。
- **注释用中文**，解释「为什么」并引用 `docs/` 规格章节；用户可见文本走 i18n（`src/webview/i18n/` 的 `zh` / `en`）。
- 类内按注释分区，不为了「短」而拆类（如 `WebViewUI` 保持单类）。
- 不用 `!` 空断言；必选性由构造时序保证。

## 3. 命名约定（[docs/architecture/events.md 第 4 节](docs/architecture/events.md#4-命名约定)）

| 前缀 | 语义 | 判据 |
| --- | --- | --- |
| `on*` | 事实通知，状态由别处拥有 | 存在外部 source of truth |
| 动词开头 | 命令，UI 自己拥有该状态 | 状态只在 UI 内部 |

- `CoreEvent` / `CoreRequest` 的 `type` = handler 方法名去 `on` 前缀。
- `UiEvent` 用**过去式**（`modelChanged`），描述已发生的动作，不用命令式（不叫 `setModel`）。
- 事件 `type` 全小写驼峰、不带 `on` 前缀；wire protocol 名称不受此约定约束。

## 4. 架构铁律（[docs/architecture/principles.md](docs/architecture/principles.md)）

1. **不过度 fallback**：接线缺失 / 配置漏了直接抛错，不静默降级。只有「设计允许的瞬时状态」才允许 no-op，且必须注释理由。
2. **不让接口 / 参数可选**：契约成员全必选；「没有」用 `null`，「互斥结果」用判别联合，不用 `?`。
3. **core 描述事实，UI 决定表现**：防抖、节流、刷新哪些视图、未打开时怎么办，都不写进 core。
4. **一份事实只有一个写入点**：指定唯一 owner，其余是只读投影，禁止从投影反推事实。
5. **契约只写现状，派生字段从根字段推导**；派生逻辑只有一份纯函数。
6. **同一字段的默认值只有一处**（配置默认值唯一来源是 `src/shared/settingsSnapshot.ts`）。
7. **webview 不持有事实默认值**：事实未到达用 `undefined` 表示等待态（转圈），不用猜值，也不回传猜值。
8. **预览只有一份渲染实现**：每种预览只落一个渲染方，另一侧只取内容 / 发消息。
9. **共享文件写安全**：`settings.json` 等跨进程共写文件必须「跨进程锁 + 读不出拒绝写 + 原子落盘 + 内容未变不落盘」（`src/shared/utils/fileLock.ts`）。

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

- **分档闸门（进入实施的第一步）**：先按改动性质定档，档位由提交信息里的 `Flow` trailer 声明，
  产物即证据；闸门在 `scripts/githooks/commit-msg`（克隆后 `git config core.hooksPath scripts/githooks`
  启用，LFS 钩子已随库迁移到同目录）——它读不到档位或查不到对应产物就拒绝提交。

  | 档 | 判据 | 产物 | 提交信息 |
  | --- | --- | --- | --- |
  | L0 直改 | 可观察效果不落任何 US / FR 的验收标准，且不触契约面（事件类型、载荷字段、契约成员、wire 消息、落盘字段）：样式、文案、配置、依赖、纯重构 | 无 | `Flow: L0`（理由写正文） |
  | L1 缺陷修复 | 代码与 as-built 规格 / 契约不一致——应有行为已定义，只是没做到 | `specs/defects/<slug>.md`（现状 / 期望 / 不变量 / 回归测试 / 验证记录；文件名即 slug，不编号、不归档） | `Flow: L1` + `Defect: <slug>` |
  | L2 需求变更 | as-built 规格定义的应有行为本身要变 | 就地修订 `docs/` 的基线 + 代码 + 测试（同一提交）；基线缺失时先补基线，单独一个提交 | `Flow: L2` |
  | L3 新特性 | 新增 US / FR / 事件 / 契约成员 / 面板 / 宿主 / 文件格式 | `specs/<NNN>-<slug>/` 三件套 | `Flow: L3` + `Spec: <NNN>` |

  判不清取较高档；档位可升不可降（实施中发现越档即停、重新定档）。L0 允许新增文件——判据只看
  效果，不看文件数。merge 提交与纯文档提交不要求档位；`--no-verify` 仍能跳过一切，但那是例外
  而不是出口。入口：L1 走 `/fix`，L3 走 `/spec` → `/plan` → `/tasks` → `/implement` →
  `/converge`（每个 skill 产出即停等人评审），L2 就地改，L0 直接改。技能入库在
  `.agents/skills/`（跨工具共享目录，产品运行时也优先读它）；ZCode 会话的技能入口是
  `.zcode/skills`，它是**本机**指向 `.agents/skills` 的 junction，不入库——克隆后自行建一次
  （Windows `cmd /c mklink /J .zcode\skills .agents\skills`，POSIX `ln -s ../../.agents/skills
  .zcode/skills`）。编辑与提交都走 `.agents/skills`。
- 测试在 `src/test/*.test.ts`；Rust 在 `core-rs/src/*_tests.rs`。
- **文档同步是硬约束**：改 Core 行为 / 契约 / 事件词汇表时，同步受影响的规格
  （`docs/architecture/events.md` 事件表、对应 `docs/<topic>.md`），`npm run test:all -- docs-lint` 必须绿。
  新增 / 移动文档要更新 `docs/README.md` 的地图；守卫进 CI（`.github/workflows/docs.yml`，
  docs-lint 与 tests 两个 job 都不过滤路径——docsLint 还扫描代码注释里的章节引用，
  tests job 跑 check-types / lint / 全部测试 / `test:core`，并先构建 Linux Core 让
  `standalone*` 系列测试驱动真实二进制而不是 skip）。
- **e2e 也进 CI**（`.github/workflows/e2e.yml`）：`prepare` 构建产物 + `check-types:e2e`，
  之后 `ui` / `electron` / `tui` 三个车道并行（electron 车道跑在 `xvfb-run` 里）。
  `electron-ssh`（真实 SSH 远端）是本地车道、不进 CI：它要一台可连的外部机器，runner 内
  临时起的 sshd 替代不了（`npm run test:e2e:ssh`）。新增 e2e project 时同步该工作流与
  [e2e/README.md](e2e/README.md#ci-车道githubworkflowse2eyml)。
- **发布产物走 Actions**（`.github/workflows/release.yml`）：手动 `workflow_dispatch`，
  在 Windows runner 上跑 `npm run package` 后把 .vsix / NSIS x64+arm64 / TUI 安装器四平台
  上传到 tag `v<version>` 的 GitHub Release（默认草稿）。版本号只从 `package.json` 取，
  产物文件名与 tag 名都由它派生——本地打包与 CI 发布是同一条链。
- 提交前至少跑 `npm run check-types && npm run lint`，涉及 core 的改动加 `npm run test:core`
  （CI 会再跑一遍，本地跑只是提前暴露）。
- **涉及 core 的改动先 `npm run build:core:host` 再跑 `npm run test:all`**：`standalone*`
  系列测试直接驱动真实 Core 二进制，产物缺失时走 `markSkipped()`——runner 单列「跳过」并
  打印原因，不再算通过（CI 的 tests job 先 `build:core:linux-x64` 所以真实在跑；本地 Windows
  不补这一步，帧协议类漂移在本地发现不了）。

## 6. 常见改动清单

**新增事件**（[docs/architecture/events.md 第 7 节](docs/architecture/events.md#7-新增事件时的检查清单)）：定方向（CoreEvent / CoreRequest / UiEvent / UiRequest）→ 定名 → 定载荷（必填，可选语义用 `null` / 判别联合）→ 改四组联合类型 + `WebViewUI` 映射表（漏写会编译报错）→ `UiEvent` 补 core 侧订阅与 `WebviewMessageHandler` 翻译 → 更新文档表格（`docsLint.test.ts` 校验数量、名单、逐事件载荷列与 2.1 触发点列）。

**新增启动期注入点**（[docs/hosts/host-bootstrap.md 第 6 节](docs/hosts/host-bootstrap.md#6-新增启动期注入点检查清单)）：core 定写入入口 + 读取入口（未写入抛错）→ 分类（宿主环境走同步 `UiEvent` 注册，进程内进 `bootstrapCore`）→ 登记 `CoreBootstrapOptions` 与 `bootstrapSnapshot` → 更新 `bootstrapWiring.test.ts` → 同步文档。

**重构 / 挪动 emit 位点**：docsLint 把 2.1 触发点列与真实 emit 位点逐事件对照、把契约成员数 /
名单与文档数字对照——重构后先跑 `npm run test:all -- docs-lint`，红在哪一项就同步哪一处文档。
新增可选契约成员会被「可选成员冻结」拦下（铁律 4.2：可选语义用 `null` / 判别联合；存量豁免
清单在 `docsLint.test.ts`，只减不增）。

**加新宿主 / 新面板**：实现对应契约接口，不动共享代码；差异只经契约注入。
