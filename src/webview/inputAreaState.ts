/**
 * 主输入框的禁用与 placeholder 决策（specs/016 FR-004）。
 *
 * 纯函数，InputArea 与测试共用一份实现（与 `host/abortButtonState.ts` 同模式），
 * 不在组件里另写一遍 `if`。两个禁用来源语义不同：
 * - provider 未配置：禁用 + 引导覆盖层（打开设置）；
 * - spin 模式：禁用 + placeholder 提示（会话不受理输入），无覆盖层。
 */

export interface InputAreaDisableFacts {
  /** 服务商配置是否已完成（null = 尚未到达） */
  providerConfigured: boolean | null;
  /** 会话工作模式（core 事实投影） */
  workMode: 'normal' | 'spin';
}

/** 输入框是否禁用：provider 未配置或 spin 模式 */
export function resolveInputDisabled(facts: InputAreaDisableFacts): boolean {
  return facts.providerConfigured === false || facts.workMode === 'spin';
}

/** placeholder 三态：spin 提示 > 未配置空串（覆盖层负责引导）> 默认文案 */
export function resolveInputPlaceholder(
  facts: InputAreaDisableFacts,
  texts: { default: string; spin: string },
): string {
  if (facts.workMode === 'spin') return texts.spin;
  return facts.providerConfigured === false ? '' : texts.default;
}
