---
status: 已修
---

# 缺陷：标签页绿灯补挂重试在已读之后重新点亮，已激活的标签页再也熄不掉

重开（启动恢复 / 重连）后非当前标签页的离场完成绿灯正常点亮，用户切到该标签页时也正常
熄灭；但熄灭之后的一次对话列表到达会把**同一批已读会话**重新补武装：标签页绿灯重新挂回，
而此时该标签页已经处于激活态——激活是唯一熄灯路径，对着已激活的标签页再点一次不产生任何
激活事件，绿灯就永久留在顶部标签页上（只能关标签页或重启应用），与
[docs/hosts/host-matrix.md](../../docs/hosts/host-matrix.md#6-宿主固有差异有意保留)
「激活该标签页清掉标签页项」的既有口径相反。

## 现状

- 离场完成的**首次**补武装不看 `tabActive`（激活中的标签页也算未读，完成时刻用户完全缺席，
  见 [specs/defects/restart-tab-lights-incomplete.md](restart-tab-lights-incomplete.md)）——**这不是缺陷**：重开时活动项恰好是
  该标签页时，绿灯照常点亮是对的。
- 真正的缺陷是**已读之后被当成一次全新的离场完成重新武装**，而重新武装的出口同样不看
  `tabActive`、也不查已读名单，于是绿灯直接落到已激活标签页上：
  - `backfillCompletionAttention` 的幂等键只有**未读集合**（`unreadCompletionSessions`）。
    打开对话（`onActiveSessionChanged`）会把会话从未读集合里删掉（这是行灯灭的正确语义），
    下一次列表到达时该会话已不在 `existing` 里——盘上若仍带旧计数（清零写盘与这次读盘在途），
    它就被当成新的离场完成重新武装；
  - 为此专门写的护栏 `completionsReadInRun` 全仓库**只写不读**（三处 `add`：成为当前对话 /
    回窗聚焦 / 打开对话；零处消费），在途窗口实际没有被挡住；
  - 补挂循环（`electron/main.ts` 列表到达回调遍历 `backfillArmedSessions`）只判
    「还在未读集合里 + 归属可解析」，不看该标签页此刻是否已激活，直接
    `unreadCompletionTabs.add(workspaceKey)`。
- 熄灯路径只有一条：`activateWorkspace` 在活动项**真正变化**时执行
  `unreadCompletionTabs.delete(refKey(ref))` 并补推快照（`electron/main.ts`）。
  标题栏渲染层对已激活标签页不发送 `titlebar:activate-workspace`
  （`electron/titlebar/main.ts` 的点击 / 键盘处理都有 `if (!isActive)`），主进程也不在
  「活动项未变化」时清除——**已激活标签页上的绿灯没有熄灯入口**；
  在线差分（`diffCompletionAttention`）只对未激活标签页武装，从不主动清除集合。
  所以重新挂上的绿灯既无法靠点标签页摘掉，也无法靠打开对话摘掉，只能切走再切回或重启。
- 激活标签页时的「补武装来源作废」依赖宿主索引 `sessionWorkspaces`（`for (const [sid, ws]
  of [...sessionWorkspaces])`），而归属解析（`completionFactsOf` → `resolveSessionWorkspaceRef`）
  在索引未命中时还会退回 Client 路由表（`coreClient.workspaceRefForSession`）——武装能解析出
  归属、作废却拿不到会话，两侧口径不对称：用户在建链 / 列表装载完成前激活标签页时，作废
  循环扫不到该会话，随后列表到达的重试循环照样把绿灯补回。
- 复现步骤与每一步的实际行为（双工作区 A 本地 / B SSH，B 非当前时退出整个应用并选「后台
  运行」；任务在孤儿期完成，远端 `meta.json` 记 `unreadCompletions=1`）：
  1. 重开应用（活动项 A）→ B 标签页亮绿灯（首次补武装，正确）；
  2. 点击 B → 绿灯灭（`activateWorkspace` 清 `unreadCompletionTabs`）、对话行绿灯亮；
  3. 打开那个已完成的会话 → 行灯灭、`unreadCompletionSessions` 删掉该会话、core 开始清零；
  4. 清零写盘与列表读盘之间的在途列表到达（`getConversations` → `refresh()`；日志实测与
     `loadConversation` 同一毫秒到达）→ 旧计数重新武装该会话 → 补挂循环把 B 挂回绿灯；
  5. B 此刻已是激活标签页：点击不发激活事件，绿灯常亮。
- 日志证据（宿主日志文件的 `[probe]` 行即补挂循环的瞬时视图，路径见 `src/config/project.ts` 的日志目录口径）：

  ```
  16:12:43.522 [completion-backfill] [probe] sid=session_...ny2lspn wsKey=ssh//pz@<远端>/<仓库目录> tabs=[]   ← 首次武装（active=common）
  16:12:50.120 [completion-sync] tabs=[] sessions=1                                                      ← 点击 B：标签页灭、行灯留
  16:13:04.538 Received from webview: loadConversation                                                   ← 打开完成会话
  16:13:04.551 [completion-backfill] [probe] sid=session_...ny2lspn wsKey=ssh//... tabs=[]  →  [completion-sync] tabs=[ssh//pz@<远端>... ] sessions=1  ← 同一毫秒重新武装并挂回
  16:13:16.655 [completion-sync] tabs=[] sessions=1 / 16:13:16.660 tabs=[] sessions=0                     ← 只有切走再切回才灭
  ```

  另一份记录（同一日志、pid 11952）里启动时活动项就是该 SSH 标签页：首次武装即落在激活
  标签页上（规格允许），随后 `tabs=[ssh//<目标>...] sessions=0`——行灯已清、标签页绿灯仍在，
  同样落进「已激活标签页无熄灯入口」。

## 期望

- **已读护栏对补武装生效**：`completionsReadInRun` 里的会话不再被 `unreadCompletions`
  补武装（`backfillCompletionAttention` 接收该名单并跳过），在途列表快照里的旧计数不翻旧账
  ——对话行绿灯与标签页绿灯都不复亮。
- **补挂重试按在线的「激活中即已读」口径**：重试循环解析出归属后，若该标签页此刻已激活，
  不补亮标签页绿灯，并把该会话从补武装来源集合里作废（用户正看着这页 = 已读，之后切走再
  经列表到达也不补亮）。
- **补武装来源作废的会话口径与武装一致**：激活标签页时按与归属解析同一套查找
  （`resolveSessionWorkspaceRef`，含 Client 路由表兜底）判定会话是否属于该目录，不再只认
  宿主索引 `sessionWorkspaces`。
- 激活已激活的标签页照样不产生事件（设计如此，不改）；上述三条保证「已激活标签页上不会
  留下无法清除的绿灯」。

## 不变量

- 离场完成首次武装不适用在线规则：列表到达那一刻激活中的标签页也算未读（
  [specs/defects/restart-tab-lights-incomplete.md](restart-tab-lights-incomplete.md)），首次武装仍可点亮激活标签页；
  本缺陷只约束**补挂重试**与**已读之后**的重新武装。
- 在线差分武装规则完全不变（`diffCompletionAttention` 的可见性判定与 `tabActive` 判定）。
- 对话行绿灯的既有语义不变：激活标签页只清标签页项，行灯等对话被打开 / 成为当前对话才清；
  激活标签页仍把该目录会话的补武装来源作废（既有不变量，只修判定口径）。
- agent 创建的会话在两条武装源头上保持安静（specs/025 FR-003）。
- 标签页蓝 / 黄灯聚合、侧栏 / webview 的灯条渲染、`completion-sync` 幂等快照推送时机不变。
- 托盘状态点 / 睡眠阻断 / 关闭确认语义不变（不消费格林集合）。

## 回归测试

- **RT-1**：单测——补武装跳过本次运行已读的会话；同一份列表里未读的会话照常武装
  （落点：`src/test/completionAttention.test.ts`，用例「补武装：本次运行已读的会话不再武装」）。
- **RT-2**：e2e 本地车道——重开后非当前标签页亮绿灯；激活即灭并打开对话完成阅读；随后把
  `meta.json` 的 `unreadCompletions` 写回 1 模拟清零落盘前的在途列表快照，再改一次会话标题
  驱动列表到达：标签页（已激活）与对话行都不复亮绿灯
  （落点：`e2e/electron/completionAfterRestart.spec.ts`，用例「US-65 已读之后旧计数到达不再
  复亮标签页绿灯」）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1（修复前） | `npm run test:unit -- completionAttention` | 红 | 失败断言「补武装：本次运行已读的会话不再武装（在途旧计数不翻旧账）」——`backfillCompletionAttention` 不接收已读名单，已读会话照旧进入武装名单（22 通过 / 1 失败） |
| RT-2（修复前） | `npx playwright test -c e2e/playwright.config.ts --project=electron-app -g "已读之后旧计数到达不复亮标签页绿灯"` | 红 | 断言 `not.toHaveClass(/activity-completed/)` 失败，实测 class 为 `ws-tab active activity-completed`——已激活标签页上绿灯被复亮且无法清除，与用户报告一致 |
| RT-1（修复后） | `npm run test:unit -- completionAttention` | 绿 | 23 断言全过：已读会话跳过、同一列表里的未读会话照常武装；其余 22 条补武装 / 差分 / 已读清理断言无回归 |
| RT-2（修复后） | `npx playwright test -c e2e/playwright.config.ts --project=electron-app -g "已读之后旧计数到达不复亮标签页绿灯"` | 绿 | 旧计数回写 + 改名驱动列表到达后，已激活标签页与对话行都不复亮 |
| 既有回归（离场完成灯路） | `npx playwright test -c e2e/playwright.config.ts --project=electron-app completionAfterRestart completionTab` | 绿 | 5 通过：单工作区 / 非当前标签页重开、已读不复亮、在线完成、失焦完成；首次武装仍可点亮激活中的标签页 |
| 既有回归（electron 车道全量） | `xvfb-run -a npx playwright test -c e2e/playwright.config.ts --project=electron-app` | 绿 | 91 通过 / 2 挂：`sessions.spec` US-22（删除会话后盘上残留 4 个 session 文件）单跑整个文件 7 通过、`preview.spec` US-38（查看器窗口位置记忆）在未改动的 main 上也同样挂——两者与本缺陷无关，属本机车道负载 / 窗口管理器偶发 |
| 类型 / lint | `npm run check-types && npm run lint` | 绿 | 三份 tsconfig + eslint 无报错 |
| docsLint | `npm run test:unit -- docsLint` | 绿 | 49 + 6 断言全过（[docs/hosts/host-matrix.md 第 6 节](../../docs/hosts/host-matrix.md#6-宿主固有差异有意保留) 的未读完成行按新口径同步） |
