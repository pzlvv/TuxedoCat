/**
 * Responses 协议（OpenAI Responses API）：POST {baseURL}/v1/responses
 *
 * 探测原理：网关按「路径定协议 → 查模型是否注册该协议 → 鉴权 → 转发上游」的顺序
 * 处理。探测 body 故意不携带必填的 input，请求会在上游入参校验阶段被拒，
 * 正常情况下不会进入推理，因此不产生 completion、不消耗 token。
 * 额外带上 max_output_tokens = 1 兜底：即使后端忽略 schema 直接生成，
 * 输出也被封顶在 1 个 token。
 */

import { joinV1Path } from '../urlJoin.js';
import type { ApiType, ApiTypeDefinition, ApiTypeProbeContext, ApiTypeProbeRequest, ProbeVerdict } from './Types.js';
import { classifyProbeResponse } from './ProbeClassify.js';

export class ResponsesApiType implements ApiTypeDefinition {
  readonly type: ApiType = 'Responses';
  readonly probePriority = 0;

  buildProbeRequest(ctx: ApiTypeProbeContext): ApiTypeProbeRequest {
    return {
      url: joinV1Path(ctx.baseURL, 'responses'),
      headers: { 'Authorization': `Bearer ${ctx.apiKey}` },
      // 缺少必填的 input → 上游入参校验必失败；max_output_tokens 兜底封顶
      body: { model: ctx.model, max_output_tokens: 1 },
    };
  }

  classifyProbeResponse(status: number, text: string): ProbeVerdict {
    return classifyProbeResponse(status, text);
  }
}
