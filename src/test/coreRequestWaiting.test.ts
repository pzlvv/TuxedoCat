/**
 * CoreRequest 的 waiting 语义登记表（`specs/defects/tool-card-roundtrip-marks-waiting`
 * 修复时登记的缺口）：
 *
 * - `CoreRequest` 联合的**每种**类型都必须在 WAITING_REGISTRY 里登记「在途期间是否把
 *   `sessionRuntime.waiting` 标 true」，并配一个真实 Core 二进制上的往返用例；
 *   新增 CoreRequest 类型而漏登记时本用例红（枚举从 AssistantEventBus.ts 源码解析，
 *   不依赖手抄名单）。
 * - 登记语义对照 [docs/core/session-runtime.md 第 1 节](../../docs/core/session-runtime.md)：
 *   只有 `userChoice`（UserBlockingRequest / `waiting_request`）算等用户；
 *   `toolPermissionRequested` 的渲染往返（HostRenderRequest / `plain_request`）不算。
 *
 * 需要 Standalone Core 产物（先跑 `npm run build:core:host`）；产物缺失时跳过
 * （登记表完备性检查不受影响，始终执行）。
 * 运行方式：npm run test:all -- core-request-waiting
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { CONFIG_DIR_NAME, CORE_RESOURCE_DIR } from '../config/project';
import { coreBinaryFileName, corePlatformDir } from '../host/standalone/coreBinary';
import { CORE_PROTOCOL_VERSION } from '../host/standalone/protocol';
import { createChecker, runTests } from './helpers/harness';
import { settingsSnapshotFromHome } from './helpers/fixtures';

/** 仓库根：编译产物在 `out/src/test/`，往上三层 */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const BUS_SOURCE = path.join(REPO_ROOT, 'src', 'shared', 'AssistantEventBus.ts');
const CORE_BINARY = path.join(
  REPO_ROOT,
  'resources',
  CORE_RESOURCE_DIR,
  corePlatformDir('win32', 'x64')!,
  coreBinaryFileName('win32'),
);

const SESSION_ID = 'sess-waiting';

/** 从 AssistantEventBus.ts 源码解析 CoreRequest 联合的成员 type 名单 */
function coreRequestTypes(): string[] {
  const source = fs.readFileSync(BUS_SOURCE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const start = source.indexOf('export type CoreRequest =');
  if (start < 0) throw new Error('AssistantEventBus.ts 缺 export type CoreRequest');
  const end = source.indexOf('export type CoreRequestResultMap', start);
  if (end < 0) throw new Error('AssistantEventBus.ts 缺 CoreRequestResultMap');
  const names = new Set<string>();
  for (const m of source.slice(start, end).matchAll(/type:\s*'([a-zA-Z]+)'/g)) {
    if (m[1] !== undefined) names.add(m[1]);
  }
  return [...names].sort();
}

interface Frame {
  kind: string;
  id?: number;
  request?: { type?: string; permResult?: { behavior?: string } };
  event?: { type: string; [key: string]: unknown };
}

/** 一次往返的观察结果 */
interface RoundtripObservation {
  /** 在途窗口（应答发出前）内该会话 `waiting=true` 快照条数 */
  waitingTrueDuringInflight: number;
  /** 应答之后是否回落：neverWaiting = 全程从未进入 waiting；recovered = 应答后出现 waiting=false */
  settled: boolean;
  /** 场景前置断言的失败信息（空数组 = 场景按预期发生） */
  preconditionFailures: string[];
}

interface Scenario {
  /** 会话询问模式（settings.json 的 defaultAgentMode） */
  mode: 'risk' | 'manual';
  /** 首轮 fake LLM 返回的 Bash 命令 */
  command: string;
  /** toolPermissionRequested 到达后压住应答的时长（构造真实的在途窗口） */
  permHoldMs: number;
  /** userChoice 到达后压住应答的时长；0 = 该场景不等到 userChoice */
  choiceHoldMs: number;
}

/**
 * 跑一轮「消息 → 工具调用 → 请求往返 → queryEnd」，返回窗口观察。
 *
 * 应答被刻意压住：在途窗口期间收到的 `sessionRuntimeChanged` 快照按帧序切片，
 * waiting 语义对不对在窗口上看才是硬断言（应答即发即答的 RT 断言锁不住「窗口内
 * 迟到的错误快照」）。
 */
async function runRoundtrip(scenario: Scenario): Promise<RoundtripObservation> {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-waiting-'));
  const workspace = path.join(homeDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const llm = await startFakeLlm(scenario.command);
  const configDir = path.join(homeDir, CONFIG_DIR_NAME);
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'settings.json'),
    JSON.stringify({
      defaultAgentMode: scenario.mode,
      llm: {
        maxTokens: 4096,
        activeProvider: 'fake',
        providers: {
          fake: {
            baseURL: llm.url,
            apiKey: 'test-key',
            models: ['fake-model'],
            defaultModel: 'fake-model',
            modelConfigs: { 'fake-model': { apiType: 'OpenAI', maxOutputTokens: 4096 } },
          },
        },
      },
    }),
    'utf8',
  );

  const child = spawn(CORE_BINARY, ['stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, USERPROFILE: homeDir, HOME: homeDir },
    windowsHide: true,
  });
  const frames: Frame[] = [];
  const send = (frame: unknown): void => {
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  };
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  // 窗口锚点：请求帧下标与应答发出时刻的帧总数（frames 只增，下标即到达序）
  let permArrivedAt = -1;
  let permReleasedAt = -1;
  let choiceArrivedAt = -1;
  let choiceReleasedAt = -1;

  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        try {
          const frame = JSON.parse(line) as Frame;
          frames.push(frame);
          if (frame.kind === 'request' && typeof frame.id === 'number') {
            if (frame.request?.type === 'toolPermissionRequested') {
              // 模拟真实 UI：先上架卡片（原样回传 permResult），压住片刻再应答
              permArrivedAt = frames.length - 1;
              const id = frame.id;
              const permResult = frame.request.permResult ?? { behavior: 'ask' };
              void sleep(scenario.permHoldMs).then(() => {
                permReleasedAt = frames.length;
                send({ kind: 'response', id, ok: true, result: permResult });
              });
            } else if (frame.request?.type === 'userChoice') {
              choiceArrivedAt = frames.length - 1;
              const id = frame.id;
              void sleep(scenario.choiceHoldMs).then(() => {
                choiceReleasedAt = frames.length;
                send({ kind: 'response', id, ok: true, result: { index: 0 } });
              });
            }
          }
        } catch {
          /* 忽略非法行 */
        }
      }
      index = buffer.indexOf('\n');
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', () => undefined);

  const waitFor = async (predicate: () => boolean, timeoutMs = 20_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await sleep(20);
    }
    return predicate();
  };

  try {
    send({ kind: 'hello', protocol: CORE_PROTOCOL_VERSION });
    if (!(await waitFor(() => frames.some((frame) => frame.kind === 'ready')))) {
      return { waitingTrueDuringInflight: -1, settled: false, preconditionFailures: ['core 未就绪'] };
    }
    send({
      kind: 'uiEvent',
      event: {
        type: 'hostEnvironmentProvided',
        extensionPath: REPO_ROOT,
        logToConsole: false,
        configDirName: CONFIG_DIR_NAME,
        settings: settingsSnapshotFromHome(homeDir),
        mcpServers: [],
      },
    });
    send({ kind: 'uiEvent', event: { type: 'sessionWorkspaceAssigned', sessionId: SESSION_ID, workspacePath: workspace } });
    send({ kind: 'uiEvent', event: { type: 'conversationStarted', sessionId: SESSION_ID } });
    send({
      kind: 'uiEvent',
      event: { type: 'userMessageSubmitted', sessionId: SESSION_ID, content: '跑一下', uuid: 'user_waiting_1' },
    });
    const ok = await waitFor(() =>
      frames.some((frame) => frame.kind === 'event' && frame.event?.type === 'queryEnd'),
    );
    if (!ok) {
      return { waitingTrueDuringInflight: -1, settled: false, preconditionFailures: ['未等到 queryEnd'] };
    }
  } finally {
    try {
      send({ kind: 'shutdown' });
      child.stdin.end();
    } catch {
      /* 已关闭 */
    }
    child.kill();
    await llm.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }

  // 该会话的 waiting 快照（按到达序）
  const waitingFlags: Array<{ at: number; waiting: boolean }> = [];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (frame?.kind !== 'event' || frame.event?.type !== 'sessionRuntimeChanged') continue;
    const states = frame.event.states as Array<{ sessionId?: string; waiting?: boolean }> | undefined;
    const mine = (states ?? []).find((state) => state.sessionId === SESSION_ID);
    if (mine) waitingFlags.push({ at: i, waiting: mine.waiting === true });
  }
  const countWaitingTrue = (from: number, to: number): number =>
    waitingFlags.filter((snapshot) => snapshot.at > from && snapshot.at <= to && snapshot.waiting).length;

  const problems: string[] = [];
  const permissionRequests = frames.filter(
    (frame) => frame.kind === 'request' && frame.request?.type === 'toolPermissionRequested',
  );
  const userChoices = frames.filter((frame) => frame.kind === 'request' && frame.request?.type === 'userChoice');
  if (permissionRequests.length !== 1) {
    problems.push(`toolPermissionRequested 恰一次，实际 ${permissionRequests.length}`);
  }

  if (scenario.choiceHoldMs === 0) {
    // 渲染往返场景：全程不该有 userChoice，也不该有任何 waiting=true
    if (userChoices.length !== 0) problems.push(`不该有 userChoice，实际 ${userChoices.length}`);
    const waitingTrue = waitingFlags.filter((snapshot) => snapshot.waiting).length;
    return {
      waitingTrueDuringInflight: countWaitingTrue(permArrivedAt, permReleasedAt),
      settled: waitingTrue === 0,
      preconditionFailures: problems,
    };
  }

  // 用户阻塞场景：权限往返窗口内不标 waiting（渲染往返语义，回归
  // specs/defects/tool-card-roundtrip-marks-waiting），userChoice 窗口内必须标
  if (choiceArrivedAt < 0 || choiceReleasedAt < 0) {
    problems.push(`userChoice 恰一次且已应答，实际 ${userChoices.length}`);
    return { waitingTrueDuringInflight: -1, settled: false, preconditionFailures: problems };
  }
  const permWindowWaitingTrue = countWaitingTrue(permArrivedAt, permReleasedAt);
  if (permWindowWaitingTrue !== 0) {
    problems.push(`toolPermissionRequested 在途窗口出现 ${permWindowWaitingTrue} 条 waiting=true 快照`);
  }
  const recovered = waitingFlags.some((snapshot) => snapshot.at > choiceReleasedAt && !snapshot.waiting);
  return {
    waitingTrueDuringInflight: countWaitingTrue(permReleasedAt, choiceReleasedAt),
    settled: recovered,
    preconditionFailures: problems,
  };
}

/** 假 LLM：先回一次 Bash 工具调用，再回最终文本（对齐 standaloneCorePermission 的驱动方式） */
function startFakeLlm(command: string): Promise<{ url: string; close: () => Promise<void> }> {
  let hits = 0;
  const server = http.createServer((request, response) => {
    request.on('data', () => undefined);
    request.on('end', () => {
      const isFirst = hits === 0;
      hits += 1;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (isFirst) {
        response.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_waiting',
                      function: { name: 'Bash', arguments: JSON.stringify({ command }) },
                    },
                  ],
                },
              },
            ],
          })}\n\n`,
        );
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      } else {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' } }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      }
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/**
 * 登记表：CoreRequest 每种类型 →「在途期间是否 waiting」+ 真实二进制上的往返驱动。
 * key 集合必须与联合逐成员一致（下方前两条 check 锁死双向）。
 */
const WAITING_REGISTRY: Record<string, { waiting: boolean; run: () => Promise<RoundtripObservation> }> = {
  // 渲染往返（`plain_request`）：上架卡片、回传 permResult，全程不算等用户
  toolPermissionRequested: {
    waiting: false,
    run: () => runRoundtrip({ mode: 'risk', command: 'sleep 1', permHoldMs: 400, choiceHoldMs: 0 }),
  },
  // 用户阻塞（`waiting_request`）：真确认框在途期间必须标 waiting
  userChoice: {
    waiting: true,
    run: () => runRoundtrip({ mode: 'manual', command: 'dd if=/dev/zero of=x count=0', permHoldMs: 300, choiceHoldMs: 400 }),
  },
};

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // ---- 登记表完备性（不依赖二进制，始终执行：新增 CoreRequest 类型漏登记即红） ----
  const unionTypes = coreRequestTypes();
  const registered = Object.keys(WAITING_REGISTRY).sort();
  const unregistered = unionTypes.filter((type) => !WAITING_REGISTRY[type]);
  const stale = registered.filter((type) => !unionTypes.includes(type));
  check(
    `CoreRequest 每种类型都登记了 waiting 语义（联合 ${unionTypes.join(' / ')}）`,
    unregistered.length === 0,
  );
  for (const type of unregistered) console.log(`     ${type} 未登记进 WAITING_REGISTRY`);
  check(`WAITING_REGISTRY 没有联合之外的条目（多余 ${stale.length} 个）`, stale.length === 0);
  for (const type of stale) console.log(`     ${type} 不在 CoreRequest 联合里`);

  if (process.platform !== 'win32' || !fs.existsSync(CORE_BINARY)) {
    console.log(`skip: ${path.relative(REPO_ROOT, CORE_BINARY)} missing (run npm run build:core:host)`);
    finish();
    return;
  }

  // ---- 表驱动：每种类型在真实 Core 上跑一次往返，在途窗口对照登记 ----
  for (const type of registered) {
    const entry = WAITING_REGISTRY[type]!;
    const obs = await entry.run();
    const windowOk = entry.waiting ? obs.waitingTrueDuringInflight >= 1 : obs.waitingTrueDuringInflight === 0;
    check(
      `${type}：在途期间 waiting 快照与登记一致（登记 waiting=${entry.waiting}，窗口内 waiting=true ${obs.waitingTrueDuringInflight} 条）`,
      windowOk,
    );
    check(`${type}：应答后回落（${entry.waiting ? '出现 waiting=false' : '全程未进入 waiting'}）`, obs.settled);
    check(`${type}：场景前置成立`, obs.preconditionFailures.length === 0);
    for (const problem of obs.preconditionFailures) console.log(`     ${type}: ${problem}`);
  }
  finish();
}

runTests('core-request-waiting', run);
