/**
 * 主输入框禁用 / placeholder 决策（`src/webview/inputAreaState.ts`，specs/016 FR-004），
 * 以及选项菜单锁定判定（specs/020 FR-005）。
 *
 * 覆盖点：provider 未配置与 spin 模式两个禁用来源的独立性——
 * spin 只禁用 + 换 placeholder（无引导覆盖层），provider 未配置禁用 + 空 placeholder
 * （覆盖层负责引导）；非 Master 子代理会话锁定提示词模式 / 联网搜索 / MCP，
 * Master 子代理（含 Spin 起）与普通会话不锁定。
 *
 * 运行方式：npm run test:all -- inputAreaState
 */

import { resolveInputDisabled, resolveInputPlaceholder, resolveSessionOptionsLocked } from '../webview/inputAreaState';
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

  // ── 选项菜单锁定（specs/020 FR-005）──
  check('explorer 子代理锁定', resolveSessionOptionsLocked({ subAgentRole: 'Explorer' }) === true);
  check('Master 子代理不锁定', resolveSessionOptionsLocked({ subAgentRole: 'Master' }) === false);
  check('普通会话（无 role）不锁定', resolveSessionOptionsLocked({ subAgentRole: null }) === false);
  check('role 未到达（undefined）不锁定', resolveSessionOptionsLocked({}) === false);
  check('判据按「非 Master」而非逐角色列举（将来新角色无需改 UI）', resolveSessionOptionsLocked({ subAgentRole: 'future-role' }) === true);

  finish();
});
