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
