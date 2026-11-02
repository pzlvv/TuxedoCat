---
status: 起草
---

# 改动规格：`Transfer` 工具卡片

`Transfer`（跨工作区文件传输）在 webview 里没有任何工具卡片，落到未知工具兜底（扳手
图标 + 裸工具名）。这次的补全只做**展示**：给 Transfer 一张与 `Agent` 卡片同构的卡片，
写清「从哪传到哪、传了哪些、多少字节、跳过多少符号链接」，不加进度流式上报、不加新的
契约事件。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| `docs/features/cross-workspace-transfer.md` | 功能需求（新增 FR-008） | 新增 | 工具卡片的展示口径（两端身份、文件清单、字节数、跳过项、失败态） |
| `docs/features/cross-workspace-transfer.md` | 5. 非目标 | 修改 | 删掉「专用工具卡片」一条（它成了本次范围），保留「传输进度的流式上报」为非目标 |
| `docs/features/cross-workspace-transfer.md` | 7. 追溯矩阵 | 修改 | 补 FR-008 一行 |

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

## 非目标

- 不做传输进度的流式上报（仍是 `docs/features/cross-workspace-transfer.md` 的非目标：
  需要新契约事件，另立 spec）。
- 不做卡片内「打开目标目录」之类的动作（卡片只读）。
- 不改工具结果的文本格式（`✓ Transferred …` 逐字不变）。
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

（待 /converge 填写）
