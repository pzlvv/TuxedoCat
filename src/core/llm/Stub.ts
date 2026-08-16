/**
 * Stub LLM API - 支持 Mock 或真实 API
 * 按照 LLM API 兼容格式返回消息
 *
 * 测试模式：多轮对话 + 工具调用，模拟真实交互流程
 * - 第 1 轮：thinking + 文本 + echo 工具
 * - 第 2 轮：thinking + 文本 + date 工具
 * - 第 3 轮：最终文本回复
 * - 每条/工具间有间隔，用于测试自动滚动行为
 */

import type { Message } from '../types.js';
import { logger } from '../Logger.js';

let stubCallCount = 0;

interface ContentBlock {
  type: 'text' | 'tool_use' | 'thinking';
  [key: string]: unknown;
}

export interface StreamOptions {
  tools: unknown[]
  signal: AbortSignal | null
  onProgress?: (message: Message) => void
}

/**
 * 测试专用：模拟多轮工具调用流程
 * 用于测试自动滚动行为
 */
export async function* callModelStub(options: StreamOptions): AsyncGenerator<Message> {
  const { signal } = options;

  stubCallCount++;
  logger.info('stub', `callModelStub started (call #${stubCallCount})`);

  if (signal && signal.aborted) {
    logger.warn('stub', 'Aborted before start');
    return;
  }

  // =====================================================
  // 第 1 轮：thinking + 文本 + echo 工具
  // =====================================================
  if (stubCallCount === 1) {
    // 1a. 先发一条 thinking 消息（表示 LLM 在思考）
    logger.info('stub', '=== Round 1: yielding thinking ===');
    yield {
      type: 'assistant' as const,
      message: {
        role: 'assistant' as const,
        content: [{
          type: 'thinking',
          thinking: '好的，让我先了解当前系统环境。\n\n我需要执行几个命令来获取系统信息，然后进行分析。',
          signature: 'stub_signature_' + Date.now(),
        }],
        stop_reason: 'thinking',
      },
      uuid: generateUUID(),
      timestamp: Date.now(),
    };
    await sleep(300);

    // 1b. 中间插入两段较长的文本，模拟多段 assistant 消息
    logger.info('stub', '=== Round 1: yielding first text (long) ===');
    yield {
      type: 'assistant' as const,
      message: {
        role: 'assistant' as const,
        content: [{
          type: 'text',
          text: '我将先执行几个基本的系统检查命令。\n\n## 计划\n\n1. 首先打印 "hello" 来测试终端连接\n2. 然后检查当前系统时间\n3. 最后查看工作目录内容\n\n请稍候，我正在逐一执行这些命令...',
        } satisfies ContentBlock],
        stop_reason: 'thinking',
      },
      uuid: generateUUID(),
      timestamp: Date.now(),
    };
    await sleep(200);

    // 1c. 再发一条短文本 + tool_use（echo hello）
    logger.info('stub', '=== Round 1: yielding short text + tool_use (echo) ===');
    const toolUseId1 = generateToolUseId();
    yield {
      type: 'assistant' as const,
      message: {
        role: 'assistant' as const,
        content: [
          {
            type: 'text',
            text: '让我先执行一个简单的 echo 命令来测试终端。',
          } satisfies ContentBlock,
          {
            type: 'tool_use',
            id: toolUseId1,
            name: 'Bash',
            input: {
              command: 'echo "hello from stub"',
              description: '打印 hello 消息测试终端连接',
            },
          } satisfies ContentBlock,
        ],
        stop_reason: 'tool_use',
      },
      uuid: generateUUID(),
      timestamp: Date.now(),
    };

    logger.info('stub', `--- Round 1 complete, tool_use id: ${toolUseId1} ---`);
  }

  // =====================================================
  // 第 2 轮：thinking + 文本 + date 工具
  // =====================================================
  else if (stubCallCount === 2) {
    // 2a. thinking
    logger.info('stub', '=== Round 2: yielding thinking ===');
    yield {
      type: 'assistant' as const,
      message: {
        role: 'assistant' as const,
        content: [{
          type: 'thinking',
          thinking: 'echo 命令执行成功，终端连接正常。\n\n接下来检查系统日期和时间，看看当前的环境信息。',
          signature: 'stub_signature_' + Date.now(),
        }],
        stop_reason: 'thinking',
      },
      uuid: generateUUID(),
      timestamp: Date.now(),
    };
    await sleep(200);

    // 2b. 一段较长文本（带代码块）
    logger.info('stub', '=== Round 2: yielding text with code block ===');
    yield {
      type: 'assistant' as const,
      message: {
        role: 'assistant' as const,
        content: [{
          type: 'text',
          text: 'echo 命令返回了预期结果，终端工作正常。\n\n现在我要检查系统时间。这段文本比较长，包含了一些格式化的内容用于测试滚动行为：\n\n```\n结果分析：\n- 终端状态: 正常\n- 连接类型: 本地 Shell\n- 响应时间: 12ms\n```\n\n接下来我将执行 date 命令获取当前系统时间。',
        } satisfies ContentBlock],
        stop_reason: 'thinking',
      },
      uuid: generateUUID(),
      timestamp: Date.now(),
    };
    await sleep(200);

    // 2c. 短文本 + tool_use（date）
    logger.info('stub', '=== Round 2: yielding short text + tool_use (date) ===');
    const toolUseId2 = generateToolUseId();
    yield {
      type: 'assistant' as const,
      message: {
        role: 'assistant' as const,
        content: [
          {
            type: 'text',
            text: '现在获取系统时间。',
          } satisfies ContentBlock,
          {
            type: 'tool_use',
            id: toolUseId2,
            name: 'Bash',
            input: {
              command: 'echo %date% %time%',
              description: '获取当前系统日期和时间',
            },
          } satisfies ContentBlock,
        ],
        stop_reason: 'tool_use',
      },
      uuid: generateUUID(),
      timestamp: Date.now(),
    };

    logger.info('stub', `--- Round 2 complete, tool_use id: ${toolUseId2} ---`);
  }

  // =====================================================
  // 第 3 轮：最终回复（大段总结文本）
  // =====================================================
  else if (stubCallCount === 3) {
    // 3a. 先发一条 thinking
    logger.info('stub', '=== Round 3: yielding thinking ===');
    yield {
      type: 'assistant' as const,
      message: {
        role: 'assistant' as const,
        content: [{
          type: 'thinking',
          thinking: '所有命令已执行完毕，现在整理最终总结。',
          signature: 'stub_signature_' + Date.now(),
        }],
        stop_reason: 'thinking',
      },
      uuid: generateUUID(),
      timestamp: Date.now(),
    };
    await sleep(200);

    // 3b. 大段最终回复
    logger.info('stub', '=== Round 3: yielding final long text ===');
    yield {
      type: 'assistant' as const,
      message: {
        role: 'assistant' as const,
        content: [{
          type: 'text',
          text: `## 执行总结

所有命令已成功执行完毕。以下是完整的汇总信息：

### 1. 终端连接测试
- **命令**: \`echo "hello from stub"\`
- **结果**: ✅ 成功 - 终端连接正常
- **输出**: "hello from stub"

### 2. 系统时间
- **命令**: \`date\`
- **结果**: ✅ 成功 - 获取到系统时间

### 3. 综合分析

| 检查项 | 状态 | 备注 |
|--------|------|------|
| 终端连接 | ✅ 正常 | 响应迅速 |
| 系统时间 | ✅ 正常 | 时区配置正确 |
| Shell 环境 | ✅ 可用 | 支持标准 POSIX 命令 |

### 4. 建议

根据以上检查结果，系统运行正常，没有发现任何问题。

\`\`\`typescript
// 示例：后续可执行的自动化检查脚本
async function systemCheck() {
  const checks = [
    { name: '终端连接', command: 'echo test' },
    { name: '系统时间', command: 'date' },
    { name: '磁盘空间', command: 'df -h' },
  ];

  for (const check of checks) {
    console.log(\`正在检查: \${check.name}\`);
    // 执行检查...
  }
}
\`\`\`

> **提示**: 以上所有操作均在隔离的沙箱环境中执行，不会影响您的工作环境。

如果您需要进一步的分析或有其他问题，请随时告诉我。`,
        } satisfies ContentBlock],
        stop_reason: 'end_turn',
      },
      uuid: generateUUID(),
      timestamp: Date.now(),
    };

    logger.info('stub', '=== Round 3 complete - final response yielded ===');
  }

  // =====================================================
  // 第 4+ 轮：重置计数器
  // =====================================================
  else {
    logger.info('stub', `Reached end of cycle (call #${stubCallCount}), resetting`);
    stubCallCount = 0;
    // 递归调用开始新的循环
    yield* callModelStub(options);
    return;
  }

  logger.info('stub', `callModelStub completed (call #${stubCallCount})`);
}

/**
 * 生成 UUID
 */
function generateUUID(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * 生成工具调用 ID
 */
function generateToolUseId(): string {
  return `toolu_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

// 全局延迟服务器（复用）
const delayServer: { port: number | null } = { port: null };

// 初始化延迟服务器
async function initDelayServer(): Promise<number> {
  if (delayServer.port) {
    return delayServer.port;
  }

  const http = await import('http');

  return new Promise<number>((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      const delay = parseInt(url.searchParams.get('delay') || '0', 10);

      setTimeout(() => {
        res.writeHead(200);
        res.end('OK');
      }, delay);
    });

    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as any).port;
      delayServer.port = port;
      resolve(port);
    });
  });
}

async function sleep(ms: number): Promise<void> {
  try {
    const port = await initDelayServer();
    await fetch(`http://127.0.0.1:${port}/?delay=${ms}`);
  } catch {
    // 降级到 setTimeout
    await new Promise(resolve => setTimeout(resolve, ms));
  }
}
