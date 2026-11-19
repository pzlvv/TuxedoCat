---
status: 已修
---

# 缺陷：远端槽位里的可执行文件不校验构建指纹，被污染的槽位永久连不上

SSH 引导把「指纹槽位里存在可执行文件」当作「这个可执行文件就是该指纹的产物」，从不问它
自己的构建指纹。于是只要槽位里的文件被换成任何别的二进制（历史遗留的手工 `cargo build`
产物、上一次清理留下的半截文件、另一个客户端的错误上传），引导就永远复用这份坏产物。

本次故障就是这条路径：远端 `~/.local/share/<core.deployPrefix>/cdbabb0b…/<core.binaryName>`
里躺着一份 `cargo build` 直接产出、指纹烧成占位值 `manual-build` 的二进制。它启动 daemon
时按自己的指纹写状态文件 `run/core-daemon-manual-build.json`，而宿主按自己的指纹去读
`run/core-daemon-cdbabb0b….json`，永远读不到——引导报
`remote daemon started but …/core-daemon-cdbabb0b….json is missing or malformed`，
工作区在标题栏与聊天区都显示「无法连接远程主机」，且**每次重连都重走同一条死路**。

一份被污染的槽位没有任何自愈路径：`ensureRemoteBinary` 只做 `stat().exists` 判断，
存在即返回 `false`（不上传），坏产物原地留到有人手工删目录为止。

## 现状

- `src/host/standalone/sshDaemonBootstrap.ts` 的 `ensureRemoteBinary`：

  ```ts
  if ((await ssh.stat(remoteBinary)).exists) return false;
  ```

  判据只有「文件存在」。函数的文档注释把「同指纹的两个构建产物行为一致」当作不校验的
  理由，但这条推理的前提是「槽位里的文件确实由该指纹构建而来」——文件系统上没有任何
  东西保证这一点。

- 槽位里也不放 `fingerprint` 文件（`ensureRemoteBinary` 只上传二进制），因此宿主即使想
  比对也没有可读的凭据。[docs/core/standalone-core.md 第 3.1 节](../../docs/core/standalone-core.md#31-平台矩阵)
  画的部署布局里槽位是 `<核心可执行文件> + fingerprint` 两份文件，实现只落了前者。

- 二进制自身**带得动**这个事实：`--version` 输出
  `<core.binaryName> <版本> (fingerprint <指纹>)`（`core-rs/src/cli.rs::version`，值来自
  `remote.rs::build_fingerprint` 的编译期常量）。

- 实测（2026-11-19，远端 `8.136.22.171`，本机产物指纹 `cdbabb0b…`）：

  ```
  $ ~/.local/share/<core.deployPrefix>/cdbabb0b…/<core.binaryName> start --idle-exit 30
  [core] 远程服务已就绪，监听 127.0.0.1:32879（Host 经 SSH 转发接入）
  $ ls ~/<configDir>/run/
  core-daemon-manual-build.json          # 宿主读的是 core-daemon-cdbabb0b….json
  ```

  同一份槽位文件 `grep -c manual-build` 为 1、`grep -c cdbabb0b…` 为 0。

- 宿主日志（`~/<configDir>/logs/<logFileName>`）逐次重连都停在同一句：

  ```
  [ssh] daemon state file missing or unreadable; treating as no daemon
  remote daemon started but /home/pz/<configDir>/run/core-daemon-cdbabb0b….json
  is missing or malformed
  ```

## 期望

- 引导在**决定复用**槽位里的可执行文件之前，先问它自己的构建指纹
  （`<远端可执行文件> --version`），与本地产物指纹比对：
  - 一致 → 视为同版本，不重传（现有「不无脑覆盖」语义不变）；
  - 不一致 → 用本地产物原子上传覆盖，日志点名「槽位里的产物指纹是 X、期望 Y，已重传」；
  - 探测失败（文件不可执行 / 输出认不出指纹）→ 同样按「不可复用」处理并重传。
- 重传之后再问一次指纹；仍不一致就报错并点名两侧指纹（`fail-closed`，不静默降级到
  「先连上再说」）。
- 槽位里同时落一份 `fingerprint` 文件（与
  [docs/core/standalone-core.md 第 3.1 节](../../docs/core/standalone-core.md#31-平台矩阵)
  的部署布局一致），让远端目录自身可读地说明「我属于哪个指纹」。
- 该判据与 daemon 复用判据相互独立：**daemon 活着且状态文件按本指纹命名**仍然直接复用
  （状态文件按指纹命名，能读到就说明 daemon 就是本版本），不为校验而重启在跑的 daemon。

## 不变量

- 同一指纹不重复上传（不无脑覆盖）——校验只拦「指纹对不上」，不引入字节比对。
- 上传仍是「客户端唯一暂存名 + `mv` 原子换名」，运行中的 daemon 不受影响（`ETXTBSY` 规避）。
- 多版本各占一个槽位：新版本落新槽位，旧 daemon 原样留给旧客户端。
- 内置工具（`ripgrep` / `fd`）的共享位与指纹无关，部署判据不变。
- 校验只发生在 SSH 引导（`ensureRemoteDaemon`）；本地进程的 Core 不走这条路径。

## 回归测试

- **RT-1**（`src/test/sshDaemonBootstrap.test.ts`）：槽位里有可执行文件但 `--version`
  报告的指纹与本地指纹不一致 → 上传一次本地产物覆盖、`mv` 到槽位路径，且**不**跳过
  `start`。
- **RT-2**（同上）：槽位里指纹一致 → 不上传（既有「已部署不重传」用例保持绿，断言
  `uploads.length === 0`）。
- **RT-3**（同上）：`--version` 执行失败 / 输出里没有指纹 → 按不可复用处理并重传。
- **RT-4**（同上）：重传后 `--version` 仍报不一致 → 引导抛错，错误信息点名期望指纹与实际
  指纹，且不执行 `start`。
- **RT-5**（同上）：槽位里同时落 `fingerprint` 文件，内容与本地一致。
- **RT-6**（真机，`e2e/environments.json` 的 ssh 目标）：把槽位里的可执行文件替换成指纹
  不符的产物，触发一次 SSH 引导 → 连接成功建立，远端槽位可执行文件的 `--version` 与本地
  指纹一致。验证记录需含实际命令与输出。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 现状复现（槽位里的二进制自报 `manual-build`） | `ssh … 'grep -a -c manual-build <槽位二进制>'` | 红 | 远端 `cdbabb0b…` 槽位返回 1，`grep -c cdbabb0b…` 返回 0 |
| 现状复现（daemon 状态文件名与宿主期望不一致） | 远端执行 `<槽位二进制> start --idle-exit 30` 后 `ls ~/<configDir>/run/` | 红 | 落盘 `core-daemon-manual-build.json`，宿主读 `core-daemon-cdbabb0b….json` |
| 现状复现（宿主每次重连都失败） | `~/<configDir>/logs/<logFileName>` 检索 `missing or malformed` | 红 | 启动探测与「重新连接」两条路径同错 |
| RT-1..RT-5（实现未改时的红） | `npm run test:unit -- ssh-daemon-bootstrap` | 红 | 60 通过 / 7 失败：槽位指纹不符不重传、`--version` 失败不重传、重传后不校验、槽位无 `fingerprint` 文件 |
| RT-1..RT-5（实现改完后的绿） | `npm run test:unit -- ssh-daemon-bootstrap ssh-transport` | 绿 | sshDaemonBootstrap 69 通过 / 0 失败；sshTransport 8 通过 / 0 失败 |
| 全量单测 | `npm run test:unit` | 绿 | 116 通过 / 0 失败 / 2 跳过（跳过为既有环境前置不满足） |
| RT-6（真机：槽位换成 `/bin/true` 后跑引导） | 远端 `cp /bin/true <槽位>/<core.binaryName>`，再跑 `ensureRemoteDaemon` | 绿 | 日志 `deployed … (linux-x64)`，返回 endpoint 并成功开转发通道；槽位 `--version` 回到本机指纹 `cdbabb0b…` |
| RT-6 复跑（槽位换成 `/bin/true` 且删掉 `fingerprint`） | 同上，额外 `rm -f <槽位>/fingerprint` | 绿 | 自动部署同时补回二进制与 `fingerprint` 文件，全程无手工远端操作 |
| 旁挂文件读不出不阻塞引导 | `npm run test:unit -- ssh-daemon-bootstrap` | 绿 | 新增用例：`fingerprint` 文件读不出时引导照常成功且不重传二进制 |
| RT-6 后续状态（槽位自读 + 状态文件名） | `ssh … '<槽位>/<core.binaryName> --version; cat <槽位>/fingerprint; ls ~/<configDir>/run/'` | 绿 | 版本行指纹与 `fingerprint` 文件一致；状态文件为 `core-daemon-cdbabb0b….json` |
| 重传不影响在跑的 daemon（原子换名） | RT-6 期间 `ps -eo pid,etime,args` 查远端 daemon | 绿 | 全程只有一个 daemon，按 `--idle-exit 30` 自行退出 |
| 类型 / 静态检查 | `npm run check-types`、`npm run lint` | 绿 | 均退出码 0 |
| 文档同步闸门 | `npm run test:unit -- docs-lint` | 绿 | 章节引用、缺陷规格五节与两侧锚点均通过 |
| 品牌字面量闸门 | `npm run test:unit -- brand-literal` | 绿 | 12 通过 / 0 失败；本规格与 `sshDaemonBootstrap` / `sshTransport` 用例改用 `<core.binaryName>` 等身份占位符 |
