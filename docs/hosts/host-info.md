---
owner: pzlvv
last_reviewed: 2026-10-14
---

# 规格：webview 侧的宿主能力声明与消息通道

本规格界定 webview 与宿主之间的两条契约：宿主能力声明 `HostInfo`（第 1–3 节：注入、读取与校验、消费点）与 webview → 宿主的消息通道（第 4 节）。

交叉引用：`docs/architecture/contracts.md`（宿主契约的定义）、`docs/hosts/webview-facts.md`（webview 的事实与等待态）、`docs/hosts/webview-ui.md`（宿主侧的消息入口）、`docs/hosts/electron-multi-workspace.md`（多工作目录宿主）、`docs/architecture/principles.md`（架构原则）。

---

位置：`src/host/types.ts`（接口与两个常量）、`src/webview/webviewEnv.ts`（读取与校验）。

`HostInfo` 是**宿主能力声明**：宿主在 webview 启动前把自己「是什么、哪些 UI 由谁渲染」写进
`window.__hostInfo`，webview 据此渲染。它是 webview 感知**宿主能力差异**的唯一入口——
「对话列表归谁渲染 / 新建对话入口在哪 / 打开会话用哪种方式」都只读这张表，不做宿主嗅探
（嗅探只能回答「有没有 Electron preload」，无法表达这类能力差异）。

```ts src=src/host/types.ts
export interface HostInfo {
  /**
   * 会话视图模式：每个会话是否有独立的 webview。它是「切换会话 / 关闭会话」这一组
   * 行为的根，由宿主在启动时注入，运行期不变：
   * - multi：多视图。每会话一个独立 webview；切换会话由宿主另开 / 切换视图
   *   （openConversation），并提供关闭按钮销毁当前视图。
   * - single：单视图。一个 webview 承载全部会话；切换会话在当前 webview 内原地加载
   *   （loadConversation）；没有独立视图可关，因而不提供关闭按钮。
   */
  conversationView: 'single' | 'multi';
  /**
   * 对话列表的渲染方（唯一 owner），可在运行期切换：
   * - host：宿主原生侧栏（Electron 完整模式）
   * - webview：webview 顶栏下拉（VS Code / Electron 悬浮窗）
   */
  conversationListOwner: 'host' | 'webview';
}
```

两个字段正交：`conversationView` 是宿主的静态能力，`conversationListOwner` 只表达「列表与新建
入口画在哪里」。**其余差异由这两个字段推导**，收敛成 `src/host/types.ts` 里的四个纯函数，
避免各处重复写 `=== 'multi'`：

| 派生函数 | 语义 |
| --- | --- |
| `rendersConversationListInWebview(info)` | `conversationListOwner` 为 `webview` 时列表内嵌在 webview 顶栏；`host` 时由宿主原生侧栏渲染 |
| `newConversationEntryOf(info)` | 新建对话入口跟列表走：列表在原生侧栏时按钮也在侧栏，列表搬到顶栏后入口跟着搬 |
| `openConversationModeOf(info)` | `multi` → `openConversation`（另开视图）；`single` → `loadConversation`（原地重载） |
| `canCloseConversation(info)` | 仅 `multi` 为 `true`：只有多视图有可销毁的独立视图 |

两个常量是同一接口的两份取值：

| 常量 | 使用方 | `conversationView` | `conversationListOwner`（初始值） | 派生：列表渲染 | 派生：打开方式 | 派生：关闭按钮 |
| --- | --- | --- | --- | --- | --- | --- |
| `VSCODE_HOST_INFO` | VS Code 扩展 | `single` | `webview` | webview 顶栏 | `loadConversation` | 无 |
| `ELECTRON_HOST_INFO` | Electron 桌面窗口（`preload.ts`） | `multi` | `host` | 原生侧栏 | `openConversation` | 有 |

Electron 悬浮窗只把 `conversationListOwner` 切到 `webview`（原生侧栏没有位置可放），
`conversationView` 恒为 `multi`：切换会话照旧复用 / 另开视图，不原地重载。

## 1. 注入

同步注入的事实（页面首帧之前写入 `window`，webview 只读，缺失即接线错误，见[第 1 节](#1-注入)）：

| 事实 | 读取方 | VS Code（`src/extension.ts` 的 `getWebviewContent()` 内联脚本） | Electron（`electron/preload.ts`） |
| --- | --- | --- | --- |
| 宿主能力 `HostInfo` | `getHostInfo()` | `window.__hostInfo = ${JSON.stringify(VSCODE_HOST_INFO)}` | `contextBridge.exposeInMainWorld('__hostInfo', hostInfoForConversationListOwner(ELECTRON_HOST_INFO, conversationListOwner))`；`conversationListOwner` 取自 `--conversationListOwner=`（悬浮窗为 `webview`，完整模式为 `host`，见第 3.2 节） |
| 界面语言 | `i18n` 的 `readInitialUiLanguage()` | `window.__uiLocale = "${uiLanguage}"`（宿主 `settings.json` 的 `uiLanguage`） | `exposeInMainWorld('__uiLocale', uiLanguage)` |
| 界面字号 | `fontSize` 的 `readInitialUiFontSize()` | `window.__uiFontSize = "${uiFontSize}"`（宿主 `settings.json` 的 `uiFontSize`） | `exposeInMainWorld('__uiFontSize', uiFontSize)`（取自 `--uiFontSize=`） |
| 首帧主题 | `getInitialTheme()` | `window.__initialTheme`（`activeColorTheme.kind === Light` → `'light'`，否则 `'dark'`） | `exposeInMainWorld('__initialTheme', initialTheme)` |

注入都在 webview 的 module 脚本执行之前完成，读取方首次调用时一定已就绪。

## 2. 读取与校验

位置：`src/webview/webviewEnv.ts`。

```ts src=src/webview/webviewEnv.ts
export function getHostInfo(): HostInfo;
```

- 首次调用读 `window.__hostInfo`，**逐字段校验**（`conversationView` / `conversationListOwner` 的取值），
  任一缺失或非法直接抛错；不做默认值兜底——「新宿主忘记声明能力」在启动期暴露。
- 校验通过后缓存到模块级 `_hostInfo`，后续调用直接返回。
- 全局类型声明在 `src/webview/declarations.d.ts`（`Window.__hostInfo?: HostInfo`）。
- **消息通道不在这里**：`resolveHostMessageApi()` 另外按「有没有 `window.electronAPI` / `window.vscode`」
  解析（Electron preload vs VS Code），那是传输层的存在性判断，不是能力声明（见第 4 节）。

## 3. 消费点

webview 只按能力渲染，不判断宿主类型：

| 消费点 | 读取 | 行为 |
| --- | --- | --- |
| `App.tsx` 顶栏 | `rendersConversationListInWebview(hostInfo)` | `true` 时渲染对话历史下拉（`Dropdown`）；`false` 时由 Electron 原生侧栏接管，webview 不渲染 |
| `App.tsx` 历史对话按钮提醒 | `sessionRuntimeStatesRef` 的 `waiting` + 本视图 `conversations` 的 `sessionId` 集合 | 对话列表由 webview 渲染（VS Code / Electron 悬浮窗）时，**本视图对话列表里**有「其它会话」在等待用户操作（ask user / 权限确认）时给历史按钮加黄色呼吸提醒（`history-btn--attention`）。只认本视图列表里的会话：列表按工作目录读盘（`loadConversationList(workspace)`），因此其它工作目录的 `waiting` 不提醒——浮窗顶栏只能看 / 切到本目录的对话，提醒了也过不去。列表与运行时状态都是**视图本地缓存**：列表只推给活动视图、状态只在变化时推，所以切到 webview 渲染列表时 `App.tsx` 会主动补发 `getConversations` + `requestSessionRuntimeStates`，避免「之前不是活动视图」的浮窗用旧数据判断（[docs/architecture/host-ui-modules.md 第 3 节](../architecture/host-ui-modules.md#3-webviewmessagehandler)） |
| `App.tsx` 顶栏 | `newConversationEntryOf(hostInfo) === 'webview'` | 渲染「新建对话」按钮；`'host'` 时由侧栏按钮触发。点击后按 `openConversationModeOf(hostInfo)` 分支：`openConversation`（多视图）只发 `{ type: 'openNewConversation' }` 交给宿主另开 / 复用「未发送的新对话」视图，本视图不改自己的会话状态；`loadConversation`（单视图）在当前视图内原地新建（发 `startNewConversation`） |
| `App.tsx` 历史对话下拉的删除 | `openConversationModeOf(hostInfo)` | 删除当前对话后：`openConversation`（多视图）由宿主连同该会话的视图一起关（`deleteConversationWithViews`），关掉当前视图后由 `switchAwayFromClosedSession` 另开一个新对话视图，webview 不再自己新建；`loadConversation`（单视图）在当前视图内原地新建 |
| `App.tsx` 顶栏 | `canCloseConversation(hostInfo)` | `true` 时渲染关闭按钮，发 `{ type: 'closeWebview' }`（销毁 webview，释放渲染进程） |
| `App.tsx.navigateToSession()`（会话跳转的唯一 UI 入口，内部委托 `webviewEnv.navigateToConversation()`） | `openConversationModeOf(hostInfo)` | 对话列表 / 对话树 / 子代理 From 链接 / 返回父会话跳转时：`openConversation` 只发消息交给宿主另开视图；`loadConversation` 在当前视图内原地加载。任何入口都不得直连 `navigateToConversation`，否则会绕过 loading（统一入口见 9.3.1） |
| `Main.tsx` | 是否注入 `window.electronAPI` | 独立宿主（Electron）给 `<html>` 加 `standalone-host` class（深色背景 CSS）；VS Code 扩展不加。**不要用 `conversationListOwner` 判定**：悬浮窗注入的是 `webview`，但它仍是独立窗口，一样需要深色兜底 |

### 3.1 会话跳转的唯一入口

会话跳转（对话列表、对话树、子代理 From 链接、返回父会话按钮）**有且只有 `App.tsx` 的
`navigateToSession()` 一个 UI 入口**。它统一完成切换前的固定动作——暂存新对话草稿、进入
`useConversationLoading` 的 loading 状态、清空消息与排队横幅——最后才委托
`webviewEnv.navigateToConversation()` 把消息发给宿主。

`webviewEnv.navigateToConversation()` 是**底层原语，不是入口**，只允许被 `navigateToSession()`
调用。历史上返回父会话按钮与 From 链接曾直连该原语，导致同一类跳转「有的显示 loading、
有的直接换内容」的双路径不一致（直连路径还会让旧会话内容在 `conversationLoaded` 到达前
继续显示，且失败时没有超时兜底）。新增跳转入口时必须走 `navigateToSession()`。

### 3.2 渲染方的运行期切换

`conversationListOwner` 不只由注入值决定。Electron 悬浮窗会隐藏原生侧栏，此时宿主发
`{ type: 'setConversationListOwner', owner }` 消息，`webviewEnv` 写进模块级渲染方
并通知订阅者；`App.tsx` 用 `useState` + `onConversationListOwnerChanged` 重渲染，其余消费点统一读
`getEffectiveHostInfo()`（= `hostInfoForConversationListOwner(getHostInfo(), 当前渲染方)`），
不再直接读 `getHostInfo()`。

宿主侧同一个入口负责「布局 + 能力声明」：`ChatViewManager.setConversationListOwner(owner)`
同步更新原生侧栏的显隐与 `--conversationListOwner=` 启动参数，已打开的视图收
`setConversationListOwner` 消息就地切换，新建视图直接带新参数（避免顶栏闪一下）。

`conversationView` 不参与运行期切换：Electron 悬浮窗仍是多视图，切换会话照旧复用 / 另开视图。
`Main.tsx` 的 `standalone-host` 不看渲染方，改用 `window.electronAPI` 判定宿主类型
（见第 3 节表格）：渲染方会随悬浮窗变化，而「是否独立窗口」不会。

## 4. 消息通道

能力声明之外的另一条契约：webview 往宿主发消息。位置：`src/webview/webviewEnv.ts`。

```ts src=src/webview/webviewEnv.ts
interface HostMessageApi {
  postMessage(message: unknown): void;
}
export function getHostMessageApi(): HostMessageApi;   // 取通道；缺失抛错
export function hasHostMessageApi(): boolean;          // 探测通道；不抛错
export function postMessage(msg: unknown): boolean;    // 有通道则发，返回是否发出
```

`getHostMessageApi()` 首次调用按固定顺序解析并缓存到模块级 `_hostMessageApi`：
`window.electronAPI.postMessage`（Electron preload）优先，其次 `window.vscode.postMessage`
（VS Code `acquireVsCodeApi()` / 浏览器 shim）；两者都没有直接抛错——宿主集成缺失，
不做静默降级（[docs/architecture/principles.md 第 1 节](principles.md#1-不过度-fallback)）。`hasHostMessageApi()` 走同一套探测但不抛错、不写缓存，供可选发送路径先行判断。

| 宿主 | 注入方 | 通道 | 消息去向 |
| --- | --- | --- | --- |
| VS Code | `extension.ts` `getWebviewContent()` 内联脚本 | `window.vscode` | 扩展主进程 |
| Electron | `electron/preload.ts` `contextBridge` | `window.electronAPI` | `ipcRenderer.send('webview-message')` → 主进程 |

Electron 下 `getHostMessageApi()` 返回 `electronAPI` 的包装对象，`window.vscode` 在该宿主不存在；
VS Code 下返回 `acquireVsCodeApi()` 实例本身。

反向通道（宿主 → webview）两宿主统一成 `window` 的 message 事件：preload 把 `webview-message`
的 `ipcRenderer` 事件转发为 `window.postMessage(msg, '*')`，webview 只写一份
`addEventListener('message')`（`electron/preload.ts` 文件头注释）。

这条通道只回答「怎么发」，不表达宿主能力差异；UI 行为差异一律读 `__hostInfo`（第 2 节 / 第 3 节）。
