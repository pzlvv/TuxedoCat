---
status: 已修
---

# 缺陷：凭据通道拆成两次 exec，第二步拿不到上一步的 sudo 认证

`specs/051-overlay-root-mount-proxy` 的 FR-004 第 2 / 3 条要求：免密 `sudo` 不可用时，
用户提供密码由宿主完成提权安装，密码只经 stdin、不进 argv / 环境 / 日志。修复
[mount-proxy-credential-line-pollutes-payload](mount-proxy-credential-line-pollutes-payload.md)
时把凭据通道改成**两次独立 exec**——先 `sudo -S -v` 只做认证，再 `sudo -n` 执行安装。
这条路径依赖「上一次调用的认证缓存对下一次调用有效」，在 sudo-rs 上不成立，于是带密码的
部署**一次都装不上**：安装脚本一行没跑，能力停在 `absent`。

## 现状

`src/host/mountProxyInstall.ts` 的 `deployWithCredential`（`sudoPassword` 分支）：

```ts 示意
// 第一次 exec：只认证
const probe = await target.shell.run('sudo -S -v -p ""', { stdin: credential.line() });
// 第二次 exec：安装，-n 表示「认证已经有了，别再问」
const result = await target.shell.run('sudo -n sh -c \'…\'', { stdin: proxyBytes });
```

第一步成功、第二步必然失败。目标机（`122.51.248.34`）上实测：

```
$ id e2essh
uid=1002(e2essh) gid=1002(e2essh) groups=1002(e2essh),27(sudo)   ← 需要密码的账号

$ sudo -S -v -p ""          （密码写 stdin）
$ echo $?
0
$ sudo -n id -u             （另一次 exec）
sudo: interactive authentication is required
```

原因在认证缓存的匹配范围。远端 `/usr/bin/sudo` 是 **sudo-rs 0.2.13**（Ubuntu 的 Rust 实现），
它的 session record 按 `RecordScope` 匹配，取值只有两种：`Tty { tty_device, session_pid,
init_time }` 或 `Ppid { group_pid, init_time }`。SSH exec 没有 tty，走 `Ppid` 分支，而每次
exec 的进程组与组创建时间都不同：

```
$ ps -o pid=,pgid=,sid=,ppid= -p $$   # 连续三次 exec
568285  568285  568285  568284
568287  568287  568287  568284       ← pgid/sid 每次都变
568290  568290  568290  568284
```

于是第一步写下的记录，第二步在文件里找不到匹配项。e2essh 的 session record 文件
（`/run/sudo-rs/ts/1002`）有 39988 字节 = `52 + 48 × 832`，832 条正是历史上每次 exec
各记一条的累计——记录从不跨 exec 复用。

经典 sudo 在无 tty 时按**父进程**键控时间戳，同一次 SSH 会话里的两次 exec 共享 sshd
父进程，所以旧写法「勉强能跑」。换成 sudo-rs 后这个前提消失，而 PR 的验证记录里 RT-4
（真机车道）标的是 `not-run`，因此没有被发现。

## 期望

- 认证与安装**在同一次调用里**完成，不跨 exec 依赖认证缓存。
- 密码与载荷的字节集合仍不相交：密码不进 `--install` 能读到的位置，落盘内容不得带任何前缀。
  免密账号与缓存命中（`sudo` 不读 stdin）两种情形都要成立——这是
  [mount-proxy-credential-line-pollutes-payload](mount-proxy-credential-line-pollutes-payload.md)
  的原始诉求，不能因为本次修复而回退。
- 密码仍不进 argv、不进环境变量、不为密码路径分配 pty；失败原因经剔除后再回给界面
  （FR-004 第 3 条）。
- 认证失败与安装失败仍可区分：前者回三选一让用户重试或换来源，后者点名安装本身的原因
  （FR-004 第 5 条）。

## 不变量

- `deployWithCredential(options, method, secret)` 的签名、`MountProxyCredentialMethod` 的三个
  取值、`sudoPassword` / `rootPassword` / `manual` 的分工都不变。
- 免密通道（`deployWithPasswordlessSudo`）的行为不变：仍是「`sudo -n true` 探可达性 → 安装」，
  探测不带载荷、安装 stdin 只有代理字节。
- 安装命令仍是固定字符串、不含用户可控输入；内容只经 stdin 进 root 侧（FR-005 / FR-009）。
- `BOOTSTRAP_INSTALL_SCRIPT` 的落盘不变量不变：临时名由 root 侧生成、`04755`、装完清理。
- 安装落点、审计行四要素（主机名 / 落点 / sha256 / uid）不变。
- 不改 wire 协议、不新增落盘字段、不新增 IPC 通道。

## 回归测试

- **RT-1**：`sudoPassword` 通道只发一次调用——认证与安装不拆成两次 exec。
  （落点：`src/test/mountProxyInstall.test.ts`，用例「RT-1 认证与安装只发一次调用，不退化成两步 exec」）
- **RT-2**：密码与载荷按标记行划界——标记行之前只有密码行、之后就是载荷本身，不多不少；
  因此「`sudo` 不读 stdin」也不会让密码成为载荷前缀。
  （落点：同文件「RT-1 标记行把密码与载荷划开，载荷不带密码前缀」「RT-2 root 密码通道同样按标记行划界」）
- **RT-3**：真机端到端——用一个「免密 sudo 不可用、口令式 `sudo -S` 可用」的账号，
  经 `resolveTarget` → `deployWithCredential` 装真实代理：结果为 `installed`、落点
  `root:root 04755`、落盘 sha256 与随包产物一致、代理可执行。
  （实现见 `scripts/verify-mount-proxy-target-remote.mjs` 的凭据段）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 缺陷复现（真机，修复前） | 分两次 exec 跑 `sudo -S -v` 与 `sudo -n id -u` | 红 | 第一步退出 0、第二步 `sudo: interactive authentication is required`；两步在同一 bash 内则可用，证明是跨 exec 的匹配范围问题 |
| 认证缓存匹配范围 | `ps -o pid=,pgid=,sid=,ppid= -p $$` 连跑三次 exec | 红 | pgid / sid 每次都变、ppid 恒为同一个 sshd-session；sudo-rs 的 `RecordScope::Ppid` 因此匹配不上 |
| session record 证据 | `ls -la /run/sudo-rs/ts/`、`stat -c %s` | 红 | `1002`（e2essh）39988 字节 = 52 + 48×832，每次 exec 一条，跨 exec 不复用 |
| 修复前（真机端到端） | `deployWithCredential` 经真实 SSH 部署 | 红 | `kind: 'failed'`；告警形态与缺陷形态同源——见上面「认证缓存匹配范围」两行即缺陷本身，端到端只在修复后才转绿 |
| 单测（修复后） | `npm run test:unit -- mount-proxy-install` | 绿 | 27 通过 / 0 失败：标记行划界、只发一次调用、载荷字节逐字一致 |
| 真机端到端（修复后） | 同上，账号 pzprobe（免密不可用 + 口令式可用），真实代理 766552 字节 | 绿 | `installed`、`root:root 4755`、落盘 sha256 与源一致、`--protocol-version` 回 `1`；跑完已卸载并删除账号 |
| 缓存命中形态 | 同一账号连续两次部署（第二次 `sudo` 不读 stdin） | 绿 | 两种情形落盘 sha256 都等于源、都不含密码前缀 |
| 既有回归 | `npm run test:unit` | 绿 | 见下方全量结果 |
| 类型与静态检查 | `npm run check-types`、`npm run lint` | 绿 | 三份 tsconfig + eslint 无报错 |
