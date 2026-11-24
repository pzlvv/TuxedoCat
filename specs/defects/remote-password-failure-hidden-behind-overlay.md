---
status: 已修
---

# 缺陷：口令浮层里的一次提交失败被写成「终止性失败」，原因被浮层盖住

「打开远程工作区」面板在口令浮层里提交口令后，如果这次认证被服务端拒绝，用户看不到任何
原因：浮层原样停在那里，失败原因被写进浮层**背后**的 `#connectError`，而那块区域被
`.overlay` 的遮罩整块盖住。用户的表现是「点了连接，什么也没发生，只能反复重试」。

## 现状

- 主进程把口令提交的失败一律当成终止性失败。`electron/main.ts` 的
  `remote-workspace:connect` 里，口令分支（`request.password !== null`）的建链失败由
  最外层的 `catch` 统一回成 `{ ok: false, reason: 'error', error }`：

  ```ts
  if (request.password !== null) {
    auth = { kind: 'sshPassword', password: request.password };
    listing = await tryConnect(base, auth);
  }
  ```

  最外层 `catch` 只回 `reason: 'error'`。而认证链分支（`request.password === null`）会按
  `runSshAuthChain` 的结论分叉，把「所有来源都认证不成立」翻成 `reason: 'needPassword'`。

- 页面按 `reason` 决定把原因写到哪里（`electron/remoteWorkspace/main.ts` 的
  `connectWithPassword`）：只有 `needPassword` 才写进浮层的 `#passwordError`，`error`
  写进表单的 `#connectError`。于是「口令被拒」这条本来该留在浮层里的原因，落到了一块
  看不见的地方。

- 与 as-built 规格不一致：`specs/053-ssh-key-first-connect/spec.md` 的 AC-08（口令被
  服务端拒绝时「走同一条浮层路径，浮层里呈现这次认证失败的原因，且不把失败当成网络错误
  停在表单上」）与 AC-10（提交了错误口令时「浮层保持打开、输入框选中内容便于重输、显示
  这次失败原因」）要求原因在浮层里；FR-009 只把不可达 / 超时 / 主机密钥变更归为「报在
  表单上」。现状把两类结论合并成了「终止性失败」。

- 浮层遮罩的层级就是判据本身（`electron/remoteWorkspace/styles.css` 的 `.overlay` 是
  `position: absolute; inset: 0` + 半透明遮罩）：只要浮层还开着，`#connectError` 的任何
  文字用户都看不见。因此**任何**在浮层开着时发生的失败都不能只写 `#connectError`。

- 口令正确之后是这样一条路：`tryConnect` 里包含 SSH 建链、远端产物部署与 daemon 启动，
  整条都可能要几十秒；这段时间浮层一直盖在前面，`#connectStatus` 的「正在连接远端并准备
  Core…」同样被遮罩盖住——用户在浮层里只看到自己刚敲的口令，没有任何进度。

- 复现（口令错 → 服务端拒绝）：打开「打开远程工作区」，填一个只能用口令登录、且本机没有
  默认私钥也没有 ssh-agent 身份的目标 → 点「连接」→ 浮层弹出 → 填错口令 → 点「连接」。
  浮层不关、口令框内容还在，屏幕上没有一行错误提示；`#connectError` 里躺着一句
  `SSH connection to … failed: All configured authentication methods failed`。

## 期望

- 口令被服务端拒绝时，失败原因出现在**口令浮层里**（`#passwordError`），浮层保持打开、
  输入内容保留并选中便于重输（AC-08 / AC-10）。判断依据是失败发生的位置：SSH 建链阶段的
  「认证不成立」才回浮层；凭证已被接受后的失败（部署 / 启动 / 列举目录）与不可达 / 超时 /
  主机密钥变更一样算终止性失败（FR-009）。
- 浮层开着时发生的终止性失败，原因显示在**看得见的地方**：收起浮层、把原因写进表单的
  `#connectError`（FR-009），不停在一个什么都没显示的同屏浮层里。
- 认证成功进入部署阶段时浮层不再遮挡进度：这一阶段的「正在连接远端并准备 Core…」与
  「连接中…」按钮状态在表单上可见（[docs/core/client-connection.md 第 4.2 节](../../docs/core/client-connection.md#42-远程打开流程electron)：连接这一步
  包含部署与启动，可能较慢，窗口在此期间显示进度提示）。
- 一次连接尝试进行中，「连接」这个确认动作呈现连接中状态（禁用 + 文案「连接中…」），
  落定后恢复。

## 不变量

- 浮层仍然是模态的：浮层期间接入表单字段不可编辑；Esc / 取消回到表单、不建链、不写历史、
  保留已填的主机 / 端口 / 用户（AC-7 / AC-11）。
- 页面任何时刻不持有连接历史里的口令（FR-006）：候选列表与浮层之间不传口令，输入框内容的
  生命周期不扩展到提交之外（成功与取消都清空）。
- 口令提交只试这一次口令，不退回私钥 / agent 重试（`src/host/sshConnectChain.ts` 的约定）。
- 认证失败不设次数上限、不显示「剩余尝试次数」（AC-10）。
- 远端建链失败的其他分类口径不变：`classifySshFailure` 的 `auth` / `fatal` 二分与
  认证链的「只有 auth 才兜底」语义不动。
- 只有口令认证成功才写连接历史的口令；私钥 / agent 成功不凭空造出带口令的条目（AC-13 /
  AC-14）。

## 回归测试

- **RT-1**：口令提交的失败按「发生在建链阶段且认证不成立」判回浮层、其余判终止性失败。
  断言建链阶段失败（`SshConnectError` 包住 `All configured authentication methods failed` /
  `Permission denied (publickey,password)`）判 `auth`；同一包装下的 `ECONNREFUSED` 判
  `fatal`；`SshHostKeyError`、部署阶段的 `permission denied`、非 Error 的值都判 `fatal`。
  （落点：`src/test/sshAuth.test.ts` 的「失败分类」用例组与
  `src/test/sshConnectChain.test.ts` 的「失败的归属」用例组）
- **RT-2**：浮层关着时发生的失败不该再被遮住。假宿主依次回 `needPassword` → `error`
  （部署阶段的失败，口令已被接受）：第一次点「连接」弹浮层，浮层里提交后浮层收起、
  `#connectError` 可见并含原因、`#connect` 恢复可点。（落点：
  `e2e/remoteWorkspace/connectAuth.spec.ts` 的「浮层提交后的终止性失败收起浮层、报在表单上
  （FR-009）」）
- **RT-3**：口令被拒时原因在浮层里，且输入内容保留并全选。
  （落点：`e2e/remoteWorkspace/connectAuth.spec.ts` 的「AC-10 口令被拒：原因在浮层里，
  输入保留且选中」）
- **RT-4**：一次口令提交在途时浮层收起（部署进度可见）且「连接」按钮呈现连接中状态，
  落定后恢复原文案。（落点：`e2e/remoteWorkspace/connectAuth.spec.ts` 的
  「浮层提交后进入连接中：浮层收起、按钮为连接中状态」）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npm run compile-tests` | 红 | RT-1 引用的分类入口与建链失败类型尚不存在：`src/test/sshConnectChain.test.ts(195,11): error TS2304: Cannot find name 'SshConnectionError'`（另有 6 处同因） |
| 回归用例（修复前） | `npm run build:remoteWorkspace && npm run test:e2e:remoteWorkspace` | 红 | 2 失败 / 14 通过。RT-2：`#passwordOverlay` 期望 hidden、实际 visible（浮层提交后的终止性失败停在同屏浮层里，原因写在遮罩背后）；RT-4：同一断言失败，部署期间浮层仍盖住 `#connectStatus` |
| 回归用例（修复后） | `npm run compile-tests && npm run test:unit -- ssh-connect-chain` | 绿 | 30 通过 / 0 失败：RT-1 六项断言全过（认证不成立 → `auth`、部署阶段的 permission denied 与主机密钥变更 → `fatal`、非 Error → `fatal`） |
| 回归用例（修复后） | `npm run build:remoteWorkspace && npm run test:e2e:remoteWorkspace` | 绿 | 16 通过 / 0 失败：RT-2 / RT-3 / RT-4 与既有 FR-001 / FR-002 / FR-004 / FR-009 用例同批通过 |
| 既有回归 | `npm run test:unit -- ssh` | 绿 | sshAuth / sshConnectChain / sshDaemonBootstrap / sshHistory / sshTransport 五个文件全过 |
| 既有回归（全量） | `npm run test:unit` | 绿 | 134 通过 / 0 失败 / 2 跳过（sidebarFiles、sidebarDocViewGit 因本机无符号链接权限走的 skip 分支） |
| 静态检查 | `npm run check-types && npm run lint` | 绿 | 三份 tsc 配置与 eslint 均无输出错误 |
| 文档守卫 | `npm run test:unit -- docs-lint` | 绿 | 缺陷规格五节、RT 编号、章节引用与验证记录取值合法 |
| 真实 SSH 远端 | — | not-run | 本机无可用 SSH 远端；页面级判定与口令浮层的交互由假宿主 e2e 覆盖，真实建链的失败报文由既有 `electron-ssh` 车道在 CI 覆盖 |
