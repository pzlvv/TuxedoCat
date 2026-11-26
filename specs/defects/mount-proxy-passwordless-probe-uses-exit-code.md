---
status: 已修
---

# 缺陷：免密 `sudo` 探测用退出码判定，安装失败被误判成「需要密码」

FR-004 第 1 条与 AC-10 / AC-11（[specs/051 的 FR-004](../../specs/051-overlay-root-mount-proxy/spec.md)）
把「免密可用」与「需要密码」定义成两个互斥的前置事实：免密可用时 AC-10 要求**不弹密码输入、
直接安装**，只有 `sudo` **确实需要密码**时才按 AC-11 弹三选一。当前实现把「免密安装命令的退出
码不是 0」一律当成「免密不可用」，于是任何**认证通过但安装本身失败**的环境都会被推进凭据通道，
弹出一个根本不解决问题的密码框。

## 现状

`src/host/mountProxyInstall.ts` 的 `deployWithPasswordlessSudo` 只按退出码分流：

```ts
const result = await target.shell.run(passwordlessInstallCommand(), { stdin: proxyBytes });
if (result.code === 0) {
  // …内容比对…
}
return { kind: 'needsCredential', manualCommand: target.manualCommand() };
```

`needsCredential` 的语义在 FR-004 第 2 条里是「**sudo 需要密码**」，但这里它实际表示「上一条
命令没有返回 0」——两者不等价。退出码非 0 有三种互不相同的成因，当前实现把它们压成了同一种：

| 成因 | 真实语义 | 应有去向 |
| --- | --- | --- |
| `sudo -n` 报 `a password is required` | 免密不可用 | `needsCredential`（AC-11） |
| 认证通过，代理 `--install` 因落点 / 祖先目录 / `nosuid` 拒绝 | 安装失败 | `failed` + 点名原因（AC-16 / AC-18） |
| 认证通过，代理自检或协议版本不符 | 能力层面不可用 | `failed` + 点名原因（AC-19 / AC-20） |

复现（WSL Arch，账号在 `wheel` 组、`NOPASSWD: ALL` 已生效）：

1. `sudo -n true` 返回 0，说明免密**确实可用**；journald 里三条安装尝试都留下
   `session opened for root(uid=0) by pz(uid=1000)`，即每次都成功提权；
2. 同一台机器 `ls -d /usr/libexec` 报 `No such file or directory`（Arch 没有该约定目录）；
3. 代理 `--install` 据此返回 `exit 3` 并打印
   `安装失败：安装落点目录 /usr/libexec 不存在；安装器不在其上创建任何目录，也不改到其它落点`；
4. 宿主把这次失败判成 `needsCredential`，界面弹出「免密 sudo 不可用」三选一。

即：**免密是可用的，退出码非 0 来自落点目录缺失，与免密无关**。用户在此状态下无论输入什么
密码都不可能装成功——落点目录仍然不存在。

## 期望

1. **两个事实分开取**：先探测「免密 `sudo` 是否可用」（一个不写文件、不装任何东西的最小命令），
   再执行安装。探测失败才回 `needsCredential`；探测成功则必须走安装，安装的失败原因以
   `failed` 回给用户，不再弹密码框（AC-10 / AC-11）。
2. **失败原因点名可行动的原因**：安装失败时把代理给的原因原样带到界面（落点目录不存在、
   祖先分量不可写、`nosuid`、内容比对不一致等），不概括成「认证失败」（AC-16 / AC-18）。
3. **不静默降级 / 不误判为无凭据**：`failed` 状态下用户可以换一条来源重试或取消；
   宿主不因为「装不上」就宣称「免密不可用」（FR-004 第 6 条）。

## 不变量

- `deployWithPasswordlessSudo` 仍是部署起手式，签名与 `MountProxyDeployOutcome` 三态
  （`installed` / `needsCredential` / `failed`）不变；`needsCredential` 仍携带
  `manualCommand`（AC-12 的零密码通道）。
- 免密路径仍**只执行一条**认证命令就得到结论，不为探测引入 pty、不写临时文件。
- 安装命令仍由常量拼装、不含用户可控字符串，内容仍只经 stdin 进入 root 侧（FR-005 / FR-009）。
- 提权顺序仍严格「先免密、后凭据」；不在探测阶段就尝试密码（FR-004 第 1 条）。
- 不新增 UiEvent / CoreEvent / UiRequest / wire 消息类型 / 落盘字段；闸门的五个 phase 不变。

## 回归测试

- **RT-1**：`sudo -n` 认证通过但代理拒绝安装（退出码 3 + stderr 点名落点目录）时，结果为
  `failed` 且 `failure` 含代理给的原因，**不**返回 `needsCredential`。（落点：
  `src/test/mountProxyInstall.test.ts`，用例名 `RT-1 免密可用但安装失败时回 failed，不误判成需要密码`）
- **RT-2**：`sudo -n` 明确回报需要密码（stderr 含 `a password is required`）时，结果仍是
  `needsCredential` 并带 `manualCommand`（确保 AC-11 不被 RT-1 的修复破坏）。（落点：
  `src/test/mountProxyInstall.test.ts`，用例名 `RT-2 免密确实不可用时仍回 needsCredential`）
- **RT-3**：探测与安装是两条命令，且探测命令不含落点路径、不携带代理字节；安装命令仍是
  `passwordlessInstallCommand()` 的固定串。（落点：`src/test/mountProxyInstall.test.ts`，
  用例名 `RT-3 免密探测与安装分成两条命令，探测不携带载荷`）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 基线（修复前） | `npm run test:unit -- mount-proxy-install` | 绿 | 20 通过 / 0 失败——现有用例没有覆盖「认证成功但安装失败」这条路径 |
| 回归用例（修复前） | `npm run test:unit -- mount-proxy-install` | 红 | 5 条新用例中 3 条红：RT-1 `AssertionError: 免密可用时安装失败不能退化成凭据通道`（`actual 'needsCredential' !== 'failed'`）；RT-3 `AssertionError: 先探免密可用性，再执行安装`（`1 !== 2`）。RT-2 绿——它是护栏用例，锁定 AC-11 不被 RT-1 的修复破坏 |
| 回归用例（修复后） | `npm run test:unit -- mount-proxy-install` | 绿 | RT-1 / RT-2 / RT-3 全绿；全文件 26 通过 / 0 失败 |
| 既有回归 | `npm run test:unit` | 绿 | 134 通过 / 0 失败 / 2 跳过（`sidebarFiles`、`sidebarDocViewGit` 环境前置不满足） |
| 类型与静态检查 | `npx tsc --noEmit -p tsconfig.json`、`-p tsconfig.test.json`、`npx eslint src/host/mountProxyInstall.ts src/test/mountProxyInstall.test.ts` | 绿 | 主项目与测试配置均 0 错误；工作区里另有一份与本缺陷无关的在改文件会让 electron 配置报错，故按单配置逐个校验 |
| 真机（WSL Arch，免密可用 + 落点存在） | 用修复后的 `deployWithPasswordlessSudo` 驱动真实 `wsl.exe` | 绿 | 返回 `failed` 并点名 `sh: line 1: /tmp/tmp.xxx: cannot execute binary file: Exec format error`（喂的是假字节），**未**误判为 `needsCredential` |
| 真机（免密确实不可用） | 同上，探测命令挡一层 `sudo -u nobody` | 绿 | 仍返回 `needsCredential` 且带零密码命令，AC-11 未被破坏 |
