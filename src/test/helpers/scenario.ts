/**
 * 场景级测试 helper：从「用户消息进 → 事件出」的整条链路驱动 core。
 *
 * 与单测的区别：单测直接调 core 内部函数（runTools / flushQueuedMessagesIntoContext），
 * 断言单个行为；场景测试把一条 `userMessageSubmitted` 走完
 * 「入队 → LLM 脚本应答 → 工具执行 / 权限 → 落盘 → queryEnd」的完整管线，
 * 断言的是事件序列、LLM 上下文与会话落盘三者的一致性。
 *
 * LLM 经 `setCallLlmOverride`（`src/core/llm/index.ts`）注入按场景编排的脚本，
 * 不发网络请求；HOME 指向临时目录，配置与会话落盘全部隔离在沙箱里。
 *
 * 运行方式：与其它单测同车道（`scripts/run-tests.mjs` 独立进程），不要放进
 * `npm test`（vscodeHost mocha）——全局单例会与已激活的扩展互相污染。
 */

import { createEventBus } from '../../host/EventBus';
import { setGlobalEventBus, resetGlobalEventBus } from '../../core/AssistantEventBus';
import type {
  AssistantEventBus,
  CoreEvent,
  CoreEventHandlers,
  CoreRequestHandlers,
} from '../../core/AssistantEventBus';
import { setCallLlmOverride, type CallLlmImplementation } from '../../core/llm/index';
import type { StreamOptions } from '../../core/llm/index';
import type { AssistantMessage } from '../../core/types';
import { setSessionWorkspace, clearSessionWorkspace } from '../../core/history/Config';
import { loadConversation } from '../../core/history/Conversation';
import { resetSettingsSnapshot } from '../../core/settings';
import { initializeCoreEvents } from '../../core/initializeCoreEvents';
import {
  createRecordingCoreEventHandlers,
  makeTempDir,
  provideHostEnvironment,
} from './fixtures';

/** 场景在 queryEnd 上等待的默认上限（Windows 上起进程 / 文件系统都慢，给足余量） */
const DEFAULT_TIMEOUT_MS = 15_000;

/** 脚本轮次：一次 callLLM 调用的应答。yield 的 Message 与真实 API 的完整消息同形 */
export type ScriptedRound = (
  options: StreamOptions,
) => AsyncGenerator<AssistantMessage, void, void>;

/** 脚本应答消息里的 content block（与 AssistantMessage.message.content 同形） */
export type ScriptedBlock = AssistantMessage['message']['content'][number];

let scriptedSeq = 0;

function nextId(prefix: string): string {
  scriptedSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${scriptedSeq}`;
}

/** 构造一条与真实 API 输出同形的 assistant 消息（stop_reason 由轮次语义决定） */
function assistantMessage(content: ScriptedBlock[], stopReason: string): AssistantMessage {
  return {
    type: 'assistant',
    message: { role: 'assistant', content, stop_reason: stopReason },
    uuid: nextId('msg'),
    timestamp: Date.now(),
  };
}

/**
 * 最终文本应答轮（end_turn）：整轮查询在本次应答后结束。
 * `thinking` 可选，给一条 thinking block 前置（覆盖 thinking 路径的流式事件）。
 */
export function textRound(text: string, thinking?: string): ScriptedRound {
  return () =>
    (async function* () {
      const blocks: ScriptedBlock[] = [];
      if (thinking !== undefined) {
        blocks.push({ type: 'thinking', thinking });
      }
      blocks.push({ type: 'text', text });
      yield assistantMessage(blocks, 'end_turn');
    })();
}

/** tool_use block 的描述；`id` 缺省自动生成（测试断言经事件上的 toolUseId 关联） */
export interface ScriptedToolUse {
  name: string;
  input: Record<string, unknown>;
  id?: string;
}

/**
 * 工具调用应答轮（stop_reason='tool_use'）：runTools 执行完工具后
 * 携带 tool_result 进入下一轮 LLM 请求。`text` 可选，作工具调用前的说明文字。
 */
export function toolUseRound(toolUse: ScriptedToolUse, text?: string): ScriptedRound {
  return () =>
    (async function* () {
      const blocks: ScriptedBlock[] = [];
      if (text !== undefined) {
        blocks.push({ type: 'text', text });
      }
      blocks.push({ type: 'tool_use', id: toolUse.id ?? nextId('toolu'), name: toolUse.name, input: toolUse.input });
      yield assistantMessage(blocks, 'tool_use');
    })();
}

/**
 * 挂起直到中止信号的应答轮：先 yield 一条 thinking 消息，然后等 abort。
 * 收到 abort 后抛 AbortError——与真实 API 被中止的行为一致，
 * 让查询走 Query.ts 的 isAborted → `*User Interrupted*` 路径。
 * `onHanging` 在生成器进入等待时回调（测试用它确认「可以中止了」，
 * 避免中止落在消息提交前被 `abortRequested` 复位竞态吞掉）。
 */
export function abortedRound(hooks?: { onHanging?: () => void }): ScriptedRound {
  return (roundOptions) =>
    (async function* () {
      yield assistantMessage([{ type: 'thinking', thinking: '进入一次不会自己结束的思考…' }], 'thinking');
      hooks?.onHanging?.();
      await waitUntilAborted(roundOptions.signal);
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      throw err;
    })();
}

function waitUntilAborted(signal: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!signal) {
      // 没有信号就没有中止路径可走；直接失败，不留下一个永远挂起的生成器
      reject(new Error('abortedRound 需要一个真实的 AbortSignal'));
      return;
    }
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

export interface ScriptedLlm {
  /** 传给 `setCallLlmOverride` 的实现 */
  override: CallLlmImplementation;
  /** callLLM 已被调用的次数（= 已消费的脚本轮次 + 1 若脚本耗尽抛错） */
  calls(): number;
  /** 第 n 次（1 起）callLLM 收到的 messages 深拷贝，断言「工具结果进入下一轮上下文」用 */
  requestMessages(n: number): unknown;
}

/**
 * 把一串脚本轮次打包成可注入的 LLM 实现。
 *
 * 脚本耗尽后再有 LLM 调用直接抛错：多出来的调用说明场景对「轮次从哪结束」的
 * 假设已经不成立，静默吞掉只会把失败推到更远的断言上（不过度 fallback）。
 */
export function createScriptedLlm(rounds: readonly ScriptedRound[]): ScriptedLlm {
  let index = 0;
  const requests: unknown[] = [];
  const override: CallLlmImplementation = async function* (options) {
    requests.push(JSON.parse(JSON.stringify(options.messages)));
    const round = rounds[index];
    index += 1;
    if (!round) {
      throw new Error(`场景脚本耗尽：第 ${index} 次 LLM 调用没有对应的脚本轮次`);
    }
    yield* round(options);
  };
  return {
    override,
    calls: () => index,
    requestMessages: (n: number) => requests[n - 1],
  };
}

interface TimelineEntry {
  readonly type: CoreEvent['type'];
  readonly event: CoreEvent;
}

export type LoadedConversation = Awaited<ReturnType<typeof loadConversation>>;

export interface ScenarioOptions {
  sessionId: string;
  /**
   * LLM 脚本（每次 callLLM 调用按序消费一个轮次）。
   * 收到沙箱信息（工作目录等）——脚本里引用工具要操作的文件路径时从这里拼。
   */
  rounds: (sandbox: { workspace: string }) => readonly ScriptedRound[];
  /** 工具权限请求的答复（缺省一律放行） */
  toolPermissionRequested?: CoreRequestHandlers['toolPermissionRequested'];
  /** 用户选择的答复（缺省选第 0 项） */
  userChoice?: CoreRequestHandlers['userChoice'];
}

export interface ScenarioHandle {
  readonly sessionId: string;
  /** 会话工作目录（临时目录，close 时自动清理） */
  readonly workspace: string;
  /** 注入的脚本 LLM：断言调用次数与每轮收到的上下文 */
  readonly llm: ScriptedLlm;
  /** 某个 core→UI 事件收到的全部事件对象（按到达顺序） */
  received<T extends CoreEvent['type']>(type: T): Array<Extract<CoreEvent, { type: T }>>;
  /** 某个事件的最后一条；没收到则为 undefined */
  last<T extends CoreEvent['type']>(type: T): Extract<CoreEvent, { type: T }> | undefined;
  /** 某个事件收到的条数 */
  count(type: CoreEvent['type']): number;
  /**
   * 本会话的事件类型序列（按到达顺序）。
   * 传 `types` 只保留这些类型（过滤掉噪音如 log / conversationListChanged），
   * 断言「事件按什么顺序发生」用。
   */
  timeline(...types: ReadonlyArray<CoreEvent['type']>): CoreEvent['type'][];
  /** 发送一条用户消息，等本轮查询结束（queryEnd）后返回 */
  send(content: string): Promise<void>;
  /** 发送一条用户消息但不等查询结束（中止场景用：先提交、后中止） */
  submit(content: string): void;
  /** 请求中止当前查询，等 queryEnd 后返回 */
  abort(): Promise<void>;
  /** 读落盘后的会话（JSONL 消息 + meta） */
  conversation(): Promise<LoadedConversation>;
  /** 结束场景：还原 LLM 注入 / 全局总线 / HOME / 会话工作区 */
  close(): void;
}

async function waitForCondition(desc: string, timeoutMs: number, cond: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`等待超时（${timeoutMs}ms）：${desc}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * 启动一个场景：搭好沙箱（HOME / 工作目录 / 事件总线 / LLM 注入），按真实
 * bootstrap 顺序完成 core 接线（initializeCoreEvents → hostEnvironmentProvided 握手），
 * 之后即可 `send()` 驱动。
 *
 * 测试结束时必须调用 `close()`（建议放 finally）——它是全局单例的还原点。
 */
export async function startScenario(options: ScenarioOptions): Promise<ScenarioHandle> {
  const { sessionId } = options;

  // ---- 沙箱：配置与会话落盘都隔离进临时目录（resolveConfigDir 按 env 逐次解析） ----
  const configHome = makeTempDir('scenario-home');
  const workspace = makeTempDir('scenario-ws');
  const prevUserProfile = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  process.env.USERPROFILE = configHome;
  process.env.HOME = configHome;

  // ---- 总线：借用 createRecordingCoreEventHandlers 的穷尽表做按类型记录，
  // 外面包一层时间线记录（总线只允许 onCoreEvents 一次，不能两层各订一份） ----
  const recording = createRecordingCoreEventHandlers();
  const timelineEntries: TimelineEntry[] = [];
  const wrapped = {} as Record<string, (event: CoreEvent) => void>;
  for (const type of Object.keys(recording.handlers) as Array<keyof typeof recording.handlers>) {
    const inner = recording.handlers[type] as (event: CoreEvent) => void;
    wrapped[type] = (event: CoreEvent) => {
      timelineEntries.push({ type: type as CoreEvent['type'], event });
      inner(event);
    };
  }
  const bus: AssistantEventBus = createEventBus();
  bus.onCoreEvents(wrapped as unknown as CoreEventHandlers);
  bus.onCoreRequests({
    toolPermissionRequested:
      options.toolPermissionRequested ?? (async () => ({ behavior: 'allow' as const })),
    userChoice: options.userChoice ?? (async () => ({ index: 0 })),
  });
  setGlobalEventBus(bus);

  // ---- 按真实 bootstrap 顺序接线：注册 UiEvent 订阅（等异步注册组就位）→
  // 宿主环境握手（同步应用配置快照 = 就绪判据）→ 会话工作区 → LLM 注入 ----
  await initializeCoreEvents(bus);
  provideHostEnvironment(bus);
  setSessionWorkspace(sessionId, workspace);
  const scripted = createScriptedLlm(options.rounds({ workspace }));
  setCallLlmOverride(scripted.override);

  const timeline = (
    ...types: ReadonlyArray<CoreEvent['type']>
  ): CoreEvent['type'][] => {
    return timelineEntries
      .filter((entry) => {
        if (types.length > 0 && !types.includes(entry.type)) return false;
        // 不带 sessionId 的事件（coreReady 等全局事件）视为本会话相关
        const withSession = entry.event as { sessionId?: string };
        return withSession.sessionId === undefined || withSession.sessionId === sessionId;
      })
      .map((entry) => entry.type);
  };

  const submit = (content: string): void => {
    bus.emitToCore({
      type: 'userMessageSubmitted',
      sessionId,
      content,
      uuid: nextId('user'),
    });
  };

  const send = async (content: string): Promise<void> => {
    const before = recording.count('queryEnd');
    submit(content);
    await waitForCondition(
      `用户消息「${content}」触发的一轮查询结束（queryEnd）`,
      DEFAULT_TIMEOUT_MS,
      () => recording.count('queryEnd') > before,
    );
  };

  const abort = async (): Promise<void> => {
    const before = recording.count('queryEnd');
    bus.emitToCore({ type: 'abortRequested', sessionId });
    await waitForCondition('中止后的 queryEnd', DEFAULT_TIMEOUT_MS, () =>
      recording.count('queryEnd') > before,
    );
  };

  return {
    sessionId,
    workspace,
    llm: scripted,
    received: recording.received,
    last: recording.last,
    count: recording.count,
    timeline,
    send,
    submit,
    abort,
    conversation: () => loadConversation(sessionId),
    close: () => {
      setCallLlmOverride(null);
      resetGlobalEventBus();
      clearSessionWorkspace(sessionId);
      resetSettingsSnapshot();
      if (prevUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    },
  };
}
