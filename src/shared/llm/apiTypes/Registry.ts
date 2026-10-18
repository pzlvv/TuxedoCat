/**
 * API 协议注册表。
 *
 * 支持在代码层面增删协议：
 *   - 新增：实现 ApiTypeDefinition 的类，然后 register 一个实例；
 *   - 下线：unregister(type)，或干脆不注册（探测时会自动跳过）。
 *
 * 探测时按 probePriority 升序执行（数值越小越优先）。
 */

import type { ApiType } from '../../utils/modelConfig.js';
import type { ApiTypeDefinition } from './Types.js';

export class ApiTypeRegistry {
  private readonly definitions = new Map<ApiType, ApiTypeDefinition>();

  /** 注册（或替换）一个协议定义 */
  register(definition: ApiTypeDefinition): this {
    this.definitions.set(definition.type, definition);
    return this;
  }

  /** 注销一个协议；返回是否确实删除了定义 */
  unregister(type: ApiType): boolean {
    return this.definitions.delete(type);
  }

  has(type: ApiType): boolean {
    return this.definitions.has(type);
  }

  get(type: ApiType): ApiTypeDefinition | undefined {
    return this.definitions.get(type);
  }

  /** 所有已注册协议 */
  list(): ApiTypeDefinition[] {
    return [...this.definitions.values()];
  }

  /** 按探测优先级升序排列（数值越小越先探测） */
  listByProbePriority(): ApiTypeDefinition[] {
    return this.list().sort((a, b) => a.probePriority - b.probePriority);
  }

  /** 已注册的协议类型列表 */
  types(): ApiType[] {
    return [...this.definitions.keys()];
  }
}

/** 全局协议注册表（内置协议在 ./index.ts 中注册） */
export const apiTypeRegistry = new ApiTypeRegistry();
