# 实施方案：托盘提醒音（Electron）

在 Electron 宿主的提醒路径上加一条听觉通道（需求与验收见同目录 [spec.md](spec.md)）：不改 core、不新增事件，触发点落在既有的 `startAttention`。技术路线是「专用隐藏窗口 + Web Audio 解码播放」——音频文件的容器时长元数据破损，`<audio>` 只播 6ms（见第 1 节实测）。

## 技术方案

### 1. 为什么不是 `<audio src>`：音频的容器元数据是坏的

`assets/meow.aac` 实为 MP4 容器（`ftyp mp42` + `moov` 里一个 `mp4a` 轨道，AAC-LC 44.1kHz 立体声），但时长元数据与数据不一致：`mvhd` / `mdhd` 声明 `duration = 263 @ timescale 44100`（≈ 6ms），`stts` 每帧 `delta = 5`，而 `mdat` 里有 55 个 AAC 帧（每帧 1024 PCM 样本，≈ 1.28s）。Chromium 按声明时长判定播放结束，实测 `<audio src>` 的 `duration` 为 0.005964、`play()` 后立刻 `ended: true`——听不到声音。

同一个文件用 `decodeAudioData` 解到文件尾则完整：实测 `duration = 1.253875`、`sampleRate = 48000`、峰值 0.52（有效音频）。所以播放走 Web Audio：解码一次 → 缓存 `AudioBuffer` → 每次提醒新建 `AudioBufferSourceNode`（`stop()` 旧源后 `start(0)`，天然满足「重播不叠加、不排队」）。

### 2. 播放载体：懒创建、播完自毁的隐藏窗口

- 窗口：`new BrowserWindow({ show: false, webPreferences: { autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false } })`——无 preload。`autoplayPolicy` 显式写死，不赌默认值：没有它，无用户手势的 `play()` 会被拦。实测该配置下隐藏窗口里 `AudioContext.state === 'running'`、`currentTime` 正常推进。
- 页面：运行时生成的最小 `data:text/html` 壳（与 `electron/shortcutDialogHtml.ts`、`electron/chatPlaceholderHtml.ts` 同模式，不新增 vite 构建目标）。音频以 base64 经 `executeJavaScript` 注入解码——`data:` 页面加载 `file://` 子资源会被拒（实测 `ERR_FAILED`），所以不能把音频当子资源引用。
- 生命周期：懒创建；播完音频时长 + 余量后销毁窗口。**不能常驻**——常驻一个隐藏窗口会改坏两处既有判定：`window-all-closed` 不再触发（`electron/main.ts` 的退出路径），`app.on('activate')` 里 `BrowserWindow.getAllWindows().length === 0` 也不再成立（主窗口关掉后重建不了）。

### 3. 模块划分

| 模块 | 职责 |
| --- | --- |
| `electron/traySoundWindow.ts`（新） | Electron 依赖层：`createTraySoundPlayer({ audioPath })` → `{ play(): Promise<void>; dispose(): void }`；懒建窗口、首次播放前解码并缓存、重播、播完自毁 |
| `electron/trayAttentionSound.ts`（新） | 纯逻辑层（不 import electron，可被 `src/test/` 单测）：`createAttentionSound({ acquirePlayer, warn })` → `{ play(): void }`；缓存载体、把播放失败翻译成一条日志、退出中的 `null` 静默 no-op |
| `electron/main.ts` | 接线：`startAttention` 里调 `play()`；`will-quit` 与主窗口 `closed` 释放载体 |

数据流：`sessionRuntimeChanged` 全量推送 → `updateTrayStatusFromStates` → `diffSessionEndEvents` 差分出「完成 / 转等待」→ `startAttention(status)`（既有唯一提醒入口，内部已完成「窗口在后台」判定）→ ① 启动托盘闪烁 ② `attentionSound.play()`。播放与闪烁同一处调用，因此「窗口在前台不提醒」自然等于「不出声」，相位切换也不会二次调用。

失败路径：文件缺失 / 解码失败 / 窗口已销毁时 `play()` reject，由 `trayAttentionSound` 捕获并落 `fileLogger.warn('tray-sound', …)`，不向外抛——同一条 `setStatusListener` 回调上还有托盘状态点与睡眠阻断，抛错会连带影响它们。

### 4. 打包边界

`.vscodeignore` 的 `!assets/**` 收窄为逐文件放行（`!assets/logo.png` / `!assets/logo.svg`）：vsce 的匹配语义是「negate 行命中即入包」（`@vscode/vsce/out/package.js` 的 `collectFiles`：`!ignore.some(…) || negate.some(…)`），在整目录放行的前提下再补一条 `assets/meow.aac` 排除行**无效**——必须收窄白名单，音频才会被首行 `**` 排除。Electron 侧不动：`electron-builder.config.js` 的 `files` 已含 `assets/**/*`。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `electron/traySoundWindow.ts` | 新增 | 无（不新增事件 / 契约成员） |
| `electron/trayAttentionSound.ts` | 新增 | 无 |
| `electron/main.ts` | 修改：`startAttention` 加播放调用；`will-quit` 与主窗口 `closed` 释放载体 | 无 |
| `.vscodeignore` | 修改：`!assets/**` → 逐文件放行 | 无 |
| `src/test/trayAttentionSound.test.ts` | 新增 | 无 |
| `src/test/traySoundAssets.test.ts` | 新增 | 无 |
| `docs/features/user-stories.md` | 修改：US-33 验收标准 | 无 |
| `docs/hosts/host-matrix.md` | 修改：托盘提醒段落 | 无 |

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：新增模块都在 `electron/`（宿主实现层）；`trayAttentionSound.ts` 不 import 任何宿主 API 与 core，`traySoundWindow.ts` 只 import `electron` 与 node 内置模块；core 零改动、不经总线新增事件、无 `host.kind` 式嗅探。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：不过度 fallback——播放失败落日志留痕，不静默吞掉；「应用退出中不新建载体」是设计允许的瞬时状态，代码注释写明理由；契约成员全必选（`play` / `dispose` / `acquirePlayer` / `warn` 都非可选）；不涉及派生字段单实现与默认值单源。
- [x] 两套 Core parity 义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：不涉及——本次不改任一侧 Core 行为（引擎 / 工具 / 技能 / 权限 / 提示词 / 落盘格式 / 事件），无对照表与两侧测试改动。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：受影响的 as-built 规格是 [docs/features/user-stories.md US-33](../../docs/features/user-stories.md#us-33-系统托盘与任务提醒) 与 [docs/hosts/host-matrix.md 第 12 节](../../docs/hosts/host-matrix.md#12-宿主固有差异有意保留)，随实施同提交；不新增文档，`docs/README.md` 地图不变；`npm run test:all -- docs-lint` 绿。

## 被否决的替代方案

1. **`<audio src>` 直接播 `assets/meow.aac`**：容器时长元数据破损，Chromium 只播 6ms（实测）；`data:` 页面又加载不了 `file://` 子资源（实测 `ERR_FAILED`）。
2. **改写音频容器的 `mvhd` / `mdhd` / `stts` 修好时长**：能救活 `<audio>` 路线，但要动用户给的二进制资源，改动不可见，换一个音频文件会再踩一次；解码路线对容器元数据不敏感。
3. **常驻隐藏窗口**（启动时创建、长期复用）：省掉每次建窗与解码的延迟，但白占一个渲染进程，并改坏 `window-all-closed` 与 `activate` 里基于窗口计数的判定。
4. **主进程 spawn 系统播放器**（PowerShell `SoundPlayer` / `afplay` / `paplay`）：跨平台分支与进程管理成本高，且要按平台嗅探（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)禁止 `host.kind === '…'` 式宿主嗅探）。
5. **注入既有渲染层播放**（主窗口 `webContents` / 侧栏视图）：省一个窗口，但把提醒音耦合到某个 UI surface 的生命周期与 CSP，而主窗口自己的 `webContents` 目前不承载页面（用途未定义）。
6. **给提示音加设置项**（开关 / 音量 / 换音频）：spec 已列为非目标，留给后续改动。
