---
status: 已修
---

# 缺陷：非当前标签页的离场完成不亮绿灯——列表只装载活动工作区，补武装永不运行

后台完成（离场完成）的补武装与标签页灯补挂**唯一**触发点是对话列表到达出口
（`electron/main.ts` initCore 里 `sidebar:conversations-updated` 的回调）。而对话列表
只装载**活动工作区**：`ConversationManager.refresh()` 只读 `host.getWorkspacePath()`，
三个触发点（`onConversationListChanged` / `sidebar:get-conversations` /
`WebViewUI.refreshConversations`）全部服务活动目录。重启 / 重开后，离场完成的会话所在
标签页若不是活动项（恰是用户场景：非当前 tab 的对话后台跑完，重开时它仍是非当前
tab），它的列表根本不装载——补武装永不运行，`unreadCompletionTabs` 永远拿不到该标签页
的 key，顶端绿色流水灯不亮。用户必须**点开**那个标签页（激活 → 侧栏拉列表 → 列表到达
→ 补武装）灯才补上；但未读完成灯的意义就是在激活前亮——US-65 验收第 4 条明确承诺
「未激活标签页」亮绿灯（[docs/features/user-stories/desktop.md](../../docs/features/user-stories/desktop.md#us-65-后台任务的重连与恢复)）。

与 `restart-tab-lights-incomplete` 的已修范围不重叠：那份修复解决的是「列表到达后武装
与聚合错过触发点」，本缺陷是「列表根本不到达」——非活动工作区没有任何列表装载触发点。

## 现状

- 补武装链路：列表到达出口对 meta.json `unreadCompletions > 0` 的会话执行
  `backfillCompletionAttention`（行绿灯）并按归属解析补挂 `unreadCompletionTabs`
  （标签页绿灯）；出口挂在 `sidebar:conversations-updated`。
- 列表装载是活动工作区专属：`ConversationManager.refresh()` 读
  `host.getWorkspacePath()`；`onConversationListChanged()` 只重读活动目录、其余目录标脏
  （脏快照也要等激活后命中才补读）；`sidebar:get-conversations` 只服务当前激活标签页。
  启动恢复（`readOpenWorkspaces`）把整个打开集合与上次的活动项原样恢复，非活动标签页
  的列表快照为空且无人装载。
- 归属索引同步（`syncSessionWorkspaceIndex`）也从活动目录的快照取
  （`getCachedList()` 按活动键取）——即使列表以某种方式到达，非活动目录会话的归属
  解析仍不命中（`restart-tab-lights-incomplete` 已把它交给「下一次列表到达」重试，
  而下一次列表到达同样只有激活才触发）。
- 复现路径：工作区 A、B 双开，B 非当前；B 里的对话后台运行（远端 detach / 宿主退出
  期间完成），meta.json `unreadCompletions=1`；重开应用（活动项是 A）→ B 标签页顶端
  无绿灯；点开 B 后绿灯才补挂。

## 期望

- 工作区建链就绪时（含启动恢复的非活动标签页、重开工作区、重连），该目录的对话列表
  被装载一次——不管它是不是活动项。装载走既有分发链：补武装（行绿灯）、归属索引、
  标签页灯补挂照常运行，非活动目录的离场完成即亮标签页绿灯。
- 非活动目录的列表装载不进侧栏：侧栏仍只显示活动目录的对话列表（列表快照与分发的
  双流契约不变，抑制只发生在「推向侧栏」这最后一跳）。
- 归属索引能从**到达的那份列表**学习归属（条目自带 `project`），不再只认活动目录的
  快照——非活动目录的会话解析得出归属，标签页灯挂得上。

## 不变量

- 在线差分的武装规则完全不变（`completionAttention.ts` 的可见性判定、武装即推）。
- 补武装的既有口径不变：agent 创建的会话安静（specs/025 FR-003）、已武装幂等、
  `completionsReadInRun` 护栏、激活标签页清标签页灯、打开对话清行灯并清零计数。
- 列表流与状态流分离、快照按工作区分份、stale-while-revalidate 语义不变。
- 过期保护不变：读盘期间活动目录切换时，活动目录装载的过期结果仍不 commit、不分发。
- 托盘状态点 / 睡眠阻断 / 关闭确认语义不变（它们不消费列表流）。

## 回归测试

- **RT-1**：e2e 双工作区重启——B（非当前标签页）里离场完成的会话，重开后（A 活动）
  B 标签页亮 `activity-completed`（不点开）；激活 B 后对话行亮绿灯，打开对话即清除、
  盘上计数归零（落点：`e2e/electron/completionAfterRestart.spec.ts` 新用例）。
- **RT-2**：单测——非活动目录的定向装载：快照进目标目录自己的键、分发链触发（灯管线
  吃列表到达）、活动目录的快照与分发不受影响（落点：
  `src/test/conversationListWorkspace.test.ts`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1（修复前） | `npx playwright test -c e2e/playwright.config.ts --project=electron-app -g "非当前标签页重开"` | 红 | 失败断言：重开（A 活动）60s 内 B 标签页 class 恒为 `ws-tab`，`activity-completed` 从未出现——非活动标签页的列表无人装载，补武装未运行 |
| RT-2（修复前） | `npm run test:unit -- conversationListWorkspace` | 红 | 失败断言：「定向装载触发分发链（非活动目录也到达）」「定向装载把快照存进目标目录」——定向装载入口不存在，探测调用为 no-op |
| RT-2（修复后） | `npm run test:unit -- conversationListWorkspace` | 绿 | 定向装载 4 断言全过：分发链到达、快照进目标键且干净、活动目录快照不受影响；该文件既有 16 断言无回归 |
| RT-1（修复后） | 同修复前命令 | 绿 | 启动后 B（非活动）标签页亮 `activity-completed`；点击激活即摘标签页灯、侧栏行灯亮、打开对话行灯熄灭且盘上计数归零 |
| 既有回归（灯路） | `npx playwright test -c e2e/playwright.config.ts --project=electron-app completionAfterRestart completionTab` | 绿 | 同文件单工作区用例 + completionTab 两用例（非活动标签页在线完成 / 失焦完成）共 4 条全过 |
| 既有回归（全量） | `npm run check-types && npm run lint && npm run test:unit` + `npx playwright test --project=electron-app`（electron 车道全量） | 绿 | 单测 86 过（仅 docsLint 待验证记录补全，见下）；electron 车道 91 过 1 挂——`workspace.spec` US-30 完整模式 ↔ 悬浮窗在全车道连跑时挂、单跑与复跑均绿，与灯路无关的负载偶发（切换时序敏感），备注留观 |
| docsLint | `npm run test:unit -- docs-lint` | 绿 | contracts.md §4 成员表同步（`refreshWorkspace` / `loadFor` / `dispatchList(list, workspace)` / `workspaceCacheKey(workspace?)`），[host-matrix.md 第 6 节](../../docs/hosts/host-matrix.md#6-宿主固有差异有意保留)未读完成呼吸行补三条口径（建链就绪装载非活动目录、归属从到达列表学习、已读作废补武装来源） |
