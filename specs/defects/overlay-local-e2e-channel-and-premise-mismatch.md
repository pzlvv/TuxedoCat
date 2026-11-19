---
status: 已修
---

# 缺陷：overlay 本地 e2e 的通道判据与前提和实现不一致，四条用例常年红

`e2e/electron/overlayMountProxyLocal.spec.ts` 自 specs/051 落地起在 `all` 车道上从未绿过，
并连带 `assistant.spec.ts` 的 US-75 一起红。四条用例的红因各不相同：两条是用例本身与实际
实现不一致，一条是把端到端构造不出的状态当成了前提，一条对应的能力已在 specs/052 之后
整体作废。

影响面：`all` 的 `e2e-electron（整应用）` job 恒红，全量回归失去信号——真实回归会淹没在
这四条固定失败里（实测 2026-11-16 起连续多轮）。

## 现状

### 1. FR-001 的通道判据只认 `window.vscode`

`storageCapabilities()` 原本写死读 `window.vscode`：

```ts
const wire = (window as unknown as { vscode?: { postMessage: (m: unknown) => void } }).vscode;
if (!wire) throw new Error('webview 无 postMessage 通道');
```

Electron 宿主注入的是 `window.electronAPI`（`electron/preload.ts` 的
`contextBridge.exposeInMainWorld`），`window.vscode` 只在 VS Code 与浏览器 shim 下存在
（`src/webview/webviewEnv.ts` 的 `getHostMessageApi`）。同一文件里 FR-010 那段早已改成
`host.electronAPI ?? host.vscode`，共用的 helper 漏改，于是能力查询必然抛
`webview 无 postMessage 通道`。

### 2. FR-001 把「非 Linux」当成了前提

用例标题与断言写死「非 Linux 宿主 Core」：`deployable` 必须为 `false`。但 CI 的
`e2e-electron` 跑在 `ubuntu-latest`，Core 是 Linux 二进制——平台为 Linux 时
`deployable` 由内核是否支持 overlayfs 派生（`core-rs/src/mount_proxy/linux.rs` 的
`probe_capabilities`），runner 上通常为 `true`。断言与运行平台无关，Linux 上必然红。

### 3. FR-010 的端到端前提不成立

用例想验「能力不可用但消息带着 `isolated` 到达 Core → Core 拒绝落盘」。这个状态
端到端构造不出来：宿主的部署闸门（`shouldBlockForMountProxy`）在消息进 Core **之前**
就按能力把它拦下，Core 永远收不到这条消息。`specs/defects/fr-010-e2e-does-not-reach-fail-closed.md`
已就同一问题的远端车道定过分层口径（工具侧归 Core 单测、宿主拦截归端到端），本地这条
没跟着收敛。

### 4. FR-011 的界面动作从未实现，且该能力已被 specs/052 取代

用例等 `[data-conversation-storage-convert]`（「转为真实工作区」）。该选择器在 `src/`
里 0 处出现：specs/051 只落了 Core 半边的转换事件与落盘语义
（T016 / T047），webview 的动作与宿主翻译从未实现。

更进一步，这个出路在 specs/052 之后已无必要：打开 `isolated` 对话本身要过部署闸门，
能力不可用时该对话**根本打不开**——不存在「打开后只能看不能动」的形态，因此不需要
「把存量隔离对话转成真实工作区」。

### 5. US-75 踩中 specs/050 的 Esc 语义

`assistant.spec.ts` 的 US-75 在权限确认框打开时按 `Escape` 关右键菜单，随后去点「允许」。
specs/050 FR-004 给 webview 加了「Esc 作废这次选择」（`src/webview/App.tsx` 的全局
capture 监听 → `handleUserChoiceCancel`），这次 Esc 把权限框一起取消了，后续
`overlay.getByRole('button', { name: /允许/ })` 永远等不到，用例 180s 超时。

## 期望

1. **通道判据与 webview 同口径**：`electronAPI ?? vscode`，缺任一时报错文案点明两者。
2. **断言按运行平台分流**：非 Linux 断言 `deployable === false`；Linux 只断言派生关系自洽
   （`deployable === true` 时 `mountProxy === 'absent'`），不把内核能力写死成期望值。
3. **入口渲染判据与能力事实同源**：`#data-work-view-option` 的存在性等于
   `isolatedWorkView || deployable`。
4. **FR-010 本地改测宿主拦截**：消息不进 Core（模型零请求）、界面不出现模型回复；
   能力可部署时断言弹部署确认框。Core 侧的拒绝落盘由单测覆盖，不在端到端重复。
5. **删除 FR-011 用例与其全部契约面**：这条 UiEvent（归属转换）、
   Core 的转换函数、dispatch 分支、事件表行、specs/051 的
   FR-011 / AC-33 / 追溯矩阵行 / T016 / T047 一并移除。归属 `isolated` 的对话只在能力
   可用时打开，不存在转换出路。
6. **US-75 用点击别处关菜单**：权限框打开期间不按 Esc，避免与 specs/050 FR-004 冲突。

## 不变量

- specs/045 的归属一次性写定语义不变：`set_session_storage` 在已有消息落盘时仍忽略改动。
- specs/051 的能力事实仍是 Core 独占：`deployable` 的推导点只有
  `core-rs/src/mount_proxy/` 一处，宿主与用例都不重算。
- specs/052 的部署闸门行为不变：可部署时弹确认框、不可部署时以 Core 的 `reason` 拒绝。
- 事件词汇表的四组数量由 `src/test/docsLint.test.ts` 对照联合类型校验，不手写维护；
  删事件后数量声明与两张表同步更新。
- `meta.json` 仍由 Core 独占写入，用例只读。

## 回归测试

- **RT-1**：能力查询走 `electronAPI` 通道不再抛「webview 无 postMessage 通道」（落点：
  `e2e/electron/overlayMountProxyLocal.spec.ts` 的「FR-001 宿主平台 Core：能力应答与入口
  渲染判据同源」）。
- **RT-2**：同一用例在 Linux 上不断言 `deployable === false`，改为断言派生关系自洽与
  入口渲染判据同源（落点同上）。
- **RT-3**：能力不可用时宿主拦下 `isolated` 消息——模型零请求、界面无回复（落点：
  `e2e/electron/overlayMountProxyLocal.spec.ts` 的「FR-010 能力不可用时宿主拦下 isolated
  归属的消息，不建会话也不落盘」）。
- **RT-4**：`UiEvent` 联合类型里不再有归属转换成员，事件表与数量声明
  同步（落点：`src/test/docsLint.test.ts` 的事件载荷列与数量对照；Rust 侧
  `main_tests` 的 `dispatch_ui_event` 分支穷尽检查）。
- **RT-5**：US-75 在权限框打开时按 Esc 之外的手势关菜单，确认与取消两条路径仍绿（落点：
  `e2e/electron/assistant.spec.ts` 的「US-75 时间线「从这里继续」…」）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 复现（修复前） | `gh run view --job 135596181243 --log-failed` | 红 | `all` 的 `e2e-electron`：`webview 无 postMessage 通道`、等 `归属拒绝探针回复` 超时 90s、等 `[data-conversation-storage-convert]` 超时 60s、US-75 在「允许」处 180s 超时；114 过 / 4 挂 |
| 修复后（类型） | `npm run check-types` | 绿 | 三份 tsconfig 全过 |
| 修复后（lint） | `npm run lint` | 绿 | 0 error / 0 warning |
| 修复后（文档闸门） | `npm run test:unit -- docs-lint` | 绿 | 49 通过 / 0 失败；事件载荷列与数量对照均绿（事件总数 85 → 84、UiEvent 29 → 28） |
| 修复后（单测） | `npm run test:unit` | 绿 | 117 通过 / 0 失败 / 2 跳过（既有环境前置） |
| 修复后（Rust） | `npm run test:core` | 绿 | `core-rs` 与 `mount-proxy-rs` 两套全绿 |
| 修复后（格式） | `npm run fmt:rust:check` | 绿 | 四个 crate 均为 rustfmt 基线 |
| 整应用车道实跑 | `npm run test:e2e:electron -- overlayMountProxyLocal assistant` | not-run | 本机缺平台 Core 与 `dist` 产物前置；CI 的 `all` 车道为最终证据 |
