# 任务分解：Overlay 挂载改由常驻 root 代理持有命名空间

spec 见 [spec.md](spec.md)，方案见 [plan.md](plan.md)。勾选状态即进度。

> **架构修订说明**：原 T007 / T011 / T012 / T021 按「Core `exec` 自身进命名空间」实现，
> 该形态在真实远端导致 daemon 反复重启。本次按 FR-007 / FR-007b 改为「常驻代理持有命名
> 空间」，相关任务重写为 T030 起。

> **进度已复位**：上一轮实施完成过的任务曾全部勾选，但那份代码已整体还原到库上版本
> （原因与保留的结论见 [spec.md 的实施现状](spec.md#实施现状)）。**所有任务重新从零开始**，
> 勾选状态只反映当前工作树的真实状态，不复用上一轮的勾选。
>
> **重新实施前先读** [plan.md 的实施注意事项](plan.md#实施注意事项)：跨平台编译、CRLF 脚本
> 编辑、crate 门禁覆盖与本机测试能力边界四条会直接决定这轮能否收敛。
>
## 1. 工程变量与构建接线

- [x] **T001**（FR-005）：`src/config/project.json` 增 `core.mountProxyName` / `core.mountProxyDir`；`src/config/project.ts` 导出 `CORE_MOUNT_PROXY_NAME` / `CORE_MOUNT_PROXY_DIR`；`core-rs/build.rs` 烧 `TC_MOUNT_PROXY_NAME` / `TC_MOUNT_PROXY_DIR` / `TC_CORE_BINARY_NAME`。完成判据：`npm run check-types` 绿，`npm run test:unit -- brand-literal` 绿。
- [x] **T002**（FR-005）：新建 `mount-proxy-rs/` crate（纯 std、零第三方依赖、`[[bin]]` 中性名），加入 `package.json` 的 `fmt:rust` / `fmt:rust:check`。完成判据：`cargo build --manifest-path mount-proxy-rs/Cargo.toml` 在 Linux 目标上产出可执行文件。
- [x] **T003**（FR-005）：`scripts/build-core.mjs` 在 Linux 目标构建代理并落位成 `resources/<core.resourceDir>/<dir>/<core.mountProxyName>`；Windows 目标跳过并打印原因。完成判据：`npm run build:core:linux-x64` 后产物存在。

## 2. 代理实现（`mount-proxy-rs`）

- [x] **T004**（FR-006）：入口自检（euid==0 / real uid != 0 / uid 允许列表 / 目标 fd 校验 `S_ISREG` + 属主 + `mode&022==0`）。完成判据：纯函数矩阵单测覆盖各拒绝分支。
- [x] **T005**（FR-006）：请求收紧（bounding set 裁三项、`umask(077)`、`chdir("/")`、信号处置复位、不读环境变量）+ 静态链接约束。完成判据：单测断言 bounding set 与信号处置。
- [x] **T006**（FR-006）：特权阶段（fork → PDEATHSIG + 回读父 pid → 子 `CLONE_NEWUSER` → 父写 `setgroups`/`uid_map`/`gid_map` → 父降权并断言 → ack → 子 `CLONE_NEWNS` + private + NNP）。完成判据：特权车道断言 `uid_map` 一行、`CapEff` 含 `CAP_SYS_ADMIN`、父进程降权后 `getuid()` 为真实 uid。
- [x] **T008**（FR-005）：`--self-check`（建 ns + 挂 overlay + 四项断言 + 卸载）与 `--protocol-version`。完成判据：自检在不满足条件的机器上非零退出并点名断言。
- [x] **T009**（FR-005）：安装模式（从 stdin 读内容、`mkstemp`、`fchown`/`fchmod` 在 rename 前、`renameat`、`fsync`、回显 sha256、祖先校验、`nosuid` 拒绝、产品子目录创建、uid 列表写入）。完成判据：单测覆盖每条拒绝分支与「内容相同不重写」。
- [x] **T030**（FR-007b / FR-006）：删掉旧 T007 的「监督目标程序」循环。A 写完映射后 `setresuid` 降权、**保持存活**只做 `waitpid(B)`；B 成为常驻代理本体、不 `exec` 任何目标。完成判据：单测断言 A 降权后 `geteuid()` 为真实 uid、B 存活且命名空间内 `getuid()` 为 0、A 不持任何特权。
- [x] **T031**（FR-007b）：新增 `--serve` 形态与 `serve.rs` 常驻循环：在传入的 fd 上收帧、按请求 `fork` 工具子进程、回传 stdout / stderr / exit。完成判据：假 Core 桩驱动一次 `spawn` 与一次 `listDir` 走通。
- [x] **T032**（FR-007 / FR-007b）：`protocol.rs`：与 Core 共用的帧定义（长度前缀 + JSON）。字段变更必须两侧同步并由单测锁死；运行期协议版本与安装握手版本分开。完成判据：两侧各自解析同一份 fixture 成功。
- [x] **T033**（FR-007b）：回收链——A 的 `PDEATHSIG` 指向 Core 作兜底，B 的指向 A；**主路径是 socketpair EOF**：Core 死 → fd 关闭 → B 读 EOF 退出 → A 的 `waitpid` 返回。完成判据：Core 被 `SIGKILL`（不给任何清理机会）后 A 与 B 在 1 秒内消失，`ps` 无残留。
- [x] **T044**（FR-007）：fd 纪律——Core ↔ 代理 socketpair 两端、A ↔ B 之间所有 fd 设 `CLOEXEC`；工具子进程只继承自己的 stdin / stdout / stderr。完成判据：单测断言工具子进程的 `/proc/self/fd` 里没有通信 fd。

## 3. Core 侧

- [x] **T010**（FR-001）：`work_view::Capabilities` 增 `mount_proxy` / `deployable` 字段；`deployable` 只在 Core 一处推导。完成判据：单测锁定三种组合（可用 / 需部署 / 不可解）。
- [x] **T013**（FR-001）：`dispatch_ui_request` 应答四字段。完成判据：`storageCapabilitiesRouting` 类测试断言字段完整。
- [x] **T014**（FR-010）：`ToolContext.work_view` 改判别联合（`workspace` / `view` / `viewUnavailable`），`io_path` 第三态报错；`ensure_work_view` 返回三态。完成判据：视图不可用时 Read / Write / Edit / Grep / Glob 全部报错且不写磁盘。
- [x] **T015**（FR-010）：能力不可用时拒绝把 `storage: isolated` 写进 `meta.json`。完成判据：单测断言 meta 不含 isolated 且回推事实。
- [x] **T016**（FR-011）：`UiEvent.conversationStorageConverted` + core 侧处理。完成判据：转换后工具读写真实磁盘、归属落盘为 workspace。
- [x] **T034**（FR-007）：重写 `core-rs/src/mount_proxy.rs`：**删除** `bootstrap()` / `reexec_through_proxy` / `BOOTSTRAP_MARKER`；改为 `ProxyClient`——定位代理、校验安装握手版本、`spawn --serve` 并持有 socketpair。完成判据：单测断言「代理不可执行 / 版本不匹配 / 允许列表拒绝」三种情形都只把状态记为 absent、进程不退出。
- [x] **T035**（FR-007）：`core-rs/src/main.rs::run_core` 删除 `mount_proxy::bootstrap()` 与 `work_view::enter()` 的代理分支；`work_view_linux.rs` 删除 `enter_in_place` / `write_id_maps` / `finish_mount_namespace`。完成判据：`rg 'unshare' core-rs/src/` 零处命中（挂载已在 B 里做完，工具不再自己 unshare）；`rg 'probe_overlay|entered\(' core-rs/src` 只余 ProxyClient 连接判据。
- [x] **T036**（FR-007 / FR-007b）：`mount_proxy/client.rs` + `exec.rs`：帧收发、代执行 `spawn` / `readFile` / `writeFile` / `listDir` / `mkdirAll`。完成判据：假代理桩驱动各请求；代理中途消失时该次调用报错、Core 不断帧通道。
- [x] **T037**（FR-007）：`mount_proxy/overlay.rs`：`mountOverlay` / `unmountOverlay` 经代理执行；**`probe_overlay()` 与 `mounted_at()` / `umount_all()` 搬进代理**（Core 没有 `CAP_SYS_ADMIN`、也看不到 B 的 mountinfo）；`work_view_linux.rs` 的视图登记改为向代理请求。完成判据：能力判据仍由「代理就绪 + 代理报回 overlay 可挂」推出；`rg 'probe_overlay|mounted_at|umount_all' core-rs/src` 只余代理侧实现；并发首次调用不叠挂。
- [x] **T038**（FR-007 / FR-010）：`tools.rs` 与 `git_view.rs` 在视图路径下的 IO 改走代执行；视图不可用时仍 fail-closed。完成判据：既有 T014 的断言全绿，且工具进程的 `unshare(CLONE_NEWNS)` 分支删除或标注不再使用。
- [x] **T039**（FR-007）：`workViewFilesRequested` / `workViewChangesRequested` / `workViewFileDiffRequested` 改走代执行（原先直接读挂载点）。完成判据：假代理桩断言三个请求都经过代执行通道，且返回形状与既有契约一致。
- [x] **T040**（FR-007）：代理运行中被杀后的恢复：能力改判 absent、下次需要时重新拉起、不重启 Core。完成判据：单测模拟代理退出后 `storageCapabilitiesRequested` 回 absent，下一次 `spawn` 请求触发重新拉起。

- [x] **T048**（FR-006 / FR-007b）：给 `mount-proxy-rs` 补 `#[test]`（当前为 0 个）：入口自检各拒绝分支、bounding set 裁剪、id 映射内容、`--serve` 的帧解析。特权阶段与信号语义无法在单测里跑，明确划到远端手工车道（T025）。完成判据：`npm run test:mount-proxy` 有实际断言数，T004 / T005 / T006 的判据据此改写。

## 4. 宿主侧

- [x] **T017**（FR-003 / FR-004）：`src/host/mountProxyInstall.ts`：`sudo -n` → 三选一提权（sudo 密码 / root 密码 / 零密码命令）、单行写 stdin 后立即关闭、不进 argv/env/日志、失败可换来源重试（不设次数上限）、sha256 比对、审计行。完成判据：单测覆盖每条分支与连试多次仍可重试。
- [x] **T027**（FR-002）：入口渲染判据改为 `isolatedWorkView || deployable`，能力可用时即使代理未装也不渲染部署提示。完成判据：e2e 覆盖「无需代理的机器不弹框」。
- [x] **T018**（FR-003）：`sendMessage` 前的部署闸门（判据 `isolatedWorkView == false && deployable == true`）。完成判据：能力可用但代理未装时不弹框。
- [x] **T019**（FR-003 / FR-004）：wire 消息 4 个 + `webviewMessageHandler` 翻译 + 凭据消息不进日志钩子。完成判据：单测断言凭据不入日志。
- [x] **T020**（FR-003 / FR-004）：`MountProxyDialog.tsx`：确认（四要素文案）/ 三选一 / 遮蔽输入 / 进度 / 失败重试（不限次数）/ 成功不弹提示（`done` 收起对话框）；i18n 中英。完成判据：e2e 覆盖。
- [x] **T022**（FR-009，部分）：`sshDaemonBootstrap` 的 `ensureRemoteMountProxy` 把代理上传到远端指纹槽位（与 Core 二进制同目录）；`mountProxyExec` 的 `installOptionsFor` 按会话工作区在本地 / SSH 出口间切换；`targetHostOf` 让确认框点名真实主机。完成判据：`mountProxyRemoteWiring` + `sshDaemonBootstrap` 单测绿。
- [x] **T021**（FR-008）：部署成功后**重查能力**（不再要求重启 Core）→ 重发被拦消息。**同时删除** `src/host/mountProxyGate.ts` 的 `finish()` 里 `restartCore()` 调用、那段「必须重启」注释与 `MountProxyGatePort.restartCore` 成员。完成判据：假 Core 桩单测走完整条链路，且 `rg 'restartCore' src/host/` 零命中。
- [x] **T041**（FR-009）：远端提权安装编排：远端 `sudo -n` 不可用时的三选一凭据采集、`requiretty` 判定、零密码通道。完成判据：假 SSH 单测覆盖三条来源；真实远端跑通。

## 5. 文档与门禁

- [x] **T023**（全部 FR）：新增 `docs/core/mount-proxy.md` 与 `docs/adr/0017-root-mount-proxy.md`；同步 [docs/core/conversation-work-view.md](../../docs/core/conversation-work-view.md)、[docs/core/standalone-core.md](../../docs/core/standalone-core.md)、[docs/core/core-remote.md](../../docs/core/core-remote.md)、[docs/hosts/product-identity.md](../../docs/hosts/product-identity.md)、[docs/architecture/events.md](../../docs/architecture/events.md)、[docs/architecture/host-ui-modules.md](../../docs/architecture/host-ui-modules.md)、[docs/README.md](../../docs/README.md)、[docs/features/user-stories/dialog-core.md](../../docs/features/user-stories/dialog-core.md)。完成判据：`npm run test:unit -- docs-lint` 绿。
- [x] **T024**（全部 FR）：`e2e/webview/overlayMountProxy.spec.ts`（确认 / 取消 / 三选一 / 遮蔽 / 不限次数重试 / 成功不弹提示 / 模态层）。完成判据：`npm run test:e2e:local -- overlayMountProxy` 绿。
- [x] **T049**（FR-001 / FR-002 / FR-003 / FR-004 / FR-009 / FR-010 / FR-011 / FR-012）：写 E2E 测试计划（[plan.md 的 E2E 测试计划](plan.md#e2e-测试计划)：分层、真机实测前置、用例清单、选择器与 wire 协议契约）并落地三条用例文件——`e2e/webview/overlayMountProxy.spec.ts`（12 条）、`e2e/electron/overlayMountProxyLocal.spec.ts`（3 条）、`e2e/electron/overlayMountProxyRemote.spec.ts`（5 条 + `privileged` 段 5 条）；新增 `e2e/helpers/mountProxyFeature.ts` 作为临时启用开关（用例先于实现落地，缺省跳过、实现后设 `<envPrefix>_E2E_MOUNT_PROXY=1` 跑红绿）；`REMOTE_SSH_SPECS` 登记新远端文件；`e2e/README.md` 结构表同步。完成判据：`npm run check-types:e2e` 绿；两条车道用例可收集且缺省全部 skipped（原因指向「实现未落地」）；置开关后首轮红（缺 `data-*` 选择器与 wire 分支），实现落地即转绿。
- [x] **T050**（全部 FR）：T024 / T025 勾选时删除 `e2e/helpers/mountProxyFeature.ts` 与三条用例文件里的 `test.skip(!mountProxyE2EEnabled(), ...)` 调用——用例不再有跳过分支（`/converge` 核对该文件已不存在）。完成判据：`rg 'mountProxyFeature' e2e/` 零命中，且三条文件在默认环境直接执行。
- [x] **T028**（FR-012）：文档化幂等卸载命令 + 安装 / 升级写审计行（主机名、落点、sha256、安装者 uid）。完成判据：单测断言审计行形状、卸载命令在真实远端可执行。
- [x] **T046**（FR-007）：新增 `docs/adr/0018-resident-mount-proxy.md`（采纳常驻形态，记录被否决的 `exec` / `setns` / 代理作父进程三条），把 `docs/adr/0016` 状态改为「被取代」并指向 0017，登记 `docs/adr/README.md` 索引。完成判据：`npm run test:unit -- docs-lint` 绿。
- [x] **T045**（全部 FR）：`fmt:rust` / `fmt:rust:check` 加入 `mount-proxy-rs`（此前从未被检查，加入后首个 `fmt:rust` 已修正存量格式）；新增 `test:mount-proxy` 并挂进 `test:core`；`AGENTS.md` 的「三个 crate」改「四个」。完成判据：`npm run fmt:rust:check` 与 `npm run test:mount-proxy` 均可执行。
- [x] **T047**（FR-011）：补 `UiEvent.conversationStorageConverted` 联合成员 + `docs/architecture/events.md` 的 UiEvent 表行 + 数量校验（事件总数 84 → 85、UiEvent 29 → 30）。此前是「Core 有处理分支、契约没登记」，TS 侧发这个事件会类型报错。完成判据：`npm run check-types` 与 `docs-lint` 绿。
- [x] **T042**（FR-007 / FR-007b）：重写 [docs/core/conversation-work-view.md 第 4 节](../../docs/core/conversation-work-view.md#4-命名空间)（新拓扑 + 为何不用 `setns`）、[docs/core/standalone-core.md 第 6 节](../../docs/core/standalone-core.md#6-生命周期)（进程链改为「宿主 → Core → 常驻代理 → 工具」）；新增 `docs/core/mount-proxy.md` 的「特权阶段时序与加固」与「进程链与生命周期」两节（`--serve` 形态与父进程即退）随 T023 一起建。完成判据：`npm run test:unit -- docs-lint` 绿。
- [x] **T043**（FR-007 / FR-007b）：回归用例——「槽位里有 0755 产物但未安装时 Core 正常启动、能力回 absent」「代理运行中被杀不影响帧通道」「用户从不使用 Overlay 时不拉起代理」。完成判据：三条用例先红后绿。
- [x] **T025**（FR-005 / FR-006 / FR-009）：用 `e2e/environments.json` 的真实远端跑一遍：上传代理 → 提权安装 → 自检 → Overlay 对话工具读写隔离。完成判据：远端 `mountProxy: 'ready'`、工具改动不落磁盘、`mountinfo` 无泄漏。
- [x] **T026**（全部 FR）：全量门禁：`npm run check-types` / `npm run lint` / `npm run fmt:rust:check` / `npm run test:unit` / `npm run test:core`。完成判据：全绿。

## 依赖关系

- T002–T009 依赖 T001。
- T010 / T013 / T014 / T015 / T016 已落地，新架构沿用。
- **T034 是本次的起点**：它删除旧 bootstrap 并引入 `ProxyClient`，T035–T040 都依赖它。
- T030 / T031 / T032 / T033（代理侧）与 T034 / T036（Core 侧）可并行，但要靠 T032 的协议
  定义对齐。
- T037 依赖 T031 + T036；T038 / T039 依赖 T037。
- T021 / T041 / T042 / T043 / T025 / T026 最后。
