import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * webview UI 级测试的「假宿主」。
 *
 * 以 `page.addInitScript` 在页面脚本执行前注入：实现 `src/webview/webviewEnv.ts`
 * 依赖的全部宿主全局（`window.vscode` / `__hostInfo` / `__initialTheme` /
 * `__uiLocale` / `__hasWorkspace` / `logoUri`），并按 `src/host/webviewMessages.ts`
 * 的 wire 协议对 webview 的请求做自动应答；`sendMessage` 触发一段脚本化的
 * 「用户回显 → queryBegin → 流式回复 → queryEnd」完整轮次。
 *
 * 测试侧通过 `FakeHostDriver`（page.evaluate 桥）读取上行消息、注入下行消息、
 * 改写脚本化轮次的参数。
 */

/** 宿主能力注入（`src/host/types.ts` 的 HostInfo 形态）：webview 据此渲染顶栏 */
export interface FakeHostInfo {
  conversationView: 'single' | 'multi';
  conversationListOwner: 'host' | 'webview';
}

/** 文件存储能力应答（`storageCapabilitiesRequested` 的四字段，specs/051 FR-001） */
export interface FakeStorageCapabilities {
  isolatedWorkView: boolean;
  mountProxy: 'ready' | 'absent';
  deployable: boolean;
  reason: string;
}

/**
 * 注入期可预置的状态（在页面脚本执行前就绪）。
 *
 * 与 `FakeHostDriver` 上的 setter 分工：能改「下一次应答」的用 setter，**必须在这一轮
 * 启动前就位**的用这里。实例：`requestStorageCapabilities` 在挂载时只问一次，webview
 * 不重复问（能力在 Core 生命周期内不变），挂载后再改 state 永远赶不上——只能注入期给。
 */
export interface FakeHostInitOptions {
  /** 文件存储能力应答；缺省 `null` = 宿主不应答（复现能力未到达的等待态） */
  storageCapabilities?: FakeStorageCapabilities | null;
}

/**
 * 按宿主能力生成注入脚本。默认形态（FAKE_HOST_INIT）是 VS Code 单视图；
 * Electron 浮窗（多视图 + 列表在顶栏，顶栏多出「关闭」按钮）等非默认形态
 * 用例传入对应能力。
 */
export function fakeHostInit(hostInfo: FakeHostInfo, init: FakeHostInitOptions = {}): string {
  return `
(() => {
  // —— 宿主注入（preload / 扩展 HTML 注入的等价物）——
  window.__hostInfo = ${JSON.stringify(hostInfo)};
  window.__initialTheme = 'dark';
  window.__uiLocale = 'zh';
  window.__uiFontSize = 'medium';
  window.__hasWorkspace = true;
  window.__highlightLanguages = [];
  window.logoUri = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#555"/></svg>'
  );

  const state = {
    // conversationsData / sessionRuntimeStates / conversationSpacesData 的应答数据（测试可改写）
    conversations: [],
    runtimeStates: [],
    conversationSpaces: [],
    // 脚本化助手轮次：每次 sendMessage 使用当时的值
    turn: { thinking: '', text: '', chunkDelayMs: 40, usage: null },
    // 界面语言（saveLLMConfig 后更新并随 llmConfigSaved 回传，驱动 US-41 立即生效）
    language: 'zh',
    // expandCompact 的应答数据：完整展开序列 + 每代起始下标（压缩历史逐层展开场景）
    expandedMessages: [],
    expandedGenerationStarts: [],
    // 非空时，loadConversation 应答（conversationLoaded）之后**同批**补发一条
    // messagesReplaced：模拟「替换与加载落在同一帧窗口」——webview 的 rAF 必然晚于
    // 同一批 wire 消息处理，用来确定性复现加载窗口内的整批替换竞态
    // （specs/defects/messages-replaced-clobbered-by-load-raf）。
    loadReplacementMessages: null,
    // 引擎忙碌时再来一条 sendMessage 是否回 queuedMessage（排队语义）
    queueWhileBusy: true,
    // 收到 abort 时回推的运行时快照（null = 回空闲快照）。
    // abort 三态用例据此模拟「第一次点击只停前台、后台任务仍在跑」。
    abortRuntimeStates: null,
    // settings.json 默认值（requestSettingsDefaults 应答 + saveLLMConfig 后更新）
    settingsDefaults: {
      model: 'mock-model', provider: 'mock-provider',
      thinkingMode: 'high', agentMode: 'risk', webSearch: false,
    },
    // MCP：mcp.json 里的服务器定义（名称列表）
    mcpServers: [],
    // settings.json 的 mcp.enabled（全局默认，设置面板编辑）
    mcpDefaults: [],
    // 当前会话生效的启用列表（meta.json 的会话覆盖优先，其次全局默认）
    mcpSessionEnabled: [],
    // 模拟宿主「钉住当前对话」失败（读 core 事实失败）：保存照常成功，只回失败标志
    mcpPinFailed: false,
    // 按会话的 Todo 清单（requestSessionTodos 的应答；core 侧事实的假实现）
    sessionTodos: {},
    // ── Overlay 挂载代理（specs/051）──
    // 能力应答（requestStorageCapabilities）：三个字段都是 Core 的事实，宿主只透传。
    // null = 宿主不应答（复现「能力始终未到达」的等待态，webview 不渲染勾选框）。
    // 缺省 null：入口渲染的用例必须显式推一次能力，等待态因此是默认基线。
    mountProxyCapabilities: null,
    // 部署编排的脚本：宿主收到 requestMountProxyDeploy 后按此推 mountProxyDeployState 序列。
    mountProxyDeployScript: ['needsCredential'],
    // 判定凭据对错的期望值（null = 任何凭据都对）
    mountProxyExpectedSecret: null,
    mountProxyExpectedMethod: null,
    // 部署脚本回推给对话框的安装落点 / 目标主机 / 零密码命令
    mountProxyFacts: { installPath: '/usr/libexec/mount-proxy', targetHost: 'this-host', manualCommand: '' },
    // 对话切换锁（specs/059 FR-007）：webview 上报的锁事实，用例断言发送前 / 确认框期间的值
    conversationSwitchLocked: false,
    conversationSwitchLockReason: '',
    // ── 自动获取模型（specs/060）──
    // 阶段一回包的模型列表与已知协议（用例可改写；缺省两个模型、都未设协议）
    fetchModelResults: ['probe-model', 'probe-model-pro'],
    fetchModelApiTypes: {},
    // 阶段一回包的上下文候选：模型名 -> token 数（空对象 = 服务商未返回，context 勾选项置灰）
    fetchModelContexts: {},
    // 阶段二探测出的协议（与 fetchModelApiTypes 合并后回包）
    fetchDetectedApiTypes: {},
  };
  // 注入期预置：挂载时只问一次的请求（能力查询）必须在启动前就位
  state.mountProxyCapabilities = ${JSON.stringify(init.storageCapabilities ?? null)};

  // webview → 宿主 的全部上行消息（追加写，测试轮询断言）
  const sent = [];
  // 正在流式中的会话（sendMessage 触发，queryEnd/abort 清除）
  const active = new Set();

  const send = (msg) => {
    // specs/019：测试直推的 sessionRuntimeStates 记入 state.runtimeStates——
    // 对齐生产 ConversationManager.getSessionStatesSnapshot（拉取回包是最近一次
    // 推送的快照，不是空表），否则 App 主动拉取会把直推状态清掉
    if (msg && msg.type === 'sessionRuntimeStates') state.runtimeStates = msg.states;
    window.postMessage(msg, '*');
  };

  /** 按启用列表把服务器定义组装成 McpServerInfo（与宿主读 mcp.json 同形状） */
  function mcpInfo(enabledNames) {
    const enabled = new Set(enabledNames);
    return state.mcpServers.map((name) => ({
      name, type: 'local', command: ['fake-mcp'], environment: {}, url: '', headers: {},
      enabled: enabled.has(name), running: enabled.has(name), toolCount: 0, error: null,
    }));
  }

  let streamSeq = 0;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** 播放一轮脚本化助手回复（流式 chunk 逐帧推送） */
  async function playTurn(sessionId, content) {
    const cfg = { ...state.turn };
    streamSeq += 1;
    const streamId = 'fake-stream-' + streamSeq;
    active.add(sessionId);

    // 用户消息回显（真实链路：core messageAdded → 宿主 addMessage）
    send({ type: 'addMessage', sessionId, role: 'user', content, messageUuid: 'fake-uuid-' + streamSeq });
    send({ type: 'queryBegin', sessionId });
    send({ type: 'sessionRuntimeStates', states: [runningState(sessionId)] });

    if (cfg.thinking) {
      // streamMessage 的 accumulated 契约是「当前累积的完整文本」（src/host/webviewMessages.ts
      // 载荷注释；core-rs/src/engine.rs 的 thinking delta 事件同口径）：webview 把它当
      // 消息全文写入，发成块级值会让 thinking 内容缩成最后一个块——与 rAF / streamEnd
      // 的到达顺序竞态（specs/defects/fakehost-thinking-accumulated-chunk-only）。
      // 注意：本函数体整体是模板字符串（第 29 行起），注释里不能再用反引号。
      let thinkingAcc = '';
      for (const chunk of chunkText(cfg.thinking)) {
        // abort 后 active 已被清掉：立即停流，不再补 idle / queryEnd（由 abort 分支回推）
        if (!active.has(sessionId)) return;
        thinkingAcc += chunk;
        send({ type: 'streamMessage', sessionId, role: 'thinking', delta: chunk, accumulated: thinkingAcc, streamId });
        await sleep(cfg.chunkDelayMs);
      }
      send({ type: 'streamEnd', sessionId, role: 'thinking', accumulated: cfg.thinking, streamId });
    }

    let acc = '';
    for (const chunk of chunkText(cfg.text)) {
      if (!active.has(sessionId)) return;
      acc += chunk;
      send({ type: 'streamMessage', sessionId, role: 'assistant', delta: chunk, accumulated: acc, streamId });
      await sleep(cfg.chunkDelayMs);
    }
    if (!active.has(sessionId)) return;
    send({
      type: 'streamEnd', sessionId, role: 'assistant', accumulated: cfg.text, streamId,
      usage: cfg.usage ?? { input_tokens: 100, output_tokens: 20 },
    });
    // 不补发 assistant 的 addMessage：as-built 契约里 core 的 message 事件只发
    // 用户消息回执 / system / 失败回显（docs/architecture/events.md 第 2.1 节事件表
    // 的触发点列；engine.rs 流式收尾后不再发 message），webview 因此对 assistant
    // 的 addMessage 没有去重逻辑——这里多发一条会把同一段回复渲染成两份。

    active.delete(sessionId);
    send({ type: 'sessionRuntimeStates', states: [idleState(sessionId)] });
    send({ type: 'queryEnd', sessionId });
    // 轮次完成计数：测试用它做确定性的轮次边界等待（按钮禁用态是快照投影，存在误报窗口）
    window.__fakeHost.turnsDone = (window.__fakeHost.turnsDone || 0) + 1;
  }

  /** 前台查询在跑的运行时快照（abort 按钮红色） */
  function runningState(sessionId) {
    return {
      sessionId, idle: false, waiting: false,
      queryRunning: true, compacting: false, pendingCompact: false, backgroundRunning: false, subAgentRunning: false,
    };
  }

  /** 全空闲的运行时快照（abort 按钮灰色） */
  function idleState(sessionId) {
    return {
      sessionId, idle: true, waiting: false,
      queryRunning: false, compacting: false, pendingCompact: false, backgroundRunning: false, subAgentRunning: false,
    };
  }

  /** 把文本切成流式 chunk（模拟 token 级增量） */
  function chunkText(text) {
    const chunks = [];
    const step = Math.max(1, Math.ceil(text.length / 6));
    for (let i = 0; i < text.length; i += step) chunks.push(text.slice(i, i + step));
    return chunks.length > 0 ? chunks : [''];
  }

  // ── Overlay 挂载代理的部署编排（specs/051 FR-003 / FR-004） ──
  // 真实宿主的状态机在 src/host/mountProxyGate.ts + mountProxyInstall.ts；假宿主只复现
  // webview 能看见的那一半：按脚本推 mountProxyDeployState，凭据提交由用例决定对错。
  // 重试不设次数上限（能试几次由服务端策略决定），因此这里也没有剩余次数。
  let deployScriptIndex = 0;
  // 每轮部署的开始序号：宿主回推的人机等待点在 deployContinue 的 resolve 处
  let deployResolve = null;
  let deployCancelled = false;
  /** 被闸门拦下的消息（取消时回填输入框，FR-003 的 AC-9） */
  let blockedMessage = null;
  let deployCredentialOk = false;
  /** 上一次认证失败的原因（失败态回显，FR-004 第 5 条） */
  let deployFailure = null;
  /** 用户在失败态点了「重试」（重新走一遍部署，不设次数上限） */
  let deployRestart = false;

  function pushDeployState(extra) {
    send({
      type: 'mountProxyDeployState',
      phase: 'running',
      failure: null,
      manualCommand: null,
      targetHost: state.mountProxyFacts.targetHost,
      installPath: state.mountProxyFacts.installPath,
      ...extra,
    });
  }

  /** 等 webview 对当前人机步骤作答（提交凭据 / 取消），或脚本自动前进 */
  function waitForHuman() {
    deployCancelled = false;
    deployCredentialOk = false;
    deployRestart = false;
    return new Promise((resolve) => { deployResolve = resolve; });
  }

  function deployContinue() {
    const resolve = deployResolve;
    deployResolve = null;
    if (resolve) resolve();
  }

  async function playMountProxyDeploy() {
    deployScriptIndex = 0;
    deployFailure = null;
    pushDeployState({
      phase: 'running',
      failure: null,
      manualCommand: null,
      installPath: state.mountProxyFacts.installPath,
      targetHost: state.mountProxyFacts.targetHost,
    });

    while (deployScriptIndex < state.mountProxyDeployScript.length) {
      const step = state.mountProxyDeployScript[deployScriptIndex];
      deployScriptIndex += 1;
      if (step === 'needsCredential') {
        // 真实宿主的 gate.fail() 把失败原因推成 failed，用户换一条来源或点「重试」
        // 都能继续——不设次数上限（FR-004 第 4 / 5 条）。
        for (;;) {
          pushDeployState({
            phase: deployFailure === null ? 'needsCredential' : 'failed',
            failure: deployFailure,
            manualCommand: null,
            installPath: state.mountProxyFacts.installPath,
            targetHost: state.mountProxyFacts.targetHost,
          });
          await waitForHuman();
          if (deployCancelled) return;
          if (deployCredentialOk) {
            deployFailure = null;
            break;
          }
          // 重试 = 重新走一遍（免密通道 + 三选一），失败原因清空
          if (deployRestart) {
            deployFailure = null;
            continue;
          }
          // 判错：进失败态回显原因，仍可换来源或再点重试
          deployFailure = 'authentication failed';
        }
      } else if (step === 'manualCommand') {
        pushDeployState({
          phase: 'needsCredential',
          failure: null,
          manualCommand: state.mountProxyFacts.manualCommand,
          installPath: state.mountProxyFacts.installPath,
          targetHost: state.mountProxyFacts.targetHost,
        });
        await waitForHuman();
        if (deployCancelled) return;
      } else if (step === 'failed') {
        // 脚本显式给出的失败步骤：失败态留在界面上说明原因（成功才自动收起）
        pushDeployState({
          phase: 'failed',
          failure: 'installation failed',
          manualCommand: null,
          installPath: state.mountProxyFacts.installPath,
          targetHost: state.mountProxyFacts.targetHost,
        });
        return;
      }
    }

    // 部署成功：能力转为可用（FR-008 的重查结果由用例侧决定，这里给「已就位」）
    state.mountProxyCapabilities = {
      isolatedWorkView: true,
      mountProxy: 'ready',
      deployable: false,
      reason: '',
    };
    pushDeployState({
      phase: 'done',
      failure: null,
      manualCommand: null,
      installPath: state.mountProxyFacts.installPath,
      targetHost: state.mountProxyFacts.targetHost,
    });

    // 部署成功后**按原载荷继续**那次提交（specs/059 FR-005）：真实宿主在
    // continueBlockedAction 里把快照原样交给已受理消息的上行；假宿主等同处理——
    // 剥掉 submitId、换成 sendMessage 走进同一条引擎链路，用户不需要再按一次发送。
    const blocked = blockedMessage;
    blockedMessage = null;
    if (blocked !== null) {
      const { submitId: _submitId, type: _type, ...payload } = blocked.wire;
      send({ type: 'sendMessage', ...payload });
    }
  }

  // —— 自动应答：覆盖 webview 启动序列的全部请求 ——
  window.addEventListener('towhost', (event) => {
    const msg = event.detail;
    switch (msg.type) {
      case 'requestTheme':
        send({ type: 'setTheme', theme: 'dark' });
        break;
      case 'requestContextLimit':
        send({ type: 'contextLimitUpdated', maxContextTokens: 128000 });
        break;
      case 'requestStorageCapabilities':
        // specs/051 FR-001：能力是 Core 的事实，宿主只透传。null = 不应答（等待态）。
        if (state.mountProxyCapabilities) {
          send({ type: 'setStorageCapabilities', ...state.mountProxyCapabilities });
        }
        break;
      case 'requestMountProxyDeploy':
        // specs/051 FR-003：宿主侧的部署闸门在真实链路里会先弹确认再编排提权；
        // 假宿主把编排脚本化，webview 只负责呈现 mountProxyDeployState。
        // 已经在等人机作答时（失败态点「重试」）= 继续这一轮，不重开脚本。
        if (deployResolve !== null) {
          deployRestart = true;
          deployContinue();
        } else {
          void playMountProxyDeploy();
        }
        break;
      case 'submitMountProxyCredential': {
        // specs/051 FR-004 AC-13：凭据只进内存，判对错后丢弃；不进 state（假宿主也不留）。
        const ok = (state.mountProxyExpectedMethod === null || state.mountProxyExpectedMethod === msg.method)
          && (state.mountProxyExpectedSecret === null || state.mountProxyExpectedSecret === msg.secret);
        deployCredentialOk = ok;
        // 次数只在真正判定一次失败时递增（见 needsCredential 之后的 failed 分支），
        // 这里不递增——两处都加会让第 1 次失败就扣掉 2 次。
        deployContinue();
        break;
      }
      case 'showMountProxyManualCommand':
        // specs/051 FR-004 第 2 条的零密码通道：真实宿主把完整命令推回去等用户自己跑。
        // 假宿主直接用它预置的命令（用例经 setMountProxyDeploy 的 facts 给出）。
        pushDeployState({
          phase: 'needsCredential',
          failure: null,
          manualCommand: state.mountProxyFacts.manualCommand,
        });
        break;
      case 'cancelMountProxyDeploy':
        // 真实宿主的 gate.cancel() 推 cancelled 让界面收起，并按 submitId 回 rejected 作废
        // 这次提交（specs/059 FR-003）。**不回填**：载体从未被消费（已删除
        // userMessageDraftRestored），所以假宿主也不发那条。
        deployCancelled = true;
        if (blockedMessage !== null) {
          send({ type: 'userMessageRejected', submitId: blockedMessage.submitId, reason: '' });
          blockedMessage = null;
        }
        send({
          type: 'mountProxyDeployState',
          phase: 'cancelled',
          failure: null,
          manualCommand: null,
          targetHost: state.mountProxyFacts.targetHost,
          installPath: state.mountProxyFacts.installPath,
        });
        deployContinue();
        break;
      case 'requestSkills':
        send({
          type: 'setSkills',
          skills: [
            { name: 'commit', description: 'Create a git commit from staged changes', isBuiltin: true },
            { name: 'spin', description: 'Run the spin workflow', isBuiltin: true },
            { name: 'demo-skill', description: '演示技能：做点什么' },
          ],
        });
        break;
      case 'requestWorkspaces':
        // @ 工作区补全（specs/023 FR-007）：宿主已排除来源视图自己的工作区（模板字符串内不写反引号）。
        // 路径要四反斜杠：本块在外层模板字符串里，源码 \\\\ 经模板求值得 \\，
        // 再经生成脚本的字符串转义落成运行期的单个 \（写 \\ 会变成 \w 这类
        // 未知转义而丢反斜杠，workspaceMention 用例曾因此恒红）
        send({
          type: 'setWorkspaces',
          workspaces: [
            { id: 'DEV-PC:C:\\\\work\\\\alpha', path: 'C:\\\\work\\\\alpha', displayName: 'alpha' },
            { id: 'DEV-PC:C:\\\\Program Files\\\\gamma', path: 'C:\\\\Program Files\\\\gamma', displayName: 'gamma' },
          ],
        });
        break;
      case 'requestMcpServers':
        send({ type: 'setMcpServers', sessionId: msg.sessionId, servers: mcpInfo(state.mcpSessionEnabled) });
        break;
      case 'setMcpEnabled':
        state.mcpSessionEnabled = msg.enabled
          ? [...new Set([...state.mcpSessionEnabled, msg.name])]
          : state.mcpSessionEnabled.filter((name) => name !== msg.name);
        send({ type: 'setMcpServers', sessionId: msg.sessionId, servers: mcpInfo(state.mcpSessionEnabled) });
        break;
      case 'setMcpEnabledList':
        state.mcpSessionEnabled = [...new Set(msg.names)];
        send({ type: 'setMcpServers', sessionId: msg.sessionId, servers: mcpInfo(state.mcpSessionEnabled) });
        break;
      case 'requestModels':
        send({
          type: 'setModels',
          providers: [{ key: 'mock-provider', models: ['mock-model', 'mock-model-pro'] }],
          activeProvider: 'mock-provider',
        });
        break;
      case 'fetchProviderModels':
        // 「自动获取」阶段一（specs/060）：模型列表 + 上下文候选同一份回包。
        // 候选来自 state.fetchModelContexts（用例按需改写；空对象 = 服务商没返回窗口）。
        send({
          type: 'providerModelsFetched',
          models: state.fetchModelResults,
          modelApiTypes: state.fetchModelApiTypes,
          needDetect: state.fetchModelResults.filter((m) => !state.fetchModelApiTypes[m]),
          modelContexts: state.fetchModelContexts,
        });
        break;
      case 'detectProviderModelApiTypes':
        // 阶段二：把请求里的候选原样带回（真实宿主同口径，specs/060 FR-006）
        send({
          type: 'providerModelsResult',
          models: msg.models,
          modelApiTypes: { ...state.fetchModelApiTypes, ...(state.fetchDetectedApiTypes || {}) },
          modelContexts: msg.modelContexts || {},
        });
        break;
      case 'requestSettingsDefaults':
        send({
          type: 'settingsDefaults',
          ...state.settingsDefaults,
          language: 'zh',
          fontSize: 'medium',
          providerConfigured: true,
        });
        break;
      case 'saveLLMConfig': {
        // 与真实宿主同口径：保存成功后回 llmConfigSaved，webview 据此更新新对话默认值、
        // 并在默认值与当前对话不一致时弹「是否应用到当前对话」对话框。
        const before = { ...state.settingsDefaults };
        if (typeof msg.language === 'string') state.language = msg.language;
        if (typeof msg.thinkingEffort === 'string') state.settingsDefaults.thinkingMode = msg.thinkingEffort;
        if (typeof msg.defaultAgentMode === 'string') state.settingsDefaults.agentMode = msg.defaultAgentMode;
        if (typeof msg.webSearch === 'boolean') state.settingsDefaults.webSearch = msg.webSearch;
        if (Array.isArray(msg.providers) && msg.providers.length > 0) {
          const activeKey = msg.activeProvider || before.provider;
          const active = msg.providers.find((p) => p.key === activeKey) || msg.providers[0];
          state.settingsDefaults.provider = active.key;
          state.settingsDefaults.model = active.defaultModel || (active.models && active.models[0]) || before.model;
        }
        // MCP 默认启用列表：真实宿主在写盘前先把当前对话钉在保存前的列表上，
        // 再把「保存后的默认列表 / 是否变化 / 当前对话保存前的列表」一起回传。
        let mcpFacts = {};
        if (Array.isArray(msg.mcpServers)) {
          const beforeMcpDefaults = [...state.mcpDefaults];
          const pinned = [...state.mcpSessionEnabled];
          state.mcpDefaults = [...new Set(msg.mcpServers)];
          // 钉住失败：真实宿主不回传三项事实，只回失败标志（保存本身照常成功）
          mcpFacts = state.mcpPinFailed
            ? { mcpPinFailed: true }
            : {
                mcpDefaultEnabled: [...state.mcpDefaults],
                mcpDefaultEnabledChanged:
                  JSON.stringify(beforeMcpDefaults) !== JSON.stringify(state.mcpDefaults),
                currentSessionMcpEnabled: pinned,
              };
        }
        const next = state.settingsDefaults;
        // 本次保存真正改动的默认项（与真实宿主同口径：对比保存前后快照）。
        // webview 的「是否询问应用到当前对话」只看这些标志。
        const defaultsChanged = {
          activeProvider: next.provider !== before.provider,
          thinkingEffort: next.thinkingMode !== before.thinkingMode,
          agentMode: next.agentMode !== before.agentMode,
          webSearch: next.webSearch !== before.webSearch,
        };
        send({
          type: 'llmConfigSaved',
          defaultModel: next.model,
          defaultModelProvider: next.provider,
          activeModel: next.model,
          activeModelProvider: next.provider,
          thinkingEffort: next.thinkingMode,
          defaultAgentMode: next.agentMode,
          webSearch: next.webSearch,
          defaultsChanged,
          currentProviderDefaultModel: next.model,
          currentProviderDefaultModelChanged: next.model !== before.model,
          language: state.language,
          ...mcpFacts,
          activeProvider: next.provider,
          closeAfterSave: !!msg.closeAfterSave,
        });
        break;
      }
      case 'getConversations':
        send({ type: 'conversationsData', conversations: state.conversations });
        break;
      case 'requestSessionRuntimeStates':
        send({ type: 'sessionRuntimeStates', states: state.runtimeStates });
        break;
      case 'requestConversationSpaces':
        send({ type: 'conversationSpacesData', spaces: state.conversationSpaces });
        break;
      case 'clearConversationSpace':
        // 与真实链路同口径：清空后回执；面板收到回执自行重取统计
        state.conversationSpaces = state.conversationSpaces.filter((s) => s.dirName !== msg.dirName);
        send({ type: 'conversationSpaceCleared', dirName: msg.dirName, removedFiles: 3, removedBytes: 456 });
        break;
      case 'requestLLMConfig':
        // provider key 必须与 baseURL 的主机 + 端口一致（面板按此推导身份，不一致会判定
        // 「未选择服务商」）；与 settingsRead 取 settings.json 表键的口径同源。
        // 旧口径键（只取主机名）的路径由 settings.spec.ts 专门覆盖
        send({
          type: 'showLLMConfig',
          providers: [{
            key: 'alpha.local:9',
            baseURL: 'http://alpha.local:9/v1',
            apiKey: 'sk-test',
            models: ['mock-model'],
            defaultModel: 'mock-model',
            // 与真实载荷同口径：settingsRead 回传的是已解析值（context/output 恒有数字）
            modelConfigs: { 'mock-model': { apiType: 'OpenAI', context: 1024000, output: 128000 } },
          }],
          activeProvider: 'alpha.local:9',
          thinkingEffort: 'high',
          defaultAgentMode: 'risk',
          webSearch: false,
          language: 'zh',
          fontSize: 'medium',
          // 设置面板「默认配置」编辑的是全局默认启用列表
          mcpServers: mcpInfo(state.mcpDefaults),
        });
        break;
      case 'startNewConversation':
        send({ type: 'initSessionState', sessionId: msg.sessionId });
        send({
          type: 'setNewConversationDefaults', sessionId: msg.sessionId,
          model: 'mock-model', provider: 'mock-provider',
          thinkingMode: 'high', agentMode: 'risk', webSearch: false,
        });
        break;
      case 'setConversationStorage':
        // 勾选后补发的归属（specs/045 FR-001）：只改 Core 侧的归属，闸门判据取自
        // sendMessage 自带的 storage（跨消息先后顺序不可靠）
        break;
      case 'submitMessage':
        // specs/059 FR-001 / FR-002：真实宿主对提���请求做三态裁决，裁决前不消费载体。
        // 假宿主复现同一判据与同一回执形态：
        //   - 能力不可用且不可部署 → 回 rejected（带 Core 的 reason）；
        //   - 能力不可用且可部署 → 拦进部署状态机（不回受理，提交保持挂起）；
        //   - 其余（含非 isolated 归属）→ 回 accepted，webview 消费载体后上行 sendMessage。
        if (
          state.mountProxyCapabilities !== null &&
          !state.mountProxyCapabilities.isolatedWorkView &&
          // 归属取自消息本身（specs/051 FR-003）：跨消息先后顺序不可靠
          msg.storage === 'isolated'
        ) {
          if (!state.mountProxyCapabilities.deployable) {
            send({
              type: 'userMessageRejected',
              submitId: msg.submitId,
              reason: state.mountProxyCapabilities.reason,
            });
            break;
          }
          // 闸门拦下：不回受理回执，webview 因此不消费载体、不上行已受理消息
          // （FR-003 的 AC-7 断言的是 sent 里没有 sendMessage）。
          // 载荷快照原样留着（specs/059 FR-005）：部署成功后按它继续
          blockedMessage = { submitId: msg.submitId, wire: msg };
          send({
            type: 'mountProxyDeployState',
            phase: 'confirm',
            failure: null,
            manualCommand: null,
            targetHost: state.mountProxyFacts.targetHost,
            installPath: state.mountProxyFacts.installPath,
          });
          break;
        }
        send({ type: 'userMessageAccepted', submitId: msg.submitId, sessionId: msg.sessionId });
        break;
      case 'conversationSwitchLockChanged':
        // specs/059 FR-007：锁登记在真实宿主的主进程；假宿主只记下已上报的事实，
        // 用例断言的正是「确认框打开 / 提交未决期间上报了 locked: true」
        state.conversationSwitchLocked = msg.locked;
        state.conversationSwitchLockReason = msg.reason;
        break;
      case 'sendMessage':
        // 已受理消息的上行（specs/059 FR-001）：用户按下发送走 submitMessage，这条只来自
        // 受理之后的消费（webview 拿到 accepted 后上行）与排队项重投。部署检测已在提交
        // 裁决里做过，这里不再判据——假宿主照旧走引擎。
        if (active.has(msg.sessionId) && state.queueWhileBusy) {
          // 引擎忙碌：真实链路由 core 排队，宿主回 queuedMessage 横幅
          send({ type: 'queuedMessage', sessionId: msg.sessionId, content: msg.content, uuid: 'q-' + Date.now() });
        } else {
          void playTurn(msg.sessionId, msg.content);
        }
        break;
      case 'abort': {
        if (msg.sessionId) {
          active.delete(msg.sessionId);
          // 默认回到空闲；三态用例把 abortRuntimeStates 设成「前台停下、后台仍在跑」的快照
          send({
            type: 'sessionRuntimeStates',
            states: state.abortRuntimeStates ?? [idleState(msg.sessionId)],
          });
          send({ type: 'queryEnd', sessionId: msg.sessionId });
        }
        break;
      }
      case 'requestSessionTodos': {
        // 任务进度（docs/features/todo-list.md FR-002）：core 持有清单，这里回该会话的假数据
        send({
          type: 'sessionTodos', sessionId: msg.sessionId,
          todos: state.sessionTodos[msg.sessionId] || [],
        });
        break;
      }
      case 'loadConversation': {
        // 单视图加载会话：回放该会话的历史消息（取自 state.conversations 的种子数据）；
        // metadata 整份来自 core（meta.json），一次性通知的 onceMessage 随之下发
        const conv = state.conversations.find((c) => c.sessionId === msg.sessionId);
        send({
          type: 'conversationLoaded', sessionId: msg.sessionId,
          conversation: {
            metadata: {
              sessionId: msg.sessionId, title: conv ? conv.title : '', model: 'mock-model', provider: 'mock-provider',
              ...(conv && conv.onceMessage ? { onceMessage: conv.onceMessage } : {}),
            },
            messages: conv && conv.messages ? conv.messages : [],
          },
          hasCompactArchive: !!(conv && conv.hasCompactArchive),
          provider: 'mock-provider', model: 'mock-model', agentMode: 'risk',
        });
        if (state.loadReplacementMessages) {
          // 与 conversationLoaded 同一批任务发出：webview 的 rAF 必然晚于两者处理，
          // 复现「替换先落、rAF 后到」的加载窗口竞态
          send({ type: 'messagesReplaced', sessionId: msg.sessionId, messages: state.loadReplacementMessages });
        }
        break;
      }
      case 'expandCompact': {
        // 压缩历史逐层展开：宿主把完整序列与每代起始下标一次交给 webview，
        // 展开到第几层由 webview 自己决定（docs/features/compaction.md FR-005）
        send({
          type: 'expandCompactDone',
          sessionId: msg.sessionId,
          messages: state.expandedMessages,
          generationStarts: state.expandedGenerationStarts,
        });
        break;
      }
      default:
        // 其余消息只记录，由测试断言
        break;
    }
  });

  window.vscode = {
    postMessage(message) {
      // sent 记录 webview 的全部上行消息。部署闸门的判据不在这里过滤：submitMessage
      // 本来就是「请宿主裁决」的那一条（它必须到达宿主，specs/059 FR-001）；被拦下时宿主
      // 不回受理回执，因此 sendMessage 不会出现——那正是 e2e 断言的事实。
      sent.push(message);
      window.dispatchEvent(new CustomEvent('towhost', { detail: message }));
    },
  };

  window.__fakeHost = { send, sent, state, turnsDone: 0 };
})();
`;
}

/** webview 侧「新对话」语义固定为 VS Code 单视图 + webview 渲染对话列表 */
export const FAKE_HOST_INIT = fakeHostInit({ conversationView: 'single', conversationListOwner: 'webview' });

/** Electron 浮窗形态：多视图（顶栏多「关闭」按钮）+ 对话列表在 webview 顶栏 */
export const FAKE_HOST_INIT_FLOATING = fakeHostInit({ conversationView: 'multi', conversationListOwner: 'webview' });

/** 测试侧驱动器：跨进程边界操作页面内的假宿主 */
export class FakeHostDriver {
  constructor(private readonly page: Page) {}

  /** 等待某类上行消息出现并返回（首个匹配）。缺省 30s：慢机器上交互到上行之间隔着完整的 UI 处理链 */
  async waitForSent(type: string, timeout = 30_000): Promise<any> {
    try {
      await this.page.waitForFunction(
        (t) => (window as any).__fakeHost.sent.some((m: any) => m.type === t),
        type,
        { timeout },
      );
    } catch (err) {
      const seen = await this.page
        .evaluate(() => (window as any).__fakeHost.sent.map((m: any) => m.type))
        .catch(() => [] as string[]);
      throw new Error(`等待上行消息 ${type} 超时（${timeout}ms）。已收消息类型：${JSON.stringify(seen)}`);
    }
    return this.page.evaluate(
      (t) => (window as any).__fakeHost.sent.find((m: any) => m.type === t),
      type,
    );
  }

  /** 等待某类上行消息中出现满足谓词的一条（跳过启动期回显，返回首个匹配） */
  async waitForSentWhere(type: string, pred: (msg: any) => boolean, timeout = 30_000): Promise<any> {
    await this.page.waitForFunction(
      ({ t, src }) => {
        const code = new Function('m', `return (${src})(m);`);
        return (window as any).__fakeHost.sent.some((m: any) => m.type === t && code(m));
      },
      { t: type, src: pred.toString() },
      { timeout },
    );
    return this.page.evaluate(
      ({ t, src }) => {
        const code = new Function('m', `return (${src})(m);`);
        return (window as any).__fakeHost.sent.find((m: any) => m.type === t && code(m));
      },
      { t: type, src: pred.toString() },
    );
  }

  /** 当前全部上行消息快照 */
  async sentAll(): Promise<any[]> {
    return this.page.evaluate(() => [...(window as any).__fakeHost.sent]);
  }

  /** 注入一条下行消息（宿主 → webview） */
  async send(msg: unknown): Promise<void> {
    await this.page.evaluate((m) => (window as any).__fakeHost.send(m), msg);
  }

  /** 改写脚本化助手轮次参数（usage 覆盖 streamEnd 的用量回执，驱动缓存命中率场景） */
  async setTurn(turn: {
    thinking?: string;
    text: string;
    chunkDelayMs?: number;
    usage?: Record<string, number> | null;
  }): Promise<void> {
    await this.page.evaluate(
      (t) => { Object.assign((window as any).__fakeHost.state.turn, t); },
      turn,
    );
  }

  /** 改写某会话的 Todo 清单（`requestSessionTodos` 的应答数据） */
  async setSessionTodos(sessionId: string, todos: Array<Record<string, unknown>>): Promise<void> {
    await this.page.evaluate(
      (args: { sid: string; list: Array<Record<string, unknown>> }) => {
        (window as any).__fakeHost.state.sessionTodos[args.sid] = args.list;
      },
      { sid: sessionId, list: todos },
    );
  }

  /**
   * 改写 expandCompact 应答的完整展开序列（压缩历史逐层展开场景）。
   * 只给序列不给分界时按「单代」处理（起点 0），等价于改动前的一次点击。
   */
  async setExpandedMessages(
    messages: Array<Record<string, unknown>>,
    generationStarts: number[] = [0],
  ): Promise<void> {
    await this.page.evaluate(
      (payload: { messages: Array<Record<string, unknown>>; starts: number[] }) => {
        (window as any).__fakeHost.state.expandedMessages = payload.messages;
        (window as any).__fakeHost.state.expandedGenerationStarts = payload.starts;
      },
      { messages, starts: generationStarts },
    );
  }

  /** 设置 loadConversation 应答后同批补发的 messagesReplaced 载荷（null = 关闭注入） */
  async setLoadReplacement(messages: Array<Record<string, unknown>> | null): Promise<void> {
    await this.page.evaluate(
      (list) => { (window as any).__fakeHost.state.loadReplacementMessages = list; },
      messages,
    );
  }

  /** 改写对话列表 / 运行时状态应答数据 */
  async setConversations(
    conversations: Array<Record<string, unknown>>,
  ): Promise<void> {
    await this.page.evaluate(
      (list) => { (window as any).__fakeHost.state.conversations = list; },
      conversations,
    );
  }

  /**
   * 设定「自动获取模型」阶段一的回包内容（specs/060）：
   * 模型列表、已知协议与上下文候选。`contexts` 为空 = 服务商未返回窗口，
   * 面板据此把「尝试获取 context 大小」置灰。
   */
  async setFetchModelResults(args: {
    models: string[];
    apiTypes?: Record<string, string>;
    contexts?: Record<string, number>;
    detectedApiTypes?: Record<string, string>;
  }): Promise<void> {
    await this.page.evaluate((a) => {
      const host = (window as any).__fakeHost;
      host.state.fetchModelResults = a.models;
      host.state.fetchModelApiTypes = a.apiTypes || {};
      host.state.fetchModelContexts = a.contexts || {};
      host.state.fetchDetectedApiTypes = a.detectedApiTypes || {};
    }, args);
  }

  /** 改写对话空间统计应答数据 */
  async setConversationSpaces(
    spaces: Array<Record<string, unknown>>,
  ): Promise<void> {
    await this.page.evaluate(
      (list) => { (window as any).__fakeHost.state.conversationSpaces = list; },
      spaces,
    );
  }

  async setRuntimeStates(
    states: Array<{ sessionId: string; idle: boolean; waiting: boolean }>,
  ): Promise<void> {
    await this.page.evaluate(
      (list) => { (window as any).__fakeHost.state.runtimeStates = list; },
      states,
    );
  }

  /**
   * 设定收到 abort 时回推的运行时快照（`null` 恢复默认的空闲快照）。
   * abort 三态用例用它模拟「第一次点击只停前台、后台任务仍在跑」。
   */
  async setAbortRuntimeStates(
    states: Array<Record<string, unknown>> | null,
  ): Promise<void> {
    await this.page.evaluate(
      (list) => { (window as any).__fakeHost.state.abortRuntimeStates = list; },
      states,
    );
  }

  /**
   * 读宿主侧状态快照（只读）：用例断言「webview 上报了哪些事实」时用。
   *
   * 目前只暴露对话切换锁（specs/059 FR-007）——锁登记在真实宿主的主进程，webview 侧
   * 看不出来，因此必须读这里才能断言「确认框打开时锁已上报」。
   */
  async state(): Promise<{ conversationSwitchLocked: boolean; conversationSwitchLockReason: string }> {
    return this.page.evaluate(() => ({
      conversationSwitchLocked: !!(window as any).__fakeHost.state.conversationSwitchLocked,
      conversationSwitchLockReason: String((window as any).__fakeHost.state.conversationSwitchLockReason ?? ''),
    }));
  }

  /**
   * 设定文件存储能力应答（specs/051 FR-001）：`null` 表示宿主不应答，
   * 复现「能力始终未到达」的等待态。
   */
  async setMountProxyCapabilities(capabilities: {
    isolatedWorkView: boolean;
    mountProxy: 'ready' | 'absent';
    deployable: boolean;
    reason: string;
  } | null): Promise<void> {
    await this.page.evaluate(
      (cap) => { (window as any).__fakeHost.state.mountProxyCapabilities = cap; },
      capabilities,
    );
  }

  /**
   * 设定部署编排脚本（specs/051 FR-003 / FR-004）。
   *
   * `script` 逐条推进：`needsCredential` 停下等人提交凭据（对错由 `expected` 判定），
   * `manualCommand` 停下等零密码通道走完，`failed` 记一次失败并停手。`facts` 是回推给
   * 对话框的安装落点 / 目标主机 / 零密码命令。
   */
  async setMountProxyDeploy(options: {
    script?: Array<'needsCredential' | 'manualCommand' | 'failed'>;
    expected?: { method?: 'sudoPassword' | 'rootPassword'; secret?: string } | null;
    facts?: { installPath?: string; targetHost?: string; manualCommand?: string };
  }): Promise<void> {
    await this.page.evaluate((opts) => {
      const host = (window as any).__fakeHost;
      if (opts.script) host.state.mountProxyDeployScript = opts.script;
      host.state.mountProxyExpectedMethod = opts.expected?.method ?? null;
      host.state.mountProxyExpectedSecret = opts.expected?.secret ?? null;
      if (opts.facts) Object.assign(host.state.mountProxyFacts, opts.facts);
    }, options);
  }

  /**
   * 设定 MCP 三份状态：`servers` 是 mcp.json 的服务器定义（名称），
   * `defaults` 是全局默认启用列表（设置面板编辑的对象），
   * `sessionEnabled` 是当前会话生效的启用列表（输入框菜单展示的对象）。
   */
  async setMcpState(state: {
    servers: string[];
    defaults?: string[];
    sessionEnabled?: string[];
    /** 模拟宿主钉住当前对话失败（保存仍成功，只回 `mcpPinFailed`） */
    pinFailed?: boolean;
  }): Promise<void> {
    await this.page.evaluate((s) => {
      const host = (window as any).__fakeHost;
      host.state.mcpServers = [...s.servers];
      host.state.mcpDefaults = [...(s.defaults ?? [])];
      host.state.mcpSessionEnabled = [...(s.sessionEnabled ?? s.defaults ?? [])];
      host.state.mcpPinFailed = !!s.pinFailed;
    }, state);
  }

  /** 等待 webview 完成启动初始化（主题已下发、输入框可用） */
  async waitReady(): Promise<void> {
    await expect(this.page.locator('textarea.input-textarea')).toBeVisible({ timeout: 30_000 });
    // 设置装载完成的 UI 信标：上下文进度条只在 maxContextTokens 到达后渲染
    // （webview 不猜值，铁律 7）。配置装载期间 sendDisabled 会丢弃 Enter
    // （InputArea 的 configBusy 分支），不等到这一刻就交互是用例级 flake 的来源。
    await expect(this.page.locator('span[title="点击压缩"]')).toBeVisible({ timeout: 30_000 });
  }
}
