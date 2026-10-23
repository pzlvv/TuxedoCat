import { collectRunningSubAgents, deriveContainerBusyLevel, sessionBusyLevel } from '../shared/sessionRuntime';
import { createChecker, runTests } from './helpers/harness';

/**
 * 会话忙闲的单一派生（三处消费：标签页流水灯 / 托盘状态点 / 关闭二次确认）。
 *
 * 锁定口径：waiting 优先（即使引擎已 idle），running 次之，idle 垫底——
 * 「等用户输入但空闲」的会话必须算忙，否则关对话不问、关工作区却问
 * （US-19 验收 7 明确把「等待用户确认」列进需要二次确认的非 idle 集合）。
 *
 * `collectRunningSubAgents`（specs/019 FR-001）：abort 悬停明细的子代理清单聚合，
 * 锁定深先序 / 只经非空闲节点下钻 / description 缺省保留 null 的口径。
 *
 * `deriveContainerBusyLevel`（specs/024 FR-001）：跨工作区容器行的状态灯派生，
 * 按直接子代理聚合，waiting > running > idle，子代理缺态视为空闲（不猜值）。
 *
 * 运行方式：npm run test:all -- sessionBusyLevel
 */

const state = (over: {
  sessionId: string;
  idle?: boolean;
  waiting?: boolean;
  parentSessionId?: string | null;
  subAgentDescription?: string | null;
}) => ({
  idle: false,
  waiting: false,
  parentSessionId: null,
  subAgentDescription: null,
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
    state({ sessionId: 'p' }),
    // 直接子代理：一个在跑（Master）、一个已完成（idle 跳过）
    state({ sessionId: 'c1', parentSessionId: 'p', subAgentDescription: '浏览文件找规格' }),
    state({ sessionId: 'c2', parentSessionId: 'p', idle: true, subAgentDescription: '已完成' }),
    // 下层子代理挂在 c1 下：随 c1 一起列出（深先序：c1 在前、孙在后）
    state({ sessionId: 'g1', parentSessionId: 'c1', subAgentDescription: null }),
    // 别的会话的子代理，与 p 无关
    state({ sessionId: 'x1', parentSessionId: 'other', subAgentDescription: '别的会话' }),
  ];

  check('子代理清单：非 idle 直接子代理 + 下层，深先序，idle 跳过',
    JSON.stringify(collectRunningSubAgents(states, 'p')) === JSON.stringify([
      { sessionId: 'c1', description: '浏览文件找规格' },
      { sessionId: 'g1', description: null },
    ]));

  check('无子代理 / 未知会话返回空数组',
    collectRunningSubAgents(states, 'nosuch').length === 0
    && collectRunningSubAgents([states[0]], 'p').length === 0
    && collectRunningSubAgents(states, 'c2').length === 0);

  // specs/024 FR-001：容器行状态灯按直接子代理聚合（子代理集合由调用方按列表父子树选出）
  const child = (over: { idle?: boolean; waiting?: boolean }) => ({
    idle: over.idle ?? false,
    waiting: over.waiting ?? false,
  });

  check('容器：任一子代理等待（含 waiting-but-idle）→ waiting',
    deriveContainerBusyLevel([child({}), child({ idle: true, waiting: true })]) === 'waiting'
    && deriveContainerBusyLevel([child({})]) === 'running');

  check('容器：全部子代理 idle / 无子代理 → idle',
    deriveContainerBusyLevel([child({ idle: true })]) === 'idle'
    && deriveContainerBusyLevel([]) === 'idle');

  finish();
});
