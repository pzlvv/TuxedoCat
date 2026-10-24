/**
 * 主输入框禁用 / placeholder 决策（`src/webview/inputAreaState.ts`，specs/016 FR-004；
 * specs/025 FR-004），以及选项菜单锁定判定（specs/020 FR-005；specs/025 FR-005 收窄）。
 *
 * 覆盖点：三个禁用来源的判别原因与独立性——spin 只禁用 + 换 placeholder（无引导
 * 覆盖层），provider 未配置禁用 + 空 placeholder（覆盖层负责引导），非用户创建
 * （creator 为 agent 形态）禁用 + 提示文案；优先级 Spin > 非用户创建 > 未配置。
 * 非 Master 的**本地**子代理锁定提示词模式 / 联网搜索 / MCP；跨工作区派发的对话
 * （creator.workspaceId 非空）三项不锁定；Master 子代理（含 Spin 起）与普通会话不
 * 锁定。提示词模式的锁定口径更宽：跨工作区对话恒 normal（specs/025 FR-005），不提
 * 供切换入口。
 *
 * 运行方式：npm run test:all -- inputAreaState
 */

import {
  resolveInputDisabledReason,
  resolveInputPlaceholderText,
  resolvePromptModeLocked,
  resolveSessionOptionsLocked,
} from '../webview/inputAreaState';
import { createChecker, runTests } from './helpers/harness';

runTests('inputAreaState', () => {
  const { check, finish } = createChecker();
  const texts = {
    default: '输入消息',
    spin: 'Spin 模式下不响应用户输入',
    notUserCreated: '非用户创建对话无法输入',
  };
  const agentCreator = { kind: 'agent' as const, workspaceId: null, sessionId: 'p1' };
  const remoteCreator = { kind: 'agent' as const, workspaceId: 'HOST:/a', sessionId: 'origin' };

  // ── 禁用决策（判别原因）──
  check('正常态不禁用', resolveInputDisabledReason({ providerConfigured: true, workMode: 'normal', notUserCreated: false }) === null);
  check('配置未到达（null）不禁用', resolveInputDisabledReason({ providerConfigured: null, workMode: 'normal', notUserCreated: false }) === null);
  check('provider 未配置 → providerNotConfigured', resolveInputDisabledReason({ providerConfigured: false, workMode: 'normal', notUserCreated: false }) === 'providerNotConfigured');
  check('spin 模式 → spinMode（配置已就绪）', resolveInputDisabledReason({ providerConfigured: true, workMode: 'spin', notUserCreated: false }) === 'spinMode');
  check('spin 模式 → spinMode（配置未到达）', resolveInputDisabledReason({ providerConfigured: null, workMode: 'spin', notUserCreated: false }) === 'spinMode');
  // specs/025 FR-004：非用户创建的对话禁用输入，与 spin / provider 方案区分
  check('非用户创建 → notUserCreated', resolveInputDisabledReason({ providerConfigured: true, workMode: 'normal', notUserCreated: true }) === 'notUserCreated');
  check('优先级：spin > 非用户创建', resolveInputDisabledReason({ providerConfigured: true, workMode: 'spin', notUserCreated: true }) === 'spinMode');
  check('优先级：非用户创建 > 未配置', resolveInputDisabledReason({ providerConfigured: false, workMode: 'normal', notUserCreated: true }) === 'notUserCreated');

  // ── placeholder 文案 ──
  check('可输入用默认文案', resolveInputPlaceholderText(null, texts) === texts.default);
  check('provider 未配置用空串（引导交给覆盖层）', resolveInputPlaceholderText('providerNotConfigured', texts) === '');
  check('spin 用 spin 提示文案', resolveInputPlaceholderText('spinMode', texts) === texts.spin);
  check('非用户创建用提示文案（specs/025 FR-004）', resolveInputPlaceholderText('notUserCreated', texts) === texts.notUserCreated);

  // ── 选项菜单锁定（specs/020 FR-005；specs/025 FR-005 收窄为仅本地子代理）──
  check('explorer 本地子代理锁定', resolveSessionOptionsLocked({ subAgentRole: 'Explorer', creator: agentCreator }) === true);
  check('explorer 跨工作区对话不锁定（联网 / MCP 全量继承，specs/025 FR-005）', resolveSessionOptionsLocked({ subAgentRole: 'Explorer', creator: remoteCreator }) === false);
  check('creator 未到达时保守锁定', resolveSessionOptionsLocked({ subAgentRole: 'Explorer' }) === true);
  check('Master 子代理不锁定', resolveSessionOptionsLocked({ subAgentRole: 'Master', creator: agentCreator }) === false);
  check('普通会话（无 role）不锁定', resolveSessionOptionsLocked({ subAgentRole: null }) === false);
  check('role 未到达（undefined）不锁定', resolveSessionOptionsLocked({}) === false);
  check('判据按「非 Master」而非逐角色列举（将来新角色无需改 UI）', resolveSessionOptionsLocked({ subAgentRole: 'future-role', creator: agentCreator }) === true);

  // ── 提示词模式锁定（specs/025 FR-005：跨工作区对话恒 normal）──
  check('explorer 本地子代理提示词模式随三项锁定', resolvePromptModeLocked({ subAgentRole: 'Explorer', creator: agentCreator }) === true);
  check('explorer 跨工作区对话提示词模式锁定（恒 normal，specs/025 FR-005）', resolvePromptModeLocked({ subAgentRole: 'Explorer', creator: remoteCreator }) === true);
  check('Master 跨工作区对话提示词模式锁定', resolvePromptModeLocked({ subAgentRole: 'Master', creator: remoteCreator }) === true);
  check('Master 本地子代理提示词模式不锁定（specs/020 继承口径）', resolvePromptModeLocked({ subAgentRole: 'Master', creator: agentCreator }) === false);
  check('普通会话提示词模式不锁定', resolvePromptModeLocked({ subAgentRole: null }) === false);
  check('creator 未到达时按本地口径（Master 不锁定，事实到达后锁）', resolvePromptModeLocked({ subAgentRole: 'Master' }) === false);

  finish();
});
