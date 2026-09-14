/**
 * API 协议抽象层入口。
 *
 * 每种协议一个类（一个文件），类里实现该协议的探测规则；通过 apiTypeRegistry
 * 统一注册。新增协议时实现 ApiTypeDefinition 并在此 register 即可；
 * 临时下线某协议：注释掉对应的 register 行。
 */

import { apiTypeRegistry } from './Registry.js';
import { ResponsesApiType } from './ResponsesApiType.js';
import { OpenAiApiType } from './OpenAiApiType.js';
import { AnthropicApiType } from './AnthropicApiType.js';

/** 注册内置协议（幂等：重复调用会覆盖为同一实现） */
export function registerBuiltinApiTypes(): void {
  apiTypeRegistry.register(new ResponsesApiType());
  apiTypeRegistry.register(new OpenAiApiType());
  apiTypeRegistry.register(new AnthropicApiType());
}

// 模块加载即注册内置协议，保证调用方 import 后即可直接使用。
registerBuiltinApiTypes();

export { apiTypeRegistry, ApiTypeRegistry } from './Registry.js';
export type {
  ApiTypeDefinition,
  ApiTypeProbeContext,
  ApiTypeProbeRequest,
  ProbeVerdict,
} from './Types.js';
