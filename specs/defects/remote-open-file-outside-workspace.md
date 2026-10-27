---
status: 已修
---

# 缺陷：远程会话点击工作区外文件的 Read / Edit 链接打不开文件

远程（SSH）工作区的会话里，Read / Edit / Bash 输出等工具卡片上的文件链接，只有路径落在
某个已打开远程工作区目录**内部**才能打开；会话读过的工作区**外部**文件（如 `/etc/hosts`、
`~/.bashrc`、未打开的兄弟目录），点击后按本地路径处理，本地盘读不到，Monaco 窗口内容为空，
文件打不开。这违反 FR 基线「Read 卡片路径可点击打开文件」
（[docs/features/user-stories/messages.md](../../docs/features/user-stories/messages.md) US-14 AC 3，
该条未限定工作区），也违反本缺陷口径下同样的 Edit / Bash 输出链接行为。远程接入只有
Electron 宿主提供（VS Code 宿主没有远程入口，见
[docs/hosts/host-matrix.md 第 7 节](../../docs/hosts/host-matrix.md#7-尚未收敛的分叉点)的已登记分叉），
故本缺陷只涉及 ElectronUIHost。

## 现状

复现路径（Electron 宿主）：

1. 「打开远程工作区」接入一台远程机器，选定目录 `/home/pz/proj`（会话工作目录）。
2. 会话里让助手 Read 一个工作区外的文件（如 `/etc/hosts`）。
3. 点击 Read 卡片上的路径链接。

实际结果：Monaco 查看窗口打开但内容为空（本地盘 `/etc/hosts` 不存在），远程文件没有打开。
工作区**内**文件（如 `/home/pz/proj/src/main.ts`）正常经 SFTP 读出进窗口。

证据链（只读代码定位）：

- webview 侧所有文件链接统一发 `openFile` 消息，`filePath` 是工具参数里的远端 POSIX 绝对路径
  （`src/webview/tools/ReadFile.tsx`、`EditFile.tsx`、`WriteFile.tsx`、`Bash.tsx`、
  `persistedOutput.tsx`、`MessagesView.tsx`）。
- 共享 handler 原样转交：`src/host/ui/webviewMessageHandler.ts` 的 `handleOpenFile` 调
  `this.host.openFile(filePath, selectedLines ?? null)`，**不携带来源视图**。
- `electron/ElectronUIHost.ts` 的 `openFile` 先走 `resolveRemoteFileWorkspace`：只把「`/` 开头
  且落在某个已打开远程工作区 root 内」的路径判为远程（活动项优先的 `/` 前缀匹配）；未命中即按
  本地路径进 `openMonacoWindow`（本地读盘）。工作区外路径必然未命中 → 本地分支 → ENOENT → 空窗口。

机器归属的事实来源其实存在：消息上下文 `ctx.sender` 标识来源视图（`WebviewRequestContext`），
UIHost 契约已有 `getWorkspaceRefForView(view)`（specs/023 FR-007 引入），ElectronUIHost 据此能拿到
该视图所属工作区的 `WorkspaceRef`（含远程 endpoint）。当前 `handleOpenFile` 没有把它传下去。

## 期望

- 点击链接时，文件归属机器 = **发送消息的会话视图**所属工作区那台机器：
  1. 路径落在某个已打开远程工作区 root 内 → 按现语义经打开集合解析（活动项优先）；
  2. 未命中且来源视图所属工作区是远程（`endpoint` 非空）且路径是 POSIX 绝对路径 →
     按该视图工作区的 endpoint 经 SFTP 打开，与命中 root 的远端路径同一套窗口与读失败兜底；
  3. 其余（`view` 为 `null`、本地工作区视图、非 `/` 开头路径）→ 维持本地语义。
- `view` 为 `null`（宿主主动调用，如 `electron/main.ts` 侧栏 `openLocalFile`、单视图宿主）时
  **不**给「活动工作区」兜底：无来源视图就无法判定机器归属，维持现状本地判定，避免把本地路径
  误判成远程。
- `UIHost.openFile` 契约签名补第三个必选参数 `view: WebviewViewHandle | null`（契约成员数不变，
  wire 消息 `openFile` 载荷不变，webview 不感知远程）；VS CodeUIHost 接受参数但不使用
  （其工作区引用 `endpoint` 恒为 `null`，打开逻辑本就不经工作区解析）。

## 不变量

- 已打开远程工作区 root 内的路径，仍按打开集合 `/` 前缀匹配解析（活动项优先）——现行为不变。
- 本地语义不变：Windows 路径（`C:\…` / `D:/…`）、相对路径、本地工作区视图下的绝对路径都走本地分支。
- 远端读失败仍开窗口显示原因（「点击有响应」，与本地 ENOENT 对齐）——不变。
- `openFile` 消息的 wire 载荷字段不变；webview 侧不做任何远程判定。
- VS Code 宿主行为不变（该宿主当前没有远程工作区入口）。
- 跨工作区子代理会话（卡片路径属于另一工作区机器且落在其已打开 root 外）不在本次范围：
  该场景修复前后都解析不到正确 endpoint，不因本次修复变得更差（修复前落本地 ENOENT，
  修复后经来源视图 endpoint 读、读不到显示原因窗口，均有可见反馈）。

## 回归测试

- **RT-1**：`handleOpenFile` 把 `ctx.sender` 作为 `openFile` 的第三参传给宿主——`createTestHost`
  以 rest 参数捕获 `openFile` 调用，`getWorkspaceRefForView` 对来源句柄返回远程引用，
  断言 `calls[0][2] === senderHandle`（落点：`src/test/openFileViewContext.test.ts`）。
- **RT-2**：路径解析纯函数——工作区外 POSIX 绝对路径 + 远程来源视图引用 → 解析到该视图的
  endpoint（而非 `null`）（落点：`src/test/remoteFileResolve.test.ts`，模块
  `src/host/remoteFileResolve.ts` 为本次修复新抽的纯函数）。
- **RT-3**：解析不变量——root 内路径仍按打开集合解析且活动项优先；Windows 路径 / 相对路径 /
  非字符串返回 `null`；`viewRef` 为本地（endpoint `null`）或 `undefined` 时 root 外路径返回
  `null`；路径落在已打开**本地** root 内但来源视图是远程时按远程解析（本地引用无 endpoint 被
  跳过）（落点：`src/test/remoteFileResolve.test.ts`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npm run test:unit -- open-file-view-context` | 红 | `FAIL openFile 第三参携带来源视图句柄` / `FAIL 无来源视图时第三参为 null`（3 通过 / 2 失败） |
| 回归用例（修复前） | `npm run test:unit -- remote-file-resolve` | 红 | 编译失败：`error TS2307: Cannot find module '../host/remoteFileResolve'`（被抽的纯函数尚不存在） |
| 回归用例（修复后） | `npm run test:unit -- open-file-view-context remote-file-resolve` | 绿 | handler 侧 5 项 + 解析纯函数 12 项断言全过 |
| 既有回归 | `npm run test:unit` | 部分验证 | 88 个文件 84 通过 / 1 跳过（`sidebarFiles` 缺本机 SSH 凭证，文档化常态）；其间 `brandLiteral` 失败是本次测试夹具路径撞品牌字面量扫描、`docsLint` 失败是本规格的裸引用与占位值——均已修，聚焦重跑绿（见下行）；`docsLintLocalOnlyPaths` 的 2 项失败为既有问题，与本缺陷无关（见下行） |
| 既有回归（聚焦重跑） | `npm run test:unit -- brand-literal open-file-view-context remote-file-resolve` | 绿 | 全过 |
| docsLint | `npm run test:unit -- docs-lint` | 部分验证 | `docsLint` 全组通过（含缺陷规格组）；`docsLintLocalOnlyPaths` 仍红 2 项——**既有问题，与本缺陷无关**：git 2.53.0.windows.1 的 `check-ignore` 对「不存在路径 + 尾斜杠」查询误报 exit 0（`-v` 显示空 pattern），击穿 `src/test/helpers/docPathExistence.ts` 的 `/` 回落判定，`isLocalOnlyPath` 对一切路径返回 true。本缺陷未触碰该 helper 与 `.gitignore`；需另立缺陷修复判定逻辑 |
| 既有回归（core 未涉及） | `npm run test:core` | not-run | 纯宿主侧改动，不触 core-rs |
| 类型 / lint | `npm run check-types && npm run lint` | 绿 | 主 / webview / electron 三份 tsconfig 与 eslint 均过 |
| 真机 SSH 复现路径 | 手动（Electron 接入真实远端，点工作区外 Read 链接） | skipped | 需要可连的外部机器；SFTP 读取与远端查看器窗口链路由既有 e2e electron 车道覆盖 |
