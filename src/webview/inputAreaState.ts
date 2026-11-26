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
  /**
   * 是否有一次提交已上行、还没拿到裁决（specs/059 FR-004）。
   *
   * 未决期间输入区只读：同一时刻只能有一条提交在飞。裁决返回后自动解除——它是
   * 瞬时等待态，不是会话状态，因此不落在 placeholder 上（沿用默认文案，不额外说明）。
   */
  submitPending: boolean;
}

/** 输入禁用的判别原因（specs/025 FR-004：与 spin / 未配置服务商方案区分） */
export type InputDisabledReason = 'providerNotConfigured' | 'spinMode' | 'conversationEnded' | 'submitPending';

/**
 * 输入禁用原因；`null` = 可输入。
 * 优先级沿用既有次序并在其后插入（specs/025 FR-004；specs/059 FR-004）：Spin >
 * 非用户创建已结束 > 未配置服务商 > 提交未决。
 *
 * 「提交未决」排在最后：它只在用户刚刚按下发送、等裁决的瞬间成立，且此时前面几项
 * 早已判定过（能按下发送说明当时可输入）。放在最后避免它的 placeholder 覆盖更重要的
 * 会话级说明。
 */
export function resolveInputDisabledReason(facts: InputAreaDisableFacts): InputDisabledReason | null {
  if (facts.workMode === 'spin') return 'spinMode';
  if (facts.notUserCreated && facts.sessionEnded) return 'conversationEnded';
  if (facts.providerConfigured === false) return 'providerNotConfigured';
  if (facts.submitPending) return 'submitPending';
  return null;
}

/**
 * placeholder 文案按禁用原因选择：spin / 非用户创建已结束换提示文案，provider 未配置
 * 取空串（引导由覆盖层负责，specs/016 FR-004），提交未决与可输入都取默认文案——它是
 * 瞬时等待态，不值得换文案（换文案会让用户以为出了状况）。
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
 * **本地**子代理锁定联网搜索 / MCP 两项——core 侧对本地非 Master 角色固定不联网 /
 * 无 MCP，UI 不提供入口。跨工作区派发的对话继承创建者配置、不按角色固定
 * （specs/025 FR-005），本两项锁定不适用。creator 尚未到达时按本地口径处理
 * （保守：锁定）。
 */
export function resolveSessionOptionsLocked(facts: SessionOptionsLockFacts): boolean {
  const role = facts.subAgentRole;
  if (role === undefined || role === null || role === 'Master') return false;
  const remoteDispatched = facts.creator?.kind === 'agent' && facts.creator.workspaceId !== null;
  return !remoteDispatched;
}

