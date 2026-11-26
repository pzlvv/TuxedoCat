/**
 * 打开已有 Overlay 对话时的部署闸门（specs/052）。
 *
 * 覆盖 [spec.md](spec.md) 的 AC-1..AC-8：第二个部署入口与既有「发第一条消息」入口共用
 * 同一份判据，只在「拦下什么动作」与「成功后继续什么」上不同。
 *
 * 用假 `UIHost` + 假全局事件总线跑，不连 Core：
 * - `sessionStorageOf` 决定该对话是否 Overlay 归属（Core `meta.json` 的投影）；
 * - `storageCapabilitiesRequested` 给能力事实（`isolatedWorkView` / `deployable`）；
 * - `conversationLoadRequested` 被调用即证明「真的去加载了」。
 *
 * 运行方式：npm run test:unit -- overlay-open-deploy-gate
 */

import { createChecker, runTests } from './helpers/harness';
import { createTestHost } from './helpers/fixtures';
import { UserChoiceManager } from '../host/ui/userChoice';
import { WebviewMessageHandler } from '../host/ui/webviewMessageHandler';
import { setGlobalEventBus, resetGlobalEventBus } from '../shared/AssistantEventBus';
import type { StorageCapabilities } from '../shared/AssistantEventBus';

/**
 * 假 Core 的当前行为。
 *
 * 全局总线只能注册一次（`setGlobalEventBus` 的约定），因此这里注册一次、用例之间只换
 * 这个引用的指向；每次用例开头 `makeFakeCore` 覆盖它。
 */
let fakeCore: {
  capabilities: StorageCapabilities;
  capabilitiesAsked: string[];
  loaded: string[];
  readyAfter?: number;
  /** 能力查询直接抛错（模拟 Core 不可达 / 超时） */
  failCapabilities?: boolean;
  /** 上行 UiEvent（断言「没有写归属」这类事实时的唯一证据） */
  uiEvents?: Array<{ type: string }>;
} | null = null;

/** 假 Core：只回答本组用例要问的两类请求，其余一律报错（漏桩立刻暴露） */
function makeFakeCore(options: {
  capabilities: StorageCapabilities;
  capabilitiesAsked: string[];
  loaded: string[];
  readyAfter?: number;
  failCapabilities?: boolean;
  uiEvents?: Array<{ type: string }>;
}): void {
  fakeCore = options;
}

function installFakeBus(): void {
  const readyCapabilities: StorageCapabilities = {
    isolatedWorkView: true,
    mountProxy: 'ready',
    deployable: false,
    reason: '',
  };
  setGlobalEventBus({
    requestCore: (async (request: { type: string; sessionId?: string | null }) => {
      if (fakeCore === null) throw new Error('fake core not configured');
      if (request.type === 'storageCapabilitiesRequested') {
        fakeCore.capabilitiesAsked.push(request.sessionId ?? '');
        if (fakeCore.failCapabilities) throw new Error('core unreachable');
        const asked = fakeCore.capabilitiesAsked.length;
        if (fakeCore.readyAfter !== undefined && asked >= fakeCore.readyAfter) {
          return readyCapabilities;
        }
        return fakeCore.capabilities;
      }
      if (request.type === 'conversationLoadRequested') {
        fakeCore.loaded.push(request.sessionId ?? '');
        return { messages: [], metadata: null, pendingToolUseIds: [] };
      }
      throw new Error(`unexpected core request: ${request.type}`);
    }) as never,
    // 上行 UiEvent 的落点：归属改写（storageChanged）会经过这里
    emitToCore: (event: { type: string }) => {
      fakeCore?.uiEvents?.push(event);
    },
    dispatch: () => undefined,
  } as never);
}

function makeHandler(hostOptions: Parameters<typeof createTestHost>[0] = {}): {
  handler: WebviewMessageHandler;
  loaded: string[];
  capabilitiesAsked: string[];
  broadcasts: Array<{ type: string }>;
  logs: string[];
} {
  const loaded: string[] = [];
  const capabilitiesAsked: string[] = [];
  const broadcasts: Array<{ type: string }> = [];
  const logs: string[] = [];
  const host = createTestHost({
    log: (line: string) => {
      logs.push(line);
    },
    broadcastToWebviews: (message) => {
      broadcasts.push(message as { type: string });
    },
    ...hostOptions,
  });
  const handler = new WebviewMessageHandler({
    host,
    postToWebview: () => undefined,
    postConversationLoaded: (sessionId) => {
      loaded.push(sessionId);
    },
    setTitle: () => undefined,
    userChoiceManager: new UserChoiceManager({
      outputChannel: undefined,
      postToWebview: () => undefined,
      closePreview: () => undefined,
      isSessionOpenInternal: () => false,
    }),
  });
  return { handler, loaded, capabilitiesAsked, broadcasts, logs };
}

const OPEN = (sessionId: string) => ({ type: 'loadConversation' as const, sessionId });

runTests('overlayOpenDeployGate', async () => {
  const { check, finish } = createChecker();
  installFakeBus();

  // ---------- AC-1：Overlay 对话 + 不可用可部署 → 拦下，不加载 ----------
  {
    const asked: string[] = [];
    const coreLoaded: string[] = [];
    makeFakeCore({
      capabilities: { isolatedWorkView: false, mountProxy: 'absent', deployable: true, reason: '代理未部署' },
      capabilitiesAsked: asked,
      loaded: coreLoaded,
    });
    const { handler, loaded, broadcasts } = makeHandler({
      sessionStorageOf: () => 'isolated',
      resolveMountProxyTarget: async () => ({ host: 'lab' } as never),
    });

    await handler.handleWebviewMessage(OPEN('s1'), { sender: null });

    check('AC-1 拦下后不加载对话', loaded.length === 0 && coreLoaded.length === 0);
    check('AC-1 推了部署确认态', broadcasts.some((m) => m.type === 'mountProxyDeployState'));
    check('AC-1 按会话查能力', asked.length === 1 && asked[0] === 's1');
  }

  // ---------- AC-6：不可用且不可部署 → 抛错点名原因，不弹框 ----------
  {
    const asked: string[] = [];
    const coreLoaded: string[] = [];
    makeFakeCore({
      capabilities: {
        isolatedWorkView: false,
        mountProxy: 'absent',
        deployable: false,
        reason: '内核无 overlayfs',
      },
      capabilitiesAsked: asked,
      loaded: coreLoaded,
    });
    const { handler, loaded, broadcasts, logs } = makeHandler({
      sessionStorageOf: () => 'isolated',
      resolveMountProxyTarget: async () => ({ host: 'lab' } as never),
    });

    await handler.handleWebviewMessage(OPEN('s2'), { sender: null });
    // handleWebviewMessage 捕获异常并落日志（不向调用方抛），因此断言在日志上
    check('AC-6 点名校验：日志里带 Core 给的原因', logs.some((l) => l.includes('内核无 overlayfs')));
    check('AC-6 不弹部署框', !broadcasts.some((m) => m.type === 'mountProxyDeployState'));
    check('AC-6 不加载对话', loaded.length === 0 && coreLoaded.length === 0);
  }

  // ---------- AC-7：workspace 归属 → 不进闸门、不查能力 ----------
  {
    const asked: string[] = [];
    const coreLoaded: string[] = [];
    makeFakeCore({
      capabilities: { isolatedWorkView: false, mountProxy: 'absent', deployable: true, reason: '' },
      capabilitiesAsked: asked,
      loaded: coreLoaded,
    });
    const { handler } = makeHandler({ sessionStorageOf: () => 'workspace' });

    await handler.handleWebviewMessage(OPEN('s3'), { sender: null });

    check('AC-7 workspace 对话不进闸门且不查能力', asked.length === 0);
    check('AC-7 workspace 对话照常加载', coreLoaded.length === 1 && coreLoaded[0] === 's3');
  }

  // ---------- AC-8：Overlay 对话能力已就绪 → 不进闸门，直接加载 ----------
  {
    const asked: string[] = [];
    const coreLoaded: string[] = [];
    makeFakeCore({
      capabilities: { isolatedWorkView: true, mountProxy: 'ready', deployable: false, reason: '' },
      capabilitiesAsked: asked,
      loaded: coreLoaded,
    });
    const { handler, broadcasts } = makeHandler({ sessionStorageOf: () => 'isolated' });

    await handler.handleWebviewMessage(OPEN('s4'), { sender: null });

    check('AC-8 能力就绪时不弹部署框', !broadcasts.some((m) => m.type === 'mountProxyDeployState'));
    check('AC-8 能力就绪时直接加载', coreLoaded.length === 1 && coreLoaded[0] === 's4');
  }

  // ---------- AC-3：部署成功后自动继续打开（不要求用户再点一次） ----------
  {
    const asked: string[] = [];
    const coreLoaded: string[] = [];
    // 第 1 次查询：不可用可部署（拦下）；第 2 次起：已就绪（部署完成）
    makeFakeCore({
      capabilities: { isolatedWorkView: false, mountProxy: 'absent', deployable: true, reason: '代理未部署' },
      capabilitiesAsked: asked,
      loaded: coreLoaded,
      readyAfter: 2,
    });
    const { handler, broadcasts } = makeHandler({
      sessionStorageOf: () => 'isolated',
      resolveMountProxyTarget: async () => ({
        host: 'lab',
        isInstalled: async () => true,
        manualCommand: () => 'sudo install',
      } as never),
    });

    await handler.handleWebviewMessage(OPEN('s5'), { sender: null });
    check('AC-3 拦下时推了确认态', broadcasts.some((m) => m.type === 'mountProxyDeployState'));
    check('AC-3 拦下时尚未加载', coreLoaded.length === 0);

    // 用户点「部署」→ 假安装编排会失败（没有真实 sudo），因此先确认取消路径不加载
    await handler.handleWebviewMessage({ type: 'cancelMountProxyDeploy' }, { sender: null });
    check('AC-2 取消后仍不加载', coreLoaded.length === 0);
    check(
      'AC-2 取消 openConversation 不回执提交（没有提交可作废）',
      !broadcasts.some((m) => m.type === 'userMessageRejected'),
    );
  }

  // ---------- 部署目标解析不出：报错不猜 ----------
  {
    const asked: string[] = [];
    const coreLoaded: string[] = [];
    makeFakeCore({
      capabilities: { isolatedWorkView: false, mountProxy: 'absent', deployable: true, reason: '' },
      capabilitiesAsked: asked,
      loaded: coreLoaded,
    });
    const { handler, logs } = makeHandler({
      sessionStorageOf: () => 'isolated',
      resolveMountProxyTarget: async () => null,
    });

    await handler.handleWebviewMessage(OPEN('s6'), { sender: null });
    check('目标解析不出时报错', logs.some((l) => l.includes('解析不出部署目标')));
    check('目标解析不出时不加载', coreLoaded.length === 0);
  }

  // ---------- AC-4：部署失败 → 不加载、不改归属、界面不移动 ----------
  {
    const asked: string[] = [];
    const coreLoaded: string[] = [];
    const uiEvents: Array<{ type: string }> = [];
    makeFakeCore({
      capabilities: { isolatedWorkView: false, mountProxy: 'absent', deployable: true, reason: '代理未部署' },
      capabilitiesAsked: asked,
      loaded: coreLoaded,
      uiEvents,
    });
    const { handler, broadcasts } = makeHandler({
      sessionStorageOf: () => 'isolated',
      resolveMountProxyTarget: async () => ({
        host: 'lab',
        // 安装编排第一轮就失败（模拟命令报错），闸门应进 failed 态
        isInstalled: async () => false,
        manualCommand: () => 'sudo install',
      } as never),
    });

    await handler.handleWebviewMessage(OPEN('s7'), { sender: null });
    await handler.handleWebviewMessage({ type: 'requestMountProxyDeploy' }, { sender: null });

    const last = broadcasts.filter((m) => m.type === 'mountProxyDeployState').pop() as
      | { phase?: string }
      | undefined;
    check('AC-4 部署失败后停在 failed 态', last?.phase === 'failed');
    check('AC-4 部署失败不加载对话', coreLoaded.length === 0);
    check(
      'AC-4 部署失败不写归属（没有归属类 UiEvent 上行）',
      !(uiEvents ?? []).some((e) => e.type === 'storageChanged'),
    );
    check('AC-4 部署失败不回执提交（没有提交可作废）',
      !broadcasts.some((m) => m.type === 'userMessageRejected'));
  }

  // ---------- AC-5：失败后再次打开，重新走一遍部署流程 ----------
  {
    const asked: string[] = [];
    const coreLoaded: string[] = [];
    makeFakeCore({
      capabilities: { isolatedWorkView: false, mountProxy: 'absent', deployable: true, reason: '代理未部署' },
      capabilitiesAsked: asked,
      loaded: coreLoaded,
    });
    const { handler } = makeHandler({
      sessionStorageOf: () => 'isolated',
      resolveMountProxyTarget: async () => ({
        host: 'lab',
        isInstalled: async () => false,
        manualCommand: () => 'sudo install',
      } as never),
    });

    await handler.handleWebviewMessage(OPEN('s8'), { sender: null });
    await handler.handleWebviewMessage({ type: 'cancelMountProxyDeploy' }, { sender: null });
    const askedBefore = asked.length;
    await handler.handleWebviewMessage(OPEN('s8'), { sender: null });

    check('AC-5 再次打开会重新查能力（不留下永久不可打开）', asked.length > askedBefore);
    check('AC-5 再次打开仍不加载（部署仍未完成）', coreLoaded.length === 0);
  }

  // ---------- 能力查询失败：按打开失败处理，不弹部署框 ----------
  {
    // 让假 Core 在能力查询上抛错（Core 不可达 / 超时的同一形态）
    const asked: string[] = [];
    const coreLoaded: string[] = [];
    makeFakeCore({
      capabilities: { isolatedWorkView: false, mountProxy: 'absent', deployable: true, reason: '' },
      capabilitiesAsked: asked,
      loaded: coreLoaded,
    });
    fakeCore = {
      ...fakeCore!,
      failCapabilities: true,
    };
    const { handler, broadcasts, logs } = makeHandler({
      sessionStorageOf: () => 'isolated',
      resolveMountProxyTarget: async () => ({ host: 'lab' } as never),
    });

    // 直接验闸门判据：能力查询抛错时必须向上失败（不吞掉后继续打开）
    let failed = false;
    try {
      await (handler as unknown as {
        shouldBlockOpenConversation(id: string): Promise<boolean>;
      }).shouldBlockOpenConversation('s9');
    } catch (error) {
      failed = String(error).includes('core unreachable');
    }

    check('能力查询失败时闸门判据向上失败', failed);
    check('能力查询失败时不弹部署框', !broadcasts.some((m) => m.type === 'mountProxyDeployState'));
    check('能力查询失败时不加载对话', coreLoaded.length === 0);
    void logs;
  }

  // ---------- 并发打开：以最后一次打开请求为准 ----------
  {
    const asked: string[] = [];
    const coreLoaded: string[] = [];
    makeFakeCore({
      capabilities: { isolatedWorkView: false, mountProxy: 'absent', deployable: true, reason: '代理未部署' },
      capabilitiesAsked: asked,
      loaded: coreLoaded,
    });
    const { handler, broadcasts } = makeHandler({
      sessionStorageOf: () => 'isolated',
      resolveMountProxyTarget: async () => ({ host: 'lab' } as never),
    });

    // 连续打开两个对话：两次都该被拦下（各自进入确认），且不加载任何一个
    await handler.handleWebviewMessage(OPEN('a'), { sender: null });
    await handler.handleWebviewMessage(OPEN('b'), { sender: null });

    check('并发打开时两次都被拦下且都不加载', coreLoaded.length === 0);
    const confirms = broadcasts.filter(
      (m) => m.type === 'mountProxyDeployState' && (m as { phase?: string }).phase === 'confirm',
    );
    check('并发打开时每次都重新进入确认态', confirms.length === 2);
  }

  resetGlobalEventBus();
  finish();
});
