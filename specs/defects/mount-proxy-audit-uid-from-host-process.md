---
status: 已修
---

# 缺陷：远端部署的审计行记录的是宿主进程 uid，Windows 宿主上写成 `unknown`

FR-012 / AC-37（[specs/051 的 FR-012](../../specs/051-overlay-root-mount-proxy/spec.md)，
as-built 见 [docs/core/mount-proxy.md 第 2.2 节](../../docs/core/mount-proxy.md#22-安装审计)）
要求每次安装或升级在宿主日志写一行审计记录，含**主机名、落点、内容 sha256、安装者 uid**。
审计行的用途是共享机器上的可追溯性：谁把这份 setuid-root 的代理装了上去。

## 现状

- 审计行由 `src/host/ui/webviewMessageHandler.ts` 的 `applyDeployOutcome` 构造，`uid` 传的是
  ```ts
  uid: outcome.digest.length > 0 ? (process.getuid?.() ?? null) : null
  ```
  `process.getuid` 是 **Node 宿主进程自身**的 uid：
  - Windows 宿主上该函数不存在（`process.getuid` 为 `undefined`）→ `uid=unknown`；
  - Linux 宿主上即使是**远端**部署也取的是本机 uid，与目标机上真正执行安装的账号无关；
  - 本地部署时两者恰好相同，因此这个错误只在远端 / Windows 上可见。
- 安装侧其实**已经知道**正确的值：`mount-proxy-rs` 的 `privilege::installer_uid()` 读
  `SUDO_UID`（`sudo` 拉起 `--install` 时即发起安装的用户），并把它写进允许列表
  （`<落点>.uids`，FR-005 的受众收窄）——这正是审计行要记录的那个身份。
- 代理安装成功时只往 stdout 回显 sha256 一行（`main.rs` 的 `emit_line(&digest)`），
  这个值没有传给宿主。
- 复现（`electron-ssh` 车道，Windows 宿主）：`FR-012 AC-37 安装写审计行` 在
  `e2e/electron/overlayMountProxyRemote.spec.ts` 上稳定失败，
  收到的是 `... sha256=<64 hex> uid=unknown`。

## 期望

1. **安装者 uid 是目标机上的真实安装者**：审计行写代理在**执行安装的那台机器**上算出的
   uid，即 `SUDO_UID`（无 `SUDO_UID` 时回退该机器的 `getuid()`），不读宿主进程 uid。
2. **跨平台一致**：Windows 宿主部署远端时同样写得出真实 uid，不再出现 `unknown`；
   拿不到该值才算失败，不写占位。
3. **不回显任何密码**：安装者 uid 与 sha256 一样是代理 stdout 上的固定行，不经过
   stdin 的凭据部分（FR-004 第 3 条）。

## 不变量

- 安装命令的 stdin 契约不变：`sudo -S` 读第一行密码、剩余字节是代理内容（FR-004 第 3 条）。
- 安装落点的形态不变：`root:root` + `04755`、内容比对、非同内容才重写（FR-005 / AC-15 / AC-17）。
- 允许列表 `<落点>.uids` 的写法与语义不变，仍由代理在 root 侧追加去重。
- 审计行的其余三要素（主机名 / 落点 / sha256）形状不变；`auditLine` 仍是唯一产出点。
- 不新增 UiEvent / CoreEvent / UiRequest / 落盘字段；不新增 wire 消息类型。

## 回归测试

- **RT-1**：`parseInstallReport` 从代理 stdout 取出 sha256 与安装者 uid（两种顺序、夹杂
  其它行都认）；缺 uid 行判失败，不再静默写 `unknown`。（落点：
  `src/test/mountProxyInstall.test.ts`）
- **RT-2**：`auditLine` 的 `uid` 参数不再接受 `null`，形状锁死为真实数字。
- **RT-3**：真机形态由 `electron-ssh` 车道的 `FR-012 AC-37 安装写审计行` 覆盖——它现在跑在
  `ssh.sudoPasswordRequired` 登记的账号上（免密不可用 → 三选一凭据通道），审计行必须写出
  该账号的 uid。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-3（修复前，真机） | `npx playwright test -c e2e/playwright.config.ts --project=electron-ssh overlayMountProxyRemote` | 红 | `审计行缺安装者 uid`，收到 `[mount-proxy] installed host=<远端账号>@… sha256=<64 hex> uid=unknown` |
| RT-1 / RT-2（修复后） | `npm run test:unit -- mount-proxy-install` | 绿 | 20 通过 / 0 失败（新增 5 条：解析两行 / 顺序无关 / 夹杂输出 / 缺 uid 行判失败 / installed 带 uid） |
| RT-3（修复后，真机） | `npx playwright test -c e2e/playwright.config.ts --project=electron-ssh overlayMountProxyRemote -g "AC-37 安装写审计行"` | 绿 | 审计行写出 `uid=1002`（`ssh.sudoPasswordRequired` 那个测试账号的真实 uid），不再有 `unknown` |
| 整文件回归（真机） | `npx playwright test -c e2e/playwright.config.ts --project=electron-ssh overlayMountProxyRemote` | 绿 | 17 通过 / 0 失败；其中 FR-009 首次部署与 AC-36 卸载在免密不可用账号上走三选一凭据通道 |
| Rust 侧 | `cargo test --manifest-path mount-proxy-rs/Cargo.toml` / `npm run fmt:rust:check` | 绿 | 9 通过 / 0 失败；格式基线通过 |
