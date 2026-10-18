/**
 * LLM 请求专用 undici dispatcher
 *
 * 背景：
 * - 部分 LLM 网关（例如 z.ai / glm 等）在返回 502/503 后，会静默丢弃空闲
 *   keep-alive 连接而不发送 TCP RST。
 * - undici 默认 dispatcher 的 keepAliveTimeout 较长，下一次请求可能复用这些
 *   “僵尸 socket”，导致请求一直卡到 headersTimeout 才超时，表现为 502/503
 *   之后所有 LLM 请求全部卡死。
 *
 * 解决：
 * - 不再依赖 `Connection: close` 请求头“绕池”。
 * - 为 LLM 请求提供独立的自定义 dispatcher：
 *   - `keepAliveTimeout: 1` / `keepAliveMaxTimeout: 1`：空闲连接立即回收，
 *     避免复用可能已被服务端丢弃的死连接。
 *   - `pipelining: 0`：禁用连接上的请求流水线，进一步降低连接复用风险。
 */

import { Agent, type Dispatcher } from 'undici';

let llmDispatcher: Dispatcher | undefined;

export function getLLMDispatcher(): Dispatcher {
  if (!llmDispatcher) {
    llmDispatcher = new Agent({
      keepAliveTimeout: 1,
      keepAliveMaxTimeout: 1,
      pipelining: 0,
    });
  }
  return llmDispatcher;
}

export async function closeLLMDispatcher(): Promise<void> {
  if (!llmDispatcher) return;
  const dispatcher = llmDispatcher;
  llmDispatcher = undefined;
  try {
    await dispatcher.close();
  } catch {
    // 关闭 dispatcher 失败无需影响扩展退出
  }
}

let probeDispatcher: Dispatcher | undefined;

/**
 * 「短请求」专用 dispatcher：模型列表拉取、API 协议探测等。
 *
 * 与 getLLMDispatcher 的差别是**保留正常的 keep-alive 连接复用**：
 * - getLLMDispatcher 的 keepAliveTimeout=1 是为了避免长连接流式请求复用到
 *   被网关静默丢弃的僵尸 socket；代价是每个请求都要重新做 TCP/TLS 握手。
 * - 协议探测是短平快的 POST，一次「自动获取」可能打出上百个请求
 *   （37 模型 × 3 协议 = 111 个），逐个重新握手会让耗时翻倍
 *   （实测 15.3s → 7.2s）。
 * - 探测请求本身带 AbortController 超时，即使复用到失效连接也不会无限等待。
 */
export function getProbeDispatcher(): Dispatcher {
  if (!probeDispatcher) {
    probeDispatcher = new Agent({
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 120_000,
      // 并发探测（默认 10 模型 × 3 协议）时留足连接数
      connections: 32,
    });
  }
  return probeDispatcher;
}

export async function closeProbeDispatcher(): Promise<void> {
  if (!probeDispatcher) return;
  const dispatcher = probeDispatcher;
  probeDispatcher = undefined;
  try {
    await dispatcher.close();
  } catch {
    // 关闭 dispatcher 失败无需影响扩展退出
  }
}
