/**
 * 协议探测的默认响应判定（三态）。
 *
 * 三种协议的探测响应形状高度相似，判定规则也一致，因此抽出为共享默认实现，
 * 由各协议类在 classifyProbeResponse 中复用；个别协议若需要不同的判定规则，
 * 在自己的类里覆盖即可。
 *
 * 需要区分三种形状相近、含义完全不同的响应体：
 *   1. 网关自身信封：{"type":"error","error":{"type":"ModelError"|"AuthError"|"RegionError"|"error"|...}}
 *      → 与协议无关的拒绝（模型不支持该格式 / 鉴权 / 地区限制 / 内部错误）
 *   2. 上游错误被网关包一层：{"model":"X","error":{...}} 或 {"error":{...}}
 *      → 请求已经路由到该协议的上游，说明该协议**可用**
 *        （例如 gpt-5.6-luna 的 Responses 返回 403 地区限制，恰恰证明 Responses 路由通了）
 *   3. 上游标准错误（Anthropic 风格）被网关原样透传：
 *      {"type":"error","error":{"type":"invalid_request_error"|"authentication_error"|...}}
 *      → 同样说明请求到达了上游
 */

import type { ProbeVerdict } from './Types.js';

/** 网关自身产生的、明确表示「该协议不可用」的错误类型 */
const GATEWAY_REJECT_TYPES = new Set([
  'ModelError',
  'AuthError',
  'MissingSessionID',
  'CreditsError',
  'error',
]);

/** 网关自身产生的、与协议无关（无法判断）的错误类型 */
const GATEWAY_UNKNOWN_TYPES = new Set(['RegionError']);

/**
 * 判定一次探测响应的含义（三态）。
 *
 * @param status HTTP 状态码
 * @param text   响应体文本
 */
export function classifyProbeResponse(status: number, text: string): ProbeVerdict {
  let payload: any;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = undefined;
  }

  if (payload && typeof payload === 'object') {
    const isGatewayEnvelope = payload.type === 'error'
      && payload.error && typeof payload.error === 'object';
    if (isGatewayEnvelope) {
      const errType = typeof payload.error.type === 'string' ? payload.error.type : '';
      if (GATEWAY_REJECT_TYPES.has(errType)) {
        // 模型不支持该格式 / 鉴权失败 / 网关内部 500（适配器崩溃）
        return 'unsupported';
      }
      if (GATEWAY_UNKNOWN_TYPES.has(errType)) {
        // 地区限制等，与协议无关 → 无法判断
        return 'unknown';
      }
      // 其余是上游业务错误（invalid_request_error 等）被网关原样透传：已到达真实上游
      return status === 400 || status === 422 ? 'supported' : 'unknown';
    }

    // 上游错误被网关包了一层（可能带顶层 model 字段）→ 已路由到该协议的上游
    if (payload.error && typeof payload.error === 'object') {
      return 'supported';
    }
  }

  // 无错误体：按状态码兜底
  //   400/422 → 上游入参校验拒绝（body 缺必填字段）→ 端点存在，支持
  //   2xx     → 理论上不会发生（body 非法），保守视为支持
  //   404/405 → 端点不存在 → 不支持
  //   401/403/其它 5xx → 无法判断
  if (status === 400 || status === 422) return 'supported';
  if (status >= 200 && status < 300) return 'supported';
  if (status === 404 || status === 405) return 'unsupported';
  return 'unknown';
}
