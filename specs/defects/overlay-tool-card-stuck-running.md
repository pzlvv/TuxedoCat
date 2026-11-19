---
status: 已修
---

# 缺陷：Overlay 对话里工具卡片停在 running、以及卡片上屏前的无指示空窗

两个症状都出现在工具调用的状态推进上，成因是同一个结构事实：`addMessage`（上架工具
卡片）与 `updateToolStatus`（推进卡片状态）是**两条独立推送**，同会话内不保证顺序。

- 卡片停在 running：状态更新先于卡片到达时被塞进「只在 `conversationLoaded` 回放」的
  缓冲；实时会话永远等不到那次回放，风车就永久转着。
- 无指示空窗：`addMessage(toolcall)` 一到就无条件关掉 thinking 动画，此时状态还没推进到
  `running`，于是「thinking 已消失、风车还没亮」——界面上没有任何进行中的指示。

Overlay 对话把这两段间隔放大：首次工具调用要现挂视图（建命名空间 + 挂 overlay + bind），
权限阶段还要经代理回读文件生成 diff，比磁盘路径多出若干次跨进程往返。

## 现状

### 1. 状态更新落到只服务历史恢复的缓冲里

`src/webview/hooks/handlers/toolHandlers.ts` 的 `handleToolUpdateToolStatus` 在
`toolCallId` 匹配不到已有消息时，把更新写进 `bufferedToolStatusRef`。这个 ref 的唯一消费
点是 `conversationHandlers.ts` 的 `replayBufferedToolStatusIntoMessages`，而它只在
`conversationLoaded` 时调用。实时会话里卡片随后由 `addMessage` 上架，但缓冲再无人消费。

实测（真实 SSH 远端 + Overlay 会话，记录 webview 收到的消息）：

```text
207 updateToolStatus status=running  id=6495_0
208 updateToolStatus status=running  id=6495_0
208 addMessage       status=normal   id=6495_0
208 updateToolStatus status=success  id=6495_0
```

`success` 与 `addMessage` 落在同一毫秒；一旦 rAF 批次先消费 `success`（卡片尚未进
messages），该状态就进了缓冲、永久失效。

### 2. 卡片上屏时无条件让出 thinking 动画

同文件里 `handleToolAddMessage` 在 `msg.role === 'toolcall'` 时关闭 thinking 动画（
WebSearch 例外）。判定只看「这是工具卡片」，不看卡片是否已经进入执行态；状态更新晚到
时，界面在两段指示之间出现空档。

实测（同一链路，逐帧采样「thinking 可见 / 有 running 风车」，记录所有不活跃区间）：

```text
[诊断] 不活跃区间（ms）： [{"from":311,"ms":195}]
```

即存在一段约 195ms 既无 thinking 也无 running 风车的区间。

## 期望

1. **状态推进不丢**：任何时候卡片上架，先于它到达的状态更新都要立刻应用，不等
   `conversationLoaded`。缓冲因此不再只服务历史恢复——它是「卡片还没上牌时的暂存」，
   牌一上就清空。
2. **状态只推进不降级**：应用缓冲时沿用既有优先级（`success` / `fail` > `running` >
   `normal`），不把已经收尾的卡片拉回运行态。
3. **没有无指示空窗**：卡片上屏时若状态还不是 `running` / `normal`，thinking 动画继续
   显示，直到卡片真正进入执行态才让出。WebSearch 仍保持既有例外（整个搜索期间显示
   thinking）。
4. **风车必须收起**：工具成功或失败后，时间线上不得残留 `msg-timeline-dot-running` 节点。

## 不变量

- `addMessage` 与 `updateToolStatus` 仍是两条独立推送，不合并、不加新消息类型。
- 跨会话缓冲语义不变：非当前会话的更新照旧进缓冲，供切回该会话时回放。
- `conversationLoadingRef` 期间的缓冲语义不变（加载中不丢状态）。
- 工具状态优先级不变（`TOOL_STATUS_PRIORITY`）。
- `isStreaming` 在 `success` / `fail` 时置 false 的口径不变。
- WebSearch 的「搜索期间保留 thinking 动画」行为不变。
- 历史恢复（`conversationLoaded` + `replayBufferedToolStatusIntoMessages`）路径不变。

## 回归测试

判定抽成纯函数（`src/webview/toolCardStatus.ts`）后可以直接驱动，不依赖 React 与真实
Core；e2e 补一条端到端旁证。

- **RT-1**（期望 1 / 2）：`applyBufferedToolStatus` 把缓冲里的 `success` 应用到 running
  卡片上——状态变 success、带上输出、清掉 `isStreaming`，且缓冲条目出队；
  反过来 `running` 不得覆盖已 success 的卡片（只升不降），但仍要消费缓冲。
  （落点：`src/test/toolCardStatus.test.ts` 的 `toolCardStatus` 用例组）
- **RT-2**（期望 3）：`isToolCardRunning` 对 `undefined` / `running` / `normal` 恒为真，
  对 `success` / `fail` 为假——这正是「卡片此刻会不会转风车」的判据；
  `shouldKeepThinkingForToolCard` 与之同源（进行中就让出 thinking，否则保留）。
  （同一用例组）
- **RT-3**（期望 4）：真实 SSH 远端的 Overlay 对话里跑一次 Write，成功后时间线上
  `msg-timeline-dot-running` 数量为 0，且写入不落真实磁盘。
  （落点：`e2e/electron/overlayMountProxyRemote.spec.ts` 的
  `Overlay 对话：Write 的风车必须收起，且工具卡片上屏期间不出现无指示空窗`）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 现状取证（问题一） | 临时诊断：记录 webview 收到的 `updateToolStatus` / `addMessage` 序列 | 红 | `success` 与 `addMessage` 同毫秒到达（见「现状」第 1 段实测） |
| 现状取证（问题二） | 临时诊断：逐帧采样 thinking / running，统计不活跃区间 | 红 | 存在约 195ms 无指示区间（见「现状」第 2 段实测） |
| RT-1 / RT-2（变异验证） | 依次把 `isToolCardRunning` 还原成只看 `running`/`normal`、去掉 `isStreaming` 清零、让缓冲不消费，各跑一次 `npm run test:unit -- toolCardStatus` | 红 | 三次变异分别被抓到 2 / 1 / 1 条断言，确认用例有诊断力 |
| RT-1 / RT-2（修复后） | `npm run test:unit -- toolCardStatus` | 绿 | 18 通过 / 0 失败 |
| RT-3（修复后） | `npx playwright test -c e2e/playwright.config.ts --project=electron-ssh -g "Write 的风车必须收起"` | 绿 | 1 passed（13.7s） |
| 类型检查 | `npm run check-types` | 绿 | 四份配置 |
| Lint | `npm run lint` | 绿 | — |
| Rust 格式基线 | `npm run fmt:rust:check` | 绿 | 本次未改 Rust |
| 全量单元回归 | `npm run test:unit` | 绿 | 116 通过 / 0 失败 / 2 跳过（`sidebarDocViewGit`、`sidebarFiles` 因本机 git 前置走 skip 分支） |
| 文档一致性 | `npm run test:unit -- docs-lint` | 绿 | 49 + 6 全过 |

备注：

1. 两个症状同源但不互为因果：收敛点分别是「缓冲的消费时机」与「让出 thinking 的判据」。
   修复动 `src/webview/toolCardStatus.ts`（新增纯模块）、`toolHandlers.ts`（改为驱动纯
   函数）与 `MessagesView.tsx`（时间线判据与卡片内容渲染口径对齐），未改契约、未新增
   消息类型。
2. 复现需要真实 SSH 远端：本机 Windows Core 没有 Overlay 能力（`isolatedWorkView` 恒
   false），本地车道进不到该分支。
3. e2e 的 RT-3 在正常路径下即使不回退修复也会绿——`success` 通常晚于 `addMessage` 到达，
   顺序不定的窗口很难在 e2e 里稳定构造。因此**行为验收以 RT-1 / RT-2 的变异验证为准**
   （三次变异全部变红），RT-3 只作端到端旁证：确认该链路上风车确实收起、写入确实不落盘。
