---
status: 已修
---

# 缺陷：远程工作区路径的尾分隔符使同一目录裂成两个工作区与两个对话空间

远程目录选择器交给宿主的目录**恒带尾分隔符**（`electron/remoteWorkspace/pathInput.ts` 的
`ensureTrailingSeparator`，[docs/core/core-remote.md 第 2.6 节](../../docs/core/core-remote.md#26-远端目录选择)：路径框显示的目录始终以 `/`
结尾），daemon 回显的 `listing.path` 保留用户输入的原样
（`core-rs/src/remote.rs` 的 `list_directories` 用 `requested.to_string_lossy()`）。而
`remoteWorkspaceRef` 把这个字符串**原样**存进 `WorkspaceRef.path`，此后所有按路径派生的
身份都没抹平尾分隔符：

- `workspaceRefKey`（Connection 身份、标签页 / 侧栏项的稳定 id）逐字拼路径；
- `sameWorkspaceRef` 的远程分支逐字比较（本地分支走 `sameWorkspace`，本来就归一）；
- 反序列化（`parseWorkspaceEntry`）原样还原落盘值，旧状态文件里的尾斜杠恢复后照样带着。

于是同一个目录 `/srv/app/` 与 `/srv/app` 在打开集合里是**两个**工作区。这不是显示差异：
`Client.openWorkspace` 按 `workspaceRefKey` 建 Connection，两种写法各建一条；Core 的对话空间
目录按 `encodeURIComponent(path)` 派生（`core-rs/src/config.rs` 的
`project_conversation_dir`），`%2Fsrv%2Fapp%2F` 与 `%2Fsrv%2Fapp` 是两个目录——同一目录的
对话列表裂成两份，用户切到「另一张标签页」后看不到刚聊过的对话。

## 现状

- `src/host/workspaceRef.ts` 的 `remoteWorkspaceRef` 原样存放 `path`：

  ```ts src=src/host/workspaceRef.ts
  export function remoteWorkspaceRef(
    endpoint: WorkspaceEndpoint,
    path: string,
  ): WorkspaceRef {
    return { scheme: SSH_WORKSPACE_SCHEME, path, endpoint };
  }
  ```

- `workspaceRefKey` 的远程分支同样原样拼接：

  ```ts
  const path = ref.scheme === 'file' ? normalizeWorkspacePath(ref.path) : ref.path;
  return `${ref.scheme}//${target}${path}`;
  ```

- `sameWorkspaceRef` 的远程分支逐字比较：`a.path === b.path`；
- `src/host/workspaceState.ts` 的 `parseWorkspaceEntry` 原样还原 `refPath`。

  复现（Linux，仓库根，直接用编译产物调用同一组纯函数）：

  ```
  node -e "
  const { remoteWorkspaceRef, workspaceRefKey, sameRemotePath } = require('./out/src/host/workspaceRef.js');
  const ep = { host: 'h', port: 22, user: 'root', auth: { kind: 'sshPassword', password: 'p' } };
  const a = remoteWorkspaceRef(ep, '/srv/app/');
  const b = remoteWorkspaceRef(ep, '/srv/app');
  console.log('refKey equal:', workspaceRefKey(a) === workspaceRefKey(b));
  console.log('sameRemotePath:', sameRemotePath(a.path, b.path));
  console.log('dir a:', encodeURIComponent(a.path), '| dir b:', encodeURIComponent(b.path));
  }"
  ```

  实测输出：

  ```
  refKey equal: false
  sameRemotePath: true
  dir a: %2Fsrv%2Fapp%2F | dir b: %2Fsrv%2Fapp
  ```

  `sameRemotePath` 已经返回 `true`（它本来就抹平尾分隔符），但 `workspaceRefKey` 与
  `sameWorkspaceRef` 不走它——同一份路径在同一模块里有两种判等口径，这是分叉的根。
- 现有用例覆盖不到：`src/test/workspaceRef.test.ts` 只用不带尾分隔符的路径
  （`/home/dev/repo`、`/x`），`src/test/workspaceState.test.ts` 的往返用例同样。

## 期望

1. **构造即归一**：`remoteWorkspaceRef(endpoint, path)` 去掉尾分隔符后存放——
   `/srv/app/` 与 `/srv/app` 得到同一个 `WorkspaceRef`。根路径 `/` 保持 `/`（不能剥成空串，
   空串是「未打开工作目录」的占位语义）。
2. **一份归一，四处共用**：归一是纯函数 `normalizeRemoteWorkspacePath`，被构造
   （`remoteWorkspaceRef`）、反序列化（`parseWorkspaceEntry`）、身份键（`workspaceRefKey`
   的远程分支）与判等（`sameRemotePath` / `sameWorkspaceRef` 的远程分支）共用——不再有
   「一处归一、一处逐字」。
3. **落盘恢复同样归一**：旧 `workspace-state.json` 里带尾分隔符的远程项恢复后与新建项是
   同一个键，重启不会为同一目录再建一条 Connection。
4. **连续尾分隔符全部去掉**：`/srv/app///` → `/srv/app`。
5. **对话空间目录只有一个**：同一目录的 `encodeURIComponent(path)` 恒定。
6. **升级不丢活动项**：`workspace-state.json` 的 `activeWorkspaceKey` 是按旧口径写下的
   （远程键末尾多一个 `/`），恢复时必须仍能认回该工作区——否则升级后活动标签页静默
   回落到最后一项。兼容只放行「远程键 == 当前键 + `/`」这一种历史写法
   （`workspaceRefKeyMatches`），不做前缀匹配。

## 不变量

- 远程路径**不跑本地规范化**：`path.resolve('/home/pz/a')` 在 Windows 上会变成
  `D:\home\pz\a`，归一只处理 `/` 结尾，不改大小写、不解析符号链接、不合并中间的分隔符。
- 各机器的同名目录不被混淆：`(scheme, endpoint, path)` 三元组身份不变，同一路径在不同
  主机上仍是两个工作区。
- `(scheme, endpoint)` 决定 Connection 目标这一层不变（`workspaceEndpointKey` 不看路径）。
- 本地项不变：仍走 `normalizeWorkspacePath`（`path.resolve`）。
- 空引用（`emptyWorkspaceRef`，`path` 为空串）的键仍只取连接目标。
- 会话工作目录归属判定（`workspacePathMatches` / `sameRemotePath`）行为不变：本来就抹平
  尾分隔符。

## 回归测试

- **RT-1**：`remoteWorkspaceRef(endpoint, '/srv/app/')` 的 `path` 等于 `/srv/app`；它与
  `/srv/app` 的 `workspaceRefKey` 相同、`sameWorkspaceRef` 为真（修复前三条全红）。
- **RT-2**：`/` 保持 `/`。
- **RT-3**：落盘往返后 `/srv/app/` 恢复成 `/srv/app`，`/srv/app` 与 `/` 往返不变
  （修复前带尾斜杠的项原样回来）。
- **RT-4**：`/srv/app//`、`/srv/app///` 都得到 `/srv/app`。
- **RT-5**：同一目录的 `encodeURIComponent(roundTrip(path))` 等于
  `encodeURIComponent('/srv/app')`——对话空间目录只有一个。
- **RT-6**：既有语义不变——`sameRemotePath` 仍抹平尾分隔符、不同目录仍不等、
  `workspacePathMatches` 仍正确、`scheme` / `endpoint` 原样保留。
- **RT-7**：同一路径在不同主机上仍不判等、键不同。
- **RT-8**：旧口径的远程 `activeWorkspaceKey`（`ssh//root@host:22/srv/app/`）被
  `workspaceRefKeyMatches` 认回该工作区；当前形态的键照常命中（修复前逐字比较失配）。
- **RT-9**：兼容窗口只放行「末尾多一个 `/`」——不前缀匹配、不匹配别的目录，根路径的
  双斜杠键不命中。

落点：`src/test/remoteWorkspacePath.test.ts`（新增，直接调用 `workspaceRef.ts` 与
`workspaceState.ts` 的纯函数）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npm run test:unit -- remoteWorkspacePath` | 红 | 首条断言即失败：`构造时去掉尾分隔符` 实测 `'/srv/app/'`，期望 `'/srv/app'`；RT-1 的键与判等两条、RT-3 的落盘归一同批也会红 |
| 回归用例（修复后） | `npm run test:unit -- remoteWorkspacePath` | 绿 | 9 通过 / 0 失败（含 RT-8 / RT-9 的升级兼容两条） |
| 既有回归 | `npm run test:unit` | 绿 | 94 通过 / 0 失败（含 workspaceRef / workspaceState / clientConnection / crossWorkspace* 全系列） |
| Rust 回归 | `cargo test --manifest-path core-rs/Cargo.toml` | 绿 | 1050 passed / 0 failed + 1 passed / 0 failed；Core 无改动，路径编码口径未变 |
| 静态检查 | `npm run check-types`（含 webview / electron 三份配置） | 绿 | — |
| 静态检查 | `npm run lint` | 绿 | — |
| 文档守卫 | `npm run test:unit -- docs-lint` | 绿 | 缺陷规格五节与验证记录取值合法、章节引用有效 |
