# 实施方案：打开 Overlay 对话时的部署闸门

技术路线：把既有部署闸门从「只拦 `sendMessage`」泛化为「拦下一个**待续动作**」——被拦的不再
只是一条消息，也可以是「打开某对话」。闸门本身（状态机、确认框四要素、免密 → 凭据 → 手动
命令三条部署通道、成功后重查能力）完全复用，只在「成功 / 取消之后做什么」上按动作类型分派。
需求见 [spec.md](spec.md)。

## 技术方案

### 1. 闸门载荷从「消息」泛化为「待续动作」

`src/host/mountProxyGate.ts` 的 `BlockedMessage { sessionId, content }` 换成判别联合
`BlockedAction`：

```ts 示意
/** 部署成功后要继续做的事：发消息，或打开一个对话 */
export type BlockedAction =
  | { kind: 'message'; sessionId: string; content: string }
  | { kind: 'openConversation'; sessionId: string };
```

选择判别联合而不是「可选字段」：两种动作的后续语义不同（一个重发消息、一个继续加载对话），
用 `kind` 区分让分派点在编译期穷尽（AGENTS.md 铁律 4.2「互斥结果用判别联合」）。

闸门内部字段与 `block` / `takeBlocked` / `peekBlocked` 的名字保持不变，仅类型换成
`BlockedAction`——闸门是「持有一次待续动作」的状态机，不关心动作种类。

### 2. 判据抽成共用的单一实现

现有 `shouldBlockForMountProxy(sessionId, storage)` 已经回答了「这个会话要不要先部署」，
两处入口直接复用，不新增判断分支。差异只在调用点的前置条件：

| 入口 | 归属来源 | 触发时机 |
| --- | --- | --- |
| 发消息（既有） | `sendMessage` 消息自带的 `storage` | `handleUserMessage` |
| 打开对话（新增） | Core `meta.json` 投影（`sessionStorageLookup`） | `handleLoadConversation` 开头 |

打开入口在 `handleLoadConversation` 的**最前面**（`noteSessionActivity` 之后、读盘之前）
介入：此刻还没有加载任何内容，放弃打开天然不产生副作用，界面停在原位置（FR-003）。

### 3. 归属查询：复用已有投影，不新增请求

`ElectronUIHost` 已有 `setSessionStorageLookup`（本次修复引入，读
`src/shared/history/Conversation.ts` 的 `storage` 投影）。`WebviewMessageHandler` 经
`this.host` 取该会话归属：宿主契约新增只读查询方法，VS Code 宿主与 Electron 宿主各实现
一份（VS Code 侧没有 Overlay 能力，恒 `workspace`，因此永不进闸门）。

判断是否「Overlay 对话」用 `storage === 'isolated'`，与既有闸门口径一致。

### 4. 成功后按动作类型继续

`applyDeployOutcome`（`src/host/ui/webviewMessageHandler.ts`）与 `handleMountProxyManualCommand`
的轮询回调里，当前都硬编码「重发 `sendMessage`」。抽成一个私有方法
`continueBlockedAction(action)`：

- `kind: 'message'` → 调 `handleUserMessage`（与现状完全一致，行为不变）；
- `kind: 'openConversation'` → 调 `handleLoadConversation`（不带跳过闸门的参数，
  重新查能力必然已就绪，闸门自然放行）。

只在一处写「成功后继续」，两条部署通道（免密 / 凭据 / 手动命令轮询）共用，避免两处各自
实现导致行为分叉。

### 5. 失败与取消：都不动界面

- **失败**（`gate.fail`）：界面已停在原位置（从未发起加载），无需回滚。既有对话框保持
  `failed` 态展示原因，用户可重试或取消。
- **取消**（`handleMountProxyCancel`）：既有的
  `userMessageDraftRestored` 回填是给「消息被拦」用的——打开对话没有内容可回填。因此回填
  只在 `kind === 'message'` 时发送；`kind === 'openConversation'` 只清闸门状态。
- 任何路径都不写归属、不改当前对话、不清输入框（FR-003 的「无副作用」）。

### 6. 数据流

```text
handleLoadConversation(sessionId)
  ├─ storage = host.sessionStorageOf(sessionId)        // meta.json 投影，缺失→workspace
  ├─ blocked = await shouldBlockForMountProxy(sessionId, storage)
  │    ├─ false（workspace / 已就绪）→ 原路径加载
  │    └─ true           → resolveMountProxyTarget → gate.block({kind:'openConversation'})
  │                          └─ 推 mountProxyDeployState（phase=confirm）给 webview
  │                               ├─ 取消 → gate.cancel()，界面不动
  │                               ├─ 部署失败 → gate.fail(reason)，界面不动
  │                               └─ 部署成功 → 重查能力 → gate.succeed()
  │                                              └─ continueBlockedAction → handleLoadConversation
  └─ deployable=false → 抛错带 reason（不弹框、不降级）
```

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `src/host/mountProxyGate.ts` | 修改：`BlockedMessage` → `BlockedAction` 判别联合 | 无 wire 变化（闸门是宿主内部状态机） |
| `src/host/ui/webviewMessageHandler.ts` | 修改：拦截点泛化、`continueBlockedAction` 抽取、`handleLoadConversation` 前置闸门 | 无 |
| `src/host/UIHost.ts` | 修改：新增只读方法 `sessionStorageOf(sessionId)` | **契约成员新增**（镜像 `setSessionStorageLookup` 的查询侧） |
| `src/VSCodeUIHost.ts` | 修改：实现 `sessionStorageOf` 恒回 `'workspace'` | 无 |
| `electron/ElectronUIHost.ts` | 修改：实现 `sessionStorageOf`（投影 `sessionStorages`） | 无 |
| `electron/main.ts` | 修改：把已注入的 `sessionStorages` 接到新方法 | 无 |
| `src/test/mountProxyGate.test.ts` | 修改：断言换成新载荷形态 | 无 |
| `src/test/`（新增用例） | 新增：打开对话入口的闸门用例（放既有 `sshDaemonBootstrap` 之外的单测文件，覆盖 AC-1..AC-8） | 无 |
| `docs/core/conversation-work-view.md` | 修改：第 1 节部署入口补第二处 | 无 |
| `docs/core/mount-proxy.md` | 修改：第 2 节部署触发时机 + 失败语义 | 无 |
| `docs/hosts/host-matrix.md` | 修改：打开历史 Overlay 对话的失败语义 | 无 |

`UIHost` 新增成员会被 `docsLint` 的「契约成员数 / 名单」与「可选成员冻结」两组比对，因此
文档的数字与成员名必须同提交更新。

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：改动全在 `src/host/` 与宿主实现；`src/host/ui/*`
      只经 `UIHost` 注入，不 import `electron` / `vscode`；不做 `host.kind` 嗅探。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：不引入 fallback（不可部署时抛错而非降级磁盘视图）；
      成员全必选（`BlockedAction` 用判别联合，不用 `?`）；归属事实仍由 Core 单一拥有，
      宿主只读投影；默认值（缺失即 `workspace`）只在 `setSessionStorageLookup` 一处。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：**不涉及 Core 行为**。本改动只
      新增宿主侧闸门入口，不新增 `UiEvent` / `UiRequest` / 落盘字段；Core 继续按既有
      `storageCapabilitiesRequested` 回答能力。两套 Core（standalone / 远端）共用同一应答，
      无需 parity 改动。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：三份 as-built 规格随同一提交更新（见上表），
      `npm run test:unit -- docs-lint` 需绿。

## 被否决的替代方案

1. **在 `handleLoadConversation` 里自己查能力、自己弹框**（不复用闸门）。
   否决：会产生第二套部署状态机与第二套确认框文案，两处对同一能力的解释必然分叉——
   正是 spec FR-001 明确禁止的形态。

2. **打开失败后自动把归属转成 `workspace`，用磁盘视图打开**。
   否决：静默降级会让用户以为改动落在真实工作区（Overlay 要避免的核心问题）；
   且归属转换是用户的显式决定（`convert_session_storage_to_workspace`）。

3. **在打开前预建视图，用「建不起来」作为部署触发信号**。
   否决：把「是否部署」的判据从 Core 的能力事实变成一次副作用尝试，失败原因不可枚举
   （工作区被删、权限、内核限制混在一起），无法给出准确提示；也违反「core 描述事实、
   UI 决定表现」。

4. **把 `BlockedAction` 做成可选字段（`content?: string`）**。
   否决：`content` 与「打开对话」互斥，可选字段允许两者同时存在，分派点无法穷尽
   （AGENTS.md 铁律 4.2）。

5. **部署失败时把界面切回对话列表**。
   否决：用户已确认放弃打开时界面停在原位置——失败的打开动作不该有副作用
   （spec FR-003）。
