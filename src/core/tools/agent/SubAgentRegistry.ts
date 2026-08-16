/**
 * SubAgentRegistry - 子代理实例注册表
 * 管理所有活跃的子代理实例，支持 Reply 工具向创建者投递消息
 */

import type { QueryEngine } from '../../QueryEngine.js';
import type { ToolUseContext } from '../Tool.js';
import { logger } from '../../Logger.js';

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
  }

  get(id: string): SubAgentRecord | undefined {
    return this.agents.get(id);
  }

  /** 移除并清理子代理 */
  unregister(id: string): void {
    this.agents.delete(id);
    logger.info('SubAgentRegistry', `Unregistered sub-agent: ${id}`);
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
