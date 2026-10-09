/**
 * 用户消息排队项单测（`docs/user-message-pipeline.md` 第 5 节）：
 *
 * - 引擎忙碌（core 推送的会话运行时快照 `idle === false`，含消费循环运行中与压缩中）时，
 *   宿主登记排队项（带消息 `uuid`）并置 `deferEcho`，由 core 在消息真正进入 LLM 上下文时
 *   补发用户气泡（webview 按 `messageUuid` 清除排队项）；
 * - 引擎空闲时仍是发送侧乐观回显（不登记排队项、不带 `deferEcho`）；
 * - 命令消息一律延迟回显，但只在引擎忙碌时登记排队项。
 *
 * 运行方式：npm run test:all -- user-message-queue
 */

import * as assert from 'assert';
import { createEventBus } from '../host/EventBus';
import {
  setGlobalEventBus,
  resetGlobalEventBus,
  type SessionRuntimeState,
  type UiEvent,
} from '../core/AssistantEventBus';
import type { UIHost } from '../host/UIHost';
import { UserChoiceManager } from '../host/ui/userChoice';
import { WebviewMessageHandler } from '../host/ui/webviewMessageHandler';
import type { QueuedMessageState } from '../host/ui/ports';
import { applySettingsSnapshot } from '../core/settings';
import { resolveSettingsSnapshot } from '../core/settingsSnapshot';
import { createChecker, runTests } from './helpers/harness';

type Submitted = Extract<UiEvent, { type: 'userMessageSubmitted' }>;
type Discarded = Extract<UiEvent, { type: 'queuedMessageDiscarded' }>;

interface Harness {
  handler: WebviewMessageHandler;
  /** 推给 webview 的消息体（按顺序） */
  posted: Array<Record<string, unknown>>;
  /** 发到 core 的 userMessageSubmitted */
  submitted: Submitted[];
  /** 发到 core 的 queuedMessageDiscarded（排队项「编辑 / 删除」撤回） */
  discarded: Discarded[];
  /** 宿主登记的排队项（`null` 表示清除） */
  queued: Array<{ sessionId: string; queued: QueuedMessageState | null }>;
  runtimeStates: SessionRuntimeState[];
  /** handler 的日志（handleWebviewMessage 会吞掉异常，靠它暴露问题） */
  logs: string[];
}

/** 构造一份运行时快照（用例只关心 idle，其余根事实按「忙 = queryRunning」填） */
function runtimeState(sessionId: string, idle: boolean): SessionRuntimeState {
  return {
    sessionId,
    idle,
    waiting: false,
    queryRunning: !idle,
    compacting: false,
    backgroundRunning: false,
    subAgentRunning: false,
    parentSessionId: null,
  };
}

function buildHarness(): Harness {
  const bus = createEventBus();
  setGlobalEventBus(bus);
  const submitted: Submitted[] = [];
  bus.onUiEvent('userMessageSubmitted', (event) => submitted.push(event));
  const discarded: Discarded[] = [];
  bus.onUiEvent('queuedMessageDiscarded', (event) => discarded.push(event));
  // Core 就绪：就绪前只接受 hostEnvironmentProvided（docs/core-ui-separation.md 第 7 节）
  applySettingsSnapshot(resolveSettingsSnapshot({}), []);

  const posted: Array<Record<string, unknown>> = [];
  const queued: Array<{ sessionId: string; queued: QueuedMessageState | null }> = [];
  const runtimeStates: SessionRuntimeState[] = [];
  const logs: string[] = [];

  const userChoiceManager = new UserChoiceManager({
    outputChannel: undefined,
    postToWebview: () => undefined,
    closePreview: () => undefined,
    isSessionOpenInternal: () => false,
  });

  const handler = new WebviewMessageHandler({
    host: {
      log: (line: string) => logs.push(line),
      getWorkspacePath: () => undefined,
    } as unknown as UIHost,
    postToWebview: (_sessionId, message) => posted.push(message),
    postConversationLoaded: () => undefined,
    setTitle: () => undefined,
    userChoiceManager,
  });
  handler.uiPort = {
    openSpinDesign: async () => undefined,
    refreshConversations: async () => undefined,
    noteSessionActivity: () => undefined,
    showLLMConfigPanel: async () => undefined,
    getSessionRuntimeStatesSnapshot: () => runtimeStates,
    isQueryActive: () => false,
    onQueuedMessage: (sessionId, state) => queued.push({ sessionId, queued: state }),
  };

  return { handler, posted, submitted, discarded, queued, runtimeStates, logs };
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // ===== 引擎忙碌：登记排队项 + deferEcho，不做乐观回显 =====
  {
    const { handler, posted, submitted, queued, runtimeStates, logs } = buildHarness();
    runtimeStates.push(runtimeState('s1', false));

    await handler.handleWebviewMessage({ type: 'sendMessage', sessionId: 's1', content: '排队一下' });

    check('忙碌时登记排队项', queued.length === 1 && queued[0].sessionId === 's1');
    // handleWebviewMessage 把异常兜底成一条日志，这里顺带断言链路没有抛错
    check('处理用户消息不报错', logs.length === 0);
    const state = queued[0]?.queued;
    check('排队项内容与 uuid 正确', state?.content === '排队一下' && typeof state?.uuid === 'string' && state.uuid.length > 0);
    check(
      '忙碌时不乐观回显用户气泡',
      !posted.some((message) => message.type === 'addMessage'),
    );
    check(
      '排队项 uuid 与 UiEvent uuid 一致（供补发气泡配对清除）',
      submitted.length === 1 && submitted[0].uuid === state?.uuid,
    );
    check('忙碌时置 deferEcho', submitted[0]?.deferEcho === true);
    resetGlobalEventBus();
  }

  // ===== wire 的文件行范围：`selectedLines` → `fileSelectedLines` =====
  {
    const { handler, submitted, queued, runtimeStates } = buildHarness();
    runtimeStates.push(runtimeState('s5', false));

    await handler.handleWebviewMessage({
      type: 'sendMessage',
      sessionId: 's5',
      content: '看看这几行',
      filePath: 'D:/repo/a.ts',
      selectedLines: { start: 3, end: 8 },
    });

    check(
      'wire 的 selectedLines 进 UiEvent 的 fileSelectedLines',
      JSON.stringify(submitted[0]?.fileSelectedLines) === JSON.stringify({ start: 3, end: 8 }),
    );
    check('文件信息带进排队项', queued[0]?.queued?.filePath === 'D:/repo/a.ts');
    check(
      '排队项也带文件行范围',
      JSON.stringify(queued[0]?.queued?.selectedLines) === JSON.stringify({ start: 3, end: 8 }),
    );
    resetGlobalEventBus();
  }

  // ===== 引擎空闲：乐观回显，不登记排队项、不带 deferEcho =====
  {
    const { handler, posted, submitted, queued, runtimeStates } = buildHarness();
    runtimeStates.push(runtimeState('s2', true));

    await handler.handleWebviewMessage({ type: 'sendMessage', sessionId: 's2', content: '直接发' });

    check('空闲时不登记排队项', queued.length === 0);
    const echoed = posted.find((message) => message.type === 'addMessage');
    check('空闲时乐观回显用户气泡', echoed?.content === '直接发' && echoed?.role === 'user');
    check('空闲时不置 deferEcho', submitted[0]?.deferEcho === undefined);
    check('乐观回显与 UiEvent 共用同一 uuid', echoed?.messageUuid === submitted[0]?.uuid);
    resetGlobalEventBus();
  }

  // ===== 命令消息：一律延迟回显；忙碌时同样登记排队项 =====
  {
    const { handler, posted, submitted, queued, runtimeStates } = buildHarness();
    runtimeStates.push(runtimeState('s3', false));

    await handler.handleWebviewMessage({ type: 'sendMessage', sessionId: 's3', content: '/commit 修一下' });

    check('命令消息不乐观回显', !posted.some((message) => message.type === 'addMessage'));
    check('命令消息也置 deferEcho', submitted[0]?.deferEcho === true);
    check('忙碌时命令消息同样登记排队项', queued[0]?.queued?.content === '/commit 修一下');
    resetGlobalEventBus();
  }

  // ===== 快照里没有该会话：按空闲处理（乐观回显）=====
  {
    const { handler, posted, submitted, queued } = buildHarness();

    await handler.handleWebviewMessage({ type: 'sendMessage', sessionId: 's4', content: '未知会话' });

    check('快照缺失时不登记排队项', queued.length === 0);
    check('快照缺失时乐观回显', posted.some((message) => message.type === 'addMessage'));
    check('快照缺失时不置 deferEcho', submitted[0]?.deferEcho === undefined);
    resetGlobalEventBus();
  }

  // ===== 排队项「编辑 / 删除」：discardQueuedMessage 翻译成 queuedMessageDiscarded =====
  {
    const { handler, submitted, discarded, logs } = buildHarness();

    await handler.handleWebviewMessage({ type: 'discardQueuedMessage', sessionId: 's1', uuid: 'user_1' });

    check('撤回翻译成 queuedMessageDiscarded', discarded.length === 1);
    check('sessionId 与 uuid 原样回带', discarded[0]?.sessionId === 's1' && discarded[0]?.uuid === 'user_1');
    check('撤回不产生用户消息事件', submitted.length === 0);
    check('处理撤回不报错', logs.length === 0);
    resetGlobalEventBus();
  }

  assert.ok(true);
  finish();
}

runTests('user-message-queue', run);
