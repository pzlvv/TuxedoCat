/**
 * 主输入框的禁用与 placeholder 决策（specs/016 FR-004；specs/025 FR-004；US-51 /
 * US-56 的输入口径见 docs/features/user-message-pipeline.md 第 3.3 节）。
 *
 * 纯函数，InputArea 与测试共用一份实现（与 `host/abortButtonState.ts` 同模式），
 * 不在组件里另写一遍 `if`。禁用来源用判别原因区分（方案区分，specs/025 FR-004）：
 * - provider 未配置：禁用 + 引导覆盖层（打开设置）；
 * - spin 模式：禁用 + placeholder 提示（会话不受理输入），无覆盖层；
 * - 非用户创建且已结束（creator 为 agent 形态 + 运行时快照 idle）：禁用 + placeholder
 *   提示「对话已结束」。非用户创建的会话**运行中可输入**（忙时走既有排队语义），
 *   Reply 检出与驱动收尾后由 core 拒收并丢弃排队消息（UI 禁用随空闲态到达）。
 */

import type { SessionCreator } from '../shared/sessionCreator';

export interface InputAreaDisableFacts {
  /** 服务商配置是否已完成（null = 尚未到达） */
  providerConfigured: boolean | null;
  /** 会话工作模式（core 事实投影） */
  workMode: 'normal' | 'spin';
  /** 会话是否非用户创建（creator 为 agent 形态；specs/025 FR-004） */
  notUserCreated: boolean;
  /**
   * 会话是否已结束（运行时快照 `idle`；快照未到达按已结束处理——不猜「可输入」，
   * 等待态宁禁勿放）。仅对非用户创建的会话参与禁用判定。
   */
  sessionEnded: boolean;
}

/** 输入禁用的判别原因（specs/025 FR-004：与 spin / 未配置服务商方案区分） */
export type InputDisabledReason = 'providerNotConfigured' | 'spinMode' | 'conversationEnded';

/**
 * 输入禁用原因；`null` = 可输入。
 * 优先级沿用既有次序并在其后插入（specs/025 FR-004）：Spin > 非用户创建已结束 >
 * 未配置服务商（引导覆盖层只属于 provider 分支，仅作用于可输入会话）。
 */
export function resolveInputDisabledReason(facts: InputAreaDisableFacts): InputDisabledReason | null {
  if (facts.workMode === 'spin') return 'spinMode';
  if (facts.notUserCreated && facts.sessionEnded) return 'conversationEnded';
  if (facts.providerConfigured === false) return 'providerNotConfigured';
  return null;
}

/**
 * placeholder 文案按禁用原因选择：spin / 非用户创建已结束换提示文案，provider 未配置
 * 取空串（引导由覆盖层负责，specs/016 FR-004），可输入取默认文案。
 */
export function resolveInputPlaceholderText(
  reason: InputDisabledReason | null,
  texts: { default: string; spin: string; conversationEnded: string },
): string {
  if (reason === 'spinMode') return texts.spin;
  if (reason === 'conversationEnded') return texts.conversationEnded;
  if (reason === 'providerNotConfigured') return '';
  return texts.default;
}

export interface SessionOptionsLockFacts {
  /**
   * 当前会话的子代理角色（`conversationLoaded.metadata.role`，meta.json 的 role 事实；
   * 普通会话为 null）。
   */
  subAgentRole?: string | null;
  /**
   * 会话创建者（specs/025 FR-002）；undefined = 尚未到达。
   * 跨工作区派发的对话（workspaceId 非空）不适用锁定。
   */
  creator?: SessionCreator | null;
}

/**
 * 选项菜单是否锁定（specs/020 FR-005；specs/025 FR-005 收窄）：非 Master 角色的
 * **本地**子代理锁定提示词模式 / 联网搜索 / MCP 三项——core 侧对本地非 Master 角色
 * 固定 normal 预设 / 不联网 / 无 MCP，UI 不提供入口。跨工作区派发的对话继承创建者
 * 配置、不按角色固定（specs/025 FR-005），本三项锁定不适用（提示词模式见
 * `resolvePromptModeLocked` 的独立锁定）。creator 尚未到达时按本地口径处理
 * （保守：锁定）。
 */
export function resolveSessionOptionsLocked(facts: SessionOptionsLockFacts): boolean {
  const role = facts.subAgentRole;
  if (role === undefined || role === null || role === 'Master') return false;
  const remoteDispatched = facts.creator?.kind === 'agent' && facts.creator.workspaceId !== null;
  return !remoteDispatched;
}

/**
 * 提示词模式选项是否锁定：本地非 Master 角色随三项锁定（specs/020 FR-005）；跨工作区
 * 派发的对话恒 normal（specs/025 FR-005——minimal / mixed 的首轮工具白名单会剥夺
 * `Reply` 生命周期设施），同样不提供切换入口。联网搜索 / MCP 不受此锁定影响。
 */
export function resolvePromptModeLocked(facts: SessionOptionsLockFacts): boolean {
  if (resolveSessionOptionsLocked(facts)) return true;
  return facts.creator?.kind === 'agent' && facts.creator.workspaceId !== null;
}
