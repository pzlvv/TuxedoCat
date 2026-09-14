/**
 * OpenAI 协议（Chat Completions）：POST {baseURL}/v1/chat/completions
 *
 * 探测 body 故意不携带必填的 messages，请求会在上游入参校验阶段被拒，
 * 正常情况下不会进入推理；max_tokens = 1 作为兜底封顶。
 */

import { joinV1Path } from '../shared.js';
import type { ApiType, ApiTypeDefinition, ApiTypeProbeContext, ApiTypeProbeRequest, ProbeVerdict } from './Types.js';
import { classifyProbeResponse } from './ProbeClassify.js';

export class OpenAiApiType implements ApiTypeDefinition {
  readonly type: ApiType = 'OpenAI';
  readonly probePriority = 1;

  buildProbeRequest(ctx: ApiTypeProbeContext): ApiTypeProbeRequest {
    return {
      url: joinV1Path(ctx.baseURL, 'chat/completions'),
      headers: { 'Authorization': `Bearer ${ctx.apiKey}` },
      // 缺少必填的 messages → 上游入参校验必失败；max_tokens 兜底封顶
      body: { model: ctx.model, max_tokens: 1 },
    };
  }

  classifyProbeResponse(status: number, text: string): ProbeVerdict {
    return classifyProbeResponse(status, text);
  }
}
