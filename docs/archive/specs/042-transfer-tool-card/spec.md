---
status: 已收敛
---

# 改动规格：`Transfer` 工具卡片

`Transfer`（跨工作区文件传输）在 webview 里没有任何工具卡片，落到未知工具兜底（扳手
图标 + 裸工具名）。这次的补全只做**展示**：给 Transfer 一张与 `Agent` 卡片同构的卡片，
写清「从哪传到哪、传了哪些、多少字节、跳过多少符号链接」，不加进度流式上报、不加新的
契约事件。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/features/cross-workspace-transfer.md](../../docs/features/cross-workspace-transfer.md) | [功能需求（FR-008）](../../docs/features/cross-workspace-transfer.md#fr-008工具卡片) | 新增 | 工具卡片的展示口径（两端身份、文件清单、字节数、跳过项、失败态） |
| [docs/features/cross-workspace-transfer.md](../../docs/features/cross-workspace-transfer.md) | [5. 非目标](../../docs/features/cross-workspace-transfer.md#5-非目标) | 修改 | 删掉「专用工具卡片」一条（它成了本次范围），保留「传输进度的流式上报」为非目标 |
| [docs/features/cross-workspace-transfer.md](../../docs/features/cross-workspace-transfer.md) | [7. 追溯矩阵](../../docs/features/cross-workspace-transfer.md#7-追溯矩阵) | 修改 | 补 FR-008 一行 |
| [docs/architecture/events.md](../../docs/architecture/events.md) | [2.2 CoreRequest 汇总表](../../docs/architecture/events.md#22-corerequestcore--ui请求-响应) | 修改 | `crossWorkspaceTransferRequested` 的成功应答补 `paths: string[]`（文件清单的展示数据；统计行不变） |
| [docs/features/user-stories/desktop.md](../../docs/features/user-stories/desktop.md) | [US-60](../../docs/features/user-stories/desktop.md#us-60-跨工作区文件传输) | 修改 | 补验收标准 5：Transfer 工具卡片的展示口径 |

## 用户场景与验收标准

- 场景 1：成功传输
  - **AC-1**（FR-001）：GIVEN 一次成功的跨工作区传输 WHEN 看消息区的工具卡片 THEN 显示两端身份（`source → dest`）、文件数与总字节数；文件数不超过上限时逐条列出文件相对路径
  - **AC-2**（FR-002）：GIVEN 结果里有跳过的符号链接 WHEN 看卡片 THEN 显示「跳过 N 个符号链接」；为 0 时不显示这一行
  - **AC-3**（FR-003）：GIVEN 文件数超过上限 WHEN 看卡片 THEN 显示前 N 条 + 「还有 M 个文件」而不是把卡片撑到几千行
- 场景 2：失败与守卫
  - **AC-4**（FR-004）：GIVEN 传输失败（守卫拒绝 / 链路断开） WHEN 看卡片 THEN 卡片是失败态并显示工具返回的错误原文
  - **AC-5**（FR-005）：GIVEN 历史会话重新打开（会话从 JSONL 重放） WHEN 看 Transfer 卡片 THEN 两端身份与统计与传输当时一致（卡片信息全部来自工具入参与结果文本，不依赖会话内额外状态）

## 功能需求

### FR-001：卡片的身份与统计

卡片从工具入参读两端：`sourceTarget` / `destTarget`（空 = 缺省端，即发起会话所属工作区），
从结果文本读统计（工具结果文本是既有格式 `✓ Transferred {n} files ({size}) from \`{src}\`
to \`{dst}\`{skipped}`）。缺省端在卡片上显示 `当前工作区` 而不是空白。

两端都是长路径时按中点截断（保留首尾），完整值放 `title`。

入参里**整个键缺失**（重放的旧记录被裁剪）时，两端改用结果文本里的 `from … to …`
身份；键存在但为空串 / `null` 仍按缺省端处理（显示 `当前工作区`，不用结果文本顶替——
那是「模型明确没指定某端」，与「记录里没有这个键」是两件事）。

### FR-002：跳过项

结果文本带跳过符号链接数时显示一行；为 0 或不带该项时整行不渲染。

### FR-003：文件清单上限

结果文本里的文件清单逐行解析出相对路径。上限 20 条：超过时只列前 20 条 + 一行
「还有 M 个文件」（M = 总数 − 20）。上限是**卡片自己的**展示决策，不改工具结果的生成。

### FR-004：失败态

工具 `status === 'fail'` 时卡片用失败色显示错误原文（`output` 全文，不截断——错误文案
本来就短）。守卫拒绝的四种情形（同工作区 / 两端都不是发起方 / 目标未打开 / 远程未就绪）
文案由 core 给出，卡片不自己判断。

### FR-005：重放一致

卡片所需信息全部在 `toolArgs`（`displayArgs` 的产物）与工具结果文本里，不依赖会话级
额外状态——因此 `build_replay_message_data` 与 `conversationLoaded` 两条恢复路径不需要
新字段，卡片形状天然一致。

## 边界与错误路径

- 结果文本被 4K 上限裁剪成 `<persisted-output>` 信封：卡片显示信封里的预览（与 Bash
  卡片同一套解析，`src/webview/persistedOutputParse.ts`），不额外请求完整输出。
- 入参缺 `sourceTarget` / `destTarget`（校验失败的工具调用）：两端显示 `当前工作区`，
  卡片仍是失败态显示错误原文。
- 同一个文件在清单里出现两次：照原文显示（工具结果怎么给就怎么显示，卡片不做去重）。
- 入参里有 `sourceTarget` / `destTarget`，但两端指向同一个工作区（守卫拒绝后）：失败态
  只渲染错误原文（FR-004），不渲染两端身份——卡片不自行比对两端。

## 非目标

- 不做传输进度的流式上报（仍是 `docs/features/cross-workspace-transfer.md` 的非目标：
  需要新契约事件，另立 spec）。
- 不做卡片内「打开目标目录」之类的动作（卡片只读）。
- 不改工具结果的**统计行**（`✓ Transferred …` 逐字不变）；路径明细行是本次新增的展示数据
  （清单不在现有结果文本里，见同目录 [plan.md](plan.md) 的「先补齐卡片需要的事实」一节）。
- 不做跨工作区传输的中止按钮（中止走全局 abort，见 FR-007）。

## 对需求基线的影响

关联既有 `docs/features/user-stories/desktop.md` 的 US-60（跨工作区文件传输）；
无新增 US。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `src/webview/tools/Transfer.tsx`；`src/webview/MessagesView.tsx` 的 `TOOL_COMPONENT_MAP` | `src/test/transferCard.test.ts` | 自动 |
| FR-002 | 同上 | 同上 | 自动 |
| FR-003 | 同上 | 同上 | 自动 |
| FR-004 | 同上 | 同上 | 自动 |
| FR-005 | 无新增字段（复用 `toolArgs` / `output`） | e2e `e2e/electron/crossWorkspaceTransfer.spec.ts` | 自动 |

## 待澄清

（无）

## 收敛记录

- 已满足：
  - AC-1（FR-001）：卡片标题行显示 `source → dest` 与 `{n} 个文件 · {size}`，清单逐条列出相对路径；两端完整值进 `title`（长路径按中点截断）。证据：`src/test/transferCard.test.ts`（统计行解析 / 两端身份 / 清单逐条）+ e2e `e2e/electron/crossWorkspaceTransfer.spec.ts` 的 `getByTitle(agentId(workspaceA))`、`getByTitle('deep/b.md')`。
  - AC-2（FR-002）：`skipped > 0` 才渲染跳过段。证据：`transferCard.test.ts` 的 skipped 0 / 2 两组断言；渲染侧由 `model.stats.skipped > 0` 单点判定，e2e 的传输 0 跳过时卡片不出现该段。
  - AC-3（FR-003）：工具侧 `TRANSFER_PATH_DETAIL_LIMIT = 20` 折叠成 `  ... and {M} more files`，卡片侧 `TRANSFER_PATH_LIMIT = 20` 再截并叠加 `moreCount`。证据：`core-rs/src/tools_tests.rs` 的 `transfer_path_detail_caps_and_counts_the_rest` / `transfer_path_detail_is_absent_for_empty_paths`，`transferCard.test.ts` 的三组上限断言。
  - AC-4（FR-004）：`status === 'fail'` 只渲染错误原文。证据：`transferCard.test.ts` 的失败态两组。
  - AC-5（FR-005）：信息只来自 `toolArgs` 与结果文本。证据：`transferCard.test.ts` 的「两次构造成员模型逐字相同」+ e2e 重开沙箱段（`reuseHomeDir` 后卡片两端身份、统计、清单与传输当时一致）。宿主侧确认 `build_display_args`（`core-rs/src/permission.rs`）对 `Transfer` 原样透传入参；`trimConversationForWebview` 只剥 `_meta` 里的 `beforeContent` / `afterContent`（只有 Edit / Write 有这两个字段），Transfer 不受影响；零新增字段。
  - 非目标「统计行逐字不变」：`transfer_success_summary_text` 用 `assert_eq!` 逐字锁定首行，明细只在 `lines().skip(1)` 里。
- 偏差（已就地修正并复跑验证）：
  1. **清单路径基准**：plan 写「相对目标根」，实现定为「相对被传输子树的根」（目录传输 `a.txt` / `sub/b.md`，单文件取目标文件名）——远端 SFTP 端点没有统一 basename，按目标根会让单文件与目录两条路径产生两套口径。已写入 `TransferCounts.paths` 注释与 `docs/features/cross-workspace-transfer.md` 的 FR-008 / 2.3。
  2. **`→` 的位置**：首版放在每个端点末尾，两端都缺省时渲染出 `当前工作区 → 当前工作区 →`；已改为只在两端之间渲染一个箭头。
  3. **清单块的容器**：首版塞进 `ToolHeader` 的 children（单行 `overflow: hidden` 省略容器），多行被裁掉；已改为「标题行 + 独立清单块」。
  4. **同一路径重复出现的 React key**：spec 边界要求「照原文显示、不去重」，首版用路径作 key 会撞；已改为 `路径#序号`。
  5. **FR-001 的两种「两端不可信」**：实现区分「键缺失（重放裁剪）→ 用结果文本兜底」与「键存在但空串 / null → 缺省端」。已把这个区分补进 FR-001，避免下一位实施者把两种情形合成一条。
  6. **FR-003 的口径**：spec 原文「上限是卡片自己的展示决策，不改工具结果的生成」与「卡片要显示清单」不自洽（清单不在既有结果里）；plan 阶段已就地修订非目标为「统计行逐字不变、路径明细行是新增的展示数据」，实现与文档按此口径落地。
  7. **单文件传输的清单路径**：`counts.paths` 对单文件传输记目标文件名（不是相对目标父目录的完整路径），与目录传输的「相对子树根」同一口径——e2e 的目录用例断言的是 `deep/b.md` 与 `.dotfile`。
- 未做：无（T008 已按实测勾选，见 `tasks.md`）。实施期间修掉的三条本地红灯都不由本 spec 引入：
  `brandLiteral` 的 `exp/` 草稿目录（按 `.gitignore` 豁免）、`sidebarDocViewGit` 的 Windows
  非法文件名（平台守卫），以及 `mcp::tests` 的 PATH 混合形态（单独记为
  `specs/defects/shell-env-native-path-git-bash-hybrid.md`）。
- 反向对照（实现 → spec）：从实现 diff 枚举的行为分支均已落到 spec —— 成功路径（AC-1 ～ AC-3）、失败路径（AC-4）、旧结果解析不出统计（`stats === null` 时只显示原文，落在 FR-004 的「不猜统计」与边界第 2 条）、信封裁剪（边界第 1 条）、重复路径（边界第 3 条）、两端同工作区的失败态（边界第 4 条，收敛时补入）。追溯矩阵五个落点逐个打开验证：`transferCard.test.ts` 覆盖 FR-001 ～ FR-004，e2e 覆盖 FR-005，`tools_tests.rs` 覆盖生成侧格式；无虚指。
