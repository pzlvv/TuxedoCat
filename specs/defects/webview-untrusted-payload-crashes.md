---
status: 已修
---

# 缺陷：webview 四处运行时解引用与状态不同步会打崩或锁死整页

webview 没有 error boundary，任何一个组件在渲染期抛错都让整棵 React 树卸载（空白页，只能
重开），任何一个同步死循环都锁死渲染进程主线程（界面卡住，只能重启）。本规格收四处
各自独立、但后果同级的触发点：重复调用一次应答收尾、未校验类型就解引用 `_meta.param`、
选择框草稿与问题清单失去同步、祖先链展开缺环保护。

## 现状

四处都不依赖并发时序，用正常用户路径即可到达。

1. **应答收尾重复调用一次**（`src/webview/hooks/useAppHandlers.ts` 的 `handleUserChoiceSubmit`）。
   函数体里 `resumeFollowOnChoiceRespond();` 连写两遍，兄弟 handler `handleUserChoiceResponse`
   与 `handleAnswersSubmit` 各只有一次。该函数的唯一动作是
   `props.setForceScrollKey((prev) => prev + 1)`，重复调用多推一次强制回底。
   `git log -L` 显示重复来自 `7b392b9` 的复制粘贴。同文件另两个 handler 只调一次，
   三处口径不一致本身说明这里是笔误而非有意。

2. **`_meta.param` 未校验类型就解引用**（`src/webview/MessagesView.tsx` 的 `MessageItem`：
   `metaParam` 的声明，以及 `agentSessionId` / `agentUserMatch` 与 From 头部 JSX）。
   `const metaParam = meta?.param as string | undefined;` 是纯类型断言，运行时不做任何校验；
   `meta` 由 `src/webview/hooks/handlers/shared.ts` 的 `toUiMessage` 以
   `msg.meta as Record<string, unknown>` 原样透传自磁盘 JSONL。`meta.param` 出现非字符串
   （数字 / 对象）时，`agentSessionId` 处的 `.startsWith('#')` 立刻抛 `TypeError`。同文件
   的 `metaFilePath` 与 `metaWorkspaceId` 已经是「先判类型再取值」的写法，
   `metaParam` 是这三者里唯一漏掉的。`meta.param` 的合法形态横跨两处产出方——core 的
   子代理 From/To（`core-rs/src/engine.rs` 的 `agent_source_info` 调用点）与工具卡片
   （`src/host/ui/toolHandler.ts`），读取侧不能假定它一定是字符串。

3. **选择框草稿与问题清单失去同步**（`src/webview/QuestionOverlay.tsx` 的组件体：
   `drafts` / `index` 的 `useState`、`current` / `draft` 的取值，以及
   `otherLocked` 与两处 `draft.custom` 的输入框）。`drafts` 用
   `useState(() => createDrafts(questions))` 初始化，初值函数此后不再执行，全文件没有
   `useEffect` 让 `drafts` 跟随 `questions` 变化（该文件 `useEffect` 出现次数为 0）。
   渲染侧 `src/webview/App.tsx` 的 `<UserChoiceOverlay>` 没有 `key`，只有
   `userChoiceRequest` 这个 prop 在变。`src/shared/UserChoiceQueue.ts` 的 `enqueue`
   对同一会话的新请求会替换旧请求（旧 Promise 被 reject），于是新问题清单到达时不重挂载：
   `drafts[current.id]` 在新 id 下取不到值，`draft.otherSelected` 与 `draft.custom`
   解引用 undefined 直接抛错。
   [docs/features/ask-user-question.md](../../docs/features/ask-user-question.md#逐页状态)
   第「逐页状态」节已定义该场景的应有表现：「视图重建 / pending 重新投递时从第一页开始，
   未提交的草稿不保留」——现状既没重建、也没回到第一页。

4. **祖先链展开无环保护**（`src/webview/hooks/handlers/conversationHandlers.ts` 的
   `handleConversationConversationsData`）。`while (id && convById.has(id)) { next[id] = true;
   id = convById.get(id)!.parentSessionId; }` 没有任何已访问集合或深度上限。同一份
   `parentSessionId` 数据在递归渲染侧有专门保护（`src/webview/ConversationTreeItem.tsx`
   的 `MAX_DEPTH = 20`，注释写明「circular reference / stack overflow protection」），
   说明成环是被承认的脏数据形态；本处 `while` 是同一数据上唯一没有保护的遍历点。
   A→B→A 的环会让 `setExpandedSubSessions` 的 updater 同步死循环，主线程锁死。

## 期望

- `handleUserChoiceSubmit` 的收尾与另两个应答 handler 一致：`resumeFollowOnChoiceRespond`
  每次应答只调用一次。
- `metaParam` 只在运行时确认为字符串时才当作字符串使用：非字符串（数字 / 对象 / 缺失）
  一律按「没有 param」处理——`isAgentMessage` 判定为假、From/To 头部不渲染，与缺失
  `meta.param` 时的既有表现相同，不抛错。
- 选择框实例与请求一一对应：同一会话的请求被新请求替换时，选择框按 `choiceId` 重挂载，
  草稿重置、回到第一页，与 [ask-user-question.md](../../docs/features/ask-user-question.md#逐页状态)
  的「视图重建从第一页开始」一致。
- 祖先链展开在遇到环时终止：每个会话最多被写入一次，无论 `parentSessionId` 是否成环，
  updater 都在有限步内返回。

## 不变量

- 滚动复位语义不变：应答提交后消息区复位滚离抑制并强制回底、后续新内容恢复自动跟随；
  只是不再重复推两次。
- From/To 消息的既有展示不变：`meta.param` 为字符串时，子代理跳转、`host:workspace (user)`
  头部文案、`#agentId` 形态、`title` 提示全部保持现状。
- `metaFilePath` / `metaWorkspaceId` 的取值口径不变。
- 选择框的作答交互不变：逐页进度、单选自动翻页、多选与「其他」并存、提交回传
  `answers` 的形状（[ask-user-question.md](../../docs/features/ask-user-question.md#功能需求)FR-002）。
- 选择框回底行为不变：打开时强制回底（[docs/hosts/webview-ui.md 第 11 节](../../docs/hosts/webview-ui.md#11-消息区视图行为)）。
- 祖先链展开的既有结果不变：无环时被展开的祖先集合与现状完全相同，用户已折叠的子代理
  列表不被撑开（每次列表刷新只写祖先）。
- 不引入 error boundary、不加运行时兜底渲染：缺陷在源头修掉，与
  [tool-card-missing-file-path-crash.md](tool-card-missing-file-path-crash.md) 的非目标口径一致。

## 回归测试

四处都是「不可信数据 / 状态不同步导致运行时抛错」，webview 没有渲染单测车道
（`tsconfig.test.json` 排除 `src/webview/**`，见 `src/test/README.md`），因此与
`webviewRenderInvariants.test.ts` 同一口径用**静态扫描**锁定不变量，不引入渲染测试车道。

- **RT-1**：同一个函数体内不得出现两条完全相同的调用语句（`resumeFollowOnChoiceRespond()`
  连写两遍即命中）。（落点：`src/test/webviewRenderInvariants.test.ts`「同一函数体内无重复调用语句」）
- **RT-2**：`metaParam` 的初值必须是含 `typeof … === 'string'` 判断的条件表达式，
  不得是纯类型断言。（落点：`src/test/webviewRenderInvariants.test.ts`
  「meta.param 取值前判字符串类型」）
- **RT-3**：渲染 `<UserChoiceOverlay>` 的 JSX 元素必须带 `key` 属性，使请求替换时按
  `choiceId` 重挂载。（落点：`src/test/webviewRenderInvariants.test.ts`
  「选择框按 choiceId 重挂载」）
- **RT-4**：遍历 `convById` 取 `parentSessionId` 的 `while` 循环体必须含环保护
  （写入已访问集合或深度计数）。（落点：`src/test/webviewRenderInvariants.test.ts`
  「祖先链遍历有环保护」）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npm run test:unit -- webview-render-invariants` | 红 | 4 条 RT 全部命中：`useAppHandlers.ts` 相邻重复语句、`MessagesView.tsx` 初值为纯类型断言、`App.tsx` 缺 `key`、`conversationHandlers.ts` 无环保护 |
| 回归用例（修复后） | `npm run test:unit -- webview-render-invariants` | 绿 | 17 通过 / 0 失败：4 条新断言全绿，原有 hooks 顺序 / 语言探测 / Write 高亮三组不回归 |
| 类型检查 | `npm run check-types` | 绿 | 三份 tsconfig（主 / webview / electron）0 错 |
| 静态检查 | `npm run lint` | 绿 | `eslint src` 无告警 |
| 文档一致性 | `npm run test:unit -- docs-lint` | 绿 | 49 通过 / 0 失败，缺陷规格组 0 问题 |
| 既有回归（单测全量） | `npm run test:unit` | 绿 | 100 通过 / 1 失败 / 1 跳过；两项均与本改动无关，见下两行 |
| 既有回归：`sidebarDocViewGit` | `npm run test:unit -- sidebar-doc-view-git` | 红 | 失败原因 `ENOENT … quo"te.md`：该用例在临时目录里写含双引号的文件名，Windows 文件系统不允许。**已用 `git stash` 暂存本次全部改动后复跑，同一失败在干净基线上重现**（0 通过 / 1 失败）——是既有环境限制，非本改动引入，也不在本规格范围内 |
| 既有回归：`sidebarFiles` | `npm run test:unit` | skipped | 环境前置不满足，用例走 `markSkipped()` 分支；与本改动无关 |
| 打包产物 | `npm run build:webview` | not-run | 本定位只跑单测与静态检查；改动集中在 `.tsx` / `.ts` 逻辑，未动构建配置 |
