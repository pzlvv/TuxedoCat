/**
 * PRODUCT_NAME CLI - 单次执行模式
 *
 * 用法:
 *   ${COMMAND_PREFIX} ask "你的问题"
 *   ANTHROPIC_API_KEY=xxx ${COMMAND_PREFIX} ask "你的问题"
 *   node dist/cli/index.js "你的问题"
 */

import { COMMAND_PREFIX } from '../config/project.js';
import { setGlobalUI } from '../core/AssistantUI.js';
import { QueryEngine } from '../core/QueryEngine.js';
import { getAllTools } from '../core/tools/index.js';
import { logger, setLogCallback } from '../core/Logger.js';
import { CLIUI } from './CliUI.js';
import {
  ensureConfigDirs,
  setProjectRootProvider,
  setExtensionPathProvider,
  getConfigHomeDir,
} from '../core/history/Config.js';
import { appendFileSync } from 'fs';
import { join } from 'path';

async function main() {
  // 解析参数：${COMMAND_PREFIX} ask "xxx" 或 ${COMMAND_PREFIX} "xxx"
  const args = process.argv.slice(2);
  const prompt = args[0] === 'ask' ? args.slice(1).join(' ') : args.join(' ');

  if (!prompt) {
    throw new Error(`Usage: ${COMMAND_PREFIX} ask "your question"`);
  }

  // 配置日志 -> 文件（不污染 stdout）
  // 同时禁用 console.log（Logger 中也会调用 console.log）
  console.log = () => {};
  console.debug = () => {};
  const logFile = join(getConfigHomeDir(), 'cli.log');
  setLogCallback((message: string) => {
    try {
      appendFileSync(logFile, message + '\n');
    } catch (e) {
      logger.error('CLI', `写日志文件失败: ${e}`);
    }
  });

  // 配置基础设施
  setProjectRootProvider(() => process.cwd());
  setExtensionPathProvider(() => process.cwd());

  // 确保配置目录存在
  try {
    await ensureConfigDirs();
  } catch (e) {
    logger.error('CLI', `创建配置目录失败: ${e}`);
  }

  // NodeRegistry (Redis-based) removed

  // 创建 CLI UI
  const ui = new CLIUI();
  setGlobalUI(ui);

  // 创建用户消息（需提前放入 messages，供 Query 层使用）
  const userMsg = {
    type: 'user' as const,
    message: { role: 'user' as const, content: prompt },
    uuid: `user_${Date.now()}`,
    timestamp: Date.now(),
  };

  // 创建 QueryEngine（传入初始消息）
  const engine = new QueryEngine('cli-session', {
    cwd: process.cwd(),
    tools: getAllTools(),
    getAppState: () => ({}),
    setAppState: () => {},
    initialMessages: [userMsg],
    ui,
  });

  // 执行查询
  try {
    ui.onQueryBegin('cli-session');
    ui.onMessage('cli-session', { role: 'user', content: prompt });

    for await (const _ of engine.submitMessage(prompt, 'user')) {
      // 消息由 CLIUI.onMessage 处理并输出
      void _;
    }

    ui.onQueryEnd('cli-session');
  } catch (error) {
    logger.error('CLI', 'Query failed:', error);
    throw error;
  }
}

main().then(() => {
  process.exit(0);
}).catch((error) => {
  if (error instanceof Error && error.message !== 'aborted') {
    console.error('Fatal error:', error);
  }
  process.exit(1);
});
