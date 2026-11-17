---
status: 已修
---

# 缺陷：部署目标按宿主平台判定，远端 Linux 工作区被判成「宿主不支持部署」

在 Windows / macOS 宿主上用远端 Linux 工作区时，勾选 Overlay 并发消息会弹出确认框，
点「部署」后直接失败并显示「当前宿主不支持部署挂载代理」——而该远端 Core 明明报
`deployable: true`，代理本可以在远端装上。

## 现状

修复前，两个宿主的 `createMountProxyShell()` 都写着：

```ts
createMountProxyShell(): MountProxyShell | null {
  if (process.platform !== 'linux') return null;   // 判的是宿主平台
  return createLocalMountProxyShell(...);
}
```

`process.platform` 是**宿主进程**跑在哪，不是**目标 Core** 在哪。这造成两类错判：

| 宿主 | 会话工作区 | 实际能力 | 修复前行为 |
| --- | --- | --- | --- |
| Windows | 本地 Windows | 无（Core 的 `capabilities()` 恒不可用） | 正确拒绝 |
| Windows | **远端 Linux（SSH）** | 可在远端部署 | **错误拒绝** |
| Linux | 本地 Linux | 可用 | 正确 |
| Linux | 远端 Linux | 可在远端部署 | 正确（碰巧：宿主也是 Linux） |

同时暴露了第二个问题：`isMountProxyInstalled()`、`getBundledMountProxyPath()`、
`readBundledMountProxyBytes()` 都没有目标参数，实现只能假设「就是本机」——即使平台
判断修好，远端路径也会去读宿主上的文件、检查宿主上的落点。远端部署还有第三个缺口：
没有经 SSH 写 stdin 的能力，代理字节无法按 FR-005 第 1 条「内容经管道」送入远端
root 侧。

排查起点：用户报告部署提示「当前宿主不支持部署挂载代理」。该文案出自
`handleMountProxyDeployRequest` 的 `if (!shell)` 分支。

## 期望

1. **目标按会话工作区判定**：`WorkspaceRef.endpoint === null` → 本地；`scheme === 'ssh'`
   且能取到远端执行面 → 远端。与宿主进程平台无关。
2. **路径不混机器**：远端目标的零密码命令必须用远端暂存路径（
   `$HOME/.cache/<产品>/mount-proxy`），不得出现宿主路径（`C:\...` 在远端不存在）。
3. **远端字节经管道**：代理内容经 SSH 通道写进远端 `sh` 的 stdin，由远端 `sudo` 喂给
   `--install`；上传后核对 sha256，被截断即失败。
4. **取不到远端执行面时给 `null` 并显式报错**，不退回本机——退回会把代理装到错的机器上
   （铁律 1「不过度 fallback」）。
5. 远端就位判据与本地同口径：`stat -c '%U %G %a'` 得 `root root 4755`（FR-005b）。

## 不变量

- 提权顺序、密码只走 stdin、次数上限三条与本地完全一致（同一份 `mountProxyInstall.ts`
  编排，只是执行面不同）；
- 密码仍不进 argv / 环境变量 / 日志，不为密码路径分配 pty；
- 代理入口自检、安装不变量（`mkstemp` / `fchown`+`fchmod` 先于 `rename` / `renameat`）
  全在代理侧，远端与本地是同一份二进制、同一套行为；
- 确认框仍点名目标主机（远端显示 `user@host`，本机 `null` 不显示该行）；
- Core 的能力事实不变：`deployable` 仍只由 Core 推导，宿主不重算。

## 回归测试

- **RT-1**：`mountProxyTarget.test.ts` 的「远端 SSH 会话解析出远端目标（与宿主平台无关）」
  ——在 Windows 开发机上跑也必须是绿（这是本缺陷的正面回归）。
- **RT-2**：同上「远端目标的零密码命令用远端暂存路径，不含本地路径」——断言命令里没有
  宿主路径、没有 Windows 盘符。
- **RT-3**：同上「上传把字节经 stdin 送过去，并核对 sha256」——断言字节长度走 stdin、
  命令行里不含字节内容。
- **RT-4**：同上「远端连接取不到时给 null，不退回本机」。
- **RT-5**：`mountProxyInstall.test.ts` / `mountProxyGate.test.ts` 在改动后仍全绿
  （编排层未因执行面抽象而改变行为）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 复现（用户报告） | Electron 宿主（Windows）+ 远端 Linux 工作区，勾选 Overlay 发消息 → 点部署 | 红 | 提示「当前宿主不支持部署挂载代理」，远端 Core 同期的 `deployable` 为 `true` |
| 目标分流回归 | `npm run test:unit -- mount-proxy-target` | 绿 | 3 个文件全绿；RT-1 在 Windows 开发机上通过 |
| 路径不混机器 | 同上（RT-2） | 绿 | 零密码命令只含 `/home/pz/.cache/...`，无宿主路径 |
| 字节经管道 | 同上（RT-3） | 绿 | `stdinLength === PAYLOAD.length`，命令行不含字节 |
| 编排层未回归 | `npm run test:unit -- mount-proxy` | 绿 | gate / install 两个文件行为不变 |
| 类型与 lint | `npm run check-types && npm run lint` | 绿 | 0 error / 0 warning |
| 真机远端部署 | `node scripts/verify-mount-proxy-target-remote.mjs`（Windows 宿主 → `8.136.22.171`） | 绿 | 真实 ssh2 驱动 `resolveTarget` / `remoteTarget` / `beginDeploy` / `deployWithCredential` 全链路；落点 `root root 4755`、内容 sha256 一致、`isInstalled()` 正确、审计行点名 `pz@8.136.22.171`、幂等重装 inode 与 mtime 均不变、卸载后位点/允许列表/暂存目录全部清除 |
| 首次安装自举 | 同上「凭据通道」段 | 绿 | 落点尚不存在时，`sudo sh -c '<固定脚本>'` 把 stdin 字节写入 root 私有临时文件后执行其 `--install`；源路径与落点都不进命令行（FR-005 第 1 条） |
| 内容相同不重写 | 同上「幂等重装」段 | 绿 | 修前 inode 每次变化；修后 `393834 → 393834`、mtime 不变 |
