/**
 * SubAgentRegistry - 子代理实例注册表
 * 管理所有活跃的子代理实例，支持 Reply 工具向创建者投递消息
 */

import type { QueryEngine } from '../../QueryEngine.js';
import type { ToolUseContext } from '../Tool.js';
import { logger } from '../../Logger.js';
import { markSessionSubAgent } from '../../sessionRuntime.js';

export interface SubAgentRecord {
  id: string;
  engine: QueryEngine;
  creatorContext: ToolUseContext;
  creatorSessionId: string;
  /** 创建时间戳 */
  createdAt: number;
}

class SubAgentRegistryImpl {
  private agents = new Map<string, SubAgentRecord>();

  register(id: string, engine: QueryEngine, context: ToolUseContext, creatorSessionId: string): void {
    this.agents.set(id, {
      id,
      engine,
      creatorContext: context,
      creatorSessionId,
      createdAt: Date.now(),
    });
    logger.info('SubAgentRegistry', `Registered sub-agent: ${id} (creator: ${creatorSessionId})`);
    // 父会话据此算「非空闲」：子代理在跑时父会话的 abort 按钮要可用。
    // 父会话自己消费队列时 query 来源也会为真；spin 模式下父会话不消费队列，
    // 只有这个来源能反映「子代理还在跑」。
    this.syncCreatorState(creatorSessionId);
  }

  get(id: string): SubAgentRecord | undefined {
    return this.agents.get(id);
  }

  /** 移除并清理子代理 */
  unregister(id: string): void {
    const creatorSessionId = this.agents.get(id)?.creatorSessionId;
    this.agents.delete(id);
    logger.info('SubAgentRegistry', `Unregistered sub-agent: ${id}`);
    if (creatorSessionId) this.syncCreatorState(creatorSessionId);
  }

  /** 按「该创建者是否还有活跃子代理」同步 sessionRuntime 的 subagent 事实 */
  private syncCreatorState(creatorSessionId: string): void {
    markSessionSubAgent(creatorSessionId, this.hasActiveForCreator(creatorSessionId));
  }

  /** 获取所有活跃子代理 ID */
  list(): string[] {
    return Array.from(this.agents.keys());
  }

  /** 检查指定 creatorSessionId 是否有活跃的子代理 */
  hasActiveForCreator(creatorSessionId: string): boolean {
    for (const record of this.agents.values()) {
      if (record.creatorSessionId === creatorSessionId) {
        return true;
      }
    }
    return false;
  }

  /** 获取指定 creatorSessionId 的所有活跃子代理 ID 列表 */
  listForCreator(creatorSessionId: string): string[] {
    const ids: string[] = [];
    for (const [id, record] of this.agents.entries()) {
      if (record.creatorSessionId === creatorSessionId) {
        ids.push(id);
      }
    }
    return ids;
  }
}

export const subAgentRegistry = new SubAgentRegistryImpl();
