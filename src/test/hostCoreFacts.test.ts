/**
 * 单测：宿主侧「core 事实」入口（`docs/core/standalone-core-boundaries.md 第 2 节）。
 *
 * 事实都在 Core 进程内：coreFacts 的每个取数函数都必须把同名 `UiRequest`
 * 发上总线、把应答原样返回。这里用内存总线锁「函数 → UiRequest 类型」的
 * 路由契约（帧通道侧的编解码由 standalone 系列用例覆盖）。
 *
 * 运行方式：npm run test:all -- hostCoreFacts
 */

import { createChecker, runTests } from './helpers/harness';
import { makeTestBus } from './helpers/fixtures';
import { setGlobalEventBus, type UiRequest, type UiRequestHandlers } from '../shared/AssistantEventBus';
import {
  loadConversationForHost,
  requestBalance,
  requestCompactArchive,
  requestConversationSpaces,
  requestFlushSession,
  loadConversationListForHost,
  requestMcpServers,
  requestSkills,
  requestSmartNaming,
  requestSpinDesign,
  saveSpinDesign,
} from '../host/coreFacts';

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  const { bus } = makeTestBus();
  /** 收到的 UiRequest（按到达顺序），按类型回一个可识别的应答 */
  const sent: UiRequest[] = [];
  const handlers: UiRequestHandlers = {
    conversationListRequested: async (req) => {
      sent.push(req);
      return [{ sessionId: 'c1', title: 't' } as never];
    },
    conversationLoadRequested: async (req) => {
      sent.push(req);
      return {
        messages: [],
        metadata: null,
        pendingToolUseIds: [],
        hasCompactArchive: false,
        agentMode: null,
        workMode: 'normal',
      };
    },
    smartNamingRequested: async (req) => {
      sent.push(req);
      return { title: 'named' };
    },
    balanceRequested: async (req) => {
      sent.push(req);
      return null;
    },
    compactArchiveRequested: async (req) => {
      sent.push(req);
      return null;
    },
    mcpServersRequested: async (req) => {
      sent.push(req);
      return [];
    },
    conversationSpacesRequested: async (req) => {
      sent.push(req);
      return [];
    },
    flushSessionRequested: async (req) => {
      sent.push(req);
      return null;
    },
    skillsRequested: async (req) => {
      sent.push(req);
      return { skills: [] };
    },
    spinDesignRequested: async (req) => {
      sent.push(req);
      return { status: 'ok', data: null, skills: [] };
    },
    spinDesignSaveRequested: async (req) => {
      sent.push(req);
      return { status: 'ok' };
    },
    watchWorkspaceFileRequested: async (req) => {
      sent.push(req);
      return { ok: true };
    },
    unwatchWorkspaceFileRequested: async (req) => {
      sent.push(req);
      return null;
    },
  };
  bus.onUiRequests(handlers);
  setGlobalEventBus(bus);

  // 每个取数函数发出同名 UiRequest，载荷带上路由键
  const list = await loadConversationListForHost('/ws');
  check('对话列表走 conversationListRequested', list.length === 1 && list[0].sessionId === 'c1');
  check('列表请求带工作区', (sent.at(-1) as { workspacePath?: string })?.workspacePath === '/ws');

  const loaded = await loadConversationForHost('s1');
  check('会话加载走 conversationLoadRequested', loaded.messages.length === 0);
  check('加载请求带会话', (sent.at(-1) as { sessionId?: string })?.sessionId === 's1');

  const title = await requestSmartNaming('s1');
  check('智能命名走 smartNamingRequested 并回传标题', title === 'named');

  const balance = await requestBalance('s1');
  check('余额走 balanceRequested', balance === null);

  const archive = await requestCompactArchive('s1');
  check('归档展开走 compactArchiveRequested', archive === null);

  const servers = await requestMcpServers('s1');
  check('MCP 列表走 mcpServersRequested', servers.length === 0);

  const spaces = await requestConversationSpaces();
  check('空间统计走 conversationSpacesRequested', spaces.length === 0);

  await requestFlushSession('s1');
  check('落盘收尾走 flushSessionRequested', sent.at(-1)?.type === 'flushSessionRequested');

  const skills = await requestSkills('s1');
  check('技能列表走 skillsRequested', skills.length === 0);

  const spin = await requestSpinDesign('s1');
  check('Spin 读取走 spinDesignRequested', spin.status === 'ok');
  check('Spin 读取请求带会话', (sent.at(-1) as { sessionId?: string })?.sessionId === 's1');

  const saved = await saveSpinDesign('s1', { nodes: [], edges: [], meta: {} });
  check('Spin 保存走 spinDesignSaveRequested', saved.status === 'ok');
  check('Spin 保存请求带会话', (sent.at(-1) as { sessionId?: string })?.sessionId === 's1');

  check(
    '路由契约齐全（11 类请求各到一次）',
    new Set(sent.map((req) => req.type)).size === 11,
  );

  finish();
}

runTests('hostCoreFacts', run);
