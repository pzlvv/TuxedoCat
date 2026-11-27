/**
 * 主输入框禁用 / placeholder 决策（`src/webview/inputAreaState.ts`，specs/016 FR-004；
 * specs/025 FR-004），以及选项菜单锁定判定（specs/020 FR-005；specs/025 FR-005 收窄）。
 *
 * 覆盖点：禁用来源的判别原因与独立性——spin 只禁用 + 换 placeholder（无引导
 * 覆盖层），provider 未配置禁用 + 空 placeholder（覆盖层负责引导），非用户创建
 * 且已结束禁用 + 「对话已结束」提示；非用户创建的会话**运行中可输入**
 * （docs/features/user-message-pipeline.md 第 3.3 节），快照未到达按已结束处理
 * （宁禁勿放）；优先级 Spin > 对话已结束 > 未配置。
 * 非 Master 的**本地**子代理锁定联网搜索 / MCP；跨工作区派发的对话
 * （creator.workspaceId 非空）两项不锁定；Master 子代理（含 Spin 起）与普通会话不
 * 锁定。
 *
 * 运行方式：npm run test:all -- inputAreaState
 */

import {
  resolveInputDisabledReason,
  resolveInputPlaceholderText,
  resolveSessionOptionsLocked,
} from '../webview/inputAreaState';
import { createChecker, runTests } from './helpers/harness';

runTests('inputAreaState', () => {
  const { check, finish } = createChecker();
  const texts = {
    default: '输入消息',
    spin: 'Spin 模式下不响应用户输入',
    conversationEnded: '对话已结束',
  };
  const agentCreator = { kind: 'agent' as const, workspaceId: null, sessionId: 'p1' };
  const remoteCreator = { kind: 'agent' as const, workspaceId: 'HOST:/a', sessionId: 'origin' };

  // ── 禁用决策（判别原因）──
  check('正常态不禁用', resolveInputDisabledReason({ providerConfigured: true, workMode: 'normal', notUserCreated: false, sessionEnded: true, submitPending: false }) === null);
  check('配置未到达（null）不禁用', resolveInputDisabledReason({ providerConfigured: null, workMode: 'normal', notUserCreated: false, sessionEnded: true, submitPending: false }) === null);
  check('provider 未配置 → providerNotConfigured', resolveInputDisabledReason({ providerConfigured: false, workMode: 'normal', notUserCreated: false, sessionEnded: true, submitPending: false }) === 'providerNotConfigured');
  check('spin 模式 → spinMode（配置已就绪）', resolveInputDisabledReason({ providerConfigured: true, workMode: 'spin', notUserCreated: false, sessionEnded: true, submitPending: false }) === 'spinMode');
  check('spin 模式 → spinMode（配置未到达）', resolveInputDisabledReason({ providerConfigured: null, workMode: 'spin', notUserCreated: false, sessionEnded: true, submitPending: false }) === 'spinMode');
  // 非用户创建的会话只在**已结束**后禁用：运行中可输入（忙时走排队语义）
  check('非用户创建 + 运行中 → 可输入', resolveInputDisabledReason({ providerConfigured: true, workMode: 'normal', notUserCreated: true, sessionEnded: false, submitPending: false }) === null);
  check('非用户创建 + 已结束 → conversationEnded', resolveInputDisabledReason({ providerConfigured: true, workMode: 'normal', notUserCreated: true, sessionEnded: true, submitPending: false }) === 'conversationEnded');
  // 「已结束」只作用于非用户创建的会话：用户创建的空闲会话照常可输入
  check('用户创建 + 已结束 → 不禁用', resolveInputDisabledReason({ providerConfigured: true, workMode: 'normal', notUserCreated: false, sessionEnded: true, submitPending: false }) === null);
  check('优先级：spin > 对话已结束', resolveInputDisabledReason({ providerConfigured: true, workMode: 'spin', notUserCreated: true, sessionEnded: true, submitPending: false }) === 'spinMode');
  check('优先级：对话已结束 > 未配置', resolveInputDisabledReason({ providerConfigured: false, workMode: 'normal', notUserCreated: true, sessionEnded: true, submitPending: false }) === 'conversationEnded');
  // 提交未决（specs/059 FR-004）：一次只允许一条提交在飞
  check(
    '提交未决 → submitPending（其余条件都满足可输入）',
    resolveInputDisabledReason({ providerConfigured: true, workMode: 'normal', notUserCreated: false, sessionEnded: true, submitPending: true }) === 'submitPending',
  );
  check(
    '裁决返回（submitPending 转 false）即恢复可输入',
    resolveInputDisabledReason({ providerConfigured: true, workMode: 'normal', notUserCreated: false, sessionEnded: true, submitPending: false }) === null,
  );
  check(
    '优先级：会话级说明 > 提交未决（不覆盖「对话已结束」）',
    resolveInputDisabledReason({ providerConfigured: true, workMode: 'normal', notUserCreated: true, sessionEnded: true, submitPending: true }) === 'conversationEnded',
  );

  // ── placeholder 文案 ──
  check('可输入用默认文案', resolveInputPlaceholderText(null, texts) === texts.default);
  check('provider 未配置用空串（引导交给覆盖层）', resolveInputPlaceholderText('providerNotConfigured', texts) === '');
  check('spin 用 spin 提示文案', resolveInputPlaceholderText('spinMode', texts) === texts.spin);
  check('对话已结束用结束文案（US-51 / US-56）', resolveInputPlaceholderText('conversationEnded', texts) === texts.conversationEnded);
  // 提交未决是瞬时等待态，不换文案（换了会让用户以为出了状况）
  check('提交未决沿用默认文案', resolveInputPlaceholderText('submitPending', texts) === texts.default);

  // ── 选项菜单锁定（specs/020 FR-005；specs/025 FR-005 收窄为仅本地子代理）──
  check('explorer 本地子代理锁定', resolveSessionOptionsLocked({ subAgentRole: 'Explorer', creator: agentCreator }) === true);
  check('explorer 跨工作区对话不锁定（联网 / MCP 全量继承，specs/025 FR-005）', resolveSessionOptionsLocked({ subAgentRole: 'Explorer', creator: remoteCreator }) === false);
  check('creator 未到达时保守锁定', resolveSessionOptionsLocked({ subAgentRole: 'Explorer' }) === true);
  check('Master 子代理不锁定', resolveSessionOptionsLocked({ subAgentRole: 'Master', creator: agentCreator }) === false);
  check('普通会话（无 role）不锁定', resolveSessionOptionsLocked({ subAgentRole: null }) === false);
  check('role 未到达（undefined）不锁定', resolveSessionOptionsLocked({}) === false);
  check('判据按「非 Master」而非逐角色列举（将来新角色无需改 UI）', resolveSessionOptionsLocked({ subAgentRole: 'future-role', creator: agentCreator }) === true);

  finish();
});
