---
status: 已收敛
---

# 改动规格：托盘提醒音（Electron）

Electron 宿主在「任务结束提醒」触发托盘图标闪烁时，同时播放一次 `assets/meow.aac`：把窗口最小化 / 隐藏到托盘的用户除了看图标，还能凭声音知道有任务结束（完成 / 转等待用户）。改动只落在 Electron 宿主的提醒路径与打包配置——不新增事件、不动 core、不改 VS Code 宿主行为；音频文件随 Electron 应用分发，不进 vsix。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/features/user-stories.md](../../docs/features/user-stories.md#us-33-系统托盘与任务提醒) | US-33 系统托盘与任务提醒 | 修改 | 验收标准补一条：提醒闪烁的同时播放提示音 |
| [docs/hosts/host-matrix.md](../../docs/hosts/host-matrix.md#12-宿主固有差异有意保留) | 12. 宿主固有差异（有意保留） | 修改 | 托盘提醒段落补提示音行为与窗口生命周期，退出清理行补「销毁提醒音播放窗口」 |
| [docs/hosts/host-matrix.md](../../docs/hosts/host-matrix.md#6-宿主接线) | 6. 宿主接线 | 修改 | 退出清理行补「销毁提醒音播放窗口」 |
| [e2e/README.md](../../e2e/README.md#隔离策略electron-app) | 隔离策略（electron-app） | 修改 | 补「整应用用例关掉提示音」的启动开关 |

## 用户场景与验收标准

- 场景 1：窗口不在前台时任务结束，除闪烁外还出声
  - **AC-1**（FR-001）：GIVEN Electron 宿主运行中且主窗口不在前台（最小化 / 隐藏 / 可见但非顶层），WHEN 任一会话从运行中变为空闲，THEN 托盘图标开始闪烁并播放一次提示音
  - **AC-2**（FR-001）：GIVEN Electron 宿主运行中且主窗口不在前台，WHEN 任一会话从运行中变为等待用户确认，THEN 托盘图标开始闪烁（黄点）并播放一次提示音
  - **AC-3**（FR-001）：GIVEN 本应用有窗口持有焦点（主窗口或快捷键设置对话框），WHEN 任一会话从运行中变为空闲或等待用户确认，THEN 不闪烁也不播放提示音
  - **AC-4**（FR-001）：GIVEN 提示音正在播放，WHEN 又触发一次提醒，THEN 提示音从头重新播放，且同一时刻只有一路在播
- 场景 2：一次提醒只出一声
  - **AC-5**（FR-001）：GIVEN 托盘图标处于闪烁状态，WHEN 闪烁定时器在「亮 / 灭」相位之间切换，THEN 不再播放提示音
- 场景 3：播放出问题不影响提醒
  - **AC-6**（FR-002）：GIVEN 音频文件缺失或无法解码，WHEN 触发提醒，THEN 托盘图标照常闪烁，且宿主日志中留下一条播放失败记录
  - **AC-7**（FR-002）：GIVEN 播放过程抛错，WHEN 触发提醒，THEN `setStatusListener` 回调不中断，同一快照上的托盘状态点与睡眠阻断照常更新
- 场景 4：资源只随 Electron 分发
  - **AC-8**（FR-003）：GIVEN 打出的 vsix，WHEN 检查包内文件，THEN 不含 `extension/assets/meow.aac`，且 `extension/assets/logo.png` 仍在包内
  - **AC-9**（FR-003）：GIVEN Electron 打包产物，WHEN 检查应用资源，THEN 含 `assets/meow.aac`
  - **AC-10**（FR-003）：GIVEN VS Code 宿主（扩展）运行中且窗口不在前台，WHEN 任一会话从运行中变为空闲，THEN 不播放任何提示音
- 场景 5：e2e 用例跑在开发机上不吵人
  - **AC-11**（FR-004）：GIVEN 应用进程的环境变量 `DISABLE_TRAY_SOUND=1`，WHEN 任一会话从运行中变为空闲且窗口不在前台，THEN 不创建播放载体、不播放提示音，托盘图标照常闪烁
  - **AC-12**（FR-004）：GIVEN e2e 的整应用启动器，WHEN 它拉起应用进程，THEN 该进程环境里带 `DISABLE_TRAY_SOUND=1`

## 功能需求

### FR-001：提醒触发时播放一次提示音

Electron 宿主在「任务结束提醒」的触发判定成立时（任一会话从运行中结束：完成 → 空闲，或转等待用户确认 → 等待；且窗口处于后台），除启动托盘图标闪烁外，播放一次 `assets/meow.aac`。

- 播放与闪烁同一判定、同一时机：窗口在前台时不提醒，也就不播放。
- 每次提醒触发播一次；闪烁的「亮 / 灭」相位切换不是提醒触发，不重复播放。
- 同一时刻只有一路播放：上一次尚未播完时又来一次提醒，从头重新播放，不叠加、不排队。
- 播放不依赖托盘图标是否渲染成功：图标合成失败时提醒仍成立，声音照播。

### FR-002：播放失败不阻断提醒，且必须留痕

播放是提醒的附加通道。音频文件缺失 / 无法解码 / 播放载体不可用时，提醒照常进行——托盘闪烁照常启动，`setStatusListener` 回调不中断（同一条回调上还有托盘状态点与睡眠阻断），但必须落一条失败日志（宿主日志出口，与唤醒快捷键注册失败同一口径）——静默无声的症状无从排查。

### FR-003：资源分发边界

- 音频取自仓库内 `assets/meow.aac`，随 Electron 打包产物分发。
- vsix 不含该文件：VS Code 扩展包的文件白名单排除它，其余 Electron 专属资源（`assets/logo.png` / `assets/logo.svg`）照常入包。
- VS Code 宿主不播放提示音，也不因本次改动新增任何 VS Code 侧行为。

### FR-004：e2e 用例运行时不播放提示音

e2e 的整应用用例在开发机上跑完整链路，会话结束同样会触发提醒；出声会与开发机上真实
运行的应用（或用户正在听的其它声音）撞在一起。因此提醒音有一个**启动期开关**：
开关打开时不建播放载体、不出声，而提醒的其余部分（托盘闪烁、状态点、睡眠阻断）照旧。

- 开关走环境变量 `DISABLE_TRAY_SOUND`：取值为 `1` / `true` 时关闭，其余取值（含未设置）
  照常播放。
- 变量名与取值只有一处定义（`electron/trayAttentionSound.ts` 导出常量），宿主与 e2e
  启动器共用同一处，改名不会两边漂。
- e2e 的整应用启动器（`e2e/helpers/electronApp.ts`）在拉起应用时置位，与它的其它隔离
  项（沙箱 HOME、`CORE_KIND` 覆盖）并列，见 [e2e/README.md](../../e2e/README.md#隔离策略electron-app)。

## 边界与错误路径

- 播放失败：不抛错、不中断会话状态流（按 FR-002 落日志）。
- 快速连续提醒（两个会话先后结束 / 同一会话连续两轮）：每次触发播一次，后一次从头重播；不节流、不排队、不合并。
- 用户聚焦取消提醒：不打断已在播放的提示音（音频很短，播完自然结束）。
- 子代理会话完成、应用启动或切换工作区恢复出的等待会话：不是提醒事件（既有 `diffSessionEndEvents` 语义），不播放。
- 托盘图标不可用（`tray` 创建失败 / 图标合成为空）：提醒仍触发，提示音照播（FR-001）。
- 应用退出中：不新建播放载体；已在播放的提示音随进程结束。
- 播放窗口不常驻：播完（音频时长 + 余量）自毁，主窗口关闭与应用退出时立即销毁——它也是
  一个 BrowserWindow，留着会让 `window-all-closed` 不再触发（应用不退出）、`activate` 里
  「没有窗口才重建主窗口」的判定失效；销毁后再次提醒重新懒建。
- 提醒音开关取值不在 `1` / `true` 之列（含未设置、空串、`0`、`false`）：按启用处理，
  不抛错——它是测试用的逃生开关，默认行为就是播放，未知取值不该把提醒弄哑。

## 非目标

- VS Code 宿主播放提示音（明确不做）。
- 提示音开关 / 音量 / 自定义音频的设置项：本次固定为「提醒即播」，可配置化留给后续改动。
- 改变提醒判定、闪烁节奏、状态点颜色与睡眠阻断。
- 系统级通知（Toast / Notification API）、任务栏或窗口闪烁。
- core 侧任何改动（不新增事件、两套 Core 都不动）。

## 对需求基线的影响

修改 [US-33 系统托盘与任务提醒](../../docs/features/user-stories.md#us-33-系统托盘与任务提醒) 的验收标准，新增一条：提醒闪烁的同时播放提示音。US-33 已在 `docs/features/user-stories.md` 的「未覆盖 e2e 的 US」豁免段登记（OS 集成层，真实托盘与声音无法被 Playwright 驱动），新增行为沿用同一豁免，不新增 e2e 用例；触发与失败路径由 `src/test/` 的单测覆盖（见追溯矩阵），真实出声人工验证。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `electron/main.ts` 的 `startAttention` 与新增 `electron/trayAttentionSound.ts` | `src/test/trayAttentionSound.test.ts` | 自动 |
| FR-002 | `electron/trayAttentionSound.ts` 的失败分支与 `electron/main.ts` 的调用点 | `src/test/trayAttentionSound.test.ts` | 自动 |
| FR-003 | `.vscodeignore`、`electron-builder.config.js` 的 `files` | `src/test/traySoundAssets.test.ts` | 自动 |
| FR-004 | `electron/trayAttentionSound.ts` 的 `traySoundEnabled` 与 `electron/main.ts` 的 `acquirePlayer`；`e2e/helpers/electronApp.ts` 的启动环境 | `src/test/trayAttentionSound.test.ts` | 自动 |

## 待澄清

（无未决问题。）

## 收敛记录

收敛时由 /converge 填写，结论只分三类。

- 已满足：
  - **FR-001 / AC-1–AC-5**（提醒触发时播一次）：`attentionSound.play()` 全仓只有一处调用，
    在 `electron/main.ts` 的 `startAttention` 内（闪烁定时器只 `tray.setImage`，不碰播放）——
    「前台不提醒即不出声」「相位切换不重复出声」由既有判定保证；载体懒取后缓存、每次触发
    播一次、reject 不外抛由 `src/test/trayAttentionSound.test.ts` 锁定；重播语义（停旧源 +
    `start(0)`、单路）由 `electron/traySoundWindow.ts` 实现，并以真实模块实跑确认（重播复用
    同一窗口、播完窗口自毁）。
  - **FR-002 / AC-6–AC-7**（失败不阻断、必须留痕）：`src/test/trayAttentionSound.test.ts`
    覆盖载体 reject / 同步抛错 / 取载体抛错三条路径（各落一条日志、不向外抛）；真实模块实跑
    确认音频文件缺失时 `play()` reject 且半成品窗口被清理。
  - **FR-003 / AC-8–AC-10**（资源分发边界）：`src/test/traySoundAssets.test.ts` 用 vsce 自己的
    打包过滤（`@vscode/vsce` 的 `collect` + 仓库真实 `.vscodeignore`）断言 `extension/assets/meow.aac`
    不入包、`logo.png` / `logo.svg` 仍入包，并断言 electron-builder 的 `files` 覆盖 `assets/`；
    反向验证过（白名单改回 `!assets/**` 该用例立刻红）。打包清单实测 98 → 97，只少了该音频；
    `src/` 侧零引用（grep 核对），VS Code 宿主无该行为。
  - **FR-004 / AC-11–AC-12**（e2e 静音开关）：`src/test/trayAttentionSound.test.ts` 覆盖取值口径
    （`1` / `true` 关闭，其余含未设置照常播）；`e2e/helpers/electronApp.ts` 与宿主共用
    `TRAY_SOUND_DISABLE_ENV` 常量置位；整应用 e2e 实跑 59/60（唯一失败见「未做」）。
  - 音频内容确实出声（除人耳）：`decodeAudioData` 解出 1.253875s、AnalyserNode 采样输出峰值
    0.29–0.39；容器声明的 6ms 是坏元数据（`<audio>` 路线实测只播 6ms，故改走 Web Audio）。
- 偏差：
  - 补记 1（spec 未覆盖、实现已有）：播放窗口的生命周期——播完自毁，主窗口关闭与应用退出时
    立即销毁（它是 BrowserWindow，留着会让 `window-all-closed` 不再触发、`activate` 里
    「没有窗口才重建主窗口」的判定失效）。已补进「边界与错误路径」，并同步
    `docs/hosts/host-matrix.md` 的两处「退出清理」行（宿主接线表与宿主固有差异表），
    影响基线相应补一行。
  - 补记 2（实施期由用户追加）：FR-004（e2e 静音开关）与其 AC-11 / AC-12、任务 T008，
    原 spec 未覆盖，已在实施期补进本规格。
  - 追溯矩阵落点复核：两个测试文件都存在且覆盖所声称内容（无虚指）；`electron/traySoundWindow.ts`
    依赖真实 Electron 渲染进程，矩阵未把它列为自动覆盖，由真实模块实跑与人工确认兜底。
- 未做：
  - **T007 的「真实出声人耳确认」**（需真实 provider 跑一轮会话）：用户裁决先不试，按未做
    归档——`tasks.md` 的 T007 保持不勾并注明。替代证据：音频图输出非静音、窗口生命周期正确、
    真实模块实跑通过。
  - **整应用 e2e 60 项中的 1 项失败**（与本次改动无关）：`e2e/electron/subagentConcurrency.spec.ts`
    的 US-49 用例——`dist/resources/core/arm64-win32/` 的 Core 产物是 2026-10-06 的，早于该特性
    落地的 497456d（2026-10-12），按 `e2e/README.md` 前置需先 `npm run build:core`；未在本 spec
    范围内重建（避免把并行会话正在改的 `core-rs/` 工作混进这次验证）。
