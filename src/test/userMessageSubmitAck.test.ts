/**
 * 提交请求的两段式语义（specs/059 FR-001 / FR-002 / FR-003 / FR-005 / FR-007）。
 *
 * 覆盖 AC-1..AC-15 与 AC-21 的宿主侧那一半：裁决三态、原载荷不丢、取消无副作用、
 * 已受理消息的静默复核、锁判据。webview 侧的「载体从未被消费」由 e2e 与
 * `focusTrap` / `inputAreaState` 的单测共同锁定。
 *
 * 用假 `UIHost` + 假全局事件总线跑，不连 Core：
 * - `storageCapabilitiesRequested` 给能力事实（`isolatedWorkView` / `deployable`）；
 * - `emitToCore` 记录 `userMessageSubmitted`，用来断言「Core 从未收到」；
 * - `broadcastToWebviews` 记录下行裁决，用来断言受理 / 拒绝与非回填。
 *
 * 运行方式：npm run test:unit -- user-message-submit
 */

import { createChecker, runTests } from './helpers/harness';
import { createTestHost } from './helpers/fixtures';
import { UserChoiceManager } from '../host/ui/userChoice';
import { WebviewMessageHandler } from '../host/ui/webviewMessageHandler';
import { setGlobalEventBus } from '../shared/AssistantEventBus';
import type { StorageCapabilities } from '../shared/AssistantEventBus';

/** 假 Core 的当前行为（用例之间只换这个引用的指向） */
let fakeCore: {
  capabilities: StorageCapabilities;
  capabilitiesAsked: string[];
  submitted: Array<{ type: string } & Record<string, unknown>>;
  /** 非空时能力查询抛这个错（模拟路由不到 Connection / Core 应答失败） */
  capabilitiesError: string | null;
} | null = null;

function makeFakeCore(options: {
  capabilities: StorageCapabilities;
  capabilitiesError?: string;
}): void {
  fakeCore = {
    capabilities: options.capabilities,
    capabilitiesAsked: [],
    submitted: [],
    capabilitiesError: options.capabilitiesError ?? null,
  };
}

function installFakeBus(): void {
  setGlobalEventBus({
    requestCore: (async (request: { type: string; sessionId?: string | null }) => {
      if (fakeCore === null) throw new Error('fake core not configured');
      if (request.type === 'storageCapabilitiesRequested') {
        fakeCore.capabilitiesAsked.push(request.sessionId ?? '');
        if (fakeCore.capabilitiesError !== null) {
          throw new Error(fakeCore.capabilitiesError);
        }
        return fakeCore.capabilities;
      }
      if (request.type === 'conversationLoadRequested') {
        return { messages: [], metadata: null, pendingToolUseIds: [] };
      }
      throw new Error(`unexpected core request: ${request.type}`);
    }) as never,
    emitToCore: (event: { type: string }) => {
      fakeCore?.submitted.push(event as { type: string } & Record<string, unknown>);
    },
    dispatch: () => undefined,
  } as never);
}

const READY: StorageCapabilities = {
  isolatedWorkView: true,
  mountProxy: 'ready',
  deployable: false,
  reason: '',
};
const DEPLOYABLE: StorageCapabilities = {
  isolatedWorkView: false,
  mountProxy: 'absent',
  deployable: true,
  reason: '挂载代理未安装',
};
const NOT_DEPLOYABLE: StorageCapabilities = {
  isolatedWorkView: false,
  mountProxy: 'absent',
  deployable: false,
  reason: '内核无 overlayfs',
};

type Downlink = { type: string } & Record<string, unknown>;

function makeHandler(hostOptions: Parameters<typeof createTestHost>[0] = {}): {
  handler: WebviewMessageHandler;
  broadcasts: Downlink[];
  logs: string[];
  locks: Array<{ locked: boolean; reason: string }>;
} {
  const broadcasts: Downlink[] = [];
  const logs: string[] = [];
  const locks: Array<{ locked: boolean; reason: string }> = [];
  const host = createTestHost({
    log: (line: string) => {
      logs.push(line);
    },
    broadcastToWebviews: (message) => {
      broadcasts.push(message as Downlink);
    },
    setConversationSwitchLock: (_sender, locked, reason) => {
      locks.push({ locked, reason });
    },
    ...hostOptions,
  });
  const handler = new WebviewMessageHandler({
    host,
    postToWebview: () => undefined,
    postConversationLoaded: () => undefined,
    setTitle: () => undefined,
    userChoiceManager: new UserChoiceManager({
      outputChannel: undefined,
      postToWebview: () => undefined,
    } as never),
  });
  return { handler, broadcasts, logs, locks };
}

/** 一次提交请求（默认 Overlay 归属，与既有闸门用例同一成形方式） */
function SUBMIT(sessionId: string, content = 'hello', submitId = 'sub_1') {
  return {
    type: 'submitMessage' as const,
    submitId,
    sessionId,
    content,
    storage: 'isolated' as const,
  };
}

function accepted(broadcasts: Downlink[], submitId: string): boolean {
  return broadcasts.some((m) => m.type === 'userMessageAccepted' && m.submitId === submitId);
}

function rejected(broadcasts: Downlink[], submitId: string): Downlink | undefined {
  return broadcasts.find((m) => m.type === 'userMessageRejected' && m.submitId === submitId);
}

function submittedCount(): number {
  return fakeCore?.submitted.length ?? 0;
}

runTests('userMessageSubmitAck', async () => {
  const { check, finish } = createChecker();
  installFakeBus();

  const step = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      console.error(err);
      check(`用例执行未抛错（${String(err)}）`, false);
    }
  };

  // ---------- AC-1 / AC-9：能力就绪 → 受理回执，未裁决前 Core 什么都没收到 ----------
  await step(async () => {
    makeFakeCore({ capabilities: READY });
    const { handler, broadcasts } = makeHandler({ sessionStorageOf: () => 'isolated' });

    await handler.handleWebviewMessage(SUBMIT('s1'), { sender: null });

    check('AC-1 裁决前 Core 未收到 userMessageSubmitted', submittedCount() === 0);
    check('AC-9 可发送时回一条受理', accepted(broadcasts, 'sub_1'));
    // 受理本身不代发：上送由 webview 拿到回执后自己走 sendMessage（FR-004）
    check('AC-9 受理不代发（仍要 webview 消费后上行）', submittedCount() === 0);
    check('AC-9 回执带原会话 id', broadcasts.some((m) => m.type === 'userMessageAccepted' && m.sessionId === 's1'));
  });

  // ---------- AC-1：非 Overlay 归属 → 不查能力、直接受理 ----------
  await step(async () => {
    makeFakeCore({ capabilities: NOT_DEPLOYABLE });
    const { handler, broadcasts } = makeHandler({ sessionStorageOf: () => 'workspace' });

    await handler.handleWebviewMessage(
      { ...SUBMIT('s2'), storage: 'workspace' },
      { sender: null },
    );

    check('AC-1 workspace 归属照常受理', accepted(broadcasts, 'sub_1'));
    check('AC-1 workspace 归属不进闸门（仍按会话查一次能力用于判据）', (fakeCore?.capabilitiesAsked.length ?? 0) === 1);
  });

  // ---------- AC-3：可部署但未就绪 → 弹确认框、不发回执、不进 Core ----------
  await step(async () => {
    makeFakeCore({ capabilities: DEPLOYABLE });
    const { handler, broadcasts, logs } = makeHandler({
      sessionStorageOf: () => 'isolated',
      resolveMountProxyTarget: async () => ({ host: 'lab' } as never),
    });

    await handler.handleWebviewMessage(SUBMIT('s3', '需要部署'), { sender: null });

    check('AC-3 推了确认态', broadcasts.some(
      (m) => m.type === 'mountProxyDeployState' && m.phase === 'confirm',
    ));
    check('AC-3 不推受理回执（提交仍挂起）', !accepted(broadcasts, 'sub_1'));
    check('AC-3 Core 未收到该消息', submittedCount() === 0);
    check('AC-3 记了拦截日志并点名主机', logs.some((l) => l.includes('host=lab')));
  });

  // ---------- AC-4：不可部署 → 拒绝回执带 Core 的 reason，不弹框 ----------
  await step(async () => {
    makeFakeCore({ capabilities: NOT_DEPLOYABLE });
    const { handler, broadcasts } = makeHandler({ sessionStorageOf: () => 'isolated' });

    await handler.handleWebviewMessage(SUBMIT('s4'), { sender: null });

    const reject = rejected(broadcasts, 'sub_1');
    check('AC-4 拒绝回执携带 Core 的 reason', typeof reject?.reason === 'string'
      && String(reject.reason).includes('内核无 overlayfs'));
    check('AC-4 不弹部署框', !broadcasts.some((m) => m.type === 'mountProxyDeployState'));
    check('AC-4 Core 未收到该消息', submittedCount() === 0);
  });

  // ---------- AC-5 / AC-6 / AC-14 / AC-15：取消 = 提交作废，无回填、无上行 ----------
  await step(async () => {
    makeFakeCore({ capabilities: DEPLOYABLE });
    const { handler, broadcasts } = makeHandler({
      sessionStorageOf: () => 'isolated',
      resolveMountProxyTarget: async () => ({ host: null } as never),
    });

    await handler.handleWebviewMessage(SUBMIT('s5', '取消后应原样'), { sender: null });
    check('AC-5 先进入确认态', broadcasts.some(
      (m) => m.type === 'mountProxyDeployState' && m.phase === 'confirm',
    ));

    await handler.handleWebviewMessage({ type: 'cancelMountProxyDeploy' }, { sender: null });

    check('AC-6 取消回一条拒绝（按 submitId 作废这次提交）', rejected(broadcasts, 'sub_1') !== undefined);
    check('AC-14 取消不发 userMessageDraftRestored', !broadcasts.some(
      (m) => m.type === 'userMessageDraftRestored',
    ));
    check('AC-15 取消后 Core 仍什么都没收到', submittedCount() === 0);
    check('AC-6 取消推了 cancelled 让界面收框', broadcasts.some(
      (m) => m.type === 'mountProxyDeployState' && m.phase === 'cancelled',
    ));
  });

  // ---------- AC-7：反复「提交 → 取消」每次都只作废自己那次 ----------
  await step(async () => {
    makeFakeCore({ capabilities: DEPLOYABLE });
    const { handler, broadcasts } = makeHandler({
      sessionStorageOf: () => 'isolated',
      resolveMountProxyTarget: async () => ({ host: null } as never),
    });

    for (let i = 1; i <= 3; i += 1) {
      await handler.handleWebviewMessage(SUBMIT('s6', '反复取消', `sub_${i}`), { sender: null });
      await handler.handleWebviewMessage({ type: 'cancelMountProxyDeploy' }, { sender: null });
    }

    check(
      'AC-7 三次都各自作废',
      rejected(broadcasts, 'sub_1') !== undefined
        && rejected(broadcasts, 'sub_2') !== undefined
        && rejected(broadcasts, 'sub_3') !== undefined,
    );
    check('AC-7 三次都没有上行', submittedCount() === 0);
    check(
      'AC-7 每次都重新弹一次确认（共三次确认态）',
      broadcasts.filter((m) => m.type === 'mountProxyDeployState' && m.phase === 'confirm').length === 3,
    );
  });

  // ---------- AC-12：部署成功后按原载荷继续 ----------
  await step(async () => {
    makeFakeCore({ capabilities: DEPLOYABLE });
    const { handler, broadcasts } = makeHandler({
      sessionStorageOf: () => 'isolated',
      resolveMountProxyTarget: async () => ({ host: null } as never),
    });

    // 提交时带上完整的会话配置与文件上下文（原载荷的证据）
    await handler.handleWebviewMessage({
      ...SUBMIT('s7', '原载荷'),
      filePath: '/ws/a.ts',
      fileHidden: false,
      selectedLines: { start: 3, end: 5 },
      agentMode: 'risk' as const,
      thinkingMode: 'high' as const,
      webSearch: true,
      model: 'm1',
      provider: 'p1',
    }, { sender: null });

    // 部署成功后宿主按原载荷继续：能力已转为就绪，直接重放同一条
    fakeCore!.capabilities = READY;
    const gate = (handler as unknown as {
      mountProxyGate: { succeed(): void; takeBlocked(): unknown } | null;
      continueBlockedAction(action: unknown): Promise<void>;
    });
    // 走真实路径：手动触发「成功 → 继续」这一段，等价于 applyDeployOutcome 的成功分支
    gate.mountProxyGate!.succeed();
    await gate.continueBlockedAction(gate.mountProxyGate!.takeBlocked());

    const submitted = fakeCore!.submitted.filter((e) => e.type === 'userMessageSubmitted');
    check('AC-12 部署成功后 Core 收到一条', submitted.length === 1);
    const payload = submitted[0] ?? {};
    check('AC-12 内容原样', payload.content === '原载荷');
    check('AC-12 文件引用原样', payload.filePath === '/ws/a.ts'
      && JSON.stringify(payload.fileSelectedLines) === JSON.stringify({ start: 3, end: 5 }));
    check('AC-12 会话配置原样', payload.agentMode === 'risk' && payload.thinkingMode === 'high' && payload.webSearch === true);
    // UiEvent 的模型身份是 ModelRef 对象（provider + model 整体），不是扁平的两个字段
    const modelRef = payload.model as { provider?: string; model?: string } | undefined;
    check('AC-12 模型身份原样', modelRef?.provider === 'p1' && modelRef?.model === 'm1');
    check('AC-12 归属仍是 isolated', payload.storage === 'isolated');
    // 成功不再回拒绝，也不回第二条受理
    check('AC-12 成功后不误发拒绝', rejected(broadcasts, 'sub_1') === undefined);
  });

  // ---------- AC-13：部署结束后能力仍不可用 → 明确报错、无消息进入 Core ----------
  await step(async () => {
    makeFakeCore({ capabilities: DEPLOYABLE });
    const { handler, broadcasts, logs } = makeHandler({
      sessionStorageOf: () => 'isolated',
      resolveMountProxyTarget: async () => ({ host: null } as never),
    });

    await handler.handleWebviewMessage(SUBMIT('s8'), { sender: null });
    // 部署「成功」但重查能力仍不可用：走真实收尾（finishDeployAndContinue），不是手搓 fail
    fakeCore!.capabilities = NOT_DEPLOYABLE;
    const gate = (handler as unknown as {
      mountProxyGate: unknown;
      finishDeployAndContinue(gate: unknown): Promise<void>;
    });
    await gate.finishDeployAndContinue(gate.mountProxyGate);

    check('AC-13 失败态留在界面上', broadcasts.some(
      (m) => m.type === 'mountProxyDeployState' && m.phase === 'failed',
    ));
    check('AC-13 Core 未收到该消息', submittedCount() === 0);
    check('AC-13 没有额外的静默重放', logs.every((l) => !l.includes('userMessageSubmitted')));
    // 缺陷形态：失败只落闸门、不回执 → webview 未决提交永久挂起
    // （specs/defects/submit-verdict-lost-on-gate-error.md）
    check(
      'RT-3 部署后能力仍不可用时也必须有裁决（拒绝回执）',
      rejected(broadcasts, 'sub_1') !== undefined,
    );
    check('RT-3 失败不误发受理', !accepted(broadcasts, 'sub_1'));
  });

  // ---------- RT-4：部署后重查能力抛错时同样必须有裁决 ----------
  await step(async () => {
    makeFakeCore({ capabilities: DEPLOYABLE });
    const { handler, broadcasts, logs } = makeHandler({
      sessionStorageOf: () => 'isolated',
      resolveMountProxyTarget: async () => ({ host: null } as never),
    });

    await handler.handleWebviewMessage(SUBMIT('s13', '重查会失败'), { sender: null });
    fakeCore!.capabilitiesError = 'No Connection can serve request(storageCapabilitiesRequested).';
    const gate = (handler as unknown as {
      mountProxyGate: unknown;
      finishDeployAndContinue(gate: unknown): Promise<void>;
    });
    await gate.finishDeployAndContinue(gate.mountProxyGate);

    check('RT-4 重查抛错也必须有裁决（拒绝回执）', rejected(broadcasts, 'sub_1') !== undefined);
    check('RT-4 失败态同样留在界面上', broadcasts.some(
      (m) => m.type === 'mountProxyDeployState' && m.phase === 'failed',
    ));
    check('RT-4 Core 未收到该消息', submittedCount() === 0);
    check('RT-4 失败仍记日志', logs.some((l) => l.includes('部署后重查能力失败')));
  });

  // ---------- 边界：已受理消息在能力不可用时被静默丢弃 ----------
  await step(async () => {
    makeFakeCore({ capabilities: NOT_DEPLOYABLE });
    const { handler, logs } = makeHandler({ sessionStorageOf: () => 'isolated' });

    // 直接走已受理上行（宿主重投 / 部署成功后的继续）
    await handler.handleWebviewMessage({
      type: 'sendMessage',
      sessionId: 's9',
      content: '无处可去',
      storage: 'isolated',
    }, { sender: null });

    check('边界 已受理消息在 !deployable 时丢弃', submittedCount() === 0);
    check('边界 丢弃时点名原因', logs.some((l) => l.includes('丢弃一条已受理但没有可用视图的消息')));
    check('边界 丢弃不抛错（不冒泡成未处理异常）', true);
  });

  // ---------- 边界：已受理消息在需要部署时同样丢弃（没有载体可弹框）----------
  await step(async () => {
    makeFakeCore({ capabilities: DEPLOYABLE });
    const { handler, broadcasts, logs } = makeHandler({ sessionStorageOf: () => 'isolated' });

    await handler.handleWebviewMessage({
      type: 'sendMessage',
      sessionId: 's10',
      content: '重投',
      storage: 'isolated',
    }, { sender: null });

    check('边界 重投遇到需要部署时丢弃', submittedCount() === 0);
    check('边界 重投不弹确认框', !broadcasts.some((m) => m.type === 'mountProxyDeployState'));
    check('边界 重投记了丢弃原因', logs.some((l) => l.includes('需要部署挂载代理')));
  });

  // ---------- RT-1：能力查询抛错时必须有裁决，不留悬空的未决提交 ----------
  //
  // 缺陷形态（specs/defects/submit-verdict-lost-on-gate-error.md）：能力查询失败让异常冒泡
  // 到统一兜底，`handleSubmitMessage` 既没回 `userMessageAccepted` 也没回
  // `userMessageRejected`，webview 的 `pendingSubmitRef` 永远挂着、输入区一直只读。
  // specs/059 的边界节要求「判据向上失败（报错），不默认放行；输入区原样」——收尾就是拒绝回执。
  await step(async () => {
    makeFakeCore({
      capabilities: READY,
      capabilitiesError: 'No Connection can serve request(storageCapabilitiesRequested).',
    });
    const { handler, broadcasts, logs } = makeHandler({ sessionStorageOf: () => 'isolated' });

    await handler.handleWebviewMessage(SUBMIT('s11', '能力查询会失败'), { sender: null });

    const reject = rejected(broadcasts, 'sub_1');
    check(
      'RT-1 能力查询失败也必须有裁决（拒绝回执）',
      reject !== undefined,
    );
    check(
      'RT-1 拒绝原因点名能力查询失败',
      typeof reject?.reason === 'string'
        && String(reject.reason).includes('storageCapabilitiesRequested'),
    );
    check('RT-1 失败不放行（Core 未收到该消息）', submittedCount() === 0);
    check('RT-1 失败不误发受理', !accepted(broadcasts, 'sub_1'));
    check(
      'RT-1 失败仍记日志（诊断信息不因改走回执而丢）',
      logs.some((l) => l.includes('storageCapabilitiesRequested')),
    );
  });

  // ---------- RT-2：部署目标解析不出时同样必须有裁决 ----------
  //
  // 同一缺陷的另一条入口：能力说 needsDeploy，宿主却解析不出部署目标，原实现直接 throw。
  await step(async () => {
    makeFakeCore({ capabilities: DEPLOYABLE });
    const { handler, broadcasts, logs } = makeHandler({
      sessionStorageOf: () => 'isolated',
      resolveMountProxyTarget: async () => null,
    });

    await handler.handleWebviewMessage(SUBMIT('s12', '解析不出部署目标'), { sender: null });

    const reject = rejected(broadcasts, 'sub_1');
    check('RT-2 部署目标解析失败也必须有裁决（拒绝回执）', reject !== undefined);
    check(
      'RT-2 拒绝原因点名解析不出部署目标',
      typeof reject?.reason === 'string' && String(reject.reason).includes('解析不出部署目标'),
    );
    check('RT-2 不弹确认框', !broadcasts.some((m) => m.type === 'mountProxyDeployState'));
    check('RT-2 Core 未收到该消息', submittedCount() === 0);
    check(
      'RT-2 失败仍记日志',
      logs.some((l) => l.includes('解析不出部署目标')),
    );
  });

  // ---------- AC-16 / AC-20 的宿主侧：锁上报原样分发给宿主 ----------
  await step(async () => {
    makeFakeCore({ capabilities: READY });
    const { handler, locks } = makeHandler();

    await handler.handleWebviewMessage(
      { type: 'conversationSwitchLockChanged', locked: true, reason: 'mount-proxy-dialog' },
      { sender: null },
    );
    await handler.handleWebviewMessage(
      { type: 'conversationSwitchLockChanged', locked: false, reason: 'submit-pending' },
      { sender: null },
    );

    check('AC-16 锁上报落到宿主（开门 + 关门各一次）', locks.length === 2);
    check('AC-16 锁带原因', locks[0]?.locked === true && locks[0]?.reason === 'mount-proxy-dialog');
    check('AC-16 解锁也上报', locks[1]?.locked === false);
  });

  finish();
});
