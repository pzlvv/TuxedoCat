---
owner: pzlvv
last_reviewed: 2026-10-17
---

# 规格：Core 远程服务（`start` / `kill` 与 SSH 接入）

本规格界定 Core 的远程服务：`start` / `kill` 两个动作、状态文件与按指纹落槽位、SSH 接入与远端目录选择。daemon 的进程模型、通道、生命周期与协议见 `docs/core/core-daemon.md`；Standalone Core 的形态与帧协议见 `docs/core/standalone-core.md`。

交叉引用：`docs/core/core-daemon.md`（daemon 进程模型与控制通道协议）、`docs/core/standalone-core.md`（构建指纹与 Core 形态）、`docs/core/client-connection.md`（连接模型与远端凭证落盘）、`docs/hosts/host-matrix.md`（Electron 的远端目录选择 UI）、`docs/hosts/host-bootstrap.md`（宿主侧接入接线）。

---

## 1. 能力

1. **`start` / `kill` 两个动作**：`start` 确保后台 daemon 在跑、把就绪信息打印到标准输出后自己退出；`kill` 结束在跑的 daemon 并清掉状态文件，幂等（第 2.1 节）。
2. **常驻后台 daemon**：`start` 以 `start-daemon` 拉起一个脱离终端与进程组的后台进程，诊断按指纹追加到配置目录的 `logs/`（第 2.1 节）。
3. **按构建指纹落槽位**：状态文件、`start` 互斥锁与诊断日志都按指纹区分，多版本 Core 在同一台机器上各占一个槽位、各跑一个 daemon，互不踩踏（第 2.3 节）。
4. **状态文件是唯一端口来源**：daemon 恒绑 `127.0.0.1`、端口交给内核分配，实际端口只有 daemon 自己写进状态文件（第 2.3 节）。
5. **SSH 是唯一接入方式**：控制通道经 SSH 转发接入，daemon 端口不出目标机器，用户只填 SSH 连接信息（第 2.4 节 / 第 2.8 节）。
6. **按需部署**：远端槽位没有可执行文件时上传本机携带的对应平台产物；指纹槽位存在即视为同版本，不做产物哈希比对（第 2.8 节）。
7. **远端目录选择**：`listDirectories` / `createDirectory` / `renameDirectory` / `deleteDirectory` 四个控制通道帧支撑远端目录选择器（第 2.6 节）。
8. **本地同机不走 daemon**：本地工作区由 Host 直接用 `stdio` 起一个 Core 进程，daemon 只服务远程 endpoint（第 2.7 节）。

---

## 2. 远程服务（`start` / `kill`）

### 2.1 动作

- `start`：确保后台 daemon 在跑，把就绪信息打印到标准输出后**自己退出**（daemon 常驻）。
  - 已有 daemon 在跑（状态文件里的 endpoint 连得上）→ 直接复用它，打印它的实际端口；
  - 没有 → 以 `start-daemon` 拉起一个后台进程（脱离终端与进程组、stdin 置空、诊断追加到
    `~/<configDir>/logs/core-daemon-<指纹>.log`，按指纹区分见第 2.3 节），等它落盘后打印。
  - 「检查 → 拉起」全程持按指纹的互斥锁（第 2.3 节）：两台机器的客户端同时首次引导
    同一台服务器时，同指纹只拉起一个 daemon；等锁的一方锁后重查，直接复用对方拉起的。
- `kill`：结束在跑的 daemon——连上它、`ping` 探活、发 `shutdown`，随后清掉状态文件。
  幂等：没有状态文件、或文件里的 daemon 已经不在，都算目标状态已达成（退出码 0）。
  连上了但 `ping` 等不到 `pong`（daemon 进程卡死）时按进程兜底强杀：扫描 `/proc` 找
  「本可执行文件 + `start-daemon`」的进程 SIGKILL（精确匹配 `argv[0]` 与 `argv[1]`，
  不靠名字模式，不会误伤别的进程），然后同样清掉状态文件；找不到匹配进程才报错。
- `start-daemon` 是启动器的内部实现，不出现在 `--help` 里；也可以直接运行（调试用）。
- 没有动作时按 `start` 处理。

### 2.2 选项

- `--idle-exit <秒>`：空闲退出——没有任何控制连接持续该秒数后 daemon 自行退出（0 视为
  没给）。SSH 引导固定传 30（见 12.8）：客户端异常退出（crash / 断电）后远端不留常驻
  进程。缺省不设：daemon 常驻，只有 `shutdown`（`kill`）结束。
- 没有绑定地址 / 端口 / 凭证选项：daemon 恒绑 `127.0.0.1`、端口交给内核分配（见第 2.3 节）。

### 2.3 状态文件

- 落盘文件按**构建指纹**区分（[docs/core/standalone-core.md 第 3.4 节](standalone-core.md#34-构建指纹)；都在配置目录的
  子目录里，不与 `settings.json` 混放）：状态文件（运行期事实）与 start 互斥锁在
  `run/` 子目录，诊断日志在 `logs/` 子目录（与宿主侧日志同目录）：
  状态文件 `~/<configDir>/run/core-daemon-<指纹>.json`、诊断日志
  `~/<configDir>/logs/core-daemon-<指纹>.log`。一个指纹一个 daemon、一份落盘文件：
  多版本 Core 在同一台远端机器上各占一个槽位时，各自的 `start` / `kill` / 探测只作用于
  自己指纹的 daemon，互不踩踏。命名规则与 `src/host/standalone/daemonProtocol.ts` 的
  `daemonStateFileName` / `daemonLogFileName` 一致，改动必须同步两侧。
- 状态文件字段：`endpoint`（实际监听的 `127.0.0.1:<端口>`）。
- **只有 daemon 写它**：daemon 知道实际绑定的端口。原子落盘（落盘前自建 `run/`
  目录）；Unix 上权限 `0600`。落盘前先做**同指纹把关**
  （`sibling_daemon_endpoint`）：状态文件已指向另一个连得上的 endpoint（同指纹
  已有 daemon 在跑）就退出，不落盘不服务——`start` 在「等就绪」期间被杀（客户端
  被 kill / SSH 会话断开）时，已拉起、脱离进程组的 daemon 仍会启动完成，且从此
  不再受锁保护；这道把关让孤儿让位给先落盘的兄弟，而不是覆盖它的状态文件、进而
  在 idle-exit 退出时把它删掉（在跑 daemon 从此无状态文件，下一次引导再拉一个，
  即同指纹双 daemon）。endpoint 等于自己的那份不算兄弟——别的进程占不了自己刚
  绑到的端口，那是前任留下的过期文件，照常覆盖。
  `kill` 只在文件内容仍是该 daemon 那份时删除它（期间可能有新 daemon 覆盖过）。
- 状态文件缺失、或里面的 endpoint 连不上，都按「没有 daemon」处理（`start` 会拉起新的）。
- **start 互斥锁**：`core-daemon-<指纹>.json.lock`（状态文件名加 `.lock`，与状态文件
  同在 `run/` 子目录，
  自动按指纹区分——同版本才互斥，多版本各锁各的）。`start` 在「检查 → 拉起 → 等就绪」
  全程持锁：锁文件用 `O_CREAT | O_EXCL` 创建并写入持有者 pid；pid 已死或锁文件无 pid
  且超过宽限（15s）即被接管，持有者崩溃不留永久锁；等锁超时（15s）报错退出，不静默
  拉起第二个 daemon。锁只互斥 `start` 本身，daemon 运行期不持锁。
- endpoint 恒为 `127.0.0.1:<端口>`：daemon 只绑回环，端口由内核分配，多版本 daemon 并存
  时互不抢固定端口。Host 读它开 SSH 转发通道（第 2.8 节），端口不出目标机器。

### 2.4 接入边界

- daemon 只监听 `127.0.0.1`：控制通道不可从网络直接到达，访问边界就是承载它的 SSH 通道
  （第 2.8 节）。
- 控制通道上没有单独的鉴权帧：能连上回环端口的进程已经在目标机器上，SSH 已完成机器级
  认证。
- 连上后一直不发帧的连接由心跳空闲回收兜底（第 2.5 节）：控制通道建立即武装心跳死线，
  沉默超过 `heartbeat_timeout` 即关闭这条连接，不长期占用服务线程。

### 2.5 连接与生命周期

- 一个 endpoint 的 daemon 同时服务多条控制通道：accept 循环每接受一条连接就交一个
  线程去服务（thread-per-connection，同步阻塞模型，不引入 async runtime），随即回到
  accept。客户端身份就是那条控制连接，不是来源 IP：同一来源 IP 的多条连接就是多个
  客户端。一条连接里的任何等待（目录列举、Core 重启）都不阻塞其它连接。
- 每（连接, 工作区）一个 Core 进程：channel 表、channel id 序列、计数、grace 与心跳
  （ping/pong）都按连接持有，互相隔离；两个客户端打开同一工作区得到两个互相独立的
  Core 进程（对齐本地多窗口语义，不做跨客户端共享）。
- 连接断开时，该连接上的全部 Core 进程被关闭；服务线程结束，daemon 进程继续监听并
  服务其它连接。
- 「断开」有三条判定路径：
  - TCP 层的 EOF / 读错误（Host 正常退出、socket 被关闭）；
  - **心跳空闲超时**（60s，daemon 判 Host）：Host 每 1s 发一帧 `ping`，daemon 每帧
    回 `pong`；心跳计时在控制通道建立时武装，此后任何控制帧都顺延它，超时仍无帧
    即按断开处理（连上后一直不发帧的连接也由此回收）。Host 消失而 TCP 未断（断网 /
    休眠 / 进程冻结）时读线程永远等不到 EOF，沉默是 daemon 唯一的断开依据。心跳
    计时按连接独立武装与顺延；daemon 收到未知帧一律丢弃并记录，不因此断开。
  - **Host 侧沉默判定**（≤ 3s，Host 判 daemon）：daemon 死而 socket 未断（对端
    断电 / 网络分区）与 daemon 卡死，在 socket 层都没有任何信号，唯一依据是
    `pong` 的有无。Host 见到首个 `pong` 后武装沉默死线（2.5s）——链路上这么久
    没有任何入站帧即补发一帧探针 `ping`，再宽限 400ms，仍无任何入站帧就 kill
    链路并按 fatal 上报。探针宽限吸收本进程卡顿（定时器迟到、入站帧积压在内核
    缓冲），不误杀活链路；判死上限 = 死线 + 宽限 ≤ 3s。对端不回 `pong` 时 Host 不
    武装沉默判定（不误杀），判死退回 TCP 层的节奏。
- 控制通道**不因没有工作区而 grace 退出**（`DaemonOptions.idle_exit = false`）：控制通道
  本身是生命周期边界，目录选择期间可以长时间没有工作区。
- 远程 daemon 是常驻 server：一条连接结束后继续等待下一条；只有 `shutdown` 帧
  （`kill` 发的）才结束进程。给了 `--idle-exit`（SSH 引导传 30，见第 2.8 节）的 daemon
  额外有空闲退出：**没有任何控制连接**持续该秒数就自行退出——死线在 daemon 启动时
  （兜住「拉起后无人接入」的孤儿）与最后一条连接断开时各起算一次，任何一条连接登记
  即取消；到期退出与 `shutdown` 同一条收尾路径（清状态文件、全连接收尾），到期的
  置位让迟到的连接被拒绝。断开后 30s 内的重连照常复用，不用重新 start。
- **`shutdown` 全局生效**：任一连接发 `shutdown` 即结束整个 daemon 进程，结束前该
  daemon 上全部连接的 Core 都被关闭。停机顺序：收到 `shutdown` 的连接先关闭自己的
  全部 Core（与断开同一条收尾路径），随后在连接注册表里置停机位，并向每条在途
  连接的会话注入 `HostDisconnected` 事件、同时掐断其 socket——各连接的会话主循环
  随之走自己的「Host 断开」收尾（关闭自己的全部 Core）后线程退出；主线程等全部
  连接收尾后清掉状态文件，进程退出。事件注入是主机制：Windows 上对自身 socket 的
  `shutdown` 不会取消进行中的 read，掐 socket 只作为 Unix 上让读线程立即退出的
  补充。停机窗口内新接受的连接不再服务，直接关闭（shutdown 是全局生效的 kill
  语义，设计允许的瞬时状态）。
- 停机收尾有等待上限（5s）：到点仍有连接没收尾就带着诊断退出，不让一条收不动的
  连接挂死 `kill`。Core 还有 stdin EOF 的兜底：daemon 进程退出后各 Core 读到 EOF
  自行退出。
- 控制连接开启 TCP keepalive（空闲 45s 起、每 10s 探、3 次无应答判死）：SSH 接入时
  对端是本机 sshd，探活无意义但无害；对端消失后读线程等不到 EOF 时，keepalive 是
  socket 层的回收手段（心跳超时兜底控制帧层的沉默）。
- daemon 的诊断按行原子追加到 `logs/core-daemon-<指纹>.log`（`start` 以追加模式把
  stderr 重定向到它）：全部诊断先整行格式化再一次写入（stderr 锁内），多线程并发不丢行、
  不交错半行；追加模式（O_APPEND）保证每次 write 原子落到文件尾。
- 崩溃诊断：进程入口安装 panic 钩子（`util::install_panic_hook`），panic 位置与强制
  捕获的调用栈整块写进上述日志（默认钩子依赖 `RUST_BACKTRACE`，没人设它）；daemon
  实体在 `run_start_daemon` 入口再换成 `util::install_panic_hook_with_file`——除 stderr
  外**直接追加**写同一份日志文件，手动从终端拉起（stderr 不是文件）时崩溃照样留痕。
  daemon 的启动 / 停止、控制连接接入 / 关闭、Core 子进程启动（含 pid）与信号终止
  （Unix）各落一行锚点。release 构建不 strip 并保留行号表（`core-rs/Cargo.toml` 的
  `[profile.release]`；Windows 的行号表在 `.pdb` 里，由 `scripts/build-core.mjs` 随
  可执行文件一并部署），栈帧才能符号化出函数名与行号。

### 2.6 远端目录选择

- `listDirectories { path }`：`path` 为 `null` / 空串时从目标机器的主目录开始；
  返回该目录的子目录（按名字排序）与上级目录。
- `createDirectory { path }`：新建目录，父目录不存在时一并创建；返回实际路径。
- `renameDirectory { path, name }`：重命名目录，只换同一父目录下的名字。`name` 必须是纯名字
  （不含分隔符、不是 `.` / `..`），目标已存在时拒绝、不覆盖；改名与移动是两件事，不开放移动。
- `deleteDirectory { path, recursive }`：删除目录。`recursive` 为 `false` 时只接受空目录，
  非空回 `directoryFailed` 且 `reason = 'notEmpty'`；Host 据此把删除升成「目录非空，
  连同其中的全部内容一起删除？」的**第二次确认**，确认后才带 `recursive = true` 重发。
- 无论哪种模式都拒绝文件系统根（`/`、`C:\`）：删根几乎一定是操作失误。
- 三个动作的路径都必须是绝对路径：Host 拿到的目录名要能直接当工作区路径用。
- 只列子目录，不列文件；Host 在控制通道建立后立刻请求一次，据此弹出远端目录选择器。
- 选择器页面是 `electron/remoteWorkspace/`（vite 产物，加载 `dist/remoteWorkspace/index.html`）：
  路径可编辑、列表首行是 `..`（上级）、工具栏可新建文件夹。破坏性操作不进常显 UI：
  右键目录行弹出「重命名 / 删除」菜单，选中后在该行内联编辑（重命名直接改名字；
  删除空目录一次确认、非空目录二次确认后递归删除）。
- 路径输入停顿 50ms 后刷新列表（`electron/remoteWorkspace/pathInput.ts` 负责拆分）：
  末段带分隔符（`/workspace/a/`）表示「这一级敲完了」，列它自己；末段没有分隔符
  （`/workspace/a`）表示最后一段是**前缀过滤词**，列父目录再筛——`a` 与 `abc` 同时显示，
  不进 `a`。过滤只作用于目录名——daemon 的目录列举本来就只回目录、不含文件。
- 列表按输入**预览**，不回写输入框（用户还在敲）：预览失败是静默的，只有回车（补全之后的）
  跳转失败才给明确错误。
  过滤是渲染期视图：列举结果整份保留，回写路径框（预览之外的任何一次重画）即放弃过滤、
  列表回到该目录的全部内容——在输入框里删掉最后一段后不会停在上一轮的过滤结果上。
- 列表恒有选中项（默认第一项，`..` 除外——`..` 只能靠上下键选到）：上下方向键 / `Ctrl+N` /
  `Ctrl+P` 移动选中项（到头即停，选中行滚进可视区）；`Tab` 把选中项补全进路径框（光标到
  末尾）并**始终带上尾分隔符**——候选全是目录，选中即「这一级敲完了」，预览随即展开它的
  内容（连按 `Tab` 逐级往下）；回车在有选中项时**直接进入**该目录（路径框回写自带尾分隔
  符），没有选中项（过滤无匹配 / 路径框指向别处）时按输入框原文跳转，由跳转给出明确错误。
  「打开此目录」在路径框停在候选前缀上时同样作用于选中项。
  选中项为渲染期状态：每次列举 / 预览后回到第一项，当前选中项被过滤掉或删掉时也回到第一项。
- 路径框是这一步唯一常驻焦点的控件：列表、工具栏、右键菜单上的鼠标按下都不抢焦点
  （行内编辑的输入框除外），焦点落到页面容器上时收回路径框。窗口不建菜单栏
  （Windows / Linux 下 `setMenu(null)`）：Alt 不呼出菜单。

### 2.7 本地同机不走 daemon

- 本地同机的工作区由 Host 直接用 `stdio` 起一个 Core 进程（`createStandaloneCoreBus`），
  stdio 是帧通道：不监听端口，也不经过 daemon。
- daemon 只服务远程 endpoint（`ssh` 接入）。因此端口只对远程接入有意义。

### 2.8 SSH 接入（`ssh` scheme）

目标机器只开放 SSH 端口、daemon 端口映射不出来时，用 `ssh` 接入：**全部通信走 SSH 端口**，
不需要端口映射，也不需要目标机器预装任何东西（Host 侧用 `ssh2` 库实现 SSH 客户端，
不依赖系统 OpenSSH）。

建链（`src/host/standalone/sshTransport.ts`）：

1. 按 SSH 的 host / port / user / 口令建立连接（口令鉴权；主机密钥首次记录、之后不一致
   即报错，指纹存 `~/<configDir>/known-hosts.json`。指纹变更时宿主弹告警展示新旧指纹，
   用户确认后经 `recordKnownHostFingerprint` 把新指纹写回再重连——
   模块本身不提供「跳过校验」的连接方式）；
2. 引导远端 daemon（`sshDaemonBootstrap.ts`，见下）；
3. 在远端开一条 `direct-tcpip` 转发通道到该 daemon（等价于 `ssh -W`），它就是要用的
   控制通道；控制帧与 [docs/core/standalone-core.md 第 5.2 节](standalone-core.md#52-帧类型)完全一致。

引导的分支（按顺序判断）：

| 情况 | 判据 | 行为 |
| --- | --- | --- |
| 该指纹的 daemon 在跑 | 该指纹的状态文件 `core-daemon-<指纹>.json` 里的 endpoint 探得通 | 直接复用：不重启 daemon、不覆盖产物；槽位缺可执行文件或共享位缺 `ripgrep` 时补传（「在跑」不等于产物齐全——槽位被外部清过时进程仍在跑） |
| 已部署未启动 | `~/.local/share/<core.deployPrefix>/<指纹>/` 里有可执行文件、探测不通 | 补齐缺的自带 `ripgrep`（若缺），执行 `<可执行文件> start --idle-exit 30`（幂等），再读状态文件 |
| 未部署 | `~/.local/share/<core.deployPrefix>/<指纹>/` 里没有可执行文件 | 上传本机携带的对应平台产物（按远端 `uname -sm` 选平台）后 `start --idle-exit 30` |

- 部署槽位由本机携带产物的**构建指纹**决定（[docs/core/standalone-core.md 第 3.4 节](standalone-core.md#34-构建指纹)）：
  产物落远端部署槽位 `~/.local/share/<core.deployPrefix>/<指纹>/`
  （`coreDeployDirPath`：产品目录取 `core.deployPrefix`，槽位用完整指纹；自带的
  `ripgrep` 提升为产品目录根的共享位 `share/<core.deployPrefix>/ripgrep`，Core 以
  所在槽位的上一级目录定位它，远端机器不需要预装 `rg`），状态 / 日志文件按
  完整指纹命名（第 2.3 节）。多版本 Core 在同一台远端机器上各占一个槽位、各跑
  一个 daemon——不同版本的客户端同时接入互不干扰：新版本天然落在新槽位，旧 daemon
  原样留给旧版本的客户端。
- 「指纹槽位存在即视为同版本」：指纹只由源码内容与编译器身份决定，同一指纹的产物
  行为一致，因此可执行文件存在就不再上传，**不做产物哈希比对**——缺失才部署，
  不无脑覆盖。
- SSH 引导以 `start --idle-exit 30` 启动 daemon：daemon 恒绑 `127.0.0.1`、端口交给内核
  分配（第 2.2 / 2.3 节）——转发连接从远端本机发起，端口不出机器；多版本 daemon
  并存时互不抢固定端口，实际端口随状态文件读回。
  `--idle-exit 30` 让 daemon 在最后一条控制连接断开后自行退出（第 2.5 节）：客户端
  crash / 断电后远端不留常驻进程，「拉起后无人接入」的孤儿 daemon 也由同一条规则兜底。
- 上传走**客户端唯一暂存名 + `mv` 原子换名**：目标可能正被一个在跑的 daemon 执行（它的指纹目录
  被清过、状态文件丢失时宿主无从得知它在跑），对执行中的文件直接覆盖写是 `ETXTBSY`
  （SFTP 报 `Failure`）；`mv` 只换目录项，运行中的进程继续用旧 inode。暂存名带客户端
  的 pid + 随机数后缀：两台机器的客户端同时首次部署同一槽位时各写各的暂存文件，
  不会交错损坏同一个文件，换名后谁先谁后落地的都是完整产物；上传失败时客户端清掉
  自己的暂存，不在远端槽位留半截产物。
- 状态文件缺失时按「没有 daemon」处理（与 `start` 同口径）：若该指纹的 daemon 实际
  仍在跑并占着端口，重新 `start` 的 daemon 由内核分配新端口并在新的状态文件里登记，
  宿主跟着状态文件接入——旧 daemon 成为无状态文件的残留，需要时用该指纹的二进制
  `kill` 清理（`/proc` 兜底按可执行文件路径精确匹配，只命中本指纹的 daemon）。
- 指纹槽位**不做磁盘回收**：多版本累积（每个槽位约 11MB）是接受的语义，需要清理时
  在远端手工删除——先确认该指纹的 daemon 不在跑（状态文件探得通的就是在跑的）。
- 本机产物里没有指纹文件或缺自带的 ripgrep 属于构建不完整，直接报错，不静默降级。
- daemon 的端口 **以远端状态文件为准**（第 2.3 节）：Host 读
  `~/<configDir>/run/core-daemon-<指纹>.json`，按里面的 `127.0.0.1:<端口>` 开转发通道。
- 状态文件缺失 / 损坏 / 连不上都按「没有在跑」处理，与 `start` 自己的判据同口径。
- 任何一步失败都直接报错（`start` 的退出码与 stderr 一并带回宿主），不回退到「先连上
  再说」。
- SSH 连接的生命周期就是控制通道的生命周期：SSH 断开等于控制通道断开，该连接上的
  全部 Core 一并关闭（其余连接不受影响，见第 2.5 节）。
