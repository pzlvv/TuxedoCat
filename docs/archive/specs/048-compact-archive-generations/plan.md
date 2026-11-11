# 实施方案：多次压缩的归档逐代保留与逐层展开

技术路线分三段：Core 把归档从「整份覆盖」改成「按代次追加」，并在展开应答里给出
「合并后的完整序列 + 每代起始下标」；宿主把每代分别转换成显示消息、累加出转换后的起始
下标；webview 只做一件事——按层级截取完整序列的尾部，层级只存在内存里。

需求见 [spec.md](spec.md)。

## 技术方案

### 1. 为什么起始下标要按「代」分段换算

`buildReplayMessageData` 不是一对一转换：压缩边界标记被丢掉、只含 `tool_result` 的 user
消息被跳过、空正文消息被跳过。因此 Core 给出的「第 N 代从第几条开始」在转换后会整体前移，
直接用原下标切片会错位。

解法是把**分段边界**而不是下标交给转换：Core 返回的 `generationStarts` 把完整序列切成
「每代一段 + 最后一段（末代 + 保留区）」，宿主逐段转换、按转换后的长度累加出新的起始
下标。段边界本身不受段内丢条影响，转换后的下标天然对齐。

### 2. Core：归档按代次追加（`core-rs/src/history.rs`）

- 记录信封从 `{ uuid, parentUuid, timestamp, message }` 扩为多一个 `compactGeneration`
  （u64，1 起）。旧记录缺该字段 → 读作第 1 代（`unwrap_or(1)`），不改写旧文件。
- `save_compact_archive`（整份 `std::fs::write`）改为 `append_compact_archive`：先按行读
  出既有最大代次，取 `max + 1`，再以追加方式写本代记录（`OpenOptions::append`，
  沿用 `WRITE_LOCK`）。读不出（文件不存在 / 空 / 全损坏行）按 0 处理 → 第 1 代。
- 新增 `load_compact_archive_records` 返回 `(generation, message)`；既有
  `load_compact_archive` 变成它的投影（`has_compact_archive` 等调用点语义不变）。
- 文件名、删除闭包里的后缀清单、`meta.json` 的 `isExpanded` 都不动。

### 3. Core：合并口径与代次起始下标（`core-rs/src/main.rs`）

`compact_archive_display` 的应答从 `Message[] | null` 改成
`{ messages: Message[], generationStarts: number[] } | null`：

1. 按代次升序分组（文件顺序即代次顺序；显式按 `compactGeneration` 稳定排序防御乱序）。
2. 逐代拼接，按 `uuid` 去重（保留首次出现）——上一代末尾的摘要同时是下一代归档区的
   第一条，去重后只出现一次。去重表同时记录 `uuid → 下标`。
3. `generationStarts[i]` = 第 `i+1` 代**第一条记录**在合并序列里的下标：能在去重表里查到
   （即上一条摘要）就取那个位置，否则取当前末尾；再与上一个起始下标取 max，保证单调。
   于是「起始下标」既覆盖下一代的第一条（上代摘要），又永远不会回退。
4. 旧格式补偿沿用既有口径：合并结果里没有任何摘要时，把主 JSONL 的摘要追加进来（同样
   按 `uuid` 去重）；随后追加当前保留区（user / assistant 且非摘要）。
5. 归档为空 → `null`（既有「没有可展开的内容」语义）。

### 4. 契约（`src/shared/AssistantEventBus.ts` + `src/host/webviewMessages.ts`）

```ts 示意
// UiRequestResultMap.compactArchiveRequested
export interface CompactArchiveDisplay {
  /** 合并后的完整展开序列（各代按代次升序 + 当前保留区，已按 uuid 去重） */
  messages: Message[];
  /** 每代的起始下标，升序；长度即代次数 */
  generationStarts: number[];
}

// wire：expandCompactDone 从「纯完成信号」变成「展开数据 + 完成信号」
{ type: 'expandCompactDone'; sessionId: string;
  messages: MessageData[]; generationStarts: number[] }
```

`expandCompactDone` 的两个新字段必填（没有内容时传空数组），不用 `?`——铁律 4.2。
`messagesReplaced` 不再承担展开：它回到「压缩后重建 / 回退截断」两条触发方。

### 5. 宿主（`src/host/ui/webviewMessageHandler.ts`）

`handleExpandCompact`：

1. `requestCompactArchive(sessionId)`；null / 空 → 回 `expandCompactDone` 空载荷。
2. 按 `generationStarts` 切段（末段到序列末尾），逐段 `buildReplayMessageData`，
   累加出转换后的起始下标。
3. 一次 `expandCompactDone` 下发完整序列与起始下标——展开第几层由 webview 决定，
   宿主不持有层级（宿主持有层级会在多视图下串味，也违反「UI 决定表现」）。

PyCharm 的桥（`HostUi.kt`）v1 只发完成信号，改动后按协议补空数组，行为等价于
「取不到归档」：不改变可见集合、按钮保留（`docs/hosts/pycharm-plugin.md` 第 6 节的
v1 缺口记录继续成立）。

### 6. webview

新增纯函数模块 `src/webview/compactExpand.ts`（唯一判定点，直接单测）：

```ts 示意
export function compactGenerations(view: CompactArchiveView): number;
/** 层级 depth 的可见消息；depth 超界或数据缺失时返回 null（调用方不改任何状态） */
export function compactVisibleMessages(view: CompactArchiveView, depth: number): Message[] | null;
/** 「展开压缩的对话历史」按钮是否可见：还有没展开的代次 */
export function canExpandCompact(hasArchive: boolean, depth: number, view: CompactArchiveView | null): boolean;
```

状态（`App.tsx`）：

- `hasCompactArchive: boolean`：既有事实投影，语义不变。
- `compactArchiveView: { messages: MessageData[]; generationStarts: number[] } | null`：展开数据缓存。
- `compactExpandDepth: number`：已展开层数（0 = 压缩后形态）。

流程：

| 触发 | 动作 |
| --- | --- |
| 点击按钮、`depth === 0` | 上报 `expandCompact`，等 `expandCompactDone` |
| 收到 `expandCompactDone`（载荷非空） | 存缓存、`depth = 1`、把第 1 层的可见集合铺进 `messages` |
| 点击按钮、`depth > 0` | 直接用缓存算 `depth + 1` 层，铺进 `messages`（不读盘、不发请求） |
| `conversationLoaded` / 新建对话 | 缓存清空、`depth = 0`、`hasCompactArchive` 取会话加载结果 |
| `compactEnd status === 'complete'` | 缓存清空、`depth = 0`（新代次使旧缓存失效），按钮回到初始态 |

`MessagesView` 的 `hasCompactArchive` / `isCompactExpanded` 两个 props 合并为
`canExpandCompact`；`useAppHandlers` 里两个从未被读的 props 一并删掉。

### 7. 测试

- `src/test/compactExpand.test.ts`：层级 → 可见集合、超界返回 null、按钮显隐三态
  （无归档 / 未展开 / 已展开到最深层）。
- `core-rs/src/history_tests.rs`：追加不覆盖、代次递增、缺字段按第 1 代、坏行跳过。
- `core-rs/src/main_tests.rs`：两代归档的合并序列与 `generationStarts`（含摘要去重）。
- `core-rs/src/compact_engine_tests.rs`：连续两次压缩后归档有两代，且展开序列里上代摘要只出现一次。
- `e2e/webview/messagePresentation.spec.ts`：US-17 三次点击逐层展开、末次点击后按钮消失。

## 受影响模块与契约

| 模块 | 改动 |
| --- | --- |
| `core-rs/src/history.rs` | 记录信封加 `compactGeneration`；保存改为追加；读取返回代次 |
| `core-rs/src/compact.rs` | 写归档调用点改为追加 |
| `core-rs/src/main.rs` | `compact_archive_display` 返回 `{ messages, generationStarts }` |
| `src/shared/AssistantEventBus.ts` | 新增 `CompactArchiveDisplay`、`compactArchiveRequested` 结果类型 |
| `src/host/coreFacts.ts` | 归档读取返回类型随之收窄 |
| `src/host/webviewMessages.ts` | `expandCompactDone` 增加必填 `messages` / `generationStarts` |
| `src/host/ui/webviewMessageHandler.ts` | 分段转换 + 一次下发，不再投递 `messagesReplaced` |
| `pycharm-plugin/.../HostUi.kt` | 完成信号补空载荷 |
| `src/webview/compactExpand.ts`（新增） | 层级 / 可见集合 / 按钮显隐纯函数 |
| `src/webview/App.tsx` 与 handlers | 展开层级与缓存状态、逐层铺消息 |
| `src/webview/MessagesView.tsx` | 两个布尔 props 合并为 `canExpandCompact` |
| `e2e/helpers/fakeHost.ts` | 展开应答改为携带载荷的 `expandCompactDone` |

## 宪章检查

- **分层**：新类型落在 `src/shared/`（契约层），`src/host/` 只做转换与投递，webview 不
  import 宿主实现；层级判定是 webview 纯函数，符合「core 描述事实、UI 决定表现」。
- **铁律**：新增 wire 字段全部必填（没有用 `null` 之外的信号），`?` 不新增；
  归档只有一个写入点（Core），webview 不反推事实；合并 / 去重只有一份实现（Core）。
- **Core 行为**：只改归档落盘与展开合并，不改压缩触发、摘要提示词与 LLM 上下文；
  展开仍是纯读，不改任何 Core 状态。
- **文档同步**：同步 `docs/features/compaction.md`（FR-005 / 边界 / 数据流 / 追溯矩阵）、
  US-17 验收、`docs/architecture/core-ui-separation.md` 3.6、[docs/hosts/webview-ui.md §11](../../docs/hosts/webview-ui.md#11-消息区视图行为) 与
  `onMessagesReplaced` 行、`docs/architecture/events.md` 的 `messagesReplaced`
  行；新增字段进 `docsLint.test.ts` 的载荷 / 结果类型对照范围（自动）。

## 被否决的替代方案

- **每条归档记录自带「本代第几条」由 webview 自己合并**：webview 需要读两处事实（归档 +
  保留区），违背「宿主不直接读 core 磁盘数据」，也把去重口径复制到 UI 层。
- **`expandCompact` 带上要展开到第几层、每次点击重新读盘**：磁盘无变化时重复读盘没有收益，
  而且把「读第几层」变成 Core 的职责，等于把 UI 状态塞进 Core。
- **另起一个新文件 / 新目录存每代归档**：既有归档立刻变成「不认识的格式」，需要迁移；
  同文件加代次字段让旧数据天然成为第 1 代。
- **展开时一次把每代消息分别下发、由 webview 逐代拼接**：等于把合并口径的第二份实现放进
  UI；分段下标已足够表达层级，且让 webview 只做 `slice`。
- **把展开层级写进 `meta.json` 的 `isExpanded`**：跨设备 / 多视图会互相覆盖，且层级是纯
  显示状态，重开对话回到压缩后形态是可接受且更简单的语义。
