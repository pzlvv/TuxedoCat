# e2e 场景级测试（Playwright）

以真实用户操作（输入、点击、悬停、快捷键）驱动的场景级端到端测试，需求基线是
`docs/features/user-stories.md`（每条用例标题标注覆盖的 `US-xx`，`US ↔ 用例` 映射与
未覆盖豁免段见该文件的附录）。七个 project 对应六层（`electron-app` 与 `electron-ssh`
同属整应用层：后者要外部 SSH 环境，拆开是为了让没有远端机器的开发机与 CI 车道各自独立跑；
`pycharm-plugin` 为本地车道，见下表末行）：

| project | 层级 | 驱动对象 | 宿主侧 |
| --- | --- | --- | --- |
| `webview-ui` | webview UI | Chromium 加载构建产物 `dist/webview/index.html` | 假宿主（`helpers/fakeHost.ts`）按 `src/host/webviewMessages.ts` 协议应答 |
| `electron-app` | 整应用 | 真实 Electron 应用（`dist-electron/main.cjs`） | **standalone core**（Rust，`dist/resources/core/`，先 `npm run build:core`）+ 本地 mock LLM SSE 服务器（`helpers/mockLlmServer.ts`） |
| `electron-ssh` | 整应用（真实 SSH 远端） | 同上，工作区为 `ssh://` 远端（`e2e/environments.json` 的 ssh 段） | 远端机器上的 standalone core：SSH 建链 → 上传 Core / ripgrep → 远端 daemon 引导（`docs/core/core-remote.md`） |
| `remote-workspace-ui` | 远端目录选择器页面 | Chromium 加载构建产物 `dist/remoteWorkspace/index.html`（`electron/remoteWorkspace/`） | 假 `window.remoteWorkspaceAPI`（内存目录树）：这一步要连真实 SSH 才走得到，整应用 e2e 覆盖不了 |
| `terminal-ui` | 远程终端页面 | Chromium 加载构建产物 `dist/terminal/index.html`（`electron/terminal/`） | 假 `window.terminalAPI`（内存标签表 + 回显 shell）：同上，真实链路要连 SSH |
| `tui-installer` | TUI 分发 | TUI 版安装程序（`release/tui-installer/`，用例内构建宿主平台） | 内嵌 Core / ripgrep / TUI bundle 的自解压安装与启动（`docs/features/tui-installer.md`） |
| `pycharm-plugin` | PyCharm 插件分发 + IDE 内链路 | 分发 zip 结构核验（无 IDE）；本机 PyCharm 沙箱化拉起，JCEF 面板经 CDP 驱动 | 插件自带 standalone core（zip 内四平台产物）+ 本地 mock LLM（`helpers/pycharmIde.ts`） |

## 运行

前置：构建产物必须存在（配置文件加载时校验并给出提示）。

```bash
# 首次：构建被测产物 + 安装浏览器
npm run build:webview && npm run copy-assets && npm run build:electron
npx playwright install chromium            # 网络受限时：PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright/

npm run test:e2e            # 全部（七个 project，串行，workers=1）
npm run test:e2e:local      # 除真实 SSH 远端外的五个 project（= CI 的 ui / electron / tui 三车道同集，test:all 收的就是它）
npm run test:e2e:webview    # 仅 webview UI 级
npm run test:e2e:electron   # 仅 Electron 整应用（不需要 SSH 环境）
npm run test:e2e:ssh        # 仅真实 SSH 远端车道（需要 e2e/environments.json）
npm run test:e2e:pycharm    # 仅 PyCharm 插件车道（本地车道：需要 e2e/environments.json 的 pycharm 段 + npm run package:pycharm 产物）
npm run test:e2e:remoteWorkspace   # 仅远端目录选择器页面
npm run test:e2e:terminal   # 仅远程终端页面
npm run test:e2e:tui        # 仅 TUI 安装程序

# 真实 SSH 车道的单文件跑法（远端是 Linux 时本机必须携带对应 Core 产物）
npm run build:core:linux-x64
npx playwright test -c e2e/playwright.config.ts --project=electron-ssh remoteChangeList
```

远端车道里 Core 跑在测试机上，要回连本机的 mock LLM。mock 经 **SSH 反向隧道**暴露到
测试机回环（`startMockLlm` 的 `reverseTunnel`，端口由远端分配），因此本机在 NAT 后也能跑，
`environments.json` 不需要额外配地址。

早期版本让远端直连本机内网地址（`llmAdvertiseHost`），本机在 NAT 后时那条路不通，
症状是**0 个模型请求、界面一直转圈**——看起来像工具链缺陷，其实是 mock 不可达。
需要直连时仍可配 `llmAdvertiseHost`（隧道优先，两者不冲突）。

Electron 用例不需要 Playwright 的 Chromium，用项目自带的 `node_modules/electron`。

Windows 上若 Smart App Control 处于评估 / 开启态，tui-installer 车道会被本机安全策略
拦下刚构建的无签名安装器（spawn EACCES）：车道按环境前置显式跳过并单列原因，
在 CI 与不受影响的机器上照常真跑。

排查：`E2E_DEBUG=1 npm run test:e2e:electron` 会把应用主进程日志透传到测试输出；
失败时 Playwright 输出 trace（`npx playwright show-trace <zip>`）。

## 时间预算（实测基线）

判断「是环境慢还是用例有问题」先看这张表，别凭感觉归因。数值来自 run
`44962124641`（托管 runner 1 核 + 真实 SSH 远端）与本机（Windows）的同一批用例。

| 指标 | 实测 | 说明 |
| --- | --- | --- |
| 本机→远端 TCP 握手 RTT | 16ms | 网络不是瓶颈 |
| 本机→远端 SSH 建链 + `exec true` | ~350ms | SSH 不是瓶颈 |
| sshd 反向 DNS 解析 | 关闭（`no`） | 无反向 DNS 拖慢（曾是被怀疑项） |

单条用例的 CI / 本机放大倍数随「是否启 Electron」分档：

| 用例类型 | 本机 | CI | 倍数 |
| --- | --- | --- | --- |
| 只走 `sshExec`（不启 Electron） | 8.5s | 12.4s | 1.46× |
| 启 Electron + 恢复远程工作区 | 13.4s | 31.9s | 2.38× |
| `overlayMountProxyRemote` 全 18 条 | — | 中位 31.9s / 最长 49.1s（`US-60 FR-009` 两轮工具轮次 + 第二个工作区，体内放宽到 180s） | — |

**放大集中在 Electron 冷启动，不在网络。** 结构性原因是每条用例都完整走一遍
`startMockLlm`（开反向隧道）→ `launchApp` → 等远程工作区恢复 → `afterEach` 的
`resetRemoteDaemon`（轮询远端 Core 退出，间隔固定 2s）。`workers: 1` +
`fullyParallel: false` 让这些开销逐条叠加。

整应用车道另有一个**已知未定位**的固定开销：凡是「加第二个工作区再切回去」的用例，
CI 上稳定多花约 30s（`fileExplorer.spec.ts` 的五条、`sessions.spec.ts:203`、
`desktopShell.spec.ts:339`，实测 30–34.3s；同一份用例在 Windows 开发机 2–4s）。它不是
断言里的合法等待——`e2e-debug` 车道单跑其中一条耗时 42.3s，主进程日志在最后 30s
里完全静止。排查方向见已知坑 19；在那之前 60s 档就是为它留的。

超时预算（`e2e/playwright.config.ts`）分三档，**用例超时是「链路断了」的信号，不是
「环境慢」的信号**：

| 闸门 | 取值 | 覆盖 |
| --- | --- | --- |
| 单用例（默认档） | 30s | `webview-ui` / `remote-workspace-ui` / `terminal-ui`：实测最长 13.1s |
| 单用例（整应用） | 60s | `electron-app`：实测 p90 12.3s，最长 34.3s（上一条的固定开销） |
| 单用例（真实 SSH） | 60s | `electron-ssh`：实测中位 41s；确需长等待的用例在**用例体内** `test.setTimeout()` 放宽并写明实测值 |
| 单用例（安装程序 / PyCharm） | 5min | `tui-installer` 的 `beforeAll` 要 cargo 构建安装器（project 的 `timeout` 才是 `beforeAll` 的预算）；`pycharm-plugin` 要起 IDE |
| 单断言 | 30s | 全部 project |
| 整轮 | 15min（仅 CI） | `globalTimeout`：一个 Playwright 调用 = 一个 CI 车道 |
| 失败早停 | 5 条（仅 CI） | `maxFailures`；`retries: 0`——重试会把失败墙钟翻倍 |

真出现超时时按已知坑 10 / 11 / 17 的顺序查：先看是否远端残留 daemon 拖住建链，再看
是否 `launchApp` 的 CDP 握手全超时（3 次 × 60s）留下了垂死的 Electron 进程树。

整轮墙钟（30 分钟预算，run `45140464709` 与 `45177031308` 的实测分项）：`smoke` 与
`prepare` 并行，`prepare` 3.9–4.0min → 四个车道并行，`e2e-electron` 12.8–14.7min，
`e2e-tui` 2.1–2.5min，`e2e-ui` 4.5–4.9min。

`e2e-ssh` 的墙钟由**自托管 runner 的数量**决定，不由编排决定：标签下只有一台机器，
四个矩阵 job 串行排队，合计 25.4–25.7min（run `45177031308` 的四个 job 依次
12:47:46 → 12:52:26 → 12:57:18 → 13:01:51 启动），因此这条车道就是整条 `all` 的关键路径，
全程 29.9min。其中每个 job 的固定开销（npm ci + 分片取产物 + apt + install-deps）约
2.5–3.5min，乘以四份；`ARTIFACT_CACHE_DIR` 让后三个 job 复用第一个 job 下好的产物，
省掉每轮三份重复下载（实测单份 22.7–149.5s）。

最坏情况由 job 上限兜住：`prepare` 8 + 车道 18 = 26 分钟。

## CI 车道（`.github/workflows/all.yml`）

e2e 在全量回归工作流 `all.yml` 里跑：合入 main 后整点定时（每小时）+ 手动 dispatch。
MR 的合入闸门是冒烟工作流 `smoke.yml`（文档守卫 + 编译类检查 + 单测 + Rust 测试 +
`check-types:e2e`，不含 e2e 用例；`all.yml` 直接复用它的两个 job）。`prepare` job 构建
一次产物（7 个前端产物 + 宿主平台 Core + Electron 主进程），四个车道并行下载产物后
各跑一层：

| job | project | 车道额外前置 |
| --- | --- | --- |
| `ui` | `webview-ui` / `remote-workspace-ui` / `terminal-ui` | `npx playwright install --with-deps chromium` |
| `electron` | `electron-app` | xvfb + openbox（Linux 无显示；裸 X 没有窗口管理器）+ Chromium 运行时库（`playwright install-deps`）+ artifact 下载后补可执行位（已知坑 6） |
| `tui` | `tui-installer` | rust + musl 工具链（用例内 cargo 构建安装器） |
| `ssh` | `electron-ssh`，**按 spec 文件拆成 4 个矩阵任务** | 远端凭证经 secrets 现写 `e2e/environments.json`（下节）+ xvfb + openbox + 补可执行位；产物经 `scripts/download-artifact-parallel.mjs` 并发分片取（见已知坑 21），后三个 job 复用第一个 job 落盘的本地缓存 |

失败时每个车道把 test-results/ 作为 artifact 上传（`npx playwright show-trace <zip>`）。
`electron-app` 与 `electron-ssh` 是两个 project：前者不碰外部环境，任何机器都能直接跑；
后者缺 `environments.json` 时在收集期报错（无效直接报错，不做兜底）。

`electron-ssh` 拆矩阵的原因（run `44962124641` 之前的实证）：整条车道串行跑 44 条用例时，
**单文件 15/17 通过、整条车道却 16 条失败**，每条都在 2 分钟左右超时。成因不是用例本身——
是串行累积下远端 SSH 连接与 Core/daemon 残留逐条堆积（已知坑 10 / 11 / 17 的叠加），
越往后越容易命中。按 spec 文件拆成 4 个 job 后每个 job 都是干净的 runner 与干净远端状态，
四个 spec 全绿，单 job 8–13 分钟。

四个 job **并行**跑（`all.yml` 里不再设 `max-parallel: 1`）：目标是整条 `all` 在 30 分钟内
出结论，而串行时四个文件的墙钟相加是 43 分钟。并行压的是「远端并发连接数」，判据是
「每个 job 自己建多少条链」——每个 job 只跑一个 spec 文件、一条干净链路（单文件的连接形态
在 run `44962124641` 已四个全绿）。远端是共享云主机（`maxstartups 10:30:100` /
`maxsessions 10`），旧形态「四个文件塞进一个 job、脚手架每命令建一次链」才把它压垮
（实测 39 条）。**若四路并行真的出现 `Connection lost before handshake`，把 `max-parallel`
降到 2，不要退回串行**（2 路墙钟约 24 分钟，仍在预算内；串行必然超时）。

矩阵声明为并行，但**并行度受 runner 数量约束**：`e2e-ssh` 标签下目前只有一台
`ubuntu-e2e`，一台 runner 一次只接一个 job，四路会退化成串行排队（run `45030636920`
实证：四个 job 依次 14:08 → 14:26 → 14:44 → 15:03 启动，每段都撞 18 分钟上限）。
编排保留并行是为了「补第二台同标签机器后无需改 workflow 即可真并行」。

每个车道的时间闸门见本文件「时间预算」一节。`all.yml` 的 job 上限按**关键路径**取值
（`prepare` 8 + 最慢 e2e 车道 18 = 26 分钟 ≤ 30 分钟预算）：`prepare` 8 分钟，
`ui` / `electron` / `tui` / `ssh` 四个车道各 18 分钟。四个 e2e 车道取同一个值的理由——
**job 上限必须高于 Playwright 的整轮上限（15min）**，否则某条用例挂住时是 job 先被杀，
只剩一句「job 超时」，拿不到 Playwright 报的那条用例名。`src/test/e2eCiLane.test.ts`
把关键路径、每个 job 的上限、以及「车道上限 ≥ 整轮上限」都做成了断言。

`electron-ssh` 跑在**自托管的 Ubuntu 测试机**上（`runs-on: [self-hosted, linux, x64, e2e-ssh]`），
SSH 远端就是这台机器自己的 `127.0.0.1`：宿主与远端同机，部署链路是回环而不是跨公网 WAN。
runner 只负责宿主侧：远端 Core 由用例经 ssh2 上传并引导，mock LLM 经 SSH 反向隧道暴露到
远端回环（本文件「运行」一节）。

早前用的是 GitHub 托管 runner + 独立远端机器，这条组合栽在**上传吞吐**上：托管 runner 到
远端只有 0.01–0.02MB/s（`scripts/diag-upload.mjs` 的 run `45017484821` 实测 1MB 花 62.7s、
8.2MB 整份 180s 只走到 2.3MB），而每次远端引导都要把 Core 产物传进部署槽位——8.2MB 要
6 分钟以上，直接撞穿 60s 单用例档，表现为每个 spec 文件的前几条用例全部
`Test timeout of 60000ms exceeded`（run `45007017025` / `45000752679` / `44973531021`）。
同一份产物经回环上传实测 5.8MB/s，快约 300 倍。

### 自托管 runner 的部署口径

机器是那台长期存在的 Ubuntu 测试机（`ubuntu-e2e` runner），已装为 systemd 服务
（`~/actions-runner/svc.sh`，开机自启）。三件事需要随机器维护，换机器时照此重建：

1. **标签**：`self-hosted, linux, x64, e2e-ssh`。`all.yml` 的 `runs-on` 按这组标签取，
   找不到就把整条 ssh 车道挂成待机（不是失败）。
2. **代理**：机器直连 actions CDN 只有 0.03MB/s，仓库的 checkout / npm 都要经本机
   mihomo（`127.0.0.1:7890`，实测 3.5MB/s）。`all.yml` 只给**出网步骤**
   （`npm ci` / `playwright install-deps` / `warm-electron.cjs`）注入 `https_proxy`，
   不设 job 级——用例进程要连回环上的 mock LLM 与 sshd，全局代理会把它们一起绕进代理。
   **但 Electron 运行时不该走这条代理**：改走 npmmirror 镜像后直连 14MB/s，
   经代理几乎没有提升；镜像与 `ELECTRON_GET_USE_PROXY` 的口径见已知坑 22。
3. **两个 SSH 账号**（`e2e/environments.json` 的 `ssh` 与 `ssh.sudoPasswordRequired`）：
   `ubuntu` 免密 sudo（常规通道），第二个账号（用户名见 `e2e/environments.json` 的
   `ssh.sudoPasswordRequired.user`）无 `NOPASSWD` 但口令式 `sudo -S` 可用
   （挂载代理的三选一凭据通道）。sshd 开 `PasswordAuthentication yes`——产品走口令认证。

凭证只在 job 内存在：`scripts/write-e2e-environments.mjs` 从 6 个必填 secret 生成
`e2e/environments.json`（`ssh` 段的 `host` / `port` / `user` / `password` 与
`sudoPasswordRequired` 段的 `user` / `password`），可选 `E2E_SSH_LLM_ADVERTISE_HOST`
对应 `ssh.llmAdvertiseHost`。缺任何一项即报错退出，不补默认值、不跳过用例；文件按 0600
落盘、内容不打印。这段形状与 `e2e/helpers/testEnvironment.ts` 的类型、`e2e/environments.example.json`
的示例同源。自托管车道下 `E2E_SSH_HOST` 是 `127.0.0.1`（宿主与远端同机）。

`pycharm-plugin` 仍是**本地车道**：要本机 PyCharm（`environments.json` 的 `pycharm` 段，
至少 `idePath`）与 `npm run package:pycharm` 产出的分发 zip，托管 runner 两者皆无。前置：
JDK 25（2026.2 平台类文件为 Java 25；构建脚本按 PYCHARM_JDK25 / local.properties /
常见安装位探测）。要接回 CI 时，在 `.github/workflows/all.yml` 里加回 job 并同步本表。

## 凭证不进 artifact

`electron-ssh` 车道的用例要把远端 sudo 口令 `fill()` 进密码框
（`overlayMountProxyRemote.spec.ts` 的部署确认），而 **Playwright 的 trace 会把该值原样
记下来**，实测 `trace.zip` 的三处：

| 位置 | 形态 |
| --- | --- |
| 动作参数 | `{"method":"fill","params":{...,"value":"<口令>"}}` |
| 动作日志 | `fill("<口令>")` |
| DOM 快照 | `{"__playwright_value_":"<口令>"}`，以及 trace 会打包进来的 spec 源码 |

仓库是 public，失败时 trace 作为 artifact 上传就是公开泄露。因此这条链上有三道防线：

1. **该 project 关掉 trace**（`e2e/playwright.config.ts` 的 `electron-ssh` 用
   `use: { trace: 'off' }`，不继承全局的 `retain-on-failure`）。代价是这条车道没有
   trace 可看——排查靠 `E2E_DEBUG=1` 透传主进程日志与远端证据。
2. **ssh job 不再上传 `test-results`**（关 trace 后目录是空的，留着入口等于给将来重开
   trace 留后门）。其它车道照旧上传，它们的 trace 里没有凭证。
3. **上传前扫描兜底**：`scripts/scan-e2e-artifacts-for-secrets.mjs` 在 job 里扫
   `test-results/`，命中口令明文就让 job 失败、绝不传上去。扫描**会解 zip**——trace 是
   压缩的，只扫原始字节对最需要防的 `trace.zip` 恰好漏检（实测）。缺 secret 时它同样
   失败（不知道要防什么就不放行），且只报「哪个文件、哪个 secret 名」，不打印命中内容。

新增任何「测试里会用到凭证」的车道时，按同样三条处理；`src/test/e2eCiLane.test.ts`
对「ssh project 关 trace / job 有扫描步骤 / job 不传 test-results」做了断言，
`src/test/e2eArtifactSecretScan.test.ts` 覆盖扫描器本身（含 zip 与不泄露输出）。



## 测试环境配置（environments.json）

依赖真实外部环境（当前：真实 SSH 远端，`e2e/electron/remoteSshExecution.spec.ts` /
`remoteTaskSurvival.spec.ts` / `remoteChangeList.spec.ts` / `overlayMountProxyRemote.spec.ts`）
的用例从 `e2e/environments.json` 读取环境信息；该文件**不入库**（gitignore，内容含 SSH 凭证）。
首次使用：复制 `e2e/environments.example.json` 为同目录的 `e2e/environments.json` 并填入
本机可用的环境。各段字段与含义以 `e2e/helpers/testEnvironment.ts` 的类型与校验为准。

同一台远端上登记**两个账号**（`ssh` 与 `ssh.sudoPasswordRequired`）：挂载代理的两条部署
通道互斥于账号的 sudoers 配置——免密 `sudo` 可用的账号永远进不到「三选一凭据」分支，反之
亦然。因此 `ssh` 段是常规账号，`ssh.sudoPasswordRequired` 是同一台机器上**没有 `NOPASSWD`
规则**的账号（口令式 `sudo -S` 可用），`overlayMountProxyRemote.spec.ts` 跑在后者上；
它在 `beforeAll` 实测 `sudo -n`，可用即报错（不回退成免密分支、不静默跳过）。

`electron-ssh` 车道的用例文件名单只有一份（`e2e/playwright.config.ts` 的
`REMOTE_SSH_SPECS`）：`electron-app` 用它做 `testIgnore`、`electron-ssh` 用做
`testMatch`。新增一条真实 SSH 用例时改这一处即可——只改其中一侧的后果是「新用例在
没有远端机器的机器上被收集」或「新用例永远不跑」。

有效性判断分三层，**无效直接报错，不做任何修复**（不补默认值、不从 example 兜底、
不换凭证重试、不清远端状态）——与产品代码同一原则
（[不过度 fallback](../docs/architecture/principles.md)）：

| 层 | 时机 | 覆盖 | 无效时的表现 |
| --- | --- | --- | --- |
| 产物层 | 配置加载期（`assertArtifact`） | 全部用例 | 缺构建产物 / Core 二进制即整车道报错，附构建命令 |
| 配置层 | 配置加载期（`assertEnvironmentFileIfPresent`） + 用例文件加载期（`require*`） | 文件存在但形状非法 → 全部用例；依赖的段缺失 / 字段非法 → 该文件用例 | 收集期即失败，错误列出全部问题与复制指引 |
| 连通层 | 依赖外部环境的用例的 `beforeEach` / `beforeAll` | 该用例 / 该文件 | 用例开头探测（SSH `uname -sm`、本车账号的 `sudo -n` 形态），失效立即失败并指明恢复责任在使用者 |

报错信息只描述「缺什么、去哪补」，环境本身永远由使用者恢复；用例不做任何修复动作
（测试内的清场与场景预置是 arrange，不是修复）。

## 结构

```
e2e/
├── playwright.config.ts        # 七个 project，串行执行（workers=1）
├── helpers/
│   ├── fakeHost.ts             # webview 级假宿主：注入 window.vscode / __hostInfo 等全局，
│   │                           # 自动应答启动序列，sendMessage 播放脚本化流式轮次
│   ├── webviewHarness.ts       # 静态伺服 dist/webview + 页面装配（clipboard 权限等）
│   ├── mockLlmServer.ts        # OpenAI Chat Completions 兼容 SSE 服务器：
│   │                           #   写入文件 <名> → Write 工具轮；执行命令 <cmd> → Bash 工具轮；
│   │                           #   慢速回答 → 慢速流（中止场景）；无响应 → 不回响应头（静默挂住）；
│   │                           #   其余 → 文本终轮
│   └── electronApp.ts          # Electron 启动器：沙箱隔离 + CDP 直连 + 活动视图解析
├── webview/                    # webview UI 级场景用例（覆盖的 US 见 user-stories 附录）
├── electron/                   # Electron 整应用场景用例（同上）；remoteSshExecution /
│                               #   remoteTaskSurvival / remoteChangeList /
│                               #   overlayMountProxyRemote 四条跑真实 SSH 远端
├── remoteWorkspace/            # 远端目录选择器页面（路径框编辑 / 选中项 / Tab 补全 / 焦点常驻）
├── terminal/                   # 远程终端页面（标签 / 断开态与重连 / 主题跟随 / 复制粘贴）
└── tui/                        # TUI 安装程序 e2e（构建 / 自解压 / 载荷可执行 / 启动守卫，docs/features/tui-installer.md）
```

## 隔离策略（electron-app）

- `USERPROFILE` / `HOME` / `APPDATA` / `XDG_CONFIG_HOME` 指向临时目录：`~/<configDir>/`
  （settings.json、会话落盘）与 Electron userData（workspace-state.json）全部进沙箱，
  用例结束删除。Electron 的 appData 按平台解析：Windows 读 `%APPDATA%`，Linux 走
  `$XDG_CONFIG_HOME` 或 `~/.config`（不认 APPDATA，见已知坑 7）——启动器按平台选
  同一基目录（`electronApp.ts` 的 `roamingDir`），预置与断言才和应用读写同一份状态。
- settings.json 预写 mock provider（manual 询问模式让写操作弹权限确认），
  LLM 指向本地 mock SSE 服务器，全程无外网请求。
- Core 为 Rust 独立进程（standalone，产品唯一形态），多 Connection / daemon / SSH 链路与
  产品一致；前置 `npm run build:core`。
- `--multi-instance=<id>` 跳过单实例锁；实例后缀会被 main.ts 截断到 32 字符，
  预置 workspace-state.json 时必须用同样的短 id 规则。
- `DISABLE_TRAY_SOUND=1`：关掉「任务结束」的托盘提醒音（`electron/trayAttentionSound.ts`
  的 `TRAY_SOUND_DISABLE_ENV`，启动器与宿主共用同一常量）。用例在开发机上跑完整链路，
  会话结束同样触发提醒——不出声免得与开发机上真实运行的应用撞在一起。托盘闪烁照旧。

## 已知坑（实证结论）

1. **Playwright 连接 Electron 的两个前提**（`_electron.launch` 与裸 CDP 均适用）：
   - 应用主窗口从不 `loadURL`（视图全挂 contentView），其 webContents 没有渲染进程，
     对该 target 的 CDP 命令永不响应，会让 Playwright 页面初始化无限挂起。启动器经
     Node inspector（`--inspect=0`）在主进程执行 `loadURL('about:blank')` 拉起渲染器。
   - `--inspect=0` / `--remote-debugging-port=0` / `--remote-allow-origins=*` 必须放在
     入口文件之前。
2. **多视图宿主的活动视图解析**：标题栏 / 侧栏 / 每会话聊天视图都是 WebContentsView，
   在 CDP 目标列表里同为 page target；且 Electron 对未挂载视图仍报告
   `visibilityState=visible`、`hasFocus()=true`，两者都不能判别活动视图。启动器用
   「视图绑定工作区（`electronAPI.getWorkspacePath()`）+ 视图自身会话
   （`window.__currentSessionId`）+ 侧栏列表」组合解析。
3. **antd 菜单项整项 disabled**：功能菜单 / 模型子菜单的条目刻意 `disabled: true`
   （交互交给内部控件），Playwright 的可点击性检查会拒绝，需要 `click({ force: true })`。
4. **会话条目操作按钮 hover 才显示**（纯 CSS `group-hover`）：悬停要用条目根
   （`.group`），且同名按钮在每条根会话上都存在，定位必须按行作用域化。
5. **全局快捷键会被泄漏实例占用**：用例中断（Ctrl+C / 超时强杀）跳过 afterEach 时，
   上一轮的 Electron 实例可能残留并持有全局热键，新实例启动注册静默失败（现会落
   日志）。US-34 预置独占组合键（`Ctrl+Alt+8`）断言，不依赖默认 `Ctrl+Alt+X` 是否
   空闲；跑套件前可用 `tasklist | findstr "Tuxedo"` 检查残留实例。
6. **CI 的 artifact 不保留可执行位**：`actions/upload-artifact` 的 zip 把所有文件落成
   644（官方 Limitations「Permission Loss」）。electron 车道下载后必须
   `chmod -R u+x dist/resources/core resources/core`，否则宿主 spawn Core 直接 EACCES，
   `CoreProcess` 按重启策略试满 5 次后 fatal——凡过 core 的用例全部超时，纯宿主 / UI
   用例照常通过（首次 CI 实证的失败面）。
7. **Linux 上 Electron 的 appData 不认 `APPDATA`**：Windows 读 `%APPDATA%` 环境变量，
   Linux 走 `$XDG_CONFIG_HOME` 或 `~/.config`。沙箱只把 workspace-state.json 预置到
   `AppData/Roaming` 时，Linux 上应用读不到——打开集合恢复 / 快捷键 / 最近 SSH 等
   预置全部静默失效，落盘断言读到 ENOENT。启动器按平台选基目录并显式钉住
   `XDG_CONFIG_HOME`（`electronApp.ts`）。
8. **裸 Xvfb 没有窗口管理器**：`win.maximize()` / `isMaximized()` 这类窗口管理语义在
   只有显示没有 WM 的 X 里不成立（`_NET_WM_STATE` 无人响应）。electron 车道在
   `xvfb-run` 里先拉起 openbox 再跑用例。
9. **侧栏文件分区的标题是折叠开关，不是「打开分区」**：`#filesHeader` 点一次展开、再点
   一次收起；收起后分段 switch（`#filesModeSwitch`）整体隐藏，等它可见会一直等不到。
   助手要按 `#filesSection` 的 `expanded` class 判断当前状态再决定点不点
   （`e2e/electron/fileExplorer.spec.ts` / `remoteChangeList.spec.ts` 的展开助手）。
10. **真实 SSH 远端的建链有瞬时失败**：实测一台 Ubuntu 24.04 上的 OpenSSH 在 30 次
    连续建链里约 1 次直接断开（ssh2 报 `read ECONNRESET` 或 `Timed out while waiting
    for handshake`，同机 `ssh` 命令行也复现），失败也可能落在 `ready` 之后、exec 通道
    打开之前。用例脚手架（`remoteChangeList.spec.ts` 的 `sshExec`）只在远端**还没受理**
    这条命令时重试（通道都没建起来），已开始执行的命令不会跑两遍；被测链路本身不重试
    ——那是产品行为，重试会掩盖 `specs/defects/` 里那一类缺陷。
11. **远端残留的 daemon 会拖住下一轮**：上一轮用例被杀时远端 Core 进程可能还在空闲
    退出倒计时里，`~/.<configDir>/run/core-daemon-<fingerprint>.json` 也还在。
    连真实远端的用例开头与收尾都要清场（`pkill -f '<本指纹的 core 模式>'` + 删状态文件），
    标识符从 `src/config/project.ts` 取、不写字面量（四条 ssh 车道统一经
    `e2e/helpers/remoteCoreProcess.ts` 的 `coreProcessPattern` 取模式，状态目录常量是
    `REMOTE_RUN_DIR`；按指纹收口的口径见已知坑 23）。
    清场与探测都按 **SSH 用户自己的 uid** 收口（`pkill -u "$(id -u)"` / `pgrep -u "$(id -u)"`）：
    裸 `pgrep -af` 是全机口径，把远端当本机自测时会把开发机正在用的 Core 数成残留——
    「Core 已退出」这类断言永远不满足。车道只对自己部署的进程负责（槽位与状态文件都在
    `~/.<configDir>/` 下，属同一 uid）。
    代理进程的归属只能按**父子链**判，不能数全机个数：每个隔离会话一个代理，Agent A 是
    该会话 Core 的直接子进程、Agent B 是 A 的子进程（B 以 setuid root 运行，所以还要看
    euid）。「代理是否全部退出」若写成全机计数，别的会话（同轮上一条用例的收尾、本机自测
    时开发机自己的会话）会让断言永远不成立——`overlayMountProxyRemote.spec.ts` 的
    AC-31 / AC-26 因此改为先记下本会话 Core 的 pid，再用 `sessionProxyGoneFor(corePid)`
    沿 ppid 串后代判断。
    清场不能靠固定 `sleep`：`pkill` 只负责发信号，SIGTERM 到进程真正退出之间还有 Core 的
    收尾写盘，负载高时 1s 不够——留下半死的 daemon 正是这条坑的成因。用轮询等进程真的
    消失（`pollRemote` / `waitForNoCore`，超时上限 15s）。
13. **自己准备得了的前置不要用 `test.skip` 跳过**：`test.skip(!installed, ...)` 只适合
    「远端缺少某种本文件装不出来的能力」。若前置本文件有办法建立（装代理、起 workspace、
    删状态文件），就必须自己建——否则用例间产生顺序耦合：`overlayMountProxyRemote.spec.ts`
    的 FR-010 故意卸载代理验证「能力消失」，排在它后面的 6 条用例全部因 `!installed` 跳过，
    等于永不验证。正确做法是各自调 `ensureProxyInstalled()`（幂等）自备前置。
14. **宿主侧产物不进远端日志**：审计行一类由**宿主**写的日志（`webviewMessageHandler.ts`
    的 `this.log(auditLine(...))`）落在 `launchApp` 为该实例建的沙箱 HOME
    （`<home>/<configDir>/logs/<logFileName>`），远端只有 Core 的日志。断言这类日志必须在
    **同一次实例**内读：`launchApp` 默认每条用例一个新 HOME，装完就关的旧 HOME 随实例销毁。
    要验证「安装动作写了审计行」，用例得自己走一次真实部署并在同一个 `homeDir` 里读。
15. **链路抖动会以「产品错误态」的形式出现在界面里**：已知坑 10 那 3% 的瞬时失败若落在
    **被测代码**发起的那次 exec 上（不是用例脚手架），侧栏会进入既定的错误态「读取失败，
    点击重试」——这是产品应有的行为（不静默空列表，见
    [「全部变更」视图规格](../docs/archive/specs/041-sidebar-all-changes-view/spec.md) 的 FR-003），
    不是回归。用例
    只等目标行出现就会把抖动判成缺陷（`remoteChangeList.spec.ts` 首轮全量跑即如此：RT-2
    红在 `keep.md` 不出现，单跑与复跑都绿）。等待助手因此替用户点掉 `[data-retry-doc]`
    的重试，并在判定「取数不得报错」时按日志把传输层失败与非传输层失败分开计数：只有后者
    算红。判据不因此放宽——持续报错的真失败仍然红。
16. **点「重试」会真的重发一次远端取数，必须限次退避**：错误态的重试不是幂等的空操作，
    它重跑整条取数链路。按固定间隔轮询点击会自己造一场往返风暴——`remoteChangeList.spec.ts`
    的等待助手上一版每 250ms 点一次，链路持续抖动时 120 秒里点了 324 次（诊断日志
    `runBatch: 324`），既拖长用例又把后续用例的取数计数基线搅乱。现在最多重试 3 次、
    间隔 1s / 2s / 4s 指数退避，且只在错误态出现时点（加载中点没用，还会作废在途回包）。
17. **启动阶段失败必须自己收尸，否则会自我放大**：`launchApp` 的 CDP 握手（3 次 × 60s）
    全超时时，`AppHandle` 还没返回、`close` 也不存在——早前没有任何人负责杀进程与清沙箱，
    实测留下过完整的 Electron 进程树（主进程 + GPU + 网络 + 两个渲染进程）与
    `tuxedo-e2e-home-*`。而垂死的 Electron 进程与下一个实例争 CPU 正是「时序敏感断言偶发
    超时」的成因（见 `close` 的原注释），于是泄漏会让后续用例继续握手超时。现在启动失败走
    与 `close` 同一个 `killSpawnedApp`（`e2e/helpers/processTeardown.ts`）：Windows 用
    `taskkill /T /F`，**POSIX 用进程组 `kill(-pid)`**（`spawn` 时 `detached: true` 让
    Electron 自成进程组），两条分支都轮询等进程树真正退出再返回，然后删沙箱。
    **POSIX 分支不能只 `child.kill()`**：Windows 的 `kill` 会连带结束子进程，POSIX 不会——
    实测同一个探针在 Linux 上 `parent_alive=false grandchild_alive=true`（孙进程成孤儿），
    在 Windows 上父子都退出。这个平台差异让缺陷在开发机上永远复现不出来：`electron-ssh`
    在 Linux CI 上单文件跑 139 分钟仍未结束，同一份代码在 Windows 开发机整轮 2.5 分钟
    （`specs/defects/e2e-linux-teardown-leaves-orphans.md`）。回归用例
    `src/test/e2eProcessTeardown.test.ts` 因此以 CI 的 ubuntu `tests` job 为判别面，
    Windows 上 RT-2 显式跳过并打印原因。
    排查残留：Windows 用 `Get-CimInstance Win32_Process -Filter "Name='electron.exe'"` 看
    `--multi-instance=` 的沙箱实例（**不要**误杀用户真实运行的应用进程：沙箱实例的可执行
    文件在仓库的 node_modules 下，真实安装的在用户目录的 Programs 下）；Linux 用
    `ps -o pid,etimes,args -u "$(id -u)" | grep electron` 看是否有跨用例存活的进程。
18. **US-49 的排队顺序不能读 mock 的请求到达时刻**：`subagentConcurrency.spec.ts` 的 US-49
    曾经两层都踩过。第一层是**推进轮次**：父会话上下文里 `Agent [Master] queued` 出现次数
    决定「该发任务 5 / 该发任务 6」，而排队结果是工具结果回投，回投与下一轮驱动之间有竞态，
    单核 runner 上下一轮可能先于回投到达、`queued` 仍为 0，于是任务 6 先被发出
    （run `44962124641` 实证）。第二层是**FIFO 断言本身**：改成按「助手是否发出过该任务的
    tool_use」推进轮次后仍在 CI 读到 `[6, 5]`（run `45089008241` / `45082033033`），因为
    `ordered.slice(4)` 排序用的是 mock 的 `startedAt`——那是「首个 LLM 请求到达」的时刻。
    产品侧的 FIFO 保证点是**槽位预留转移**（`core-rs/src/subagent.rs` 的 `waiters` /
    `enter_slot_queue` / `hand_off_reservation`），预留之后还要经过「后台线程 → 建 meta /
    注册 / emit → 再起驱动线程 → 组提示词（首次探测 26 个命令，带进程级缓存）」若干段没有
    顺序依赖的链路，`startedAt` 的顺序因此没有任何保证。
    结论：排队顺序只读**槽位授予时刻**（子会话 id 的 `sub_<millis>_<suffix>` 前缀，也是
    `meta.json` 的创建时刻），判定在 `helpers/subagentGrantOrder.ts`，由
    `src/test/subagentGrantOrder.test.ts` 确定性锁定（含「首请求倒序时判定不变」）。首轮并发
    直取的那批相互之间本就不承诺顺序，不要断言它们的先后——详见
    [specs/defects/us49-fifo-assertion-reads-first-request-order.md](../specs/defects/us49-fifo-assertion-reads-first-request-order.md)。
19. **「加第二个工作区」在 CI 上稳定多花约 30s（根因未定位）**：凡是「加第二个工作区
    再切回去」的整应用用例，CI 上整条耗时固定在 30–34.3s（`fileExplorer.spec.ts` 的
    142/181/485/674/812 五条、`sessions.spec.ts:203`、`desktopShell.spec.ts:339`），
    同一份用例在 Windows 开发机 2–4s。`e2e-debug` 车道单跑 `fileExplorer.spec.ts:142`
    耗时 42.3s，`E2E_DEBUG=1` 的主进程日志在最后 30s 里完全静止（没有任何一条 IPC /
    视图事件），因此**不是断言里的合法等待**——它卡在某个没人打日志的同步点上。
    多工作区的 open 走 `addWorkspaceRefs` → `activateWorkspace` → `syncChatAreaForActiveWorkspace`
    → `ChatViewManager.setActiveWorkspace`，加上主窗口启动时为非活动工作区调度的
    `preloadWorkspace`（`400 + index * 250` ms 错开）。候选方向：本地工作区的
    `preloadWorkspace` 与紧随其后的 `setActiveWorkspace` 竞争、或 `syncTitlebarWorkspaces`
    的诊断落盘在慢盘上同步阻塞。**排查入口**：在 `activateWorkspace` /
    `setActiveWorkspace` / `writeWorkspaceState` 三处加临时时标日志，用 `e2e-debug`
    车道复现；定位后按【修复后删掉本条、另立条目】处理。
    在这之前**不要**为了这 30s 把整应用车道降到 30s 档：7 条用例会稳定超时，
    60s 档（`ELECTRON_APP_TEST_TIMEOUT_MS`）就是为它留的。
20. **自托管机器长期跑会累积沙箱，最终让 Electron 启动即崩**：症状是某条用例报
    `等待输出超时: /DevTools listening on/` 或 `browserType.connectOverCDP: ECONNREFUSED`，
    换个用例重跑又正常——**不是产品缺陷，是环境毒化**。实测（ubuntu-e2e，跑了两天）：
    `/tmp` 积了 961 个 `playwright*` 沙箱目录 + 804 个 `*-e2e-home-*`，`/dev/shm` 用到
    81%，此时直接 spawn Electron 会停在 `[main] waiting for app ready` 然后以 SIGTRAP
    退出（信号名不进反引号：docsLint 会把反引号里的名字当仓库标识符校验），
    而同一份产物在清理后立刻正常启动（完整走完 `requestTheme` / `startNewConversation`
    等启动序列）。
    清理：`/etc/cron.daily/tuxedo-e2e-cleanup` 每日清 mtime > 1 天的自有产物
    （`/tmp` 的沙箱 / 锁 / 视图、`/dev/shm` 的 Chromium 段、部署槽位里中断上传留下的
    `*.new`）。手动排障时先跑它再复现；`/dev/shm` 的 `sem.*` 属于系统服务（`barad_age`），
    不属于本车道，不要动。
    同源现象：`~/.<configDir>/run/` 会留下上一轮 daemon 的状态文件，而「远端就是本机」时
    `pgrep -u "$(id -u)"` 是**整个 uid 口径**——手工跑过用例后再跑 `remoteSshExecution`
    的清理类断言，会看到自己刚才那轮的进程。复现前先按已知坑 11 的清场口径
    （`coreProcessPattern` / `REMOTE_RUN_DIR`）杀进程并删状态文件。
21. **自托管机器取 artifact 必须并发分片，官方 action 会慢到撞穿 job 上限**：
    `actions/download-artifact` 用**单条连接**拉 blob。本机到
    `*.blob.core.windows.net` 的单连接吞吐只有 25–31KB/s（直连实测），
    30MB 的 `e2e-artifacts` 要 20 分钟——四个 ssh job 依次撞 18 分钟上限，
    失败点是 `chmod: cannot access 'dist/resources/core': No such file or directory`：
    下载没完成，产物目录根本没落出来，症状与「构建漏了某产物」几乎一样。
    经 banana 代理更差（各节点 4–35KB/s，实测最优的新加坡 B2S 也才 35KB/s），**加代理无效**。
    瓶颈在单连接而不是线路：同一份 blob 切 32 段并发取，聚合到 363KB/s，
    实测整个 30MB 用 165s 取完且 zip 完整。
    因此 ssh 车道用 `scripts/download-artifact-parallel.mjs`（Range 分片 + 拼接 + unzip，
    落盘布局与官方 action 一致），`src/test/e2eCiLane.test.ts` 的 RT-15 钉住这个调用点。
    排查时先看这一步的日志行：它打印总大小、并发数、耗时与实测吞吐。
    CI 实证：`[download] 完成 28.8MB / 87.6s = 336KB/s`（修复前该 job 在下载上耗满 18 分钟）。

    **同 run 的四个 job 会重复下同一份产物**：标签下只有一台机器，它们串行排队在同一台
    机器上，每个都付一遍 22.7–149.5s（run `45177031308` 实测）。`ARTIFACT_CACHE_DIR`
    让产物按 `run-<runId>-<attempt>` 落在 `runner.workspace` 下（**不能是 `runner.temp`**：
    后者每个 job 开头会被清掉），后三个 job 直接复用。复用前校验三个必备目录齐全，
    不齐就走下载——被打断的那一轮留下的半个目录不会被当成产物。
    `src/test/artifactCache.test.ts` 的 RT-1 / RT-2 / RT-3 分别钉住「命中即复用」
    「换 run 不命中」「槽位不完整不复用」。

    **暂存目录必须建在缓存目录之内**：脚本落缓存前先在暂存目录解压 + 自检，通过后再
    `rename` 到位。`rename` 只在同一文件系统内成立，而 runner 的 `/tmp` 与工作区是两个
    挂载点——暂存目录若放在 `os.tmpdir()`，必现
    `EXDEV: cross-device link not permitted`（run `45292363880`：四个 ssh job 全红在取
    产物这一步，用例一条都没跑）。暂存目录因而住在 `<cache>/.staging/job-*`，名字用
    `mkdtemp` 保证每个 job 唯一（矩阵声明四路并行，真并行时固定命名会互删）；
    缓存目录是持久路径，所以开场按 mtime 清掉一小时前的残骸（job 被 `timeout-minutes`
    强杀时 `finally` 跑不到）。`src/test/artifactCache.test.ts` 的 RT-4 钉住「跨文件系统
    仍成功」，RT-5 钉住「修复不是靠不落缓存绕过去」，RT-6 / RT-7 钉住「暂存目录不留
    残渣」与「过期暂存目录被清掉、正在用的不被误删」。
22. **`@electron/get` 读不到 `.npmrc` 的镜像、也不认 `https_proxy`**：两者叠加会让
    `warm-electron.cjs` 回落到 GitHub Releases 拉 100MB。症状是步骤日志停在
    `Downloading Electron binary...` 十几分钟不动（job 撞 18 分钟上限），或直接
    `TypeError: fetch failed` → `Electron failed to install correctly`
    （run `45042250492` 的两条 ssh job 各中一种）。
    两个坑各自的成因：
    - `.npmrc` 的 `electron_mirror` **只在 `npm run` 下生效**——npm 会把它转成
      `npm_config_electron_mirror` 注入子进程，`@electron/get` 读的是那组变量，不读文件本身。
      CI 跑的是 `node scripts/warm-electron.cjs`，没有这层转换。
    - `@electron/get` 用 undici，其 `initializeProxy()` 只在 `ELECTRON_GET_USE_PROXY=true`
      时被调用，`https_proxy` 不会自动生效。
    修法在 `scripts/warm-electron.cjs`：自己解析 `.npmrc` 的镜像写进 `ELECTRON_MIRROR`，
    有代理环境时置 `ELECTRON_GET_USE_PROXY=true`（RT-16 钉住三条）。
    本机实测：GitHub 直连 30KB/s、经代理 3.5MB/s；`cdn.npmmirror.com/binaries/electron/`
    直连 14MB/s；走镜像后 `@electron/get` 真实下载 117.1MB / 10.2s = 11.7MB/s。
23. **同一远端上并存的多个部署槽位会被误判成「本车道残留」**：远端是共享机器（CI 里
    自托管 runner 与 SSH 远端同机，`E2E_SSH_HOST=127.0.0.1`），同机可以并存多个部署槽位
    `~/.local/share/<core.deployPrefix>/<指纹>/`——一个指纹一个 daemon、一份状态文件，
    多版本各占一个槽位互不踩踏（[docs/core/core-remote.md 第 2.3 节](../docs/core/core-remote.md#23-状态文件)）。
    只按 `<core.binaryName>` 匹配进程有两条后果，run `45877287618` 两条都踩到：
    - **别人的 Core 被算成自己的残留**：`US-65 离场完成` 等的是「本层孤儿 Core 已被收尾」，
      判据是远端没有 ` stdio` 形态的 Core——另一个槽位的 Core 让条件永远不成立，
      失败信息里三条残留进程分属两个指纹（`c601…` 与 `2429…`）。
    - **清场时误杀别人的进程**：`pkill -f '<binaryName>'` 是无差别口径，会顺手杀掉同机
      另一个槽位正在服务的 daemon / Core。
    因此四条 ssh 车道统一经 `e2e/helpers/remoteCoreProcess.ts` 取模式：`pgrep` / `pkill`
    的模式里带本机构建指纹（部署槽位名就是它），只命中自己这轮部署的进程；指纹产物缺失
    直接抛错而不是退回名字口径。口径由 `src/test/e2eRemoteCoreProcess.test.ts` 锁定。
24. **「Overlay 入口可见」不等于「能力已就绪」**：`overlayMountProxyRemote.spec.ts` 的前置
    不能拿「勾选框可见」当能力到达——入口的渲染条件是 `isolatedWorkView || deployable`
    （[specs/051 FR-002](../specs/051-overlay-root-mount-proxy/spec.md)），而 `deployable`
    正是「代理还没就位」那一支。停在这个状态发消息，宿主按 FR-003 判 `needsDeploy`、把消息
    拦在部署确认框前，消息不进 Core，后面所有「等工具结果」的断言只剩超时、读到的只有空串
    （run `46128737230` 的 AC-31 即红在这条断言上，而同轮 17 条邻居全绿；那次只有空串，
    成因无法归到具体一环，因此这一条只消除「前置形态」这一种可能，不宣称已定位那次红）。
    代理已装好的用例因此先连 `waitForOverlayReady`：`mountProxy` 每查一次都真挂一次 overlay
    （`core-rs/src/mount_proxy/linux.rs` 的 `probe_capabilities`），负载下会瞬时失败一回把它
    报成 `absent`、下一查即恢复，所以重读 3 次就够——本车道每条用例只有 60s，长等待会把预算
    吃在「等前置」上；连续不可用则立刻带着 `reason` 抛错。同一个空串有**三种**成因（消息被
    闸门拦下 / 轮次在工具执行前失败 / 结果里没有目标文件名），AC-31 的超时信息因此摊开请求
    形态、确认框、输入区只读态与能力快照（`describeToolResultStall`），不再只报空串。
    首装（FR-009 / 审计行）与「代理不可用」（FR-010）两条用例的 ready 不该到达，不接这一步。
25. **长任务脚本不能对「任意非 tool 轮次」都回 sleep——前台超时转后台会再拉起一轮**：
    `remoteTaskSurvival.spec.ts` 的 `sleep 90` 前台死线 = `max(60s, sleep 总和)` = 90s
    （`core-rs/src/tools.rs` 的 `default_bash_timeout_ms`），与 sleep 本身几乎相等：`printf`
    先跑，shell 比死线晚几毫秒退出，30ms 的收尾轮询偶尔落在「死线已过、shell 未退」的窗口里。
    产品口径此时**不杀进程、把命令转入后台继续跑**（`auto_background_command`，前台超时不杀），
    后台任务跑完经 `enqueue_bash_notification`（`core-rs/src/engine.rs`，origin=bash）注入一条
    用户消息、拉起新一轮——这一轮最后一条不是 tool。旧脚本对任意非 tool 轮次都回 `sleep 90`，
    于是通知轮再起一个 90s 任务，孤儿忙期叠到约 210s，撞穿 AC-4 的 180s 收尾窗口
    （run `45885611474`；本机 WAN 远端可复现，daemon 日志出现两条 Bash `resolve_permission`）。
    这是概率性的：sleep 先于死线自然收尾时不转后台、无通知轮，用例就绿。修法是把长任务收敛成
    「只起一次」——按助手自己那条 tool_use 是否已进历史判（`issued`，与已知坑 18 同口径），
    通知轮给终答收尾。产品行为不变，变的只是脚本不再无限起长任务。AC-4 的超时信息也因此摊开
    模型请求形态与 daemon 日志末段（`describeOrphanStall`），不再只报进程列表。

