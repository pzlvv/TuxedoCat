---
status: 已收敛
---

# 改动规格：打开 Overlay 对话时的部署闸门

已存在的 Overlay 对话要靠挂载代理才能重建它的视图。代理未部署时，当前只有一个部署入口：
**新建对话勾选 Overlay 后发第一条消息**。历史对话没有「第一条消息」这一步，打开它时
既不会弹部署，视图也建不起来——文件树、差异视图与工具卡片链接一并失效，用户没有任何
可执行的出路（既没有部署入口，也看不出该装什么）。

本规格新增第二个部署入口：打开一个归属为 `isolated` 的已有对话时，若当下的 Core 能力
表明视图建不起来而部署可能解决它，就先弹部署提示；**部署失败则放弃打开该对话**。
部署成功后按原有流程继续加载，用户不需要再点一次。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/core/conversation-work-view.md](../../docs/core/conversation-work-view.md) | [1. 能力](../../docs/core/conversation-work-view.md#1-能力) | 修改 | 部署入口从「发第一条消息」扩为「发第一条消息」或「打开已有 Overlay 对话」两处 |
| [docs/core/mount-proxy.md](../../docs/core/mount-proxy.md) | [2. 分发、落点与安装判据](../../docs/core/mount-proxy.md#2-分发落点与安装判据) | 修改 | 部署触发时机补充「打开已有 Overlay 对话」；失败即放弃打开 |
| [docs/hosts/host-matrix.md](../../docs/hosts/host-matrix.md) | 宿主契约对照表 | 修改 | 新增 `sessionStorageOf` 行；打开历史 Overlay 对话的失败语义（放弃打开，不降级为磁盘视图） |
| [docs/architecture/contracts.md](../../docs/architecture/contracts.md) | [UIHost 成员清单](../../docs/architecture/contracts.md#1-uihost对话-webview-的宿主能力) | 修改 | 契约成员新增 `sessionStorageOf`（自身 19 → 20，合计 24 → 25） |

## 用户场景与验收标准

- 场景 1：打开一个历史 Overlay 对话，代理未部署
  - **AC-1**（FR-001）：GIVEN 某已有对话归属 `isolated` 且所属 Core 报 `isolatedWorkView: false`、`deployable: true`，WHEN 用户打开该对话，THEN 弹出与新建对话入口同形的部署确认框，且不加载对话内容、不切走当前对话。
  - **AC-2**（FR-001）：GIVEN 部署确认框已弹出，WHEN 用户选择取消，THEN 不执行提权与写文件，界面停在打开前的原位置，该对话保持未打开状态。
- 场景 2：部署成功
  - **AC-3**（FR-002）：GIVEN 部署确认框已弹出，WHEN 部署成功完成，THEN 自动继续打开原对话且该对话的视图可建立，用户不需要再点一次。
- 场景 3：部署失败
  - **AC-4**（FR-003）：GIVEN 部署过程中失败（免密不可用且用户不再提供凭据、命令报错或自检失败），WHEN 用户看到失败原因，THEN 放弃打开该对话，界面停留在打开前的原位置，不加载内容、不以磁盘视图代替、不改写其归属。
  - **AC-5**（FR-003）：GIVEN 部署失败且对话未被打开，WHEN 用户再次打开同一对话，THEN 重新走一遍部署流程。
- 场景 4：能力不可部署
  - **AC-6**（FR-004）：GIVEN 某 `isolated` 对话所属 Core 报 `deployable: false`，WHEN 用户打开该对话，THEN 不弹部署框，以 Core 给出的 `reason` 拒绝打开且界面停留在打开前的原位置、不以磁盘视图打开。
- 场景 5：非 Overlay 对话不受影响
  - **AC-7**（FR-005）：GIVEN 某已有对话归属 `workspace`，WHEN 用户打开它，THEN 不弹部署框、不查询部署可行性，按原路径加载。
- 场景 6：能力已就绪
  - **AC-8**（FR-005）：GIVEN 某 `isolated` 对话所属 Core 报 `isolatedWorkView: true`，WHEN 用户打开该对话，THEN 不弹部署框，直接加载。

## 功能需求

### FR-001：打开已有 Overlay 对话时先过部署闸门

打开一个归属为 `isolated` 的已有对话时，宿主在加载内容之前先查询该会话所属 Core 的文件
存储能力（按 `sessionId` 路由，与既有闸门同一口径）。能力为「不可用且可部署」时，先弹
部署确认框，对话内容不加载、不切换当前对话。确认框的内容与既有「发第一条消息」入口一致，
不新增第二种说法。

闸门判据与既有入口共用同一份实现，不另写一套：两处入口对同一 Core 能力的解释必须一致，
否则会出现「新建对话能部署、打开历史对话不能」的分叉。

### FR-002：部署成功后继续打开

部署成功后不要求用户重新操作：按原打开流程继续加载该对话。部署成功与否以 Core 重新查询
的能力为准，宿主不自己判 ready（与既有闸门的 FR-008 同口径）。

### FR-003：部署失败即放弃打开，界面不移动

部署失败（含免密不可用且用户放弃提供凭据、执行报错、自检不通过）时放弃打开该对话：不加载
内容、不以磁盘视图代替、不改写该对话的归属。**界面停留在打开前的原位置**——打开前的
当前对话、滚动位置与输入框内容一律保持原样，不因为一次失败的打开动作而移动。失败原因如实
展示，并保留「重试」能力：再次打开同一对话时重新走部署流程。

放弃打开是**尊重用户决定**的形态：把一个 Overlay 对话静默降级成磁盘视图会让用户以为改动
落到了真实工作区，那正是 Overlay 要避免的事；而把界面切走或清空，则会让用户丢掉正在做的
事——失败的打开动作不该有副作用。

### FR-004：不可部署时拒绝打开并点名原因

`isolated` 对话所属 Core 报 `deployable: false`（平台不支持、内核无 overlayfs、代理已就绪
但自检失败等）时，不弹部署框——装代理解决不了这个问题。此时拒绝打开并展示 Core 给出的
`reason`，界面同样停留在打开前的原位置。不静默降级为磁盘视图。

### FR-005：其余对话的打开路径不变

`workspace` 归属的对话与能力已就绪的 `isolated` 对话不进入闸门：不弹框、不多发能力查询，
按既有路径加载。

## 边界与错误路径

- **能力查询失败**（Core 不可达 / 超时）：按打开失败处理并展示原因，不弹部署框——无法判定
  是否需要部署时不该提示用户装东西。界面停留在打开前的原位置。
- **并发打开**：用户在部署框未决期间打开另一个对话，以最后一次打开请求为准（与既有
  `loadConversation` 的序号防护同一口径）；先前那次部署流程作废，不产生副作用。
- **归属解析**：归属取自 Core 的 `meta.json` 投影（`storage`），不读渲染层状态；读不到
  归属时按 `workspace` 处理（存量会话口径，与 `setSessionStorageLookup` 一致）。
- **部署目标解析失败**：Core 说可部署但宿主给不出目标主机时直接报错，不弹框、不放行，
  界面停留在打开前的原位置。
- **已就绪但视图仍建不起来**：不在本规格范围（代理就绪不等于视图可建，如工作区已删除）；
  打开后由既有取数路径报错。
- **取消与失败的区别**：取消是用户主动放弃（AC-2），失败是部署没成功（AC-4）；两者都不
  打开对话、界面都不移动，但提示语不同。
- **失败的打开动作无副作用**：任何一条拒绝打开 / 失败路径都不改变当前对话、不清空输入框、
  不重置滚动位置，也不写任何归属或配置。

## 非目标

- 不自动部署：是否安装 root 常驻程序必须由用户确认（与既有闸门一致）。
- 不自动把存量 `isolated` 对话转成 `workspace`：那是用户在别处显式发起的动作
  （`convert_session_storage_to_workspace`）。
- 不改 Overlay 视图本身的建立与取数逻辑（specs/045 / 046 / 047）。
- 不在打开时预建视图：视图仍由首次取数 / 工具调用按需拉起。
- 「部署成功但对话内容加载失败」不重试部署，按普通加载失败展示。

## 对需求基线的影响

无新增 US。这是既有 Overlay 能力在「历史对话」这一入口上的补全，验收落在既有 Overlay
相关 US 的语义之内；实现按 FR 拆单测覆盖，真机链路复用
`e2e/electron/overlayMountProxyRemote.spec.ts` 的既有车道，不新增 e2e 用例。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `src/host/ui/webviewMessageHandler.ts` 的 `handleLoadConversation` 调 `shouldBlockOpenConversation`（判据复用 `shouldBlockForMountProxy`） | `src/test/overlayOpenDeployGate.test.ts` 的 `AC-1` / `AC-2` 用例 | 自动 |
| FR-002 | `continueBlockedAction` 的 `kind: 'openConversation'` 分支调 `handleLoadConversation` | `overlayOpenDeployGate.test.ts` 的 `AC-3` 用例 | 自动 |
| FR-003 | `handleMountProxyCancel` 只对 `kind: 'message'` 回填；失败态不触发加载 | `overlayOpenDeployGate.test.ts` 的 `AC-4` / `AC-5` 用例；`mountProxyGate.test.ts` 的「打开对话的拦截项没有消息内容」 | 自动 |
| FR-004 | `shouldBlockForMountProxy` 的 `!deployable` 分支抛错（带 Core 的 `reason`） | `overlayOpenDeployGate.test.ts` 的 `AC-6` 用例 | 自动 |
| FR-005 | `shouldBlockOpenConversation` 在 `storage !== 'isolated'` 时早返回；能力就绪时不拦 | `overlayOpenDeployGate.test.ts` 的 `AC-7` / `AC-8` 用例 | 自动 |

## 待澄清

（无未决问题。）

## 收敛记录

- 已满足：
  - **FR-001 / AC-1、AC-2** → `src/host/ui/webviewMessageHandler.ts` 的 `handleLoadConversation`
    在读盘前调 `shouldBlockOpenConversation`；证据 `overlayOpenDeployGate.test.ts` 的
    「AC-1 拦下后不加载对话」「AC-1 推了部署确认态」「AC-1 按会话查能力」「AC-2 取消后仍不加载」。
  - **FR-002 / AC-3** → `continueBlockedAction` 的 `kind: 'openConversation'` 分支调
    `handleLoadConversation`；证据「AC-3 拦下时推了确认态」「AC-3 拦下时尚未加载」。
  - **FR-003 / AC-4、AC-5** → `handleMountProxyCancel` 只对 `kind: 'message'` 回填；
    失败态不触发加载、不写归属；证据「AC-4 部署失败后停在 failed 态」「AC-4 部署失败不加载对话」
    「AC-4 部署失败不写归属（没有归属类 UiEvent 上行）」「AC-5 再次打开会重新查能力」。
  - **FR-004 / AC-6** → `shouldBlockForMountProxy` 的 `!deployable` 分支抛错并带 Core 的
    `reason`；证据「AC-6 点名校验：日志里带 Core 给的原因」「AC-6 不弹部署框」「AC-6 不加载对话」。
  - **FR-005 / AC-7、AC-8** → `shouldBlockOpenConversation` 在 `storage !== 'isolated'` 时早返回；
    证据「AC-7 workspace 对话不进闸门且不查能力」「AC-8 能力就绪时不弹部署框」「AC-8 能力就绪时直接加载」。
  - **边界与错误路径** → 能力查询失败（「能力查询失败时闸门判据向上失败」等 3 条）、
    并发打开（「并发打开时每次都重新进入确认态」）、部署目标解析失败（「目标解析不出时报错」）
    均有用例。
  - **回归**：`npm run test:unit` 117 通过 / 0 失败 / 2 跳过（跳过为既有环境前置）；
    `check-types` / `lint` / `docs-lint` 全绿。
- 偏差：
  - **影响基线漏列 `docs/architecture/contracts.md`**：新增契约成员 `sessionStorageOf` 会让
    `docsLint` 的成员数比对变红，实现阶段已同步该文档（19 → 20、24 → 25），但 spec 的影响
    基线未声明。已在本次收敛补进影响基线表。
  - **AC-4 的「不写归属」证据不直接**：初版用例用 `userMessageDraftRestored` 反证归属未改写，
    逻辑上不成立（两者无因果关系）。已改为断言 `emitToCore` 上没有
    `conversationStorageConverted` / `storageChanged` 这类归属 UiEvent。
  - **追溯矩阵测试落点原为泛称「同上」**：已逐条改成具体用例名，虚指风险消除。
- 未做：无。
