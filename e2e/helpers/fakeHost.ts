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
  window.__hasWorkspace = true;
  window.__highlightLanguages = [];
  window.logoUri = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#555"/></svg>'
  );

  const state = {
    // conversationsData / sessionRuntimeStates 的应答数据（测试可改写）
    conversations: [],
    runtimeStates: [],
    // 脚本化助手轮次：每次 sendMessage 使用当时的值
    turn: { thinking: '', text: '', chunkDelayMs: 40 },
    // 引擎忙碌时再来一条 sendMessage 是否回 queuedMessage（排队语义）
    queueWhileBusy: true,
  };

  // webview → 宿主 的全部上行消息（追加写，测试轮询断言）
  const sent = [];
  // 正在流式中的会话（sendMessage 触发，queryEnd/abort 清除）
  const active = new Set();

  const send = (msg) => window.postMessage(msg, '*');

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
    send({ type: 'sessionRuntimeStates', states: [{ sessionId, idle: false, waiting: false }] });

    if (cfg.thinking) {
      for (const chunk of chunkText(cfg.thinking)) {
        send({ type: 'streamMessage', sessionId, role: 'thinking', delta: chunk, accumulated: chunk, streamId });
        await sleep(cfg.chunkDelayMs);
      }
      send({ type: 'streamEnd', sessionId, role: 'thinking', accumulated: cfg.thinking, streamId });
    }

    let acc = '';
    for (const chunk of chunkText(cfg.text)) {
      acc += chunk;
      send({ type: 'streamMessage', sessionId, role: 'assistant', delta: chunk, accumulated: acc, streamId });
      await sleep(cfg.chunkDelayMs);
    }
    send({
      type: 'streamEnd', sessionId, role: 'assistant', accumulated: cfg.text, streamId,
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    send({ type: 'addMessage', sessionId, role: 'assistant', content: cfg.text });

    active.delete(sessionId);
    send({ type: 'sessionRuntimeStates', states: [{ sessionId, idle: true, waiting: false }] });
    send({ type: 'queryEnd', sessionId });
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
        send({ type: 'setMcpServers', servers: [] });
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
          model: 'mock-model',
          provider: 'mock-provider',
          thinkingMode: 'high',
          agentMode: 'risk',
          promptMode: 'normal',
          webSearch: false,
          language: 'zh',
          providerConfigured: true,
        });
        break;
      case 'getConversations':
        send({ type: 'conversationsData', conversations: state.conversations });
        break;
      case 'requestSessionRuntimeStates':
        send({ type: 'sessionRuntimeStates', states: state.runtimeStates });
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
          mcpServers: [],
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
          send({ type: 'sessionRuntimeStates', states: [{ sessionId: msg.sessionId, idle: true, waiting: false }] });
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
          provider: 'mock-provider', model: 'mock-model', agentMode: 'risk',
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

  /** 改写脚本化助手轮次参数 */
  async setTurn(turn: { thinking?: string; text: string; chunkDelayMs?: number }): Promise<void> {
    await this.page.evaluate(
      (t) => { Object.assign((window as any).__fakeHost.state.turn, t); },
      turn,
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

  async setRuntimeStates(
    states: Array<{ sessionId: string; idle: boolean; waiting: boolean }>,
  ): Promise<void> {
    await this.page.evaluate(
      (list) => { (window as any).__fakeHost.state.runtimeStates = list; },
      states,
    );
  }

  /** 等待 webview 完成启动初始化（主题已下发、输入框可用） */
  async waitReady(): Promise<void> {
    await expect(this.page.locator('textarea.input-textarea')).toBeVisible({ timeout: 15_000 });
  }
}
