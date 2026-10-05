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

/** webview 侧「新对话」语义固定为 VS Code 单视图 + webview 渲染对话列表 */
export const FAKE_HOST_INIT = `
(() => {
  // —— 宿主注入（preload / 扩展 HTML 注入的等价物）——
  window.__hostInfo = { conversationView: 'single', conversationListOwner: 'webview' };
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
    // expandCompact 的应答数据：整批替换后的消息（压缩历史展开场景）
    expandedMessages: [],
    // 引擎忙碌时再来一条 sendMessage 是否回 queuedMessage（排队语义）
    queueWhileBusy: true,
    // 收到 abort 时回推的运行时快照（null = 回空闲快照）。
    // abort 三态用例据此模拟「第一次点击只停前台、后台任务仍在跑」。
    abortRuntimeStates: null,
    // settings.json 默认值（requestSettingsDefaults 应答 + saveLLMConfig 后更新）
    settingsDefaults: {
      model: 'mock-model', provider: 'mock-provider',
      thinkingMode: 'high', agentMode: 'risk', promptMode: 'normal', webSearch: false,
    },
    // MCP：mcp.json 里的服务器定义（名称列表）
    mcpServers: [],
    // settings.json 的 mcp.enabled（全局默认，设置面板编辑）
    mcpDefaults: [],
    // 当前会话生效的启用列表（meta.json 的会话覆盖优先，其次全局默认）
    mcpSessionEnabled: [],
    // 模拟宿主「钉住当前对话」失败（读 core 事实失败）：保存照常成功，只回失败标志
    mcpPinFailed: false,
  };

  // webview → 宿主 的全部上行消息（追加写，测试轮询断言）
  const sent = [];
  // 正在流式中的会话（sendMessage 触发，queryEnd/abort 清除）
  const active = new Set();

  const send = (msg) => window.postMessage(msg, '*');

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
      for (const chunk of chunkText(cfg.thinking)) {
        // abort 后 active 已被清掉：立即停流，不再补 idle / queryEnd（由 abort 分支回推）
        if (!active.has(sessionId)) return;
        send({ type: 'streamMessage', sessionId, role: 'thinking', delta: chunk, accumulated: chunk, streamId });
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
    send({ type: 'addMessage', sessionId, role: 'assistant', content: cfg.text });

    active.delete(sessionId);
    send({ type: 'sessionRuntimeStates', states: [idleState(sessionId)] });
    send({ type: 'queryEnd', sessionId });
  }

  /** 前台查询在跑的运行时快照（abort 按钮红色） */
  function runningState(sessionId) {
    return {
      sessionId, idle: false, waiting: false,
      queryRunning: true, compacting: false, backgroundRunning: false, subAgentRunning: false,
    };
  }

  /** 全空闲的运行时快照（abort 按钮灰色） */
  function idleState(sessionId) {
    return {
      sessionId, idle: true, waiting: false,
      queryRunning: false, compacting: false, backgroundRunning: false, subAgentRunning: false,
    };
  }

  /** 把文本切成流式 chunk（模拟 token 级增量） */
  function chunkText(text) {
    const chunks = [];
    const step = Math.max(1, Math.ceil(text.length / 6));
    for (let i = 0; i < text.length; i += step) chunks.push(text.slice(i, i + step));
    return chunks.length > 0 ? chunks : [''];
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
        if (typeof msg.defaultPromptMode === 'string') state.settingsDefaults.promptMode = msg.defaultPromptMode;
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
        send({
          type: 'llmConfigSaved',
          defaultModel: next.model,
          defaultModelProvider: next.provider,
          activeModel: next.model,
          activeModelProvider: next.provider,
          thinkingEffort: next.thinkingMode,
          defaultAgentMode: next.agentMode,
          defaultPromptMode: next.promptMode,
          webSearch: next.webSearch,
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
        // provider key 必须与 baseURL 主机名一致（面板按此推导，不一致会判定「未选择服务商」）
        send({
          type: 'showLLMConfig',
          providers: [{
            key: 'alpha.local',
            baseURL: 'http://alpha.local:9/v1',
            apiKey: 'sk-test',
            models: ['mock-model'],
            defaultModel: 'mock-model',
            modelConfigs: { 'mock-model': { apiType: 'OpenAI' } },
          }],
          activeProvider: 'alpha.local',
          thinkingEffort: 'high',
          defaultAgentMode: 'risk',
          defaultPromptMode: 'normal',
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
          thinkingMode: 'high', agentMode: 'risk', promptMode: 'normal', webSearch: false,
        });
        break;
      case 'sendMessage':
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
      case 'loadConversation': {
        // 单视图加载会话：回放该会话的历史消息（取自 state.conversations 的种子数据）
        const conv = state.conversations.find((c) => c.sessionId === msg.sessionId);
        send({
          type: 'conversationLoaded', sessionId: msg.sessionId,
          conversation: {
            metadata: { sessionId: msg.sessionId, title: conv ? conv.title : '', model: 'mock-model', provider: 'mock-provider' },
            messages: conv && conv.messages ? conv.messages : [],
          },
          hasCompactArchive: !!(conv && conv.hasCompactArchive),
          provider: 'mock-provider', model: 'mock-model', agentMode: 'risk',
        });
        break;
      }
      case 'expandCompact': {
        // 压缩历史展开：宿主读归档后整批替换消息，再回展开完成（隐藏展开按钮）
        send({ type: 'messagesReplaced', sessionId: msg.sessionId, messages: state.expandedMessages });
        send({ type: 'expandCompactDone', sessionId: msg.sessionId });
        break;
      }
      default:
        // 其余消息只记录，由测试断言
        break;
    }
  });

  window.vscode = {
    postMessage(message) {
      sent.push(message);
      window.dispatchEvent(new CustomEvent('towhost', { detail: message }));
    },
  };

  window.__fakeHost = { send, sent, state };
})();
`;

/** 测试侧驱动器：跨进程边界操作页面内的假宿主 */
export class FakeHostDriver {
  constructor(private readonly page: Page) {}

  /** 等待某类上行消息出现并返回（首个匹配） */
  async waitForSent(type: string, timeout = 10_000): Promise<any> {
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
  async waitForSentWhere(type: string, pred: (msg: any) => boolean, timeout = 10_000): Promise<any> {
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

  /** 改写 expandCompact 应答的整批消息（压缩历史展开场景） */
  async setExpandedMessages(messages: Array<Record<string, unknown>>): Promise<void> {
    await this.page.evaluate(
      (list) => { (window as any).__fakeHost.state.expandedMessages = list; },
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
    await expect(this.page.locator('textarea.input-textarea')).toBeVisible({ timeout: 15_000 });
  }
}
