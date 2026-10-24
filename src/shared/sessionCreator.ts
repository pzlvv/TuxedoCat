/**
 * 会话创建者归属（specs/025 FR-002）。
 *
 * 全部会话在创建时写入 creator：用户创建（普通 prompt 发起）为 `user`；Agent 创建
 * （本地子代理 / 跨工作区派发）为 agent 形态并携带创建方工作区身份与会话 id——本地
 * 创建时 `workspaceId` 为 `null`（工作区身份算法唯一落点是宿主 `workspaceIdentity.ts`，
 * Core 不持有该事实），跨工作区派发时为发起方身份（`机器名:路径` 口径）。
 *
 * creator 是归属的唯一根事实：托盘完成抑制、未读绿灯武装、输入禁用、`Reply` 回传
 * 路由与跨工作区跳转都是它的只读投影，不得从 `parentSessionId` 等树事实反推
 * （specs/025 FR-003 / FR-004 / FR-007）。
 *
 * 本模块**零 import**：`AssistantEventBus`（快照契约）、`shared/history`（meta 读取）
 * 与 webview 镜像类型共用；webview 的构建图不含 node 类型链，这里一旦引入任何
 * 带依赖的类型就会拉断 webview tsc 程序（`sessionRuntime.ts` 文件头同款约束）。
 */

export type SessionCreator =
  | { kind: 'user' }
  | { kind: 'agent'; workspaceId: string | null; sessionId: string };

/**
 * 从 meta.json 的 `creator` 值解析（specs/025 FR-002）：缺失或形态不对是数据异常，
 * 直接抛错不回退——未发布无存量兼容义务，静默当 user 会把 Agent 会话误判成可输入 /
 * 会提醒的正常对话。
 */
export function parseSessionCreator(value: unknown): SessionCreator {
  if (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
  ) {
    const record = value as Record<string, unknown>;
    if (record['kind'] === 'user') return { kind: 'user' };
    if (
      record['kind'] === 'agent'
      && typeof record['sessionId'] === 'string'
      && record['sessionId'] !== ''
      && (record['workspaceId'] === null || typeof record['workspaceId'] === 'string')
    ) {
      return {
        kind: 'agent',
        workspaceId: record['workspaceId'] as string | null,
        sessionId: record['sessionId'],
      };
    }
  }
  throw new Error(`conversation metadata has an invalid creator: ${JSON.stringify(value)}`);
}

/** 是否 Agent 创建的会话（creator 的 agent 形态）——静默 / 输入禁用的统一判据 */
export function isAgentCreator(creator: SessionCreator): boolean {
  return creator.kind === 'agent';
}
