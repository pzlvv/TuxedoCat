---
status: 已修
---

# 缺陷：跨工作区占位页跳转链接恒不可用（发起方工作区已打开时也显示「未打开」）

> 追记（specs/025）：跨工作区占位父对话与占位页机制已整体删除（specs/025 FR-001）——
> 派发的对话本身是顶层普通会话、跨工作区跳转改按 `creator` 寻址，本缺陷描述的
> 占位页跳转链路不复存在。本文件保留为历史记录；文中被删除的实现落点以行内代码
> 记录的原始写法为准，现已不在仓库中。

发起方工作区与目标工作区同时打开，从目标工作区侧栏点击跨工作区子代理的占位父对话，
占位页恒显示「发起方工作区未打开，跳转链接不可用」且无跳转按钮——无论发起方工作区
是否打开。发起方身份解析永远匹配失败，AC-11（[docs/archive/specs/023-cross-workspace-agent/spec.md](../../docs/archive/specs/023-cross-workspace-agent/spec.md)，
FR-005）定义的「点击跳转链接 → 切到发起方工作区并打开发起方对话」从未可达；
同时占位页路径行退化为 `ph_<发起方会话 id>`（本应是发起方工作区展示路径）。

## 现状

复现（Electron 多工作区，截图为实际表现）：

1. 工作区 A、B 同时打开；在 A 的对话里以 `Agent` + `target`（B 的身份）派发子代理。
2. 切到 B：侧栏出现占位父对话（标题带「跨工作区容器」标记）。
3. 点击占位父对话：聊天区显示「跨工作区子代理容器」占位页，正文为
   「发起方工作区未打开，跳转链接不可用」，无「跳转到发起方对话」按钮；路径行显示
   `ph_<发起方会话 id>` 而非 A 的路径。此时 A 仍处于打开集合。

根因（只读定位，未改任何源码）：`electron/main.ts` 的 showCrossWorkspacePlaceholder
把占位来源的 `origin.workspaceId` 与 `refKey(candidate)` 判等：

```ts src=electron/main.ts
  let originRef = origin
    ? openWorkspaces.find((candidate) => refKey(candidate) === origin.workspaceId)
    : undefined;
```

而 `origin.workspaceId` 全链路是**代理身份**口径（FR-001，`workspaceAgentId` =
`<机器名>:<路径>`，如 `DEV-PC:C:\work\a`）：派发时由发起方宿主算出
（`src/host/WebViewUI.ts` 的 `remoteSubAgentStarted` 载荷 `originWorkspaceId`）→
core-rs 落进子代理 `meta.json` 的 `crossWorkspaceOrigin.workspaceId`（
`core-rs/src/history.rs`）→ 列表派生带出（`src/shared/history/Conversation.ts` 的
占位条目 `placeholder: origin`）→ 侧栏点击回传（`electron/sidebar/main.ts` 的
`openConversation(sessionId, project, entry?.placeholder)`）。

`refKey(candidate)` 是 `workspaceRefKey` 口径（如本地 `file//localC:\work\a`、远程
`ssh//pz@host:22/srv/app`）。两种口径**永不相等**，`find` 恒不命中 →
`originRef` 恒为 `undefined` → crossWorkspacePlaceholderJump 恒 `null` →
占位页恒渲染不可用提示、不给跳转按钮；`path` 行退化为 `sessionId`（与截图一致）。
又因 `origin` 存在时不走 `sessionWorkspaces` 回退分支（`if (!origin && originSessionId)`），
回退路径也救不回来。侧栏行恒携带 `placeholder` 元数据，缺陷对每次侧栏点击必现。

对照：同文件里 webview 返回按钮的跨工作区跳转（`openConversation` 分支）与 `Agent`
派发解析都按 `resolveWorkspaceByIdentity`（代理身份口径）解析，是正确写法；只有
占位页这一处用错了口径。

## 期望

占位页跳转按 FR-001 的代理身份解析发起方工作区（与 `openConversation` 跳转、
`Agent` 派发同一口径 `resolveWorkspaceByIdentity`）：

- 发起方工作区已打开（身份唯一命中）：占位页显示「跳转到发起方对话」按钮与发起方
  工作区展示路径；点击后活动标签切到发起方工作区并打开发起方对话（AC-11）。
- 发起方工作区未打开（身份未命中）：显示「发起方工作区未打开，跳转链接不可用」，
  不给按钮，不自动打开工作区（AC-13，现状在这一半是对的，保持）。
- 同一身份命中多项（同 host + 同路径、不同 SSH 用户 / 端口）：与 FR-001 一致
  不取第一项，按不可用处理。
- `origin` 元数据缺省时按发起方会话工作目录回退解析的既有行为保持。

## 不变量

- 占位来源 `workspaceId` 全链路只有 `workspaceAgentId` 一种口径；core-rs 的
  `meta.json` 落盘格式与 `crossWorkspaceOrigin` 结构不变。
- 跳转动作落点（jumpToCrossWorkspaceConversation 的入参 `workspaceId`）仍是
  `workspaceRefKey` 口径——宿主按它回查打开集合引用，跨进程 IPC 形态不变。
- `!origin` 时按发起方会话工作目录（`sessionWorkspaces` 索引 + 路径判等）回退的
  既有行为保持；本地路径按宿主口径判等、远程路径逐字比较（抹平尾分隔符）的口径
  不变。
- `openConversation`（webview 返回按钮）与 `Agent` 派发的身份解析不改。

## 回归测试

- **RT-1**：e2e 整应用链路——派发后切到目标工作区，点击占位父对话，占位页出现
  「跨工作区子代理容器」标题与 `#jumpBtn`，不出现「跳转链接不可用」，路径行显示
  发起方工作区路径（落点：`e2e/electron/crossWorkspaceAgent.spec.ts`
  「US-56 占位页跳转：发起方工作区已打开时显示跳转链接」）。
- **RT-2**：占位页发起方解析的纯函数口径（修复中从 `electron/main.ts` 提取到
  `src/host/workspaceIdentity.ts`，与 `resolveWorkspaceByIdentity` 同文件共用口径）：
  本地 / 远程身份唯一命中返回该引用；未命中与歧义返回 `null`；`origin` 缺省按
  路径回退命中 / 未命中（落点：`src/test/crossWorkspaceJumpOrigin.test.ts`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1 回归用例（修复前） | `npm run test:e2e:electron -- -g "占位页跳转"` | 红 | 「跨工作区子代理容器」标题可见（占位页确已渲染），断言 `#jumpBtn` 可见失败（元素不存在，e2e/electron/crossWorkspaceAgent.spec.ts 的 172 行）；「跳转链接不可用」的反断言未及执行 |
| RT-1 回归用例（修复后） | `npm run test:e2e:electron -- -g "US-56"` | 绿 | 跳转按钮 / 路径行 / 无不可用提示全部通过；既有 US-56 派发用例同跑同绿 |
| RT-2 回归用例（修复后） | `npm run test:all -- cross-workspace-jump-origin` | 绿 | 修复前该纯函数不存在（评估段不改源码），无可运行的旧形态，先红由 RT-1 承担 |
| 既有回归（单元全量） | `npm run test:all` | 绿 | sidebarFiles 按 runner 口径跳过（环境前置不满足），其余全过 |
| 既有回归（e2e electron 全量） | `npm run test:e2e:electron` | 部分验证 | 71 通过 / 1 失败；失败项是 e2e/electron/subagentConcurrency.spec.ts 的 US-49 并发上限用例，在未含修复的 HEAD 上同样失败（既有问题，与本缺陷无关），其余全过 |
| check-types / lint | `npm run check-types && npm run lint` | 绿 | — |
| Rust 测试 | `npm run test:core` | not-run | 未触及 core-rs（改动只在 electron 宿主与 src/host 纯函数） |
