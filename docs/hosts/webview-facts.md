---
owner: pzlvv
last_reviewed: 2026-10-11
---

# 规格：webview 的事实与等待态

本规格描述 webview 与宿主之间的**事实分工**：webview 渲染所需的每一项事实都由宿主决定，
webview 不持有任何配置默认值；事实尚未到达时，界面给出明确的等待态，不显示猜测值，也不把
猜测值当作配置回传给宿主。

参考 `docs/architecture/contracts.md`（webview 侧契约：HostInfo）、`docs/hosts/webview-ui.md`（会话级 UI 状态）、
[docs/architecture/principles.md 第 1 节](../architecture/principles.md#1-不过度-fallback)（不过度 fallback）、[第 6 节](../architecture/principles.md#6-core-描述事实ui-决定表现)（core 描述事实，UI 决定表现）、[第 7 节](../architecture/principles.md#7-一份事实只有一个写入点)（一份
事实只有一个写入点）、[第 9 节](../architecture/principles.md#9-同一字段的默认值只有一处)（同一字段的默认值只有一处）、[第 10 节](../architecture/principles.md#10-webview-不持有事实的默认值)（webview 不持有
事实的默认值）；[docs/architecture/core-ui-separation.md 第 4 节](../architecture/core-ui-separation.md#4-配置归-ui)（配置归 UI 侧）。

---

## 1. 能力

1. **事实单向流动**：宿主产出事实，webview 消费事实。webview 不产出任何配置事实。
2. **默认值归宿主**：`settings.json` 缺某个字段时生效的取值，由宿主的配置快照解析决定。
   webview 不持有配置字段的默认值，也不参与「缺字段取什么」的判断。
3. **等待态**：事实未到达时，界面给出等待态（转圈 / 占位），不显示猜测值。
4. **不代宿主决定**：事实未到达时，webview 不把该字段下发给宿主——包括会话配置随用户消息
   下发、以及挂载时的自动回传。
5. **同步注入**：页面首帧之前必须由宿主写进 `window` 的事实，缺失即接线错误，在启动期暴露。
6. **唯一共享常量**：`DEEPSEEK_BASE_URL` 是跨层共享的服务地址，不是「字段缺省取值」；
   它是 webview 唯一可以自持的取值，用于「新增服务商」的预置地址。同类的还有
   「新增模型」的预置协议（`UNCONFIGURED_MODEL_API_TYPE`）：两者都是**新建数据**的
   预置选项，不覆盖任何已有字段。

---

## 2. 术语与事实来源

| 术语 | 含义 | owner |
| --- | --- | --- |
| 事实 | webview 渲染所依赖、由宿主决定的值 | host |
| 配置默认值 | `settings.json` 缺字段时生效的取值 | host（`resolveSettingsSnapshot`） |
| 等待态 | 事实未到达时的界面表现 | webview |
| 同步注入 | 页面首帧之前写进 `window` 的事实 | host |
| 面板载荷 | 设置面板打开时随 `showLLMConfig` 一次给齐的配置事实 | host |

**配置默认值的唯一来源是宿主的快照解析**（`src/core/settingsSnapshot.ts`）。该模块是
`settings.json` 的规范化入口：字段缺失、类型不对或取值非法时按默认值处理。宿主与 core 的
其它模块需要默认值时，读配置快照（`getSettings()` / `SettingsStore.getSnapshot()`），
不各自声明常量。

---

## 3. 事实清单

| 事实 | 送达方式 | 未到达时的表现 | 落点 |
| --- | --- | --- | --- |
| 宿主能力 `HostInfo` | 同步注入 `window.__hostInfo` | 抛错（接线错误） | `src/webview/webviewEnv.ts` |
| 界面语言 | 同步注入 `window.__uiLocale` | 抛错（接线错误） | `src/webview/i18n/index.ts` |
| 首帧主题 | 同步注入 `window.__initialTheme` | 抛错（接线错误） | `src/webview/webviewEnv.ts` |
| 会话配置（模型 / 思考强度 / 询问模式 / 提示词模式 / 联网搜索） | `conversationLoaded`、`setNewConversationDefaults`、`settingsDefaults` | 输入框禁用 + 转圈 | `src/webview/App.tsx`、`src/webview/InputArea.tsx` |
| 新对话默认值 | `settingsDefaults` | 输入区菜单显示等待项 | `src/webview/InputArea.tsx` |
| 服务商配置是否完成 | `settingsDefaults.providerConfigured` | 未知：不显示「请配置服务商」 | `src/webview/App.tsx` |
| 模型列表 | `setModels` | 模型菜单显示等待项 | `src/webview/InputArea.tsx` |
| MCP 服务器列表 | `setMcpServers` | 菜单显示连接中 | `src/webview/InputArea.tsx` |
| 上下文上限 | `contextLimitUpdated` | 不渲染用量进度条 | `src/webview/InputArea.tsx` |
| 账户余额 | `balanceUpdate` | 不渲染余额 | `src/webview/InputArea.tsx` |
| 对话列表 | `conversationsData` | 列表显示加载中 | `src/webview/App.tsx` |
| 会话运行时状态 | `sessionRuntimeStates` | 流水灯按未运行渲染 | `src/webview/App.tsx` |
| 设置面板载荷 | `showLLMConfig` | 不打开面板（见第 6 节） | `src/host/WebViewUI.ts` |
| 各模型的限值与协议 | 随面板载荷的 `providers[].modelConfigs` | 不打开面板 | `src/host/settingsRead.ts` |

「同步注入」的三种事实在首帧之前就位，没有等待窗口；缺失说明宿主接线不完整，
按 [docs/architecture/principles.md 第 1 节](../architecture/principles.md#1-不过度-fallback) 直接抛错。

---

## 4. 等待态的判据

等待态由**「事实是否到达」**决定，不由「值是否为空」决定。两者的区别：

- 模型列表为空数组：宿主已应答，且用户确实没有配置模型 → 不是等待态。
- 模型列表尚未收到：等待态。

因此这类事实在 webview 侧用 `undefined` 表示「尚未收到」，用空集合表示「宿主答了，就是空」。
`false` / `0` / `''` 都是**已到达的取值**，不得用作等待态判据。

---

## 5. 会话配置的下发时机

会话配置（模型身份、思考强度、询问模式、提示词模式、联网搜索）随用户消息下发
（`sendMessage`）时，webview 只在**已收到宿主事实**的前提下带上这些字段：

- 已收到：按收到的值下发。
- 未收到：输入区处于等待态，用户无法发送，因此不存在「未收到却下发」的路径。

询问模式、提示词模式、模型身份的变化通知（`setAgentMode` / `setPromptMode` / `setModel`
等会话级消息）遵循同一规则：事实未到达时不发送，避免把 webview 侧的猜测写进会话的
`meta.json`。

从磁盘恢复会话时，模型身份先按当前配置快照校验再下发：`meta.json` 记录的
（provider, model）仍有效即沿用；模型不在该 provider 的模型列表、或 provider 已从配置
移除则回退默认模型（provider 仍在时用它的默认模型，provider 已移除时用 active provider
的默认模型），回退结果经 `UiEvent.modelChanged` 让 core 写回 `meta.json`；`meta.json`
未记录身份时取 active provider 的默认模型、不回写。校验是宿主侧纯计算
（`resolveModelRef`），落盘与引擎同步归 core（[docs/core/core-parity.md 第 3.9 节](../core/core-parity.md#39-模型身份解析的归属)）。

---

## 6. 设置面板

面板载荷（`showLLMConfig`）一次给齐面板需要的全部配置事实，webview 不补默认值：

- 面板组件的入参全部必选；载荷字段缺失或取值非法即协议错误，webview 不打开面板。
- provider 表带 `modelConfigs`（各模型**已解析**的 context / output / apiType），
  面板直接显示，不自己推断协议。「某个模型用什么协议」由宿主的快照解析决定。
- 唯一的例外是「用户正在新增一个模型」时的预置协议：它和 `DEEPSEEK_BASE_URL` 同类，
  是新建数据的预置选项，不是已有字段的缺省取值；用户不改就按空值保存，
  由宿主下次自动探测后写入真实协议。
- 宿主读取配置事实失败时**不打开面板**（三条触发路径一致），只记日志。
  「读取失败」与「未配置」是两回事：只有后者才引导用户配置；用一份空面板顶上去会把
  用户误导去重配，甚至把空值当默认值写回磁盘。
- 打开面板前宿主重读一次磁盘，使用户在外部修改 `settings.json` 后不必重载窗口
  （[docs/architecture/core-ui-separation.md 第 4.5 节](../architecture/core-ui-separation.md#45-同步点)）。
- 界面语言 / 界面字号随载荷下发（`language` / `fontSize`）；webview 不补默认值，
  保存回传后即时生效（[docs/architecture/core-ui-separation.md 第 4.8 节](../architecture/core-ui-separation.md#48-文本语言)/[第 4.10 节](../architecture/core-ui-separation.md#410-界面字号)）。
- 保存成功后宿主回传保存后的默认值，以及**只有宿主知道**的两项事实：当前对话所用
  服务商的默认模型（`currentProviderDefaultModel`）与它相对保存前是否变化
  （`currentProviderDefaultModelChanged`）——webview 只有默认服务商的默认模型，
  判断不了另一个 provider 的默认模型变化。是否弹「应用到当前对话」确认框由 webview
  决定：某项默认值相对保存前有变化、且与当前对话的值不一致时才问；宿主只给事实。
- MCP 默认启用列表（`settings.json` 的 `mcp.enabled`）的变更**不自动改当前对话**：
  宿主在写盘前先把当前对话钉在它当前生效的列表上（`UiEvent.mcpEnabledListChanged`），
  再把保存后的默认列表（`mcpDefaultEnabled`）、是否变化（`mcpDefaultEnabledChanged`）
  与当前对话保存前的生效列表（`currentSessionMcpEnabled`）一起回传。webview 的会话状态
  在写盘后会被回推覆盖，判断不了保存前的值，所以「当前对话的值」也由宿主给。
  确认后 webview 发 `setMcpEnabledList` 整体覆盖该会话的启用列表。
- 钉住与保存全局默认值是两件事：宿主钉住失败**不阻断保存**，只回 `mcpPinFailed`。
  此时不回传上面三项事实（拿不到可靠的「当前对话的值」），webview 不弹确认框，
  改为给出一次提示——该对话可能已跟随新的默认值。

---

## 7. 不允许的做法

1. 在 webview 里写死配置字段的取值（`webSearch` / `thinkingEffort` / `agentMode` /
   `promptMode` / `enableUsageStats` / `uiLanguage` / `uiFontSize`）。
2. 把「尚未收到」当成某个取值下发（会话配置随消息下发、挂载时的自动回传）。
3. 用「读取失败」冒充「未配置」：失败不引导用户重配。
4. 在 webview 里做模型名 / 服务商名匹配、模型限值推导、默认模型选择、模型协议推断——
   这些是宿主侧纯函数的职责（`src/host/settingsRead.ts`）。
5. 为同一事实在 webview 与宿主各留一份取值。
6. 用「新建数据的预置选项」充当已有字段的缺省取值：预置选项只在用户新增时出现，
   已有数据一律显示宿主给出的值。

---

## 8. 验收要点

1. webview 源码不出现配置字段的默认值字面量；唯二的跨层常量是服务地址
   `DEEPSEEK_BASE_URL` 与「新增模型」的预置协议，两者都不覆盖已有字段。
2. 会话配置未到达时，输入框禁用且发送按钮显示转圈；输入区菜单显示等待项。
3. 模型列表未收到与「收到但为空」表现不同：前者等待，后者显示空列表。
4. `settings.json` 缺字段时，界面显示的取值与 core 实际使用的取值同源（都来自宿主快照）。
5. 宿主读取配置失败时不弹设置面板。
6. 两个宿主都注入 `__initialTheme` / `__uiLocale` / `__uiFontSize` / `__hostInfo`；缺失即启动期报错。

---

## 9. 落点对照

| 事项 | 落点 |
| --- | --- |
| 配置默认值（唯一来源） | `src/core/settingsSnapshot.ts` |
| 跨层服务地址常量 | `src/core/endpoints.ts` |
| 会话配置状态（`undefined` 起） | `src/webview/App.tsx`、`src/webview/sessionState.ts` |
| 等待态渲染 | `src/webview/InputArea.tsx` |
| 面板载荷入参（全必选） | `src/webview/LLMConfigPanel.tsx`、`src/host/WebViewUI.ts` |
| 同步注入（主题 / 语言 / 字号 / 能力） | `src/extension.ts`、`electron/preload.ts`、`src/webview/webviewEnv.ts`、`src/webview/i18n/index.ts`、`src/webview/fontSize.ts` |
| 宿主侧配置派生纯函数 | `src/host/settingsRead.ts` |
| 界面语言默认值（宿主） | `src/host/SettingsStore.ts` |
| 界面字号档位（宿主默认 + webview 折算） | `src/host/SettingsStore.ts`、`src/webview/fontSize.ts`、`src/webview/styles/index.css` |
| 静态守护（无默认值 / 无越权 import / 初值为 undefined） | `src/test/webviewFacts.test.ts` |
