# 任务分解：远程接入先私钥后口令，密码按需询问

执行顺序：先把「凭证形态 + 认证来源 + 认证链」这三块纯逻辑落地并用单测锁定（T001 ～ T003），
再接建链器与身份键（T004 ～ T005），然后改接入请求与两段式 IPC（T006 ～ T007），最后改页面
浮层（T008）、其余 surface（T009）、落盘（T010）与文档（T011 ～ T012）。需求见
[spec.md](spec.md)，技术方案见 [plan.md](plan.md)。

每个 T 的完成判据都指向可验证的证据：单测文件名 / e2e 用例名 / lint 组 / 具体断言。

## 任务清单

- [x] **T001**（FR-007）：`WorkspaceAuth` 扩成判别联合（`sshPassword` \| `sshKey`，`keyPath: string | null`），`src/host/workspaceRef.ts` 的注释按 as-built 口径改写；依赖：—；完成判据：`npm run check-types` 通过，`src/test/workspaceState.test.ts` 的既有口令往返用例仍绿

- [x] **T002**（FR-002、FR-003）：新增 `src/host/sshAuth.ts`——`SshAuthSource`、`DEFAULT_PRIVATE_KEY_NAMES`、`discoverDefaultPrivateKeys`、`agentSocketAvailable`、`sshAuthChain`、`classifySshFailure`、`sshAuthIdentity`；依赖：T001；完成判据：新增 `src/test/sshAuth.test.ts` 全绿——顺序用例断言「私钥在前、agent 其次、保存口令最后」；`classifySshFailure` 对主机密钥 / 超时 / ECONNREFUSED 判 `fatal`、对加密私钥与 `all configured authentication methods failed` 判 `auth`、对未知错误判 `fatal`；`sshAuthIdentity` 对同一口令稳定、对不同口令不同、不包含明文

- [x] **T003**（FR-002、FR-009）：新增 `src/host/sshConnectChain.ts`——`SshAuthOutcome`、`runSshAuthChain`、`authFromSource`、`endpointWithAuth`；依赖：T002；完成判据：新增 `src/test/sshConnectChain.test.ts` 全绿——注入的 `attempt` 记录调用顺序；首条成功即停止尝试（后续来源零调用）；`auth` 失败推进到下一条；`fatal` 立即中止且后续来源零调用；全部耗尽回 `needPassword` 且带上最后一次失败原因；无任何来源时也回 `needPassword`

- [x] **T004**（FR-002、FR-003、FR-007）：`src/host/standalone/sshClient.ts` 的 `SshTarget.password` 换成 `auth: SshAuthSource`，新增私有 `authOptions()`（口令 / agent / 私钥文件，私钥预检：读不到、超 256 KiB、`utils.parseKey` 失败都抛错）；依赖：T002；完成判据：`npm run check-types` 通过，`src/test/sshTransport.test.ts` 与 `src/test/remoteCoreDaemon.test.ts` 全绿（后者用 `auth: { kind: 'password', … }` 构造）

- [x] **T005**（FR-007、FR-008）：`src/host/sshTarget.ts` 新增 `authSourceFor`，`sshTargetKey` 的凭证身份改用 `sshAuthIdentity`，`sshTargetFor` 的守卫改为「有 auth 且有登录用户」；依赖：T002、T004；完成判据：`src/test/sshAuth.test.ts` 里身份键用例断言「同口令同键、换口令换键、口令明文不出现在键里、私钥文件内容变化即换键」；`src/test/sshTransport.test.ts` 的引导去重用例仍绿

- [x] **T006**（FR-001、FR-006）：`src/host/remoteConnect.ts` 去掉口令校验（`SshInputError` 不含 `'password'`），`RemoteConnectRequest.password: string | null`，`buildRemoteEndpoint` 增返回 `password` 且 `auth` 恒为 `null`；依赖：T001；完成判据：`src/test/remoteConnect.test.ts` 改后全绿——缺口令的请求合法、分段合法、`password` 原样透传（含首尾空格）、空串归一为 `null`

- [x] **T007**（FR-002、FR-004、FR-005、FR-009）：`electron/main.ts` 的 `remote-workspace:connect` 改两段式——表单入口跑认证链、浮层入口只试口令；`needPassword` / `error` 判别结果；口令形态成功才写连接历史；`electron/remoteWorkspace/types.ts` 的 `RemoteConnectResult` 改判别联合并删 `sshHistoryEntry`；`electron/remoteWorkspacePreload.ts` 删对应通道；依赖：T003、T005、T006；完成判据：`npm run check-types` 通过；`electron/main.ts` 里不存在 `ssh-history-entry` 频道；`e2e/electron/remoteWorkspace.spec.ts` 的候选用例改为断言回填**不含**口令

- [x] **T008**（FR-001、FR-004、FR-006）：页面改造——`index.html` 删口令字段、加浮层；`main.ts` 分叉结果、浮层提交复用同一 `connect()`、Esc / 取消保留表单、失败保持打开并 `select()`、浮层期间表单 `disabled`、候选只回填三项；`labels.ts` / `styles.css` 同步；依赖：T007；完成判据：新增 `e2e/remoteWorkspace/connectAuth.spec.ts` 全绿——首屏 `input[type=password]` 计数为 0、`needPassword` 时浮层出现且表单禁用、错口令时浮层保持并回显原因、正确口令后进选目录、Esc 关闭浮层且表单内容保留、回车与点按钮等价

- [x] **T009**（FR-007）：其余 surface 改「有没有凭证」判定——`electron/terminalShells.ts::canOpenRemoteTerminal`、`electron/terminalWindow.ts` 的守卫、`src/host/WebViewUI.ts` 的传输端点（`SshClient` 改用 `authSourceFor`）；依赖：T004、T005；完成判据：`src/test/terminalShells.test.ts` 增「`sshKey` 凭证也可打开终端」断言并全绿；`npm run check-types` 通过

- [x] **T010**（FR-008）：`src/host/workspaceState.ts::parseSerializedAuth` 接受 `sshKey`（`keyPath` 必须显式存在，`null` 与空串区别对待）；依赖：T001；完成判据：`src/test/workspaceState.test.ts` 增三条断言——`sshKey` 带路径往返、`sshKey` 带 `null` 往返、缺 `keyPath` 字段整项丢弃

- [x] **T011**（FR-001 ～ FR-009）：文档同步——按 spec 的「影响基线」改 8 份规格（`docs/core/core-remote.md`、`docs/core/client-connection.md`、`docs/hosts/host-matrix.md`、`docs/hosts/electron-multi-workspace.md`、`docs/features/cross-workspace-transfer.md`、`docs/architecture/open-questions.md`）+ US-36，并新增 `docs/adr/0019-ssh-auth-chain.md`；依赖：T001 ～ T010；完成判据：`npm run test:unit -- docs-lint` 绿；改动章节里不再出现「仅口令 / 只有 sshPassword」的表述

- [ ] **T012**（FR-001 ～ FR-009）：收尾闸门——`npm run compile`、`npm run test:unit`、`npm run build:remoteWorkspace`、`npm run test:e2e:remoteWorkspace`；依赖：T011；完成判据：上述命令退出码 0。**未执行**：实现所在机器没有 `node` / `npm`（`command -v node` 无输出），四条命令一条都跑不了；已用脚本等价核对了 docsLint 的全部守卫组（链接与锚点、章节引用、ADR 编号与索引、文档体积、spec 结构、FR / AC / 矩阵），但**类型检查、单测、e2e 必须在有 node 的环境重跑**

## 实施记录（偏差与未执行项）

- **T002 的模块名与 spec 早期的 `sshIdentity` 不同**：最终实现是 `src/host/sshAuth.ts`（来源推导 +
  失败分类 + 身份描述）与 `src/host/sshConnectChain.ts`（编排），单测为 `sshAuth.test.ts` /
  `sshConnectChain.test.ts`；spec 的追溯矩阵已同步为这两个文件名。
- **口令浮层提交不走认证链**：用户已经给出答案时只试这一次口令，不再退回私钥 / agent——
  这写进了 plan 的技术方案第 6 节，spec 的 AC-9 / AC-10 语义不变（成功进选目录、失败留在浮层）。
- **`sshHistoryEntry` 通道整体删除**：页面不再有任何「按去重键取含口令整条」的能力，
  `electron/remoteWorkspace/types.ts` 的 re-export 也一并收窄到 `SshHistoryCandidate`。
- **未执行（本机无 node）**：`npm run compile` / `test:unit` / `build:remoteWorkspace` /
  `test:e2e:remoteWorkspace`。已在无 npm 条件下逐项脚本化核对：markdown 链接与锚点（209 篇
  `docs/` 规格，0 失效）、代码侧章节引用（0 处裸引用 / 0 处失效限定引用）、ADR 编号连续与
  索引齐全（19 篇）、文档体积（无一篇超 500 行）、spec 结构（9 个 FR、25 条 AC、矩阵 9 行、
  必填 9 节齐、无待澄清残留）、页面元素 id ↔ `getElementById` 一致、labels 中英键集一致。
