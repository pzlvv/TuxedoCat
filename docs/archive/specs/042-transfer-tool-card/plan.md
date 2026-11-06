# 实施方案：`Transfer` 工具卡片

技术路线：给 webview 的工具卡片表加一个 `Transfer` 组件，从 `toolArgs` 读两端、从工具结果
文本读统计与文件清单；**不新增契约事件、不改工具结果格式、不新增持久化字段**。结果文本是
既有格式（`✓ Transferred {n} files ({size}) from \`{src}\` to \`{dst}\`{skipped}`），卡片
的派生逻辑抽成纯函数 `src/webview/transferCard.ts`，组件只渲染。需求口径见同目录
[spec.md](spec.md)。

## 技术方案

### 1. 先补齐卡片需要的事实（一处必要改动）

spec FR-001 要求「文件数不超过上限时逐条列出文件相对路径」，但**当前结果文本里没有文件
清单**：`core-rs/src/tools.rs` 的 `run_transfer` 只拼出 `files` / `bytes` / 两个身份与
skipped 数，`TransferSummary` 也只有五个标量字段。因此本 spec 落地时必须先在结果文本和
`TransferSummary` 上补清单，否则 AC-1 / AC-3 无数据可渲染。设计上取最小面：

- `core-rs/src/tools.rs::TransferSummary` 增加 `paths: Vec<String>`；
- `run_transfer` 的文本格式在统计行的**下一行**追加最多 20 条相对路径（`  - {rel}`），超过
  20 条时追加一行 `  ... and {M} more files`。「统计行逐字不变」（spec 非目标第 3 条）由
  单测锁定：`✓ Transferred …` 那一行必须与改动前完全一致。
- 宿主侧 `runSessionTransfer` 返回的 `TransferCounts` 增加 `paths`（`src/host/workspaceTransfer.ts`
  在搬运过程中本来就在逐个文件处理，顺手 push 相对路径即可）；
  `crossWorkspaceTransferRequested` 的应答载荷增加 `paths: string[]`（契约成员必选，失败
  分支仍只有 `{ error }`）；
  `core-rs/src/engine.rs::transfer_hook` 把它映射进 `TransferSummary`。
- 上限 20 的**展示决策留在卡片**：工具侧最多给 20 条 + 一条「还有 M 个」的兜底行，卡片
  自己不截断；这样 webview 不需要为超大目录扛完整清单（spec FR-003 最后一句「不改工具结果
  的生成」在本方案里修订为「只增加路径明细，不改变统计行」——这条偏差在 spec 收敛时回写，
  见第 6 节）。

> 这是本 spec 唯一的「非纯展示」改动，理由是「卡片要显示清单」而清单目前不存在。契约、
> 事件、落盘格式均不变（`paths` 走已有的 request / response 通道）。

### 2. 派生纯函数（`src/webview/transferCard.ts`，新增）

```ts 示意
export interface TransferStats {
  files: number;
  sizeText: string;          // 原样保留工具给的「4.0 KB」形态，不重算
  source: string;
  dest: string;
  skipped: number;
}

export interface TransferCardModel {
  stats: TransferStats | null;   // 统计行解析不出时为 null（失败态 / 旧结果）
  paths: string[];               // 上限 20 条
  moreCount: number;             // 0 = 没有「还有 M 个」
  failed: boolean;
}

export function buildTransferCardModel(
  args: Record<string, unknown>,
  output: string | undefined,
  status: 'normal' | 'running' | 'success' | 'fail',
): TransferCardModel;
```

解析口径（与 Bash 卡片的 `persistedOutputParse` 同模式，零依赖、webview 与单测共用）：

- 「两端身份」从 `args.sourceTarget` / `args.destTarget` 读；空 / 缺失 → `当前工作区`（spec
  FR-001 第 2 段）。结果文本里的 `from \`…\` to \`…\`` 只作**兜底**（重放时 `toolArgs`
  可能被裁剪，但既有契约里它恒在，兜底分支不额外造事实）。
- 统计从结果文本的首行解析：正则 `^✓ Transferred (\d+) files \((.+)\) from \`(.+)\` to \`(.+)\`(?: \(skipped (\d+) symlinks\))?$`。
  解不出 → `stats: null` + 卡片显示工具原文（失败 / 旧版本结果）。
- 清单从统计行之后的 `  - {rel}` 行解析；`  ... and (\d+) more files` 解析成 `moreCount`。
- 上限 20 由 `Math.min(paths.length, 20)` 与 `moreCount` 相加得到最终提示，解析与展示同一份
  常量 `TRANSFER_PATH_LIMIT = 20`。
- `<persisted-output>` 信封（4K 上限裁剪）：先用 `parsePersistedOutput` 拿 `preview`，再在
  `preview` 上跑上面的解析（spec 边界第 1 条）。preview 里可能只有部分清单，`moreCount` 以
  信封正文里能读到的为准，不额外请求完整输出。
- 长路径截断：`truncateMiddle(text, 56)`（保留首尾各 ~26 字符 + `…`），完整值放 `title`
  （spec FR-001 第 3 段）。这是渲染辅助，放同一模块便于单测。

### 3. 组件（`src/webview/tools/Transfer.tsx`，新增）

形状照 `Agent.tsx`（`ToolHeader` + 行内 meta），内容分三段：

1. 标题行：`Transfer` + `source → dest`（两端各按中点截断、`title` 给完整值）；
2. 统计行：`{files} files · {sizeText}`，skipped > 0 时追加 `· 跳过 {n} 个符号链接`
   （0 时整段不渲染，AC-2）；
3. 清单：每行一个相对路径（`font-family` 等宽，等宽与 Bash 输出框一致）；`moreCount > 0` 时
   末行 `还有 {M} 个文件`（AC-3）。

失败态（`status === 'fail'`）：不渲染统计与清单，用 `colors` 里的失败色显示 `output` 全文
（spec FR-004 第 1 段）。`stats === null` 且非失败（旧结果 / 解析失败）：只渲染身份行 + 工具
原文，不猜测统计。

`src/webview/tools/index.ts` 导出 `Transfer`；`MessagesView.tsx` 的 `TOOL_COMPONENT_MAP`
加 `'Transfer': ToolComponents.Transfer`。

### 4. 重放一致（FR-005）

卡片所需一切来自 `toolArgs` + `output`：`build_replay_message_data`（`core-rs/src/replay.rs`）
已经透传 `toolArgs` 与 `tool_result` 文本，`conversationLoaded` 走 `trimConversationForWebview`
只裁剪 Edit / Write 的 `_meta`，不动 Transfer。因此**零新增字段**：历史会话重开时卡片
形状天然一致。这条在测试里以「同一 args+output 两次构建模型结果相等」锁定。

### 5. i18n

新增键（`src/webview/i18n/{zh,en}.ts`）：`tool.transfer.files`、`tool.transfer.skipped`、
`tool.transfer.more`、`tool.transfer.currentWorkspace`、`tool.transfer.failed`。用户可见
文本一律走 i18n（`AGENTS.md` 第 2 节）。

### 6. 与 spec 的一处偏差（已就地修订）

spec 的非目标原写「不改工具结果的文本格式（`✓ Transferred …` 逐字不变）」，与 FR-001 的
「逐条列出文件相对路径」在当前代码下不可同时满足——清单不在结果里。本方案取「统计行逐字
不变、只追加路径明细行」，并把这条偏差就地回写进 `spec.md`（非目标改成「统计行逐字不变；
路径明细行是本次新增的展示数据」，影响基线表补 [docs/architecture/events.md 第 2.2 节](../../docs/architecture/events.md#22-corerequestcore--ui请求-响应)的应答载荷一行）。
按 [specs/README.md 第 9 节](../README.md#9-需求变更与补基线)，需求边界在本 spec 内先改清楚再实施，不留到收敛。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `core-rs/src/tools.rs` | `TransferSummary.paths`；`run_transfer` 追加路径明细行（统计行不变） | 无总线契约（工具结果文本） |
| `core-rs/src/engine.rs` | `transfer_hook` 映射 `paths` | `crossWorkspaceTransferRequested` 应答增加 `paths` |
| `core-rs/src/tools_tests.rs` | 统计行逐字回归 + 明细行 / 上限断言 | 无 |
| `src/shared/AssistantEventBus.ts` | `crossWorkspaceTransferRequested` 成功分支增加 `paths: string[]` | 契约成员（必选） |
| `src/host/workspaceTransfer.ts` | `TransferCounts.paths` | 宿主内部 |
| `src/host/WebViewUI.ts` | 应答载荷透传 `paths` | 同上 |
| `src/webview/transferCard.ts` | 新增（纯函数） | 无 |
| `src/webview/tools/Transfer.tsx` | 新增组件 | 无 |
| `src/webview/tools/index.ts` / `MessagesView.tsx` | 导出 + 映射 | 无 |
| `src/webview/i18n/{zh,en}.ts` | 5 个键 | 用户可见文本 |
| `src/test/transferCard.test.ts` | 新增 | 无 |
| `e2e/electron/crossWorkspaceTransfer.spec.ts` | 补一条重放断言 | 无 |
| `docs/features/cross-workspace-transfer.md` | 新增 FR-008、非目标删一条、追溯矩阵补一行、[第 2.3 节](../../docs/features/cross-workspace-transfer.md#23-事件成员)应答载荷补 `paths` | 特性规格 |
| [docs/architecture/events.md 第 2.2 节](../../docs/architecture/events.md#22-corerequestcore--ui请求-响应) | `crossWorkspaceTransferRequested` 应答补 `paths` | 事件词汇表 |

## 宪章检查

- [x] 分层与依赖（`AGENTS.md` 第 1 节）：core 侧只加一个 Vec 字段与文本行（不 import 宿主
      实现）；宿主侧只做透传；webview 侧只渲染。三方都不越界。
- [x] 架构铁律（`AGENTS.md` 第 4 节）：不过度 fallback——解析失败显式退到「原文 + 身份行」，
      不猜统计；契约成员全必选（`paths` 恒在成功分支，空数组表示没有文件）；一份事实一个
      写入点（路径清单的事实源是宿主搬运结果，卡片不自造）；派生逻辑只有一份
      （`buildTransferCardModel`）；默认值单源（`TRANSFER_PATH_LIMIT` 只有一处）。
- [x] Core 行为与落盘格式同步义务（`AGENTS.md` 第 5 节）：Core 行为改动落 `core-rs/` 并同步
      `tools_tests.rs`；落盘格式（JSONL / meta.json）零改动，`src/shared/history/` 无需同步。
      工具结果文本的变化由两侧同一份 fixture 锁定（`core-rs/fixtures/` 加一份
      `transferResult.txt` 与 TS 侧解析用例共用，仍是同一份口径）。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：`docs/features/cross-workspace-transfer.md` 与
      `docs/architecture/events.md` 同一提交；spec 非目标那条偏差已在本次 /plan 就地修订
      （第 6 节）。

## 被否决的替代方案

1. **卡片不显示文件清单，只显示统计**：spec FR-001 / AC-1 / AC-3 明确要求清单与上限。否决。
2. **在卡片里自己 `git`/`fs` 读目录**：webview 拿不到文件系统，且会把「传输了什么」变成
   「现在有什么」——重放时会漂移（FR-005）。否决。
3. **新增专门的传输结果事件（带结构化统计 + 清单）**：spec 非目标明确「不加新的契约事件」，
   且 `toolResult` 已经承载结果文本。只在既有应答里加一个 `paths` 字段即可。否决。
4. **改结果文本为 JSON**：会破坏既有的 `✓ Transferred …` 文案约定与其它消费方（提示词 /
   测试）。否决，保持统计行逐字不变、只追加明细行。
5. **把 20 条上限放到工具侧**：上限是卡片的展示决策（spec FR-003 最后一句），放在工具侧会
   让非 UI 消费方（日志 / 提示词）也丢掉信息。工具侧只做「最多 20 条 + 还有 M 个」的防爆，
   卡片侧仍按 20 截（两层同一常量、单测锁定一致）。否决「只在工具侧截」的单点方案。
6. **卡片内提供「打开目标目录」动作**：spec 非目标（卡片只读）。否决。
