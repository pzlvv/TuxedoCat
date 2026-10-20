/**
 * 主输入框禁用 / placeholder 决策（`src/webview/inputAreaState.ts`，specs/016 FR-004）。
 *
 * 覆盖点：provider 未配置与 spin 模式两个禁用来源的独立性——
 * spin 只禁用 + 换 placeholder（无引导覆盖层），provider 未配置禁用 + 空 placeholder
 * （覆盖层负责引导）。
 *
 * 运行方式：npm run test:all -- inputAreaState
 */

import { resolveInputDisabled, resolveInputPlaceholder } from '../webview/inputAreaState';
import { createChecker, runTests } from './helpers/harness';

runTests('inputAreaState', () => {
  const { check, finish } = createChecker();
  const texts = { default: '输入消息', spin: 'Spin 模式下不响应用户输入' };

  // ── 禁用决策 ──
  check('正常态不禁用', resolveInputDisabled({ providerConfigured: true, workMode: 'normal' }) === false);
  check('配置未到达（null）不禁用', resolveInputDisabled({ providerConfigured: null, workMode: 'normal' }) === false);
  check('provider 未配置禁用', resolveInputDisabled({ providerConfigured: false, workMode: 'normal' }) === true);
  check('spin 模式禁用（配置已就绪）', resolveInputDisabled({ providerConfigured: true, workMode: 'spin' }) === true);
  check('spin 模式禁用（配置未到达）', resolveInputDisabled({ providerConfigured: null, workMode: 'spin' }) === true);

  // ── placeholder 三态 ──
  check('正常态用默认文案', resolveInputPlaceholder({ providerConfigured: true, workMode: 'normal' }, texts) === texts.default);
  check('provider 未配置用空串（引导交给覆盖层）', resolveInputPlaceholder({ providerConfigured: false, workMode: 'normal' }, texts) === '');
  check('spin 模式用 spin 提示文案', resolveInputPlaceholder({ providerConfigured: true, workMode: 'spin' }, texts) === texts.spin);
  check('spin 提示优先于 provider 空串', resolveInputPlaceholder({ providerConfigured: false, workMode: 'spin' }, texts) === texts.spin);

  finish();
});
