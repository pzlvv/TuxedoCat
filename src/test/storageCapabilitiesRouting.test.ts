/**
 * 能力应答按来源视图投递（specs/defects/work-view-option-missing-on-startup.md RT-1）。
 *
 * 「Overlay 对话」勾选框只在 `setStorageCapabilities` 到达当前视图后才渲染。Electron 是
 * 多视图宿主：`host.sendToWebview` 走默认路由（回包时刻的活动视图），后台预热视图发起的
 * 能力查询如果用它回包，请求方永远收不到应答、勾选框恒不出现。本组用例锁 handler 侧的
 * 契约面：`requestStorageCapabilities` 必须按 `ctx.sender` 定向回包，无来源视图时才走
 * 默认路由（与 `requestSkills` 同口径）。
 *
 * 运行方式：npm run test:unit -- storage-capabilities-routing
 */

import { createChecker, runTests } from './helpers/harness';
import { createTestHost, makeTestBus } from './helpers/fixtures';
import { WebviewViewHandle } from '../host/UIHost';
import { remoteWorkspaceRef } from '../host/workspaceRef';
import { UserChoiceManager } from '../host/ui/userChoice';
import { WebviewMessageHandler } from '../host/ui/webviewMessageHandler';
import type { HostToWebviewMessage } from '../host/webviewMessages';
import {
  resetGlobalEventBus,
  setGlobalEventBus,
  type UiRequest,
  type UiRequestHandlers,
} from '../shared/AssistantEventBus';

/** 远端工作区：能力查询必须问到它自己的 Core，而不是活动标签页的 Core */
const REMOTE_REF = remoteWorkspaceRef(
  { host: '10.0.0.7', port: 22, user: 'pz', auth: { kind: 'sshPassword', password: 'pw' } },
  '/home/pz/proj',
);

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  const { bus } = makeTestBus();
  /** 收到的 UiRequest（按到达顺序）；能力查询回「可用」 */
  const requests: UiRequest[] = [];
  const handlers: UiRequestHandlers = {
    storageCapabilitiesRequested: async (req) => {
      requests.push(req);
      return { isolatedWorkView: true, mountProxy: 'ready', deployable: false, reason: '' };
    },
    workViewFilesRequested: async () => ({ ok: false as const, error: '测试桩' }),
    workViewChangesRequested: async () => ({ ok: false as const, kind: 'error' as const, error: '测试桩' }),
    workViewFileDiffRequested: async () => ({ ok: false as const, error: '测试桩' }),
    conversationListRequested: async () => [],
    sessionTodosRequested: async () => [],
    conversationLoadRequested: async () => ({
      messages: [],
      metadata: null,
      pendingToolUseIds: [],
      hasCompactArchive: false,
      agentMode: null,
      workMode: 'normal',
    }),
    smartNamingRequested: async () => ({ title: '测试桩' }),
    balanceRequested: async () => null,
    compactArchiveRequested: async () => null,
    mcpServersRequested: async () => [],
    conversationSpacesRequested: async () => [],
    flushSessionRequested: async () => null,
    skillsRequested: async () => ({ skills: [] }),
    spinDesignRequested: async () => ({ status: 'ok', data: null, skills: [] }),
    spinDesignSaveRequested: async () => ({ status: 'ok' }),
    watchWorkspaceFileRequested: async () => ({ ok: true }),
    unwatchWorkspaceFileRequested: async () => null,
  };
  bus.onUiRequests(handlers);
  setGlobalEventBus(bus);

  const sender = new WebviewViewHandle({});
  /** 另一个视图的句柄：属于远端工作区（能力随 Core 走，与活动标签页无关） */
  const remoteSender = new WebviewViewHandle({});
  // 两条投递路径分开记录：多视图语义下「发给了谁」正是要测的点
  const toView: Array<{ view: unknown; message: HostToWebviewMessage }> = [];
  const toDefault: HostToWebviewMessage[] = [];
  const host = createTestHost({
    sendToWebview: (message) => {
      toDefault.push(message);
    },
    sendToWebviewView: (view, message) => {
      toView.push({ view, message });
    },
    // 来源视图 → 所属工作区：能力查询按它路由到该工作区的 Connection
    // （specs/defects/prewarm-view-capability-query-hits-wrong-core）
    getWorkspaceRefForView: (view) => (view === remoteSender ? REMOTE_REF : undefined),
  });
  const handler = new WebviewMessageHandler({
    host,
    postToWebview: () => undefined,
    postConversationLoaded: () => undefined,
    setTitle: () => undefined,
    userChoiceManager: new UserChoiceManager({
      outputChannel: undefined,
      postToWebview: () => undefined,
      closePreview: () => undefined,
      isSessionOpenInternal: () => false,
    }),
  });

  // 1) 多视图宿主：带来源视图的请求，应答只投给该视图
  await handler.handleWebviewMessage({ type: 'requestStorageCapabilities' }, { sender });
  check(
    '能力查询走 storageCapabilitiesRequested',
    requests.some((request) => request.type === 'storageCapabilitiesRequested'),
  );
  check('应答只投给请求视图', toView.length === 1 && toView[0]?.view === sender);
  check(
    '应答内容来自 Core（isolatedWorkView 原样透传）',
    toView[0]?.message.type === 'setStorageCapabilities'
      && (toView[0]?.message as { isolatedWorkView?: boolean }).isolatedWorkView === true,
  );
  check('不落到默认路由（回包时刻的活动视图）', toDefault.length === 0);

  // 1b) 路由载荷：请求方所属工作区必须随 UiRequest 上行，否则 Client 会落到
  // 活动连接，预热视图拿到的是另一个 Core 的能力（本地 Windows Core 恒不可用）。
  await handler.handleWebviewMessage({ type: 'requestStorageCapabilities' }, { sender: remoteSender });
  const routed = requests.at(-1) as { type: string; workspacePath?: string } | undefined;
  check(
    '能力查询按来源视图所属工作区路由',
    routed?.type === 'storageCapabilitiesRequested' && routed.workspacePath === REMOTE_REF.path,
  );
  check('按工作区路由的应答仍只投给请求视图', toView.at(-1)?.view === remoteSender);
  check('按工作区路由的应答不走默认路由', toDefault.length === 0);

  // 2) 单视图宿主 / 宿主主动推送：没有来源视图时走默认路由
  await handler.handleWebviewMessage({ type: 'requestStorageCapabilities' });
  check(
    '无来源视图时走默认路由',
    toDefault.length === 1 && toDefault[0]?.type === 'setStorageCapabilities',
  );
  check('无来源视图时不投给视图句柄', toView.length === 2);
  check(
    '无来源视图时不带路由载荷（落到活动连接）',
    (requests.at(-1) as { workspacePath?: string | null } | undefined)?.workspacePath === null,
  );

  // 3) 部署闸门读能力：按**会话**路由（能力随该会话所属 Core 走）。闸门判据读不到
  // 正确的 Core 就会把「远端可部署」判成「本机不可部署」（或反过来）。
  await handler.handleWebviewMessage(
    { type: 'sendMessage', sessionId: 's-iso', content: 'hello', storage: 'isolated' },
    { sender: remoteSender },
  );
  const gateQuery = requests.at(-1) as { type: string; sessionId?: string } | undefined;
  check(
    '部署闸门的能力查询按会话路由',
    gateQuery?.type === 'storageCapabilitiesRequested' && gateQuery.sessionId === 's-iso',
  );

  resetGlobalEventBus();
  finish();
}

runTests('storageCapabilitiesRouting', run);
