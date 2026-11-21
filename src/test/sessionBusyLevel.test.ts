import { collectRunningSubAgents, sessionBusyLevel } from '../shared/sessionRuntime';
import { createChecker, runTests } from './helpers/harness';

/**
 * 会话忙闲的单一派生（三处消费：标签页流水灯 / 托盘状态点 / 关闭二次确认）。
 *
 * 锁定口径：waiting 优先（即使引擎已 idle），running 次之，idle 垫底——
 * 「等用户输入但空闲」的会话必须算忙，否则关对话不问、关工作区却问
 * （US-19 验收 7 明确把「等待用户确认」列进需要二次确认的非 idle 集合）。
 *
 * `collectRunningSubAgents`（specs/019 FR-001、specs/054 FR-004）：abort 悬停明细的
 * 子代理清单聚合，锁定深先序 / 只经非空闲节点下钻 / description 缺省保留 null /
 * 远程登记排在所在节点的本地子树之后且不下钻 / 开始时刻与工作区身份透传的口径。
 *
 * 运行方式：npm run test:unit -- sessionBusyLevel
 */

type RemoteBrief = {
  sessionId: string;
  description: string | null;
  workspaceId: string;
  startedAt: number;
};

const state = (over: {
  sessionId: string;
  idle?: boolean;
  waiting?: boolean;
  parentSessionId?: string | null;
  subAgentDescription?: string | null;
  subAgentStartedAt?: number | null;
  remoteSubAgents?: RemoteBrief[];
}) => ({
  idle: false,
  waiting: false,
  parentSessionId: null,
  subAgentDescription: null,
  subAgentStartedAt: null as number | null,
  remoteSubAgents: [] as RemoteBrief[],
  ...over,
});

runTests('sessionBusyLevel', () => {
  const { check, finish } = createChecker();

  check('waiting 优先（waiting-but-idle 也算忙）',
    sessionBusyLevel({ idle: true, waiting: true }) === 'waiting'
    && sessionBusyLevel({ idle: false, waiting: true }) === 'waiting');

  check('非 idle 且不在等用户 = running',
    sessionBusyLevel({ idle: false, waiting: false }) === 'running');

  check('idle 且不在等用户 = idle',
    sessionBusyLevel({ idle: true, waiting: false }) === 'idle');

  const states = [
    state({ sessionId: 'p', subAgentStartedAt: 1000 }),
    // 直接子代理：一个在跑（Master）、一个已完成（idle 跳过）
    state({
      sessionId: 'c1',
      parentSessionId: 'p',
      subAgentDescription: '浏览文件找规格',
      subAgentStartedAt: 2000,
    }),
    state({ sessionId: 'c2', parentSessionId: 'p', idle: true, subAgentDescription: '已完成' }),
    // 下层子代理挂在 c1 下：随 c1 一起列出（深先序：c1 在前、孙在后）
    state({ sessionId: 'g1', parentSessionId: 'c1', subAgentDescription: null }),
    // 别的会话的子代理，与 p 无关
    state({ sessionId: 'x1', parentSessionId: 'other', subAgentDescription: '别的会话' }),
  ];

  check('子代理清单：非 idle 直接子代理 + 下层，深先序，idle 跳过',
    JSON.stringify(collectRunningSubAgents(states, 'p')) === JSON.stringify([
      { sessionId: 'c1', description: '浏览文件找规格', startedAt: 2000, workspaceId: null },
      { sessionId: 'g1', description: null, startedAt: null, workspaceId: null },
    ]));

  // specs/054 FR-004：远程登记排在所在节点的本地子树之后，远程条目不再下钻
  const withRemote = [
    state({
      sessionId: 'p',
      remoteSubAgents: [
        { sessionId: 'r2', description: '跨区二号', workspaceId: 'HOST:/b', startedAt: 4000 },
      ],
    }),
    state({
      sessionId: 'c1',
      parentSessionId: 'p',
      subAgentDescription: '本地一号',
      subAgentStartedAt: 1000,
      remoteSubAgents: [
        { sessionId: 'r1', description: '跨区一号', workspaceId: 'HOST:/a', startedAt: 3000 },
      ],
    }),
    state({ sessionId: 'g1', parentSessionId: 'c1', subAgentDescription: '本地二号' }),
  ];
  check('远程子代理：层内本地子树在前、远程登记在后（整棵本地子树之后才轮到远程）',
    JSON.stringify(collectRunningSubAgents(withRemote, 'p')) === JSON.stringify([
      { sessionId: 'c1', description: '本地一号', startedAt: 1000, workspaceId: null },
      { sessionId: 'g1', description: '本地二号', startedAt: null, workspaceId: null },
      { sessionId: 'r1', description: '跨区一号', startedAt: 3000, workspaceId: 'HOST:/a' },
      { sessionId: 'r2', description: '跨区二号', startedAt: 4000, workspaceId: 'HOST:/b' },
    ]));

  check('远程子代理没有本地会话条目也被列出，且不展开它的「下层」',
    JSON.stringify(collectRunningSubAgents(
      [
        state({
          sessionId: 'p',
          remoteSubAgents: [
            { sessionId: 'r1', description: null, workspaceId: 'HOST:/a', startedAt: 1 },
          ],
        }),
        // 即使别处有条目把 r1 当父（理论上的脏数据），也不该从远程条目下钻
        state({ sessionId: 'stray', parentSessionId: 'r1', subAgentDescription: '不该出现' }),
      ],
      'p',
    )) === JSON.stringify([
      { sessionId: 'r1', description: null, startedAt: 1, workspaceId: 'HOST:/a' },
    ]));

  check('无子代理 / 未知会话返回空数组',
    collectRunningSubAgents(states, 'nosuch').length === 0
    && collectRunningSubAgents([states[0]], 'p').length === 0
    && collectRunningSubAgents(states, 'c2').length === 0);

  finish();
});
