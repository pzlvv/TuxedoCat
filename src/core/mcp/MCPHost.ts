/**
 * MCPHost - MCP 的会话级生命周期入口
 *
 * 它不是宿主契约——没有 VSCode / Electron 两个实现，只有一个 core 侧单例。
 * 它接替了原 UIHost.onSessionOpened 的位置：MCP 的生命周期不该由 UI 决定。
 *
 * 问题（DEVELOPMENT.md 第 5.3 节）：MCP 引用绑定的是「会话被打开过」，
 * 而「会话打开 / 关闭」是 core 自己的事实。但此前 acquire 全部由宿主在
 * 「webview 打开 / 聊天视图打开」时触发，MCP 的生命周期被绑到 UI 的视图生命周期上。
 *
 * 解法：把「会话生命周期 → MCP 引用」的映射收口到 MCPHost，驱动信号全部来自 core：
 * - 会话打开：Integration.createEngine / restoreConversationEngine
 * - 会话关闭：sessionResources.releaseSessionResources / history.deleteConversation
 * - 启用列表变化：UiEvent.mcpEnabledChanged（单开关）/ mcpEnabledListChanged（整表覆盖）
 *   的 core 侧处理
 * - 宿主退出：bootstrap
 *
 * 与 McpManager 的分工：MCPHost 管「什么时候」，McpManager 管「怎么做」。
 */

import type { Tool } from '../tools/Tool.js';
import { logger } from '../Logger.js';
import { requireEventBus } from '../AssistantEventBus.js';

class DefaultMCPHost {
  /**
   * 会话被打开 → 按该会话的启用列表建立引用（幂等）。
   * acquire 可能耗时（首次拉取包、握手），后台执行不阻塞。
   */
  onSessionOpened(sessionId: string | undefined): Promise<void> {
    if (!sessionId || sessionId === 'undefined') return Promise.resolve();
    return this.enqueue(async () => {
      const { getMcpManager } = await import('./Manager.js');
      await getMcpManager().acquire(sessionId);
      // 首次打开会话时引用刚建立、server 可能还没连上；同步结束后广播事实，
      // 让 UI 重新读取运行时状态（连接中 → 已连接 / 失败）。
      await this.notifyServersChanged(sessionId);
    });
  }

  /** 会话被关闭 → 释放该会话的全部引用（归零的 server 进入延迟回收） */
  onSessionClosed(sessionId: string | undefined): Promise<void> {
    if (!sessionId || sessionId === 'undefined') return Promise.resolve();
    return this.enqueue(async () => {
      const { getMcpManager } = await import('./Manager.js');
      await getMcpManager().release(sessionId);
    });
  }

  /** 该会话的启用列表变化（勾选 / 取消 / 全局默认变更）→ 差量同步 */
  onSessionEnabledChanged(sessionId: string | undefined): Promise<void> {
    if (!sessionId || sessionId === 'undefined') return Promise.resolve();
    return this.enqueue(async () => {
      const { getMcpManager } = await import('./Manager.js');
      await getMcpManager().syncSession(sessionId);
      // 差量同步（连接 / 断开）结束后广播事实，否则 webview 会一直停在
      // 勾选时乐观更新出来的「连接中」。
      await this.notifyServersChanged(sessionId);
    });
  }

  /**
   * 广播「该会话的 MCP 服务器状态已变化」这一事实。
   *
   * 连接 / 断开是异步的：调用方 await 到本方法时 server 已处于最终状态
   * （running 或 error）。UI 收到 sessionConfigChanged(mcpEnabled) 后重新读取
   * 运行时状态并回推 `setMcpServers`，webview 才能把「连接中」收敛掉。
   */
  private async notifyServersChanged(sessionId: string): Promise<void> {
    try {
      const servers = await this.readServers(sessionId);
      requireEventBus().emitToUi({
        type: 'sessionConfigChanged',
        sessionId,
        change: {
          key: 'mcpEnabled',
          value: servers.filter((server) => server.enabled).map((server) => server.name),
        },
      });
    } catch (err) {
      logger.warn('MCPHost', `notify MCP servers changed failed: ${err}`);
    }
  }

  /** 启动时清理没有任何会话引用的残留进程 */
  async prune(): Promise<void> {
    const { getMcpManager } = await import('./Manager.js');
    await getMcpManager().prune();
  }

  /** 宿主退出：结束全部 MCP 子进程，避免留下孤儿进程 */
  shutdown(): void {
    try {
      const { getMcpManager } = require('./Manager.js') as typeof import('./Manager.js');
      getMcpManager().shutdown();
    } catch (err) {
      logger.warn('MCPHost', `shutdown failed: ${err}`);
    }
  }

  /** 当前已连接 MCP 服务器的工具（同步，供 getAllTools 使用） */
  getTools(): Tool[] {
    try {
      const { getMcpTools } = require('./Manager.js') as typeof import('./Manager.js');
      return getMcpTools();
    } catch {
      return [];
    }
  }

  /** 各服务器的运行时状态，供 UI 展示（转发 McpManager） */
  getServerStatus(): Map<string, import('./Manager.js').McpServerRuntimeStatus> {
    const { getMcpManager } = require('./Manager.js') as typeof import('./Manager.js');
    return getMcpManager().getServerStatus();
  }

  /** 读 mcp.json + 会话启用状态（转发 McpManager/Config 的读取路径，UI 面板用） */
  async readServers(sessionId?: string) {
    const { readMcpServers } = await import('./Config.js');
    return readMcpServers(sessionId);
  }

  /** 操作串行链：避免并发造成进程重复启动或状态错乱 */
  private opChain: Promise<void> = Promise.resolve();

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.opChain.then(task, task);
    this.opChain = next.catch(() => {});
    return next;
  }
}

let instance: DefaultMCPHost | null = null;

/** 获取 MCPHost 单例 */
export function getMCPHost(): DefaultMCPHost {
  if (!instance) {
    instance = new DefaultMCPHost();
  }
  return instance;
}
