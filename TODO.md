# TODO

只列**未排期**的想法与跨 spec 的缺口，每条带验收判据或指向某个 spec。进度不在本文件：
进入实施的改动在 `specs/<NNN>-<slug>/` 跟踪，`tasks.md` 的勾选状态即进度（工作流见
[specs/README.md](specs/README.md)）。完成的项当场删除；里程碑与已完成工作的历史记录见
`docs/archive/`。文档体系与「什么内容写到哪」见 `docs/README.md`。

- **查看器自动刷新在 Core 不可用时的兜底**（[specs/018 归档](docs/archive/specs/018-viewer-file-refresh/spec.md) 收敛时登记）：
  远程查看器当前依赖远端 Core 推送；Core 不可用 / 未就绪时只显示「自动刷新不可用」标记，不做
  刷新。方向：Core 不可用时降级为 SFTP 轮询，或 Core 恢复后补齐断线期间的修改；需定义切换
  条件、轮询周期与重复刷新抑制。验收判据：Core 不可用期间的文件变更在恢复后可见（或按明确
  周期刷新），同一内容不重复刷新；`viewerWatch` 单测覆盖切换与恢复。

- **Markdown 内嵌相对路径图片的加载与刷新**（[specs/018 归档](docs/archive/specs/018-viewer-file-refresh/spec.md) 收敛时登记）：
  Markdown 预览是 data URL 页面，没有 base URL，`![](./a.png)` 这类相对路径图片当前不加载；
  方向：自定义协议 / file base / 预览服务，并让内嵌图片随源文件更新。验收判据：相对路径
  图片正常显示，源图片更新后预览自动刷新；有 e2e 或单测锁定。

- **技能发现向上查找父目录**（[specs/029 归档](docs/archive/specs/029-skill-system-alignment/spec.md) 非目标）：
  项目级技能只看会话工作目录（`<cwd>/.agents/skills` 与 `<cwd>/<configDir>/skills`），在 monorepo
  子包（如 `packages/web`）里打开会话时，仓库根上的技能不可见。方向：从 cwd 向上走到 git 工作树根，
  逐层收集同名时按「离 cwd 近的优先」。验收判据：仓库根放的技能在子目录会话里可见；同名时近的胜出
  且只出现一次；`skills_tests` 覆盖向上查找与同名仲裁的叠加。

- **SKILL.md 换成真正的 YAML 解析器**（[specs/029 归档](docs/archive/specs/029-skill-system-alignment/spec.md) 非目标）：
  当前是手写子集，只支持标量、`- ` 数组与 `|` 字面量块；`>-` / `>` 折叠标量、流式数组
  （`[a, b]`）、嵌套 map（`metadata:`）都会被静默降级——`description: >-` 会解析成字面量 `>-`，
  名单里的路由信息直接丢失。验收判据：`>-` / `>` / 流式数组 / 嵌套 map 四类用例进
  `core-rs/fixtures/skills.json` 并有对应断言；解析失败时按「跳过该技能 + 日志」而不是写进错误描述。

- **技能名单的上下文经济**（[specs/029 归档](docs/archive/specs/029-skill-system-alignment/spec.md) 非目标）：
  模型名单没有字符预算，技能一多就线性膨胀；压缩后不重新挂载已加载的技能正文；同一技能重复调用会把
  正文再灌一遍。方向：按比例预算 + 单项上限、压缩时按 token 预算重挂最近调用的技能、内容相同时只加
  一句「已加载」。验收判据：预算与上限可配置且有单测；压缩后技能指令仍可被模型读到；重复调用不重复
  注入正文。

- **标题栏最大化/还原图标与窗口实际状态脱同步**（用户报告 + 代码走读定位，偶发非阻塞）：
  图标是单向投影——只由初始 `getState()` 拉取与 `maximize` / `unmaximize` / `enter-full-screen` /
  `leave-full-screen` 四事件的 fire-and-forget 推送（`electron/main.ts` `pushTitlebarWindowState`）
  驱动，无对账；Windows 上该事件族不可靠（electron #27851 / #35223 / #19934），且 snap 排列、显示器
  变更、托盘 hide/show 往返天然不发事件，一条推送丢失图标就永久错（实测：窗口已还原、图标仍为
  「还原」）。伴生缺陷：`frame: false` + 标题栏空白区 `-webkit-app-region: drag` 让 Windows 原生
  双击切换与页面自绘 `dblclick → toggleMaximize`（`electron/titlebar/main.ts`）双触发，一次双击切换
  两次（窗口闪动、双击看似无效），并放大丢事件竞态的暴露面。方向：投影加对账——`resize` /
  `restore` / `show` / `hide` 等信号也重推 `isMaximized()`，或推送改拉取并给初始回包加 workspaces
  快照同款 version 防护；双击二选一（删自绘处理器交原生，或标题栏改 `no-drag` 自行实现拖动）。
  验收判据：snap / 托盘往返 / 最小化还原后图标与 `isMaximized()` 一致且能自愈；双击标题栏空白区
  恰好切换一次最大化；electron 车道 e2e 锁定两条行为。

- **JCEF 面板帧率被锁在 30fps（OSR 默认帧率未抬到 60）**（specs/035 实施后走读定位，修复未验证）：
  现象：PyCharm 插件面板 rAF 帧间隔稳定 33.3ms（30fps），`perfProbe.spec.ts` 量到的就是这个上限
  本身，与 GPU（D3D11）、前后台、DOM 体量无关。根因链（反编译 IDE 自带 JCEF jar + CEF 源码确认，
  不是 JBR 硬上限）：
  (1) `JBCefBrowserBuilder` 默认 `myIsOffScreenRendering = Registry.is("ide.browser.jcef.osr.enabled")
  || JBCefApp.isRemoteEnabled()`，PyCharm 2026.2.4 的 `misc/registry.properties` 两项均为 true，
  故 `WebViewPanel` 里 `JBCefBrowser("$baseUrl/index.html")` 的无参 builder 路径恒走 windowless；
  (2) 同一构造器取 `myWindowlessFrameRate = Registry.intValue("ide.browser.jcef.osr.framerate", 0)`，
  registry 默认值就是 `0`，原样写入 `CefBrowserSettings.windowless_frame_rate`；
  (3) CEF `osr_util::ClampFrameRate` 把 `< 1` 解释成 `kDefaultFrameRate = 30`，`SetFrameRate()` 据此
  算出 `frame_rate_threshold_us_ = 33333`，同时作为 BeginFrame interval 与 display vsync 参数——
  页面 rAF 因而被限在 30fps（CEF 文档口径：范围 1–60，默认 30）。
  附带确认：remote（out-of-process）模式下 `CefBrowserSettings` 到不了 CEF 侧——`RemoteBrowser.mySettings`
  只赋值不读取，thrift `Browser_Create` 参数只有 `(cid, requestContext)`，`myFrameRate` 构造器硬编码
  30；能穿透的只有运行期 `CefBrowser.setWindowlessFrameRate(int)` → `Browser_SetFrameRate` RPC。
  方向：(a) 零代码先证伪——在 `e2e/helpers/pycharmIde.ts` 的 `ide.general.xml` Registry 条目临时加
  `ide.browser.jcef.osr.framerate=60`，跑 `PYCHARM_PERF=1 npm run test:e2e:pycharm -- --grep PERF`
  看 rAF 是否落到 ~16.7ms；(b) 插件内正解（不污染用户全局 Registry）：`JBCefBrowser.createBuilder()
  .setUrl(...).setWindowlessFramerate(60)` 覆盖进程内模式，并在 native 浏览器创建完成（如 loadEnd）后
  补一次 `browser.cefBrowser.setWindowlessFrameRate(60)` 覆盖 remote 模式——两处都要，进程内模式下
  native context 未就绪时前一次调用会静默 no-op；(c) 用 IDE 自带的 `ide.browser.jcef.osr.measureFPS.id`
  （OSR JCEF FPS Meter）看 OnPaint 侧真实帧率，与 rAF 交叉比对，区分瓶颈在 CEF 出帧还是
  JCEF→Swing 的 `BufferedImage` 拷贝 / EDT repaint（高分屏下 60fps 拷贝成本翻倍，实际可能落在
  40–60 之间，不保证满帧）。
  验收判据：前台面板 rAF 均值 ≤ 17ms 且 p95 ≤ 20ms；`perfProbe` 的 A/B 两组输出留档；
  面板之外的 JCEF 用途不受影响。
  连带待修：[docs/hosts/pycharm-plugin.md](docs/hosts/pycharm-plugin.md) 的「帧呈现上限」一条把归因
  写成「JBR 层的帧呈现上限」，与上述证据不符；验证完成后按实测结论就地更正为「CEF OSR 可配置默认值」。

- **`tool_loop_has_no_default_turn_limit` 在 Windows 上贴 30s 死线偶发挂**（specs/defects/available-commands-probe-stalls-first-query 修复验证时发现，干净基线可复现）：
  该用例跑 46 轮 LLM×Bash（`echo hi`）循环，`wait_query_end` 的 30s 上限在本机
  （Windows arm64，每轮 Bash spawn 约 0.65s）实测 30.6–32.5s 徘徊，同一二进制两次运行
  一次挂一次过；stash 在干净基线同样失败，与该修复无关。方向：走 `/fix`——工具重的
  循环用例放宽等待上限（如按轮数放大 `wait_for` 时限），或把 Bash spawn 开销从
  断言路径剥离（FakeLlm 直接给 46 轮，不经真实 spawn）。验收判据：本机连续 5 次
  `cargo test tool_loop_has_no_default_turn_limit` 全绿，CI 同口径。

- **`tui-rs` 的 `cargo test` 在干净工作区编译不过**（specs/049 收敛时发现，与 specs/049 无关）：
  `tui-rs/src/core_root_tests.rs` 的 `shared_fd_lives_beside_slots` 拿
  `Option<&Path>` 与 `Option<Option<&Path>>` 比对（`fd.parent().map(|p| p.parent())`
  vs `shared_ripgrep_in(prefix).parent().and_then(|p| p.parent())`），提交 `326d061`
  引入。方向：走 `/fix`——两侧口径统一（要么都 `.map` 要么都 `.and_then`），
  验收判据：`cargo test --manifest-path tui-rs/Cargo.toml` 无编译错误，且该用例
  断言语义仍是「fd 与 rg 同级」。连带：specs/049 的两个 TUI 用例（
  `session_config_drops_removed_prompt_mode_key` / `snapshot_payload_round_shape` 的键集断言）
  当时用临时补丁验证过，修好后应自然进 CI 覆盖。

- **e2e 全量车道的负载敏感用例**（specs/049 收敛时跑 `npm run test:e2e:local` 发现）：
  同一批用例单独跑绿、全量串行跑红，已就地修三处并复跑验证——
  （1）`e2e/helpers/webviewHarness.ts` 的静态服务器用 `listen(0)` 随机端口，可能落进
  Chromium 的 unsafe port 表（实测 6697），表现为 `net::ERR_UNSAFE_PORT` 整条红；
  已改为拿到 unsafe port 就换一个重试。
  （2）`e2e/webview/messagePresentation.spec.ts` 的两条 US-16 用例发完消息只等用户气泡
  可见就做布局测量，而助手回复还在流式增长（吸附测量读最终高度）；
  已改为用假宿主 `turnsDone` 计数等轮次结束。
  （3）`e2e/webview/conversation.spec.ts` 的 US-52 用「abort 按钮回灰」等轮次结束，
  但按钮一开始就是灰的，断言立即通过、随后被轮末 idle 快照冲掉注入的黄色态；
  同样改为 `turnsDone` 计数。
  验收判据：`npm run test:e2e:local` 连续两次全绿（当前已跑通一轮）；新增用例若依赖
  布局测量，一律用 `turnsDone` 做轮次边界，不用按钮/快照投影做判据。

- **`core-rs/fixtures/` 对照表的头注停在双 Core 时代**（改 Bash `restricted` 说明面时发现）：
  Embedded TS Core 已随 [ADR-0007](docs/adr/0007-single-core-rust-only.md) 整体删除，但十余份对照表的
  `note` 与对应测试注释仍写着「Embedded（`n/...`）与 Standalone 逐字一致」「TS 侧测试断言本表 ==
  `toolToLlmFormat` 的真实输出」，`toolSchema.json` 的 `divergences` 还留着一条只为迁就已删 TS 实现
  的豁免（`Edit.replace_all` 的 `type=string` + 必填）。`rg toolSchema.json src/ e2e/ scripts/` 零命中，
  这些对侧说明现在是纯噪音，会让读者以为仓库里仍有第二条实现。方向：走 L0 清理——逐份对照表把
  `note` / 测试注释改成只描述 Rust 侧现状（对照表是冻结的期望值快照，测试断言 `definitions()` / 各
  纯函数与它逐字段一致），清掉失去对侧的 `divergences` 条目。验收判据：`rg -n "Embedded" core-rs/fixtures/
  core-rs/src/` 只剩真正描述历史的注释；`cargo test --manifest-path core-rs/Cargo.toml` 全绿（清理后
  `schema_parity_tests` 的豁免集合收缩，`Edit.replace_all` 的类型 / 必填比对转入常规断言且仍然通过）。

- **加密私钥的 passphrase 交互与手选私钥**（[specs/052](specs/052-ssh-key-first-connect/spec.md) 非目标）：
  远程接入的认证链当前把带 passphrase 的私钥当作不可用直接跳过，也不提供手选私钥文件
  的入口。方向：认证链在「所有来源都不可用」时把「输入 passphrase 解一条加密私钥」与
  「口令浮层」并列成选项；面板增加可选私钥路径，指定时优先于默认私钥顺序。验收判据：
  passphrase 只用于解密私钥、不进 argv / 环境变量 / 日志，解密失败回到来源选择；
  指定私钥路径后认证链以它为第一来源；`sshIdentity` 单测覆盖两种来源的优先级。
