import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { Client } from 'ssh2';

/**
 * Electron 整应用测试的假 LLM：一个 OpenAI Chat Completions 兼容的 SSE 服务器。
 *
 * Core（Rust）经真实链路（settings.json → settingsSnapshot → llm.rs 流式
 * 适配器）；standalone core 经 Rust 的 `llm::stream_*`。按用户消息内容脚本化决定
 * 轮次行为：
 * - 常规文本 → 流式文本终轮（finish_reason=stop）
 * - `写入文件 <名字>` → Write 工具轮（finish_reason=tool_calls），工具结果回传后
 *   下一请求自动落终轮
 * - `慢速回答` → 长间隔分片流（供中止场景）
 * - `无响应` → 接受连接、读完请求后**完全不回响应头**（模拟静默挂住的网关，
 *   供「不回响应头时中止」场景）
 * 所有请求体（model / messages / tools）都被记录，供用例断言。
 */

export interface RecordedRequest {
  url: string;
  /** 请求体解析完成（服务器侧「开始处理」）时刻 */
  startedAt: number;
  /** SSE 写完（[DONE] 已发出）时刻；hang 的请求没有此字段 */
  finishedAt?: number;
  authorization?: string;
  body: {
    model: string;
    messages: Array<{ role: string; content: unknown; tool_calls?: unknown[] }>;
    tools?: Array<{ function?: { name?: string } }>;
    [key: string]: unknown;
  };
}

/** 一轮应答的脚本：text 终轮 / tool 工具轮 / tools 多工具轮 / slow 慢速流 / hang 不回响应头 */
export type ScriptDecision =
  | { kind: 'text'; text: string; thinking?: string; delayMs?: number }
  | {
      kind: 'timed';
      /**
       * 定时脚本：thinking 与正文各按固定节奏产出，用来构造**已知速率**的场景。
       *
       * 为什么需要它：流式统计的 decode 速率只有在「每个 delta 携带固定 token 数、
       * 间隔固定」时才可断言（`e2e/electron/streamStatsRate.spec.ts`）。
       */
      thinkingChunks: number;
      /** 每个 thinking delta 的间隔（ms） */
      thinkingDelayMs: number;
      thinkingTokensPerChunk: number;
      /** thinking 结束后到正文首帧的间隔（ms），模拟思考块与正文之间的空档 */
      gapMs: number;
      textChunks: number;
      textDelayMs: number;
      textTokensPerChunk: number;
    }
  | { kind: 'tool'; name: string; args: Record<string, unknown>; preamble?: string; delayMs?: number }
  | { kind: 'tools'; calls: Array<{ name: string; args: Record<string, unknown> }>; preamble?: string; delayMs?: number }
  | { kind: 'slow'; text: string; chunkDelayMs: number }
  | { kind: 'hang' };

export interface MockLlm {
  /** baseURL（已含 /v1），写入 settings.json 的 provider */
  baseURL: string;
  requests: RecordedRequest[];
  /** 覆盖默认的内容路由（默认按用户消息文本启发式路由，见 decideRound） */
  setHandler(handler: (req: RecordedRequest) => ScriptDecision): void;
  close(): void;
}

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 提取请求里最后一条用户消息的文本（content 可能是 string 或 parts 数组） */
export function lastUserText(messages: Array<{ role: string; content: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content.map((p: any) => (p?.type === 'text' ? p.text : '')).join('');
    }
    return '';
  }
  return '';
}

function hasToolResult(messages: Array<{ role: string; content: unknown }>): boolean {
  // 只有「最后一条消息是 tool 结果」才代表本轮工具已回传（历史里的不算）
  return messages.length > 0 && messages[messages.length - 1].role === 'tool';
}

/**
 * 把本机端口经 SSH 反向隧道暴露到远端的 `127.0.0.1:<远端端口>`。
 *
 * **为什么需要它**：远端车道里 Core 跑在测试机上，要主动回连本机的 mock LLM
 * （`settings.json` 的 `baseURL`）。本机若在 NAT 后面，远端访问不到
 * `detectLlmAdvertiseHost()` 拿到的内网地址（实测：本机 `192.168.x.x`，远端
 * 公网机 → 连接超时）。症状极具迷惑性——0 个模型请求、界面无限转圈，看起来
 * 像工具链缺陷，其实是 mock 根本不可达。
 *
 * 端口用 0 让**远端**分配：mock 的监听端口是动态的，写死会与并行用例撞车。
 * `sshd` 的 `GatewayPorts no` 只允许绑回环，而 Core 与隧道同在测试机上，
 * `127.0.0.1` 足够。
 */
async function openReverseTunnel(
  ssh: { host: string; port: number; user: string; password: string },
  localPort: number,
): Promise<{ host: string; port: number; close(): void }> {
  const client = new Client();
  await new Promise<void>((resolve, reject) => {
    client.once('ready', resolve).once('error', reject);
    client.connect({
      host: ssh.host,
      port: ssh.port,
      username: ssh.user,
      password: ssh.password,
      readyTimeout: 20_000,
    });
  });
  // 每条反向连接都短接到本机 mock；长连接（SSE）靠 pipe 双向透传
  client.on('tcp connection', (_info, accept) => {
    const channel = accept();
    const target = net.connect(localPort, '127.0.0.1');
    channel.pipe(target).pipe(channel);
    target.on('error', () => channel.end());
    channel.on('error', () => target.destroy());
  });
  const remotePort = await new Promise<number>((resolve, reject) => {
    client.forwardIn('127.0.0.1', 0, (error, port) => (error ? reject(error) : resolve(port)));
  });
  return {
    host: '127.0.0.1',
    port: remotePort,
    // 远端监听不单独释放：整条 SSH 连接关闭时随之消失
    close: () => client.end(),
  };
}

export async function startMockLlm(options: {
  workspaceDir: string;
  /**
   * 监听地址（缺省 127.0.0.1）。真实 SSH 远程工作区用例里 Core 跑在远端机器上，
   * 服务器必须对外监听（0.0.0.0）远端才够得着。
   */
  listenHost?: string;
  /**
   * 写进 settings.json 的 baseURL 主机（缺省 127.0.0.1）。远程用例传本机 LAN IP
   * （远端 Core 要从这里回连 mock）。端口以实际监听端口为准。
   */
  advertiseHost?: string;
  /**
   * 经 SSH 反向隧道把 mock 暴露到远端回环（`{ ssh: { host, port, user, password } }`）。
   *
   * 给了就走隧道，`advertiseHost` 被忽略——两者是互斥的两种可达性方案：隧道适用于
   * 本机在 NAT 后、远端连不进来的情形（绝大多数开发机），直连适用于本机有对远端可达
   * 的公网 / 同网段地址。缺省不建隧道，本地车道的原有行为不变。
   */
  reverseTunnel?: { host: string; port: number; user: string; password: string };
}): Promise<MockLlm> {
  const requests: RecordedRequest[] = [];
  let handler: ((req: RecordedRequest) => ScriptDecision) | null = null;
  /** `hang` 脚本挂住的响应：close() 时兜底销毁，避免服务器关不掉 */
  const hangingResponses = new Set<http.ServerResponse>();

  /** 默认路由：按用户消息文本决定轮次行为 */
  const decideRound = (req: RecordedRequest): ScriptDecision => {
    const text = lastUserText(req.body.messages);
    // 工具结果已回传 → 一律终轮收尾
    if (hasToolResult(req.body.messages)) {
      return { kind: 'text', text: '工具已执行完毕，这是最终答复。' };
    }
    const writeMatch = text.match(/^写入文件\s+(\S+)/);
    if (writeMatch) {
      const fileName = writeMatch[1];
      const sep = options.workspaceDir.includes('\\') ? '\\' : '/';
      const filePath = `${options.workspaceDir}${sep}${fileName}`;
      return {
        kind: 'tool',
        name: 'Write',
        args: {
          file_path: filePath,
          content: `# 由 e2e 场景写入\n文件名：${fileName}\n`,
        },
        preamble: '我来创建这个文件。',
      };
    }
    if (text.startsWith('慢速回答')) {
      return { kind: 'slow', text: '这是一段慢速流式输出，逐字到达，适合验证中止操作。'.repeat(3), chunkDelayMs: 700 };
    }
    if (text.startsWith('固定速率')) {
      // 已知速率场景：thinking 20 帧 × 5 token / 每帧 100ms → 思考段 50 tok/s；
      // 之后空档 1s + 正文 10 帧 × 5 token / 每帧 50ms。
      // 若分母错用整轮时长（~4.6s），速率会掉到 ~22 tok/s（缺陷症状）。
      return {
        kind: 'timed',
        thinkingChunks: 20,
        thinkingDelayMs: 100,
        thinkingTokensPerChunk: 5,
        gapMs: 1000,
        textChunks: 10,
        textDelayMs: 50,
        textTokensPerChunk: 5,
      };
    }
    if (text.startsWith('无响应')) {
      // 静默挂住的网关：接受连接、读完请求后连响应头都不回
      return { kind: 'hang' };
    }
    const bashMatch = text.match(/^执行命令\s+(.+)$/);
    if (bashMatch) {
      return {
        kind: 'tool',
        name: 'Bash',
        args: { command: bashMatch[1], description: 'e2e 场景命令' },
        preamble: '我来执行这条命令。',
      };
    }
    return { kind: 'text', text: `收到：${text.slice(0, 40)}`, thinking: text.includes('思考') ? '先想一想。' : undefined };
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      if (req.method === 'GET' && url.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model' }, { id: 'mock-model-pro' }] }));
        return;
      }
      if (req.method !== 'POST' || !url.includes('chat/completions')) {
        res.writeHead(404).end();
        return;
      }
      let body: any;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400).end();
        return;
      }
      const recorded: RecordedRequest = {
        url,
        startedAt: Date.now(),
        authorization: req.headers.authorization as string | undefined,
        body,
      };
      requests.push(recorded);

      const decision = (handler ?? decideRound)(recorded);
      if (decision.kind === 'hang') {
        // 不回任何响应头、也不结束响应：请求一直停在「等响应头」阶段。
        // 客户端 abort 会断开连接（res 随之 close）；测试失败时由 close() 兜底销毁。
        hangingResponses.add(res);
        res.on('close', () => hangingResponses.delete(res));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });

      const write = (payload: unknown) => res.write(sseFrame(payload));
      write({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });

      const finish = (reason: string, usageOverride?: { prompt_tokens: number; completion_tokens: number; reasoning_tokens?: number }) => {
        write({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
        const completion = usageOverride?.completion_tokens ?? 20;
        write({
          choices: [],
          usage: {
            prompt_tokens: usageOverride?.prompt_tokens ?? 100,
            completion_tokens: completion,
            total_tokens: (usageOverride?.prompt_tokens ?? 100) + completion,
            ...(usageOverride?.reasoning_tokens !== undefined
              ? { completion_tokens_details: { reasoning_tokens: usageOverride.reasoning_tokens } }
              : {}),
          },
        });
        res.write('data: [DONE]\n\n');
        res.end();
        recorded.finishedAt = Date.now();
      };

      // 定时脚本：thinking / 正文各按固定间隔产出固定 token 数，
      // 用于断言「思考速率不被正文与空档稀释」（e2e/electron/streamStatsRate.spec.ts）。
      if (decision.kind === 'timed') {
        const totalThinkingTokens = decision.thinkingChunks * decision.thinkingTokensPerChunk;
        const totalTextTokens = decision.textChunks * decision.textTokensPerChunk;
        // 每 chunk 的字符数按 4 字符 ≈ 1 token 反推，使 UI 的字符计数与 token 口径可对账
        const thinkingPiece = 'x'.repeat(decision.thinkingTokensPerChunk * 4);
        const textPiece = 'y'.repeat(decision.textTokensPerChunk * 4);
        let thinkingSent = 0;
        let textSent = 0;

        const tickThinking = (): void => {
          if (res.destroyed) {
            res.end();
            return;
          }
          if (thinkingSent >= decision.thinkingChunks) {
            // thinking 结束 → 空档 → 正文
            setTimeout(tickText, decision.gapMs);
            return;
          }
          write({ choices: [{ index: 0, delta: { reasoning_content: thinkingPiece }, finish_reason: null }] });
          thinkingSent += 1;
          setTimeout(tickThinking, decision.thinkingDelayMs);
        };

        const tickText = (): void => {
          if (res.destroyed) {
            res.end();
            return;
          }
          if (textSent >= decision.textChunks) {
            finish('stop', {
              prompt_tokens: 100,
              completion_tokens: totalThinkingTokens + totalTextTokens,
              reasoning_tokens: totalThinkingTokens,
            });
            return;
          }
          write({ choices: [{ index: 0, delta: { content: textPiece }, finish_reason: null }] });
          textSent += 1;
          setTimeout(tickText, decision.textDelayMs);
        };

        tickThinking();
        return;
      }

      if (decision.kind === 'text' || decision.kind === 'slow') {
        if (decision.kind === 'text' && decision.thinking) {
          write({ choices: [{ index: 0, delta: { reasoning_content: decision.thinking }, finish_reason: null }] });
        }
        const text = decision.text;
        const step = Math.max(1, Math.ceil(text.length / 24));
        let i = 0;
        const tick = (): void => {
          if (res.destroyed) {
            res.end();
            return;
          }
          if (i >= text.length) {
            finish('stop');
            return;
          }
          write({ choices: [{ index: 0, delta: { content: text.slice(i, i + step) }, finish_reason: null }] });
          i += step;
          setTimeout(tick, decision.kind === 'slow' ? decision.chunkDelayMs : 15);
        };
        if (decision.kind === 'text' && decision.delayMs) {
          // 首字前挂起：让出事件循环（与工具轮的 delayMs 同语义），供用例把
          // 某个动作（如中止点击）确定地插进「本轮还在跑」的窗口
          setTimeout(tick, decision.delayMs);
          return;
        }
        tick();
        return;
      }

      // 工具轮：可选前置文本 → tool_calls（参数分两帧，覆盖 arguments 累积路径）。
      // `tools` 多工具轮同一批 tool_calls 按 index 递增逐个下发（specs/005 的
      // 并发上限用例用一轮 6 个 Agent 调用驱动 fan-out）。
      // `delayMs` 模拟 LLM 首字延迟：setTimeout 让出事件循环，期间其他连接的
      // 请求可以进来被解析（startedAt 落在别的请求区间内 = 并发可观测）
      const emitToolCalls = (): void => {
        if (decision.preamble) {
        write({ choices: [{ index: 0, delta: { content: decision.preamble }, finish_reason: null }] });
      }
        const calls = decision.kind === 'tools'
          ? decision.calls.map((call) => ({ name: call.name, args: JSON.stringify(call.args) }))
          : [{ name: decision.name, args: JSON.stringify(decision.args) }];
        calls.forEach((call, callIndex) => {
          write({
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: callIndex, id: `call_${Date.now()}_${callIndex}`, type: 'function',
                  function: { name: call.name, arguments: call.args.slice(0, Math.ceil(call.args.length / 2)) },
                }],
              },
              finish_reason: null,
            }],
          });
          write({
            choices: [{
              index: 0,
              delta: { tool_calls: [{ index: callIndex, function: { arguments: call.args.slice(Math.ceil(call.args.length / 2)) } }] },
              finish_reason: null,
            }],
          });
        });
        finish('tool_calls');
      };
      if (decision.delayMs) {
        setTimeout(emitToolCalls, decision.delayMs);
      } else {
        emitToolCalls();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, options.listenHost ?? '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  // 可达性：隧道优先，其次直连广播地址。隧道建在监听之后——它要把真实 port 透传出去
  const tunnel = options.reverseTunnel
    ? await openReverseTunnel(options.reverseTunnel, port)
    : null;
  const baseURL = tunnel
    ? `http://${tunnel.host}:${tunnel.port}/v1`
    : `http://${options.advertiseHost ?? '127.0.0.1'}:${port}/v1`;

  return {
    baseURL,
    requests,
    setHandler(h) { handler = h; },
    close() {
      // 先销毁挂住的响应，server.close() 才不会被未结束的连接拖住
      for (const res of hangingResponses) res.destroy();
      hangingResponses.clear();
      server.close();
      tunnel?.close();
    },
  };
}
