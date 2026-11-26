---
status: 已修
---

# 缺陷：凭据通道把密码行拼进安装载荷，NOPASSWD / 时间戳缓存下污染落盘字节

FR-004 第 3 条（[specs/051 的 FR-004](../../specs/051-overlay-root-mount-proxy/spec.md)）要求密码
**只写一行进提权子进程的标准输入、随后立即关闭**。当前凭据通道把「密码行 + 代理二进制」拼成
同一段 stdin 喂给 `sudo -S`，依赖「`sudo` 必定消费掉首行」这个前提。该前提在免密账号与
sudo 时间戳缓存命中时不成立，于是密码成为代理字节的一部分：安装失败，密码落到磁盘上的临时
文件里，并在目标机器的用户主目录留下一个由 shell 重定向生成的垃圾文件。

## 现状

`src/host/mountProxyInstall.ts` 的 `deployWithCredential`：

```ts 示意
const command = method === 'sudoPassword'
  ? `sudo -S -p "" sh -c '${BOOTSTRAP_INSTALL_SCRIPT}'`
  : `su -c "sh -c '${BOOTSTRAP_INSTALL_SCRIPT}'" root`;
const stdin = secretThenPayload(credential.line(), proxyBytes);
```

拼接函数的注释明确写着它的前提：

```
* **顺序不能交换**：`sudo -S` 从 stdin 读走**第一行**作为密码，随后它 exec 的目标
* （代理的 `--install`）继承剩余的 stdin 作为自己的输入。
```

这个前提只在「`sudo` 确实需要密码」时成立。实测（WSL Arch）：

```bash
# 免密账号（wheel + NOPASSWD: ALL）
$ printf "PWPW1234\nLINE2\n" | sudo -S -p "" sh -c cat | xxd
5057 5057 3132 3334 0a4c 494e 4532 0a   → PWPW1234\nLINE2\n   （一字未少）

# 真正需要密码的账号
$ printf "TestPw12345\nLINE2\nLINE3\n" | sudo -S -p "" sh -c cat
（首行被消费，剩余 LINE2 / LINE3）
```

`sudo -S` 在不需要密码时**完全不读 stdin**。于是 `BOOTSTRAP_INSTALL_SCRIPT` 里的
`cat > "$tmp"` 得到的是「密码行 + ELF」，随后 `"$tmp" --install < "$tmp"` 去执行它：

- ELF 魔数不在偏移 0，内核 `execve` 返回 `ENOEXEC`，`sh`（本机 `/usr/bin/sh -> bash`）
  退化成把它当脚本逐行解释；
- 代理根本没执行，`--install` 没有回显 sha256，宿主按失败处理；
- 错误输出里带着 `line 1: <密码>: command not found`，被 `sanitizeFailure` 命中后统一替换成
  「认证失败」——用户看到的结论是「密码不对」，而密码其实是对的。

**副作用（安全问题）**：ELF 头 `e_machine` 字段是 `0x3e`（`>`），bash 把它当重定向符，紧随其后
的 10 字节成为目标文件名。strace 确认唯一创建点是一次重定向：

```
openat(AT_FDCWD, "\1\20\330\1@x\317\v@8", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 3
```

产物是 `root:root`、`0` 字节、落在 sudo 命令的 `PWD`（用户主目录）下。同时密码本身被写进
`$tmp` 这份 root 侧临时文件——`0700` 限制了读取面，但密码落到磁盘是事实。

复现：WSL 免密账号 + `/usr/libexec` 缺失 → 第一次 `sudo -n` 安装返回 3 → 宿主误判为需要密码
（见 `mount-proxy-passwordless-probe-uses-exit-code.md`）→ 用户输入正确密码 → 上述链路触发。

## 期望

1. **密码与载荷不共用一段标准输入**：密码行单独作为一次提权校验的标准输入（写完即关闭），
   代理字节单独作为安装命令的标准输入。两条流的字节集合不相交，密码永远不出现在
   `--install` 能读到的位置（FR-004 第 3 条）。
2. **不依赖「`sudo` 必须消费首行」**：免密账号、`sudo` 时间戳缓存命中、`su` 从 `/dev/tty`
   读密码这三种情形下，落盘字节都必须是完整的代理二进制，不能带任何前缀。
3. **密码不落盘、不回显**：任何失败路径都不把密码写进目标机的临时文件、不进日志 / 诊断输出；
   失败原因经剔除后再回给界面（FR-004 第 3 条）。
4. **失败可换路**：凭据校验失败或安装失败都回三选一，允许改用其它来源重试（FR-004 第 5 条）。

## 不变量

- `deployWithCredential(options, method, secret)` 的签名与 `MountProxyCredentialMethod` 三个取值
  不变；`sudoPassword` / `rootPassword` / `manual` 的分工不变。
- 免密通道（`deployWithPasswordlessSudo`）的 stdin 仍只有代理字节，字节内容与顺序不变。
- 密码仍**不进 argv、不进环境变量**，不为密码路径分配 pty（FR-004 第 3 条）。
- 安装命令仍是常量拼装、不含用户可控字符串；内容仍只经 stdin 进 root 侧（FR-005 / FR-009）。
- `BOOTSTRAP_INSTALL_SCRIPT` 的落盘不变量不变：`mkstemp` 由 root 侧生成名字、`fchown` /
  `fchmod` 先于 `rename`、装完清理临时文件（FR-005 第 3 条）。
- 安装落点、允许列表格式、审计行四要素（主机名 / 落点 / sha256 / uid）均不变。

## 回归测试

- **RT-1**：`sudoPassword` 通道把密码单独作为一条提权校验命令的 stdin（恰好一行、写完关闭），
  安装命令的 stdin **只有代理字节**、不含密码；两条命令都不含密码明文。（落点：
  `src/test/mountProxyInstall.test.ts`，用例名 `RT-1 sudo 密码与安装载荷分两条流，载荷不带密码前缀`）
- **RT-2**：`rootPassword` 通道同样不把密码拼进安装 stdin（`su` 从 tty 读密码，拼进去只会
  污染载荷）。（落点：`src/test/mountProxyInstall.test.ts`，用例名 `RT-2 root 密码通道的安装 stdin 只有载荷`）
- **RT-3**：凭据校验失败时不再执行安装命令，结果是 `failed` 且 `failure` 不含密码原文。
  （落点：`src/test/mountProxyInstall.test.ts`，用例名 `RT-3 凭据校验失败时不执行安装，失败原因不含密码`）
- **RT-4**：真机形态——免密账号走凭据通道时，`/usr/libexec` 与用户主目录下都不出现垃圾文件，
  且安装落点内容 sha256 与随包产物一致。（落点：`scripts/verify-mount-proxy-target-remote.mjs`
  的凭据段；本地无特权环境由 RT-1～RT-3 覆盖）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 基线（修复前） | `npm run test:unit -- mount-proxy-install` | 绿 | 20 通过 / 0 失败——现有用例把「密码行在前、载荷在后」写成了期望，该断言与 FR-004 第 3 条冲突，修复时一并更正 |
| 回归用例（修复前） | `npm run test:unit -- mount-proxy-install` | 红 | RT-1 / RT-2 红：`AssertionError: 先校验凭据，再执行安装`（`actual 1 !== expected 2`，密码与载荷仍共用一条 stdin）；RT-3 红：`AssertionError: 校验失败不得执行安装`（凭据未过也照样跑 `--install`） |
| 回归用例（修复后） | `npm run test:unit -- mount-proxy-install` | 绿 | RT-1 / RT-2 / RT-3 全绿；全文件 26 通过 / 0 失败 |
| 既有回归 | `npm run test:unit` | 绿 | 134 通过 / 0 失败 / 2 跳过（`sidebarFiles`、`sidebarDocViewGit` 环境前置不满足） |
| 类型与静态检查 | `npx tsc --noEmit -p tsconfig.json`、`-p tsconfig.test.json`、`npx eslint src/host/mountProxyInstall.ts src/test/mountProxyInstall.test.ts` | 绿 | 主项目与测试配置均 0 错误 |
| 真机载荷形态（WSL Arch，真 ELF 775864 字节） | 用修复后的 `deployWithCredential` 驱动真实 `wsl.exe` 并记录每次调用的 stdin | 绿 | 凭据流 12 字节、首字节 `54657374`（密码行）；安装流 775864 字节、首字节 `7f454c46`（ELF 魔数）——载荷无任何前缀 |
| 真机副作用 | 安装后检查 `/home/pz` 下的非打印名文件 | 绿 | 仅有 11-25 20:07:54 的历史文件（size 0、mtime 未变），本次修复未产生新垃圾文件；落点 `root:root 4755` |
| RT-4（真机车道） | `node scripts/verify-mount-proxy-target-remote.mjs` | not-run | 需要 `e2e/environments.json` 里登记的真实 SSH 远端与凭据，本地无该环境 |
