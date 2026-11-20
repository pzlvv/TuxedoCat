---
status: 实施中
---

# 改动规格：远程接入先私钥后口令，密码按需询问

「打开远程工作区」面板当前把登录密码当成必填项：打开面板就是一个带密码输入框的表单，
用户必须先知道并输入口令才能点「连接」。本改动把认证收敛成「先试不需要用户输入的
方式」：面板只保留主机 / 端口 / 登录用户三项，点「连接」后先按本机默认私钥与 ssh-agent
尝试登录，成功即直接进入远端目录选择；私钥不可用时再尝试该目标已保存的口令；两者都不
成立（无保存口令或口令错误）才弹出密码输入框，用户输入成功后才把口令按
`user@host:port` 记进连接历史。

私钥 / agent 认证成功后建立的远程工作区与口令认证的完全同构：终端、跨工作区传输、侧栏
文件浏览、关闭后的重启恢复都以同一凭证解析路径工作，不出现「能打开却没有终端 / 不能
传文件」的半残形态。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/core/core-remote.md](../../docs/core/core-remote.md) | [第 2.8 节 SSH 接入](../../docs/core/core-remote.md#28-ssh-接入ssh-scheme) | 修改 | 「口令鉴权」改为「私钥 / agent 优先、口令兜底」；补认证方式的尝试顺序与失败分类 |
| [docs/core/core-remote.md](../../docs/core/core-remote.md) | [第 1 节 能力](../../docs/core/core-remote.md#1-能力) | 修改 | 「用户只填 SSH 连接信息」一条补上「口令按需询问，不是表单必填」 |
| [docs/core/client-connection.md](../../docs/core/client-connection.md) | [第 4 节 工作区引用](../../docs/core/client-connection.md#4-工作区引用) | 修改 | `WorkspaceAuth` 从唯一的口令形态扩成判别联合（口令 / 私钥身份），成员全必选 |
| [docs/core/client-connection.md](../../docs/core/client-connection.md) | [第 4.2 节 远程打开流程（Electron）](../../docs/core/client-connection.md#42-远程打开流程electron) | 修改 | 打开流程改为「表单三项 → 认证链 → 按需密码浮层」；连接历史的回填口径改为不含口令 |
| [docs/core/client-connection.md](../../docs/core/client-connection.md) | [第 9 节 落盘与恢复（宿主侧）](../../docs/core/client-connection.md#9-落盘与恢复宿主侧) | 修改 | 落盘凭证新增私钥身份形态；恢复远程项按落盘凭证重新认证的语义对两种形态一致 |
| [docs/core/client-connection.md](../../docs/core/client-connection.md) | [第 10 节 不覆盖范围](../../docs/core/client-connection.md#10-不覆盖范围) | 修改 | 删掉「SSH 的密钥 / agent 认证」一条（它成了本次范围），保留其未纳入的旁支 |
| [docs/hosts/host-matrix.md](../../docs/hosts/host-matrix.md) | [第 6 节 宿主固有差异](../../docs/hosts/host-matrix.md#6-宿主固有差异有意保留) | 修改 | 「打开远程工作区」一行补按需密码浮层；持久化一行补私钥身份凭证 |
| [docs/hosts/electron-multi-workspace.md](../../docs/hosts/electron-multi-workspace.md) | [第 14.5 节 连接复用与鉴权](../../docs/hosts/electron-multi-workspace.md#145-连接复用与鉴权) | 修改 | 终端连接池的凭证口径改为「同一 endpoint + 同一凭证身份」，认证方式不写死为口令 |
| [docs/features/cross-workspace-transfer.md](../../docs/features/cross-workspace-transfer.md) | [第 4 节 边界与错误路径](../../docs/features/cross-workspace-transfer.md#4-边界与错误路径) | 修改 | 「非口令凭证即拒绝」改为「凭证不可用即拒绝」——两种凭证形态都可用 |
| [docs/features/user-stories/desktop.md](../../docs/features/user-stories/desktop.md) | [US-36 打开远程工作区](../../docs/features/user-stories/desktop.md#us-36-打开远程工作区) | 修改 | 验收标准 1 与 4 改写：密码不在表单里、候选不回填口令、口令按需询问 |
| [docs/architecture/open-questions.md](../../docs/architecture/open-questions.md) | [第 1 节 Core（Rust）](../../docs/architecture/open-questions.md#1-corerust) | 修改 | 「SSH 认证」一行的现状改为私钥 / agent + 口令，待定只剩密钥与 agent 的旁支 |
| [docs/adr/0019-ssh-auth-chain.md](../../docs/adr/0019-ssh-auth-chain.md) | — | 新增 | 认证链的顺序、失败二分与凭证形态的决策记录（含被否决路线） |

## 用户场景与验收标准

- 场景 1：面板初始形态
  - **AC-1**（FR-001）：GIVEN 打开「打开远程工作区」面板 WHEN 面板首屏渲染完成 THEN 可见字段只有主机、端口、登录用户三项，页面上不存在任何口令输入元素（`input[type=password]` 数量为 0）
  - **AC-2**（FR-001）：GIVEN 面板首屏 WHEN 用户填入主机 / 端口 / 用户名并点「连接」 THEN 无需先填口令即开始认证，不出现「口令不能为空」这类校验错误
- 场景 2：私钥优先
  - **AC-3**（FR-002）：GIVEN 目标的认证方式允许公钥且本机存在可用的默认私钥 WHEN 用户点「连接」 THEN 用该私钥完成 SSH 认证后直接进入远端目录选择，全程不出现口令输入元素
  - **AC-4**（FR-002）：GIVEN ssh-agent 里已加载可用身份且默认私钥文件都不存在 WHEN 用户点「连接」 THEN 经 agent 完成认证并进入远端目录选择
  - **AC-5**（FR-003）：GIVEN 默认私钥里有一条带 passphrase 的加密私钥 WHEN 走认证链 THEN 跳过该私钥，不弹 passphrase 输入，继续尝试下一条私钥 / agent / 保存的口令
  - **AC-6**（FR-002）：GIVEN 私钥与 agent 均不可用、但该 `user@host:port` 有保存的口令且口令正确 WHEN 用户点「连接」 THEN 直接用保存的口令登录成功，不出现口令输入元素
- 场景 3：按需询问口令
  - **AC-7**（FR-004）：GIVEN 私钥 / agent 不可用且该目标没有保存的口令 WHEN 用户点「连接」 THEN 面板上弹出独立的口令浮层，焦点已在口令输入框，主机的表单字段在浮层期间不可编辑
  - **AC-8**（FR-004）：GIVEN 存在保存的口令但服务端拒绝（口令已失效） WHEN 用户点「连接」 THEN 走同一条浮层路径，浮层里呈现这次认证失败的原因，且不把失败当成网络错误停在表单上
  - **AC-9**（FR-004）：GIVEN 口令浮层已弹出 WHEN 用户提交口令并认证成功 THEN 浮层关闭、进入远端目录选择
  - **AC-10**（FR-004）：GIVEN 口令浮层已弹出 WHEN 用户提交了错误口令 THEN 浮层保持打开、输入框选中内容便于重输、显示这次失败原因；认证失败不设次数上限、不显示「剩余尝试次数」
  - **AC-11**（FR-004）：GIVEN 口令浮层已弹出 WHEN 用户按 Esc 或点「取消」 THEN 浮层关闭、回到接入表单，不建立任何连接、不写连接历史
  - **AC-12**（FR-004）：GIVEN 口令浮层里已输入口令 WHEN 用户在输入框按回车 THEN 与点浮层里的「连接」同一条提交路径，不存在两个分支
- 场景 4：口令的保存与复用
  - **AC-13**（FR-005）：GIVEN 用户经口令浮层登录成功 WHEN 连接建立 THEN 该 `user@host:port` 的口令立刻按现有连接历史的去重键写入宿主本地状态（明文落盘，最多 20 条、最近在前），与是否选完目录无关
  - **AC-14**（FR-005）：GIVEN 用户经私钥或 agent 登录成功 WHEN 连接建立 THEN 连接历史里该目标的条目不被写入或改动任何口令字段（不凭空造出一条带口令的记录）
  - **AC-15**（FR-005）：GIVEN 口令浮层里的一次提交失败 WHEN 随后关掉面板 THEN 失败的口令不落盘，历史里该目标的旧口令保持原值
  - **AC-16**（FR-006）：GIVEN 主机输入框聚焦、有连接历史 WHEN 用户点选一条候选 THEN 只回填主机 / 端口 / 用户三项，表单里不出现口令，口令仍走自动复用逻辑
- 场景 5：认证之后的形态一致
  - **AC-17**（FR-007）：GIVEN 远程工作区是私钥或 agent 认证建立的 WHEN 用户对该标签页打开终端 THEN 终端正常建链；该入口的可用性判定与口令认证的工作区一致（有凭证即可用），只因「凭证缺失」置灰
  - **AC-18**（FR-007）：GIVEN 私钥认证的远程工作区与本地工作区同时打开 WHEN 用户发起跨工作区传输且一端是该远程工作区 THEN 传输按现有语义执行（SFTP），不出现「凭证种类不支持」错误
  - **AC-19**（FR-007）：GIVEN 私钥认证的远程工作区与口令认证的远程工作区同时打开 WHEN 侧栏对两者各浏览一次远端目录 THEN 各自经自己的凭证建链成功，连接池不把两者当成同一目标复用
  - **AC-20**（FR-008）：GIVEN 私钥认证的远程工作区 WHEN 宿主重启 THEN 打开集合里的该项恢复为可用（私钥 / agent 身份仍可非交互认证成立），不需要用户重新输入任何东西；私钥 / agent 不再可用时该标签页标记为不可用并给出重新连接入口
  - **AC-21**（FR-008）：GIVEN 同一 `user@host:port` 的同一目录已以口令认证打开 WHEN 用户以私钥认证再次打开它 THEN 工作区身份不变（仍按 `(scheme, endpoint, path)` 判等、激活已有标签页），SSH 连接目标键因凭证身份不同而不同，不复用旧连接
  - **AC-22**（FR-007）：GIVEN 私钥认证的远程工作区已落盘 WHEN 读取 `workspace-state.json` 与连接历史 THEN 两者都不含私钥正文与 passphrase，凭证只以身份描述出现
- 场景 6：失败分类
  - **AC-23**（FR-009）：GIVEN 目标主机的 SSH 端口不可达或建链超时 WHEN 用户点「连接」 THEN 直接按现有口径报错停在表单，不弹口令浮层
  - **AC-24**（FR-009）：GIVEN 主机密钥与 `known-hosts.json` 记录不一致 WHEN 用户点「连接」 THEN 按现有口径报主机密钥变更错误，私钥 / 口令的兜底链不吞掉这个结论
  - **AC-25**（FR-009）：GIVEN 私钥尝试被服务端拒绝（该公钥未被授权） WHEN 认证链继续 THEN 这次拒绝不作为错误呈现给用户，兜底到保存口令 / 口令浮层

## 功能需求

### FR-001：接入面板不再把口令当必填

- 首屏只有主机、端口、登录用户三项；口令输入是「按需出现」的独立形态，不是常驻字段。
- 表单校验只看主机 / 端口 / 用户名；口令的有无从「认证链」决定，不由表单决定。
- 面板尺寸与布局不因隐藏口令字段而改变交互路径：回车在任一表单字段里仍等价于点「连接」。

### FR-002：认证链的顺序是「私钥 / agent → 保存的口令 → 询问口令」

- 一次「连接」的认证尝试顺序唯一且确定：先私钥身份，再已保存的口令，最后询问用户。
- 私钥身份的来源固定为两种：本机 `~/.ssh` 下的默认私钥（按固定顺序逐条尝试），以及
  ssh-agent（`SSH_AUTH_SOCK` 可用时）。
- 任一方式成功即停止尝试，用这次成功的凭证建链并进入远端目录选择。
- 「保存的口令」按连接历史的去重键 `user@host:port`（host 不分大小写）查，命中即用；
  未命中即视为没有。
- 私钥 / agent 的成功不依赖用户先选过任何候选、也不依赖表单里残留的旧口令。

### FR-003：加密私钥与 agent 的失败是「跳过」而不是「报错」

- 需要 passphrase 的加密私钥在本次认证里视为不可用：不询问 passphrase，不中断认证链，
  继续尝试下一条来源。
- ssh-agent 不可用（无 `SSH_AUTH_SOCK`）、无可加载身份、或对某条身份认证被拒，都同样只
  推进认证链。
- 认证链只在**所有来源都无法推进**时进入下一阶段（保存的口令 / 询问口令）。

### FR-004：口令浮层

- 只有认证链走到「没有可用的保存口令，或保存的口令被服务端拒绝」时才弹出；浮层是模态的：
  浮层期间接入表单字段不可编辑，浮层关闭后回到原表单内容。
- 浮层只含口令输入（遮蔽显示）与「连接 / 取消」两个动作，并显示本次需要口令的原因。
- 提交口令走与「连接」按钮同一个入口：输入框回车与点「连接」是同一条路径。
- 提交失败时浮层保持打开、回显失败原因、输入内容可继续编辑；不设重试上限，不显示剩余
  尝试次数（服务端是否限次由服务端决定，宿主不自造计数）。
- 取消（按钮或 Esc）回到表单，不建立连接、不写历史、不清除表单里已填的主机 / 端口 / 用户。

### FR-005：口令按「连接成功」写进连接历史

- 只有经口令认证成功的连接才写口令：写入时机是连接建立成功的那一刻，与是否选完目录无关。
- 去重键、排序、上限、明文落盘沿用现有连接历史的规则（`recentSshConnections`）。
- 私钥 / agent 认证成功不写口令字段：历史里没有该目标的条目就不新增，有的话该条目的
  口令保持原值。
- 认证失败的那次输入不落盘。

### FR-006：连接历史候选只回填非口令字段

- 候选仍然是 host / 端口 / 用户三项的展示与筛选载体，选定候选只回填这三项。
- 口令不再随候选下发到面板页面：页面在任何时刻都不持有历史口令，接口里也没有「按去重键
  取整条（含口令）」这种成员。
- 保存的口令由主进程在认证链里取用，用户不需要先点一次候选才「激活」它。

### FR-007：凭证是判别联合，不是「口令或没有」

- 远程凭证的取值是一个必选的判别联合：口令形态（口令本身）与私钥身份形态各自是完整成员；
  「没有任何可用凭证」用 `null` 表达，不用可选字段。
- 私钥身份形态只携带「这份身份的可落盘描述」（来源与公开指纹），不含私钥内容、不含
  passphrase、不含任何可反推私钥的材料；恢复时据此定位同一份身份，定位不到即按凭证不可用处理。
- 所有消费凭证的 surface 以「凭证是否可用」判定，不以「是不是口令」判定：终端入口的
  可用性、跨工作区传输的端解析、侧栏远端文件浏览、连接池去重都遵循这一条。
- 凭证不可用时各自按现有口径拒绝并报错 / 置灰，错误文案点名「凭证不可用」，不把它当成
  口令错误。

### FR-008：落盘、恢复与身份判等对两种凭证一致

- 两种凭证形态都随工作区引用落进宿主本地状态，重启后按落盘凭证重新走引导与建链；
  私钥身份形态不需要用户在重启时重新输入任何东西。
- 恢复时凭证不再可用（私钥被删、agent 里身份没了、主机不再接受该公钥）落进既有的
  「远程不可连」形态：标签页保留、标记不可用、提供重新连接入口，不静默丢弃该项。
- 连接目标的身份键包含凭证身份：凭证种类或内容不同即视为不同目标，各自建链、不互相复用；
  同一凭证身份的目标仍复用同一条连接。

### FR-009：失败分类不被兜底链掩盖

- 网络不可达、建链超时、主机密钥不一致、远端引导失败都属于「终止性失败」：按现有口径报错，
  不进入口令浮层。
- 只有「认证方式不成立」（各来源都没有可用身份 / 保存的口令被拒 / 输入的口令错误）才推进
  兜底链，因为这时唯一的解法是用户提供口令。
- 每条来源的拒绝原因留在诊断日志里；呈现给用户的是当前阶段的原因，不叠加成一段多方式
  失败说明。

## 边界与错误路径

- 用户名或主机为空：维持现状——表单内校验错误，不进入认证链、不弹浮层。
- `~/.ssh` 不存在、没有默认私钥、私钥文件不可读：视为该来源不可用，不报错。
- 私钥文件存在但内容损坏 / 格式不支持：该条来源不可用并落诊断日志，继续认证链。
- agent 里有多条身份：按 agent 提供的顺序尝试，任一条成功即停止。
- 同一目标在连接历史里有重复条目：按去重键取最新一条的口令；历史读取口径不变。
- 浮层打开期间关闭面板窗口：不建立连接、不写历史；在途的认证不需要额外中断确认。
- 认证链已经成功后短时间内的重复「连接」：第二次是同一目标的复用快路径，不重复询问口令。
- 保存的口令被拒后用户取消浮层：历史里该目标的旧口令原样保留（不因一次失败清除），
  用户下次点「连接」会再试一次旧口令——这是既有语义，不做「失败即删」。
- 主机密钥变更：沿用既有告警与「确认后重建信任」路径，不因认证方式改变而放宽。

## 非目标

- passphrase 的交互式询问、私钥加密口令的记忆（`TODO.md` 登记一条候选）。
- 面板里手选私钥文件、管理多份私钥、agent 转发（`docs/architecture/open-questions.md` 的 SSH 认证行保留为待定）。
- 凭证的加密存储与钥匙串集成（维持明文落盘，见 [docs/core/client-connection.md 第 10 节](../../docs/core/client-connection.md#10-不覆盖范围)）。
- 跳板机 / ProxyJump、多跳 SSH、`wsl` / `container` 接入方式。
- 口令浮层的「记住我这台机器」勾选（保存策略恒定按 FR-005）。

## 对需求基线的影响

- 修改 US-36（打开远程工作区）验收标准：第 1 条写明接入只填三项、口令按需询问；第 4 条
  写明连接历史的回填不再包含口令、保存口令的写入条件与复用时机。US 编号与场景不变。
- 无新增 US：本改动收紧的是既有 US-36 的接入交互，不引入新的用户可见能力面；
  `remote-workspace-ui` 车道新增页面级用例覆盖面板与浮层（见追溯矩阵），整应用链路的
  私钥建链在 `electron-ssh` 车道按现有豁免口径登记（需要能接受公钥的外部远端，本地
  无该环境时该用例 `skipped` 并留原因）。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `electron/remoteWorkspace/index.html`、`electron/remoteWorkspace/main.ts` | `e2e/remoteWorkspace/connectAuth.spec.ts`（首屏无口令元素） | 自动 |
| FR-002 | `src/host/sshAuth.ts`、`src/host/sshConnectChain.ts`、`src/host/standalone/sshClient.ts`、`electron/main.ts` 的 `remote-workspace:connect` | `src/test/sshAuth.test.ts`（顺序与来源）、`src/test/sshConnectChain.test.ts`（编排）、`e2e/remoteWorkspace/connectAuth.spec.ts` | 自动 |
| FR-003 | `src/host/sshAuth.ts` 的 `discoverDefaultPrivateKeys` / `classifySshFailure`、`sshClient.ts` 的私钥预检 | `src/test/sshAuth.test.ts`（加密私钥判 auth、agent 不可用判 auth） | 自动 |
| FR-004 | `electron/remoteWorkspace/index.html`、`electron/remoteWorkspace/main.ts` | `e2e/remoteWorkspace/connectAuth.spec.ts`（弹层、失败、Esc、回车） | 自动 |
| FR-005 | `electron/main.ts` 的 `remote-workspace:connect`、`src/host/sshHistory.ts` | `src/test/sshHistory.test.ts`、`e2e/electron/remoteWorkspace.spec.ts` | 自动 |
| FR-006 | `electron/remoteWorkspace/types.ts`、`electron/remoteWorkspace/main.ts` | `e2e/electron/remoteWorkspace.spec.ts`（候选回填不含口令） | 自动 |
| FR-007 | `src/host/workspaceRef.ts`、`src/host/sshTarget.ts`、`electron/terminalShells.ts`、`src/host/WebViewUI.ts`、`electron/sidebarFilesRemote.ts` | `src/test/terminalShells.test.ts`、`src/test/crossWorkspaceRouting.test.ts`、`src/test/remoteFileResolve.test.ts` | 自动 |
| FR-008 | `src/host/workspaceState.ts`、`src/host/bootstrapCore.ts`、`electron/main.ts` | `src/test/workspaceState.test.ts`、`src/test/bootstrapWiring.test.ts` | 自动 |
| FR-009 | `src/host/sshAuth.ts` 的 `classifySshFailure`、`electron/main.ts` 的结果分叉 | `src/test/sshAuth.test.ts`、`src/test/sshConnectChain.test.ts`、`e2e/remoteWorkspace/connectAuth.spec.ts` | 自动 |

## 待澄清

（无未决问题。）

## 收敛记录

收敛时由 /implement 填写，结论只分三类。

- 已满足：
- 偏差：
- 未做：
