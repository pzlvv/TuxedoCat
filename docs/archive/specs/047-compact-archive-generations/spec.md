---
status: 已收敛
---

# 改动规格：多次压缩的归档逐代保留与逐层展开

会话经历多次压缩后，归档文件每次都被整份覆盖，展开时只能看到最近一次压缩的原文——更早的代次
在磁盘上已经不存在。本改动让归档按代次累积，并把「展开压缩的对话历史」改成逐层展开：一次压缩
对应一次展开，每点一次补入更早的一代，直到全部展开。

修复之前已经发生的压缩不追溯：那些代次的原文在旧实现下已被覆盖，磁盘上没有可恢复的载体，
本改动只保证此后不再丢。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/features/compaction.md](../../docs/features/compaction.md) | [FR-005：归档与展开](../../docs/features/compaction.md#fr-005归档与展开) | 修改 | 归档由「每次覆盖」改为「按代次累积」；展开由「一次全量」改为「一次一代」 |
| [docs/features/compaction.md](../../docs/features/compaction.md) | [4. 边界与错误路径](../../docs/features/compaction.md#4-边界与错误路径) | 修改 | 增补归档空 / 旧格式 / 半代截断与展开层级的可见行为 |
| [docs/features/compaction.md](../../docs/features/compaction.md) | [7. 追溯矩阵](../../docs/features/compaction.md#7-追溯矩阵) | 修改 | FR-005 的实现与测试落点改到按代次累积的读取与逐层展开 |
| [docs/features/user-stories/messages.md](../../docs/features/user-stories/messages.md) | [US-17 压缩历史展开](../../docs/features/user-stories/messages.md#us-17-压缩历史展开) | 修改 | 验收 2 改为「一次点击展开一代，N 次压缩对应 N 次展开」 |
| [docs/architecture/core-ui-separation.md](../../docs/architecture/core-ui-separation.md) | [3.6 UI → core 的请求](../../docs/architecture/core-ui-separation.md#36-ui--core-的请求) | 修改 | `compactArchiveRequested` 的应答语义改为「按代次累积的完整展开序列」 |
| [docs/architecture/host-ui-modules.md](../../docs/architecture/host-ui-modules.md) | [3. WebviewMessageHandler](../../docs/architecture/host-ui-modules.md#3-webviewmessagehandler) | 修改 | `handleExpandCompact` 只取事实并整批下发，展开到第几层不由宿主决定 |
| [docs/hosts/webview-ui.md](../../docs/hosts/webview-ui.md) | [11. 消息区视图行为](../../docs/hosts/webview-ui.md#11-消息区视图行为) | 修改 | 展开按钮的逐层显隐与每层的可见集合 |

## 用户场景与验收标准

- 场景 1：多次压缩后归档不丢
  - **AC-1**（FR-001）：GIVEN 会话已压缩一次且归档里有第 1 代记录 WHEN 发生第 2 次压缩 THEN 归档追加第 2 代记录，第 1 代记录逐字节不变
  - **AC-2**（FR-001）：GIVEN 同一会话经历 3 次压缩 WHEN 读取归档 THEN 得到 3 代记录并按代次升序排列，且上一代摘要（本代归档区的第一条）在展开序列里只出现一次
- 场景 2：逐层展开
  - **AC-3**（FR-002）：GIVEN 归档有 3 代 WHEN 用户第 1 次点击「展开压缩的对话历史」THEN 消息区显示「第 3 代原文 + 第 3 代摘要 + 当前保留区」，且按钮仍可见
  - **AC-4**（FR-002）：GIVEN 已展开 1 代（共 3 代）WHEN 用户第 2 次点击 THEN 在已显示的更晚一代之前补入第 2 代原文与该代摘要，整体仍按时间顺序排列
  - **AC-5**（FR-002）：GIVEN 已展开的代次数等于归档代次数 WHEN 消息区渲染 THEN 不再出现展开按钮，显示内容为完整历史（全部原文 + 各代摘要 + 保留区）
  - **AC-6**（FR-002）：GIVEN 会话切换或新建对话 WHEN 消息区渲染 THEN 展开层级归零、按钮按该会话的归档重新判定
  - **AC-7**（FR-002）：GIVEN 会话在展开状态下又完成一次压缩 WHEN 收到新的压缩后消息集合 THEN 展开层级归零、按钮回到初始态，被压缩掉的内容出现在新代次的归档里
- 场景 3：展开的只读性
  - **AC-8**（FR-003）：GIVEN 已展开任意层级 WHEN 展开完成 THEN `<sessionId>.jsonl`、`meta.json` 与归档文件都未被改写，LLM 上下文仍是被压缩后的消息数组
  - **AC-9**（FR-003）：GIVEN 已展开 2 代 WHEN 用户继续点击 THEN 只改变可见集合，不追加重复条目、不重复请求归档
- 场景 4：单代、旧格式与缺失归档
  - **AC-10**（FR-004）：GIVEN 归档只有 1 代 WHEN 用户点击一次 THEN 显示「该代原文 + 摘要 + 保留区」并隐藏按钮，与本次改动前的一次点击结果一致
  - **AC-11**（FR-004）：GIVEN 归档记录不带代次标识（改动前写下的旧格式）WHEN 读取归档并展开 THEN 这些记录视为最早的一代，与之后追加的代次一起按顺序显示
  - **AC-12**（FR-004）：GIVEN 会话没有归档文件 WHEN 会话加载完成 THEN 不出现展开按钮
  - **AC-13**（FR-004）：GIVEN 归档读取失败或返回空 WHEN 用户在视图内点击展开 THEN 可见集合与展开层级不变，按钮保持可见

## 功能需求

### FR-001：归档按代次累积

压缩归档从「每次整份覆盖」改为「按代次追加、只增不改」：

- 归档文件仍是 `<sessionId>.compact_archive.jsonl`，仍是 Core 独占写入；每条记录在既有信封
  `{ uuid, parentUuid, timestamp, message }` 上多一个代次标识 `compactGeneration`，从 1 起单调递增。
- 一次压缩只追加本代记录，既有代次的记录不被重写、不被截断；保留区照旧不进归档。
- 本代记录 = 本次归档区消息 + 本代摘要消息。归档区按既有口径从「最后一次边界之后」截取，
  因此它的第一条是与上一代末尾相同的那条摘要；展开序列按 `uuid` 去重（保留首次出现），
  同一条摘要只出现一次。
- 代次序号 = 归档已有最大代次 + 1；读不到代次标识的旧格式记录按第 1 代处理。

### FR-002：展开逐层加深

展开层级 `d` 是该视图内「已展开几代」的计数（`0 ≤ d ≤ N`，`N` = 归档代次数），只存在于
webview 内存，不落盘：

- `d = 0` 时消息区就是压缩后的形态（最新一代摘要 + 保留区）。
- 级别 `d` 的可见集合 = 第 `N-d+1` 到第 `N` 代记录（按代次升序）+ 当前保留区。每加深一层，
  在已显示的内容**之前**补入一代更早的内容，整体顺序始终是时间顺序。
- 按钮：「展开压缩的对话历史」在 `d < N` 时可见，文案恒定不改；每点击一次 `d` 加一；
  `d = N` 后按钮消失。因此 `N` 次压缩对应 `N` 次展开。
- 层级重置：切到别的会话再回来、新建对话、或收到压缩产出的新消息集合时，`d` 归零。
- 归档的合并口径（各代拼接、去重、旧格式补摘要、并入当前保留区）仍是 Core 的唯一实现；
  webview 只按层级选取完整序列的尾部，不自行拼装事实。

### FR-003：展开的只读性

展开不写任何文件、不改任何 Core 状态：JSONL、`meta.json`、归档文件的字节在展开前后一致；
LLM 上下文仍是压缩后的消息数组，展开只影响显示。已取到的完整展开序列在同一视图内复用，
继续点击不开新的归档读取，也不产生重复条目。

### FR-004：单代、旧格式与缺失归档

- 只有 1 代归档的会话（改动前绝大多数会话就是这种形态）点一次即看到全部，按钮随即隐藏，
  结果与改动前的一次点击一致。
- 旧格式归档（记录无 `compactGeneration`）按最早的一代读；若旧归档没有摘要消息，
  沿用「追加主 JSONL 里的摘要」的补偿口径。
- 会话加载时归档为空 → 不出现展开按钮。视图内点击后取不到归档 → 可见集合与层级不变，
  按钮保持可见（不出现「点一下就没了」的形态）。

## 边界与错误路径

| 场景 | 预期行为 |
| --- | --- |
| 压缩完成但归档写盘失败 | `compactEnd` 仍是 `complete`；点击展开取不到归档 → 按 AC-13 处理（层级不变、按钮保留） |
| 归档文件尾部被截断（写一半后进程崩溃） | 按行解析、坏行跳过；该代显示已写下的记录，不回写、不阻塞下一次压缩追加新代次 |
| 同一会话多次压缩之间只压掉上一条摘要 | 该代可见增量只有一张摘要卡片；展开仍按代次计数，不合并代次 |
| 归档文件被外部删除 | 展开取不到归档，按 AC-13 处理；`hasCompactArchive` 在下一次会话加载时变假 |
| 归档读取遇到孤立代理项转义 | 与 `parse_messages` 同口径清洗后解析 |
| 会话回退（`rewindConversation`） | 不影响归档代次：归档是各次压缩那一刻的事实，不回写、不回收 |
| 展开过程中会话被其他实例持有 | 归档读取是纯读，不受会话锁限制（既有语义） |
| 归档代次数很大 | 展开序列按代次一次性应答；单次点击只改变可见集合，不逐代多次读盘 |

## 非目标

- 不追溯恢复本次改动之前已被覆盖的代次（磁盘上已无载体），见开篇。
- 不做「一键全部展开」或「收起回压缩后形态」：只有逐层加深，收起由重开会话完成。
- 不把展开层级持久化到 `meta.json`（`isExpanded` 仍只是既有的写入点，不参与判定）。
- 不改动画廊 / TUI 的入口：TUI 没有展开入口，PyCharm 插件 v1 的
  `expandCompactDone` 仍只带完成信号（分叉记录见
  [docs/hosts/pycharm-plugin.md 第 6 节](../../docs/hosts/pycharm-plugin.md#6-宿主差异与-vs-code--electron-宿主的有意分叉)）。
- 不改压缩触发、阈值、摘要提示词与用户输入历史的跨代口径。

## 对需求基线的影响

修改 US-17（压缩历史展开）的验收 2：由「点击后整批替换显示」改为「每次点击展开一代，
N 次压缩对应 N 次展开，全部展开后按钮消失」。不新增 US，e2e 映射不动
（`e2e/webview/messagePresentation.spec.ts` 已挂 US-17）。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `core-rs/src/history.rs` 的归档保存（按代次追加）与 `core-rs/src/compact.rs` 的写入口 | `core-rs/src/compact_engine_tests.rs`（多次压缩后归档代数、代次升序、摘要去重） | 自动 |
| FR-002 | `core-rs/src/main.rs` 的 `compact_archive_display`（按代次合并）+ webview 的展开层级纯函数与按钮显隐 | 层级选择纯函数的单测 + `e2e/webview/messagePresentation.spec.ts`（逐层点击、按钮消失） | 自动 |
| FR-003 | 只读路径（`UiRequest.compactArchiveRequested` 应答不改状态） | `core-rs/src/session_lock_tests.rs` 的纯读用例扩到多代；e2e 断言展开前后文件字节不变 | 自动 |
| FR-004 | `core-rs/src/history.rs` 的旧格式与空归档读取 | `core-rs/src/history_tests.rs`（缺 `compactGeneration` 的旧归档、空归档） | 自动 |

## 待澄清

无未决问题。

## 收敛记录

- **已满足**：
  - FR-001（归档按代次累积）→ `core-rs/src/history.rs` 的 `append_compact_archive`（记录带
    `compactGeneration`，只追加不覆盖）+ 专项用例
    `history_tests::compact_archive_appends_generations_instead_of_overwriting` /
    `compact_engine_tests::repeated_compact_appends_a_second_archive_generation`（AC-1 / AC-2）。
  - FR-002（展开逐层加深）→ `core-rs/src/main.rs` 的 `compact_archive_display` 产出
    `{ messages, generationStarts }`；宿主 `webviewMessageHandler.handleExpandCompact` 按代分段
    转换；webview `compactExpand.ts` 的 `compactVisibleMessages` / `canExpandCompact` + App 的
    `compactArchiveView` / `compactExpandDepth`（AC-3 ～ AC-7）。证据：
    `main_tests::compact_archive_display_merges_generations_with_start_indexes`、
    `src/test/compactExpand.test.ts`（19 项）、e2e
    `messagePresentation.spec.ts›US-17 压缩历史逐层展开`（三次点击逐层展开、末次按钮消失、
    后续层不再上报 `expandCompact`）。
  - FR-003（展开只读）→ `compactArchiveRequested` 仍为纯读分支，
    `session_lock_tests::compact_archive_read_works_when_held` 绿；展开路径不写 JSONL /
    meta.json / 归档，webview 只切片不复用转换（AC-8 / AC-9）。
  - FR-004（单代 / 旧格式 / 缺失归档）→ `main_tests::compact_archive_display_backfills_legacy_archives`、
    `history_tests::compact_archive_records_without_generation_read_as_the_first`、
    `history_tests::compact_archive_skips_half_written_lines`；空载荷 `expandCompactDone` 在
    `conversationHandlers.ts` 里直接返回、不改状态（AC-10 ～ AC-13）。
- **偏差**：无。
- **未做**：PyCharm 的 v1 回包仍只有完成信号（本 spec 非目标，按设计补空载荷）；
  `npm run build:core:host` 在本机失败（未安装 `x86_64-unknown-linux-musl` 目标），
  standalone 系列单测因此走 `markSkipped`。
