# 实施方案：远程接入先私钥后口令，密码按需询问

技术路线：把「用什么凭证」从表单搬进**认证链**（`src/host/sshAuth.ts` 产出候选来源、
`src/host/sshConnectChain.ts` 逐个尝试并分类失败），`WorkspaceAuth` 扩成口令 / 私钥身份
两种形态的判别联合；Electron 的 `remote-workspace:connect` 变成两段式 IPC（第一次跑链，
链耗尽时回 `needPassword`；第二次带上用户口令只跑口令那一段），页面把口令输入换成按需
弹出的模态浮层。需求见同目录 [spec.md](spec.md)，UI 形态已由 `exp/remote-connect-demo.html`
确认（demo 不入库）。

## 技术方案

### 1. 凭证形态：`WorkspaceAuth` 从单成员扩成判别联合

`src/host/workspaceRef.ts`：

```ts src=src/host/workspaceRef.ts
export type WorkspaceAuth =
  | { kind: 'sshPassword'; password: string }
  | { kind: 'sshKey'; keyPath: string | null };   // null = ssh-agent
```

命名为 `sshKey` 而不是 `sshPrivateKey`：这一项描述的是**身份**（一份私钥文件，或 agent
持有的那组身份），不是私钥正文。私钥正文与 passphrase 都不进这个对象（FR-007 / AC-22），
落盘与跨进程都只有「哪个文件 / 走 agent」。

### 2. 认证来源与认证链（两个新模块，均为 host 层纯逻辑）

`src/host/sshAuth.ts`——**只推导，不连接**：

| 导出 | 职责 |
| --- | --- |
| `SshAuthSource` | 建链要用的来源：`password` / `keyFile` / `agent` |
| `DEFAULT_PRIVATE_KEY_NAMES` | `id_ed25519` / `id_ecdsa` / `id_rsa` / `id_dsa`，顺序即尝试顺序 |
| `discoverDefaultPrivateKeys(sshDir)` | 按顺序挑出 `~/.ssh` 下真实存在的普通文件（读不到 = 该来源不可用） |
| `agentSocketAvailable(env)` | `SSH_AUTH_SOCK` 非空即可用（Windows 上是命名管道） |
| `sshAuthChain({ sshDir, env, savedPassword })` | **顺序的唯一一处定义**：私钥 → agent → 保存的口令 |
| `classifySshFailure(error)` | `'auth'`（推进链）/ `'fatal'`（直接报错） |
| `sshAuthIdentity(auth)` | 进连接目标键的公开描述 |

`classifySshFailure` 的判据（对应 AC-23 ～ AC-25）：

- `fatal`：`does not match the fingerprint`（主机密钥，`SshHostKeyError` 的原文）、
  `timed out` / `timeout` / `ECONNREFUSED` / `EHOSTUNREACH` / `ENETUNREACH` /
  `ECONNRESET` / `getaddrinfo` / `connection closed`。
- `auth`：`encrypted` / `passphrase` / `unable to parse` / `no key`（加密或损坏的私钥）、
  ssh2 的 `all configured authentication methods failed` / `permission denied`。
- 其余一律 `fatal`：兜底链只吃「认证不成立」这一种确定结论（铁律 4.1，不做乐观降级）。

`sshAuthIdentity` 的口径：口令 → `password:<sha256 前 16 位>`（沿用既有指纹口径）；
私钥文件 → `keyFile:<文件内容 sha256 前 16 位>`（换掉密钥文件即换身份），按
`(path, mtimeMs, size)` 做进程内缓存——`sshTargetKey` 在侧栏每次文件操作都会被调用，
反复读私钥文件不可接受；agent → 固定串 `agent`。

`src/host/sshConnectChain.ts`——**只编排，不连接**：

```ts src=src/host/sshConnectChain.ts
export type SshAuthOutcome<R> =
  | { ok: true; auth: WorkspaceAuth; result: R }
  | { ok: false; reason: 'needPassword'; cause: string }
  | { ok: false; reason: 'fatal'; cause: string };

export async function runSshAuthChain<R>(options: {
  sshDir: string;
  env: { SSH_AUTH_SOCK?: string | undefined };
  savedPassword: string | null;
  attempt: (source: SshAuthSource) => Promise<R>;
  log: (...args: unknown[]) => void;
}): Promise<SshAuthOutcome<R>>;
```

任一来源成功即 `return`；`fatal` 立刻中止；耗尽则 `needPassword` 并带回最后一次
`auth` 失败原因（浮层要显示它，AC-8）。每条的失败原因落诊断日志（AC-25）。
`attempt` 由调用方注入，于是顺序与分类**不需要真实 SSH 服务器就能单测**。

### 3. 建链器：`SshClient` 接受来源而不是口令

`src/host/standalone/sshClient.ts`：

- `SshTarget.password: string` → `SshTarget.auth: SshAuthSource`。
- `connect()` 里新增私有 `authOptions()`，把来源翻成 ssh2 的 connect 选项：
  `password` → `{ password }`；`agent` → `{ agent: process.env.SSH_AUTH_SOCK }`（缺失即抛
  `ssh-agent is not available`）；`keyFile` → 读文件、`utils.parseKey()` 预检后
  `{ privateKey }`。读不到 / 超过 256 KiB / 解析失败都**抛错**，交给认证链分类——跳过与否
  是链的判断，不是建链器的判断。
- 预检的作用：加密私钥在没有 passphrase 时以明确错误暴露成 `auth`，而不是等握手阶段报
  一句含糊的认证失败（FR-003）。
- 主机密钥校验、keepalive、超时、SFTP / shell / 转发全部不动。

### 4. 连接目标键：凭证身份参与

`src/host/sshTarget.ts`：新增 `authSourceFor(auth: WorkspaceAuth): SshAuthSource`；
`sshTargetKey` 的 `auth` 字段改为 `sshAuthIdentity(target.auth)`。语义保持「换凭证即换
目标」（FR-008 / AC-21）：同一目标换口令或换私钥各建各的连接，同一凭证仍然复用。
`sshTargetFor` 的守卫从「必须是 sshPassword」改为「必须有 auth 与登录用户」。

### 5. 接入请求：口令不是必填

`src/host/remoteConnect.ts`：

- `parseSshConnectionInput` 只校验 host / port / user，`SshInputError` 去掉 `'password'`。
- `RemoteConnectRequest.password: string | null`（`null` = 这次没有用户输入的口令）。
- `buildRemoteEndpoint` 返回 `{ ok: true, value, password }`，`value.auth` 恒为 `null`
  ——凭证由认证链在建链时决定。

### 6. 两段式连接（`electron/main.ts`）

`remote-workspace:connect` 的处理流程：

1. 校验表单 → 无凭证的 endpoint + `userPassword`。
2. 分两条路径：
   - `userPassword === null`（表单「连接」）→ `runSshAuthChain`，`savedPassword` 取连接历史
     里该 `user@host:port` 的口令，`attempt(source)` 用
     `endpointWithAuth(endpoint, authFromSource(source))` 调 `listRemoteDirectories`
     （真正建链 + 引导）。
   - `userPassword !== null`（口令浮层提交）→ **不跑链**，直接用
     `{ kind: 'password', password: userPassword }` 尝试一次：用户已经把口令给了，
     再退回私钥既无意义、又会把服务端的失败次数计到公钥上。失败即回
     `needPassword`（重试不设上限，AC-10）；主机密钥变更 / 不可达仍按 `fatal` 报错。
3. `ok` → 按 FRed 结果设置 `connected`，口令形态写连接历史（FR-005），切到选目录尺寸。
4. `needPassword` → 返回 `{ ok: false, reason: 'needPassword', error: cause }`，不动窗口尺寸。
5. `fatal` → 返回 `{ ok: false, reason: 'error', error: cause }`。

渲染进程据此分叉：`reason === 'needPassword'` 弹浮层，否则在表单上报红字。
IPC 结果类型放进 `electron/remoteWorkspace/types.ts`（判别联合，成员全必选）：

```ts src=electron/remoteWorkspace/types.ts
export type RemoteConnectResult =
  | { ok: true; listing: DirectoryListing; endpoint: { host: string; port: number; user: string | null } }
  | { ok: false; reason: 'needPassword'; error: string }
  | { ok: false; reason: 'error'; error: string };
```

### 7. 页面（`electron/remoteWorkspace/`）

- `index.html`：删掉密码字段；新增 `.overlay` 模态层（口令输入 + 原因 + 「连接 / 取消」）。
- `main.ts`：
  - `connect()` 组装请求（`password: null`），按结果分叉；`needPassword` 时
    `openPasswordOverlay(cause)`。
  - 浮层提交走**同一个** `connect()` 入口，只多带口令（AC-12）；Esc / 取消关闭浮层并
    保留表单内容（AC-11）；失败时浮层保持打开、回显原因、`select()` 便于重输、不设上限
    （AC-10）。
  - 浮层期间表单字段与「连接」按钮 `disabled`（AC-7）。
  - 候选选定只回填 host / port / user（AC-16），`api.sshHistoryEntry` 的调用删除。
- `labels.ts`：删 `sshPasswordLabel` / `sshPasswordPlaceholder`；新增浮层标题、原因前缀、
  口令标签、提交 / 取消、失败文案（结论化文案，不带次数）。
- `styles.css`：复用既有 token 增加 `.overlay` / `.dialog`；深浅色继续走
  `prefers-color-scheme`。

### 8. 其余 surface 按「有没有凭证」判定（FR-007）

| 位置 | 改法 |
| --- | --- |
| `electron/terminalShells.ts::canOpenRemoteTerminal` | `endpoint.auth != null` |
| `electron/terminalWindow.ts::openTerminalWindow` | 守卫同上，报错文案改「no credential」 |
| `src/host/WebViewUI.ts` 跨工作区传输 | `auth !== null`，`SshClient` 用 `authSourceFor(auth)` |
| `electron/sidebarFilesRemote.ts` | 无需改（走 `sshTargetFor`，已按新形态取值） |

### 9. 落盘与恢复

`src/host/workspaceState.ts::parseSerializedAuth` 增加 `sshKey` 形态：`keyPath` 字段必须
显式存在（`null` 合法、缺字段不当作 agent），非空字符串合法；私钥正文与 passphrase 不在
落盘结构里。恢复流程本身不改——`probeRemoteEndpoint` 用落盘凭证重新建链，私钥被删 /
agent 空都落进既有「远程不可连」形态（AC-20）。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `src/host/sshAuth.ts` | 新增 | 新增 `SshAuthSource`、`DEFAULT_PRIVATE_KEY_NAMES`、`discoverDefaultPrivateKeys`、`agentSocketAvailable`、`sshAuthChain`、`classifySshFailure`、`sshAuthIdentity` |
| `src/host/sshConnectChain.ts` | 新增 | 新增 `SshAuthOutcome`、`runSshAuthChain`、`authFromSource`、`endpointWithAuth` |
| `src/host/workspaceRef.ts` | 修改 | `WorkspaceAuth` 扩为 `sshPassword` \| `sshKey`（判别联合，成员全必选） |
| `src/host/sshTarget.ts` | 修改 | 新增 `authSourceFor`；`sshTargetKey` 的凭证身份改用 `sshAuthIdentity` |
| `src/host/standalone/sshClient.ts` | 修改 | `SshTarget.password` → `SshTarget.auth: SshAuthSource`；新增私有 `authOptions()` |
| `src/host/remoteConnect.ts` | 修改 | `SshInputError` 去 `'password'`；`RemoteConnectRequest.password: string \| null`；`buildRemoteEndpoint` 增返回 `password` |
| `src/host/workspaceState.ts` | 修改 | `parseSerializedAuth` 接受 `sshKey` |
| `src/host/WebViewUI.ts` | 修改 | 传输端点守卫改「凭证可用」+ `authSourceFor` |
| `electron/main.ts` | 修改 | `remote-workspace:connect` 两段式；`needPassword` 结果；历史只记口令成功 |
| `electron/remoteWorkspace/{index.html,main.ts,types.ts,labels.ts,styles.css}` | 修改 | 表单去口令字段；新增浮层；`RemoteConnectResult` 改判别联合；删 `sshHistoryEntry` |
| `electron/remoteWorkspacePreload.ts` | 修改 | 删 `sshHistoryEntry` 通道 |
| `electron/terminalShells.ts` / `electron/terminalWindow.ts` | 修改 | 可用性判定与建链守卫改「有没有凭证」 |
| `docs/`（见 spec 影响基线） | 修改 | 8 份规格 + US-36；新增 ADR-0019 |
| `core-rs/` | 不改 | 无 Core 侧改动（见宪章检查） |

## 宪章检查

- [x] **分层与依赖**（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：新增两个模块都在 `src/host/`，不 import
      `vscode` / `electron`、不做 `host.kind` 嗅探。`sshAuth.ts` 只用 `node:fs` /
      `node:crypto` / `node:path`。`sshClient.ts` 新增的 `process.env.SSH_AUTH_SOCK`
      读取是传输层自身事实（凭证的一部分），不构成宿主嗅探。页面侧只经 `preload`
      暴露的 `remoteWorkspaceAPI` 通信，页面不读环境、不碰私钥。
- [x] **架构铁律**（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：
      不过度 fallback——认证链只在 `classifySshFailure === 'auth'` 时推进，认不出的错误一律
      按终止性处理；缺私钥 / 缺 agent 是「来源不可用」而非静默降级，`sshTargetFor` 缺凭证
      仍直接抛错。
      契约成员全必选——`WorkspaceAuth` 两个成员都全必选（`keyPath` 为 `string | null`，
      不用 `?`）；`RemoteConnectResult` 三个成员全必选；`RemoteConnectRequest.password` 用
      `string | null` 而不是可选字段。
      一份事实一个写入点——认证顺序只在 `sshAuthChain` 定义；口令写入连接历史只在
      `remote-workspace:connect` 的成功分支；凭证身份键只在 `sshTargetKey` 派生。
      默认值单源——默认私钥名单只在 `DEFAULT_PRIVATE_KEY_NAMES`；端口默认值沿用既有单源。
- [x] **Core 行为与落盘格式同步义务**（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：不涉及——SSH 认证完全在宿主
      侧，`core-rs/` 与 `src/shared/history/` 均不改，Core 只见 `path`（
      [docs/core/client-connection.md 第 4 节](../../docs/core/client-connection.md#4-工作区引用)）。`workspace-state.json` 是宿主本地状态，
      不属于 core 侧落盘格式；其读写只有 `src/host/workspaceState.ts` 一处，测试在该文件的
      单测里锁定。
- [x] **文档同步义务**（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：与代码同一提交改 spec 影响基线里的 8 份规格
      + US-36，并新增 `docs/adr/0019-ssh-auth-chain.md` 记录「私钥优先、口令按需」的决策与
      被否决路线（见下一节）。`npm run test:unit -- docs-lint` 必须绿（本机无 node，见
      `tasks.md` 的未完成项）。

## 被否决的替代方案

1. **面板保留口令字段、仅把它改成可选**——否决：用户仍会被一个常驻密码框引导去输口令，
   与「先试私钥」的意图相反；且「有没有口令」与「用哪种凭证」两件事挤在同一个字段上，
   `WorkspaceAuth` 仍无法表达私钥身份。
2. **每次都先问口令，失败再试私钥**——否决：口令是唯一需要用户介入的来源，把它放前面等于
   每次连接都要人工介入，直接违背本次改动的出发点。
3. **在 `ssh2` 的 `authHandler` 里一次性注册全部认证方式，让库自己按序试**——否决：库的
   重试顺序不透明、失败后无法区分「这条来源不可用」与「整机不可达」，而 `classifySshFailure`
   的 `auth` / `fatal` 二分是「不要为拼错的主机名去输口令」这条语义的全部依据；显式的
   逐个来源尝试才能把顺序与分类都放进取证的落点。
4. **加密私钥时弹 passphrase 输入框**——否决（本次）：多一套输入状态机与「记住 passphrase」
   的安全边界，收益只覆盖「用户有加密私钥且没有 agent」的少数场景；登记进 `TODO.md`
   作为后续候选，本次按「跳过该来源」处理（FR-003）。
5. **面板里手选私钥文件**——否决（本次）：默认私钥 + agent 已覆盖绝大多数使用方式；手选
   私钥会把「文件选择器 + 路径校验 + 权限提示」一并带进接入面板，登记进 `TODO.md`。
6. **把私钥正文或 passphrase 落盘/缓存**——否决：落盘结构与跨进程载荷里只有身份描述
   （路径或 `agent`），私钥正文只在建链那一刻从磁盘读（AC-22）。这条不做成可选项。
7. **凭证身份键只取凭证种类（不含内容）**——否决：「换口令必须换连接」是既有语义
   （`sshTarget.ts` 的注释与 `bootstrapCore.ts` 的注册表口径），只取种类会让「第一次输错
   口令、改对后重试」复用旧连接。
