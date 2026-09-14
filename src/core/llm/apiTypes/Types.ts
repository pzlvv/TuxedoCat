/**
 * API 协议（apiType）抽象层：类型定义。
 *
 * 每种协议由「一个类」实现（见 ResponsesApiType / OpenAiApiType / AnthropicApiType），
 * 类里封装该协议的探测规则（如何构建探测请求、如何判定探测响应）。
 * 通过 Registry 统一注册/注销，支持在代码层面增删协议，或临时不注册某协议。
 */

import type { ApiType } from '../../utils/modelConfig.js';

export type { ApiType };

/** 一次探测请求（由协议实现构建） */
export interface ApiTypeProbeRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** 构建探测请求所需的上下文 */
export interface ApiTypeProbeContext {
  /** 原始 baseURL（协议实现内部负责规范化） */
  baseURL: string;
  apiKey: string;
  model: string;
  /** 探测会话 ID（部分网关要求携带才路由请求） */
  sessionId: string;
}

/**
 * 单次探测的判定结果（三态）：
 * - supported   该协议可用
 * - unsupported 明确不支持 / 该协议适配器不可用
 * - unknown     无法判断（限流重试后仍失败、地区限制、网络异常）→ 不猜测
 */
export type ProbeVerdict = 'supported' | 'unsupported' | 'unknown';

/**
 * 一种 API 协议的定义。
 *
 * 实现约定：
 * - `probePriority` 数值越小越先探测（高优先级一旦有结论即中止其余探测）；
 * - `buildProbeRequest` 构建「近乎零成本」的探测请求（缺少必填字段 +
 *   输出封顶 1 token），正常情况下不会进入推理、不产生 completion；
 * - `classifyProbeResponse` 判定一次探测响应的含义（三态）。
 */
export interface ApiTypeDefinition {
  /** 协议类型（与 settings.json 的 modelConfigs[model].apiType 对应） */
  readonly type: ApiType;
  /** 探测优先级：数值越小越先探测 */
  readonly probePriority: number;
  /** 构建探测请求 */
  buildProbeRequest(ctx: ApiTypeProbeContext): ApiTypeProbeRequest;
  /** 判定一次探测响应的含义（三态） */
  classifyProbeResponse(status: number, text: string): ProbeVerdict;
}
