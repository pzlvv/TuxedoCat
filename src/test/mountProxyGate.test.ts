/**
 * Overlay 部署闸门的状态机（specs/051 FR-003 / FR-004 / FR-008）。
 *
 * 闸门在宿主侧（判据要读 Core 的能力事实），本组用例锁它对外可见的状态序列：
 * 拦截 → 确认 → 进度 → 三选一 → 失败重试（不限次数）→ 成功重发 / 取消清空。
 *
 * 运行方式：npm run test:unit -- mount-proxy-gate
 */

import assert from 'node:assert/strict';
import { CORE_MOUNT_PROXY_DIR, CORE_MOUNT_PROXY_NAME } from '../config/project.js';
import { test } from 'node:test';

import { MountProxyGate, type MountProxyGateState } from '../host/mountProxyGate.js';

const INSTALL_PATH = `${CORE_MOUNT_PROXY_DIR}/${CORE_MOUNT_PROXY_NAME}`;

function makeGate(targetHost: string | null = null): {
  gate: MountProxyGate;
  states: MountProxyGateState[];
} {
  const states: MountProxyGateState[] = [];
  const gate = new MountProxyGate({
    installPath: INSTALL_PATH,
    targetHost,
    emit: (state) => states.push(state),
  });
  return { gate, states };
}

// ───────────────────────── FR-003：拦截与确认 ─────────────────────────

test('拦截一条消息后进入 confirm，载荷带四要素所需的落点与主机', () => {
  const { gate, states } = makeGate('user@remote-host');

  gate.block({ kind: 'message', sessionId: 's1', content: 'hello' });

  assert.equal(gate.currentPhase, 'confirm');
  assert.equal(states.length, 1);
  assert.equal(states[0].phase, 'confirm');
  // 四要素里由宿主提供的两项（另两项是 i18n 固定文案）
  assert.equal(states[0].installPath, INSTALL_PATH);
  assert.equal(states[0].targetHost, 'user@remote-host');
  // 契约成员全必选：不适用用 null，不是省略
  assert.equal(states[0].failure, null);
  assert.equal(states[0].manualCommand, null);
});

test('本机部署时 targetHost 为 null（确认框不显示主机行）', () => {
  const { gate, states } = makeGate(null);

  gate.block({ kind: 'message', sessionId: 's1', content: 'hello' });

  assert.equal(states[0].targetHost, null);
});

test('取消后状态整体清空，被拦消息一并丢弃', () => {
  const { gate, states } = makeGate();

  gate.block({ kind: 'message', sessionId: 's1', content: 'hello' });
  gate.cancel();

  assert.equal(gate.currentPhase, null);
  // FR-003：取消不得重发被拦消息（会话保持空状态、消息留在输入框）
  assert.equal(gate.takeBlocked(), null);
  // AC-9：取消要推 `cancelled` 让界面收起对话框（否则界面停在 confirm）
  const last = states[states.length - 1];
  assert.equal(last.phase, 'cancelled');
});

// ───────────────────── FR-004：三选一与不限次数的重试 ─────────────────────

test('免密不可用进入 needsCredential，默认不给零密码命令', () => {
  const { gate, states } = makeGate();

  gate.block({ kind: 'message', sessionId: 's1', content: 'hello' });
  gate.confirmDeploy();
  gate.requireCredential('sudo /path --install');

  const last = states[states.length - 1];
  assert.equal(last.phase, 'needsCredential');
  // 用户还没选「显示命令自己执行」，命令不下发（避免一上来就是手动通道）
  assert.equal(last.manualCommand, null);
});

test('用户选择「显示命令自己执行」后才下发完整命令', () => {
  const { gate, states } = makeGate();
  const command = 'sudo /opt/proxy --install';

  gate.block({ kind: 'message', sessionId: 's1', content: 'hello' });
  gate.confirmDeploy();
  gate.requireCredential(command);
  gate.showManualCommand(command);

  const last = states[states.length - 1];
  assert.equal(last.phase, 'needsCredential');
  assert.equal(last.manualCommand, command);
});

test('失败态带原因，仍可确认重试（不限次数）', () => {
  const { gate, states } = makeGate();

  gate.block({ kind: 'message', sessionId: 's1', content: 'hello' });
  gate.confirmDeploy();
  gate.beginCredentialAttempt();
  gate.fail('Sorry, try again.');

  const last = states[states.length - 1];
  assert.equal(last.phase, 'failed');
  assert.equal(last.failure, 'Sorry, try again.');
  // 契约里没有剩余次数：能试几次由服务端策略决定，宿主不替用户设闸门
  assert.ok(!('attemptsLeft' in last));

  // 失败态可以再次确认（重试路径）
  gate.confirmDeploy();
  assert.equal(gate.currentPhase, 'running');
});

test('连试多次失败后仍可继续重试，没有次数上限', () => {
  const { gate, states } = makeGate();

  gate.block({ kind: 'message', sessionId: 's1', content: 'hello' });
  gate.confirmDeploy();

  for (let attempt = 0; attempt < 10; attempt += 1) {
    gate.beginCredentialAttempt();
    gate.fail(`失败第 ${attempt + 1} 次`);
    assert.equal(gate.currentPhase, 'failed');
    gate.confirmDeploy();
    assert.equal(gate.currentPhase, 'running');
  }

  // 每次失败都带这次的原因，且始终没有「停手」这一态
  const failures = states.filter((s) => s.phase === 'failed');
  assert.equal(failures.length, 10);
  assert.equal(failures[failures.length - 1].failure, '失败第 10 次');
});

// ───────────────────────── FR-008：成功与重发 ─────────────────────────

test('成功进入 done，被拦消息可被取走重发（只取一次）', () => {
  const { gate, states } = makeGate();

  gate.block({ kind: 'message', sessionId: 's1', content: 'hello' });
  gate.confirmDeploy();
  gate.succeed();

  assert.equal(states[states.length - 1].phase, 'done');
  const blocked = gate.takeBlocked();
  assert.equal(blocked?.sessionId, 's1');
  assert.equal(blocked?.kind === 'message' ? blocked.content : null, 'hello');
  // 取走即清空：避免同一条消息被重发两次
  assert.equal(gate.takeBlocked(), null);
});

test('重复拦截新消息时重置手动通道标志', () => {
  const { gate } = makeGate();

  gate.block({ kind: 'message', sessionId: 's1', content: 'first' });
  gate.confirmDeploy();
  gate.requireCredential('sudo /opt/proxy --install');
  gate.showManualCommand('sudo /opt/proxy --install');
  gate.fail('nope');

  // 新的一条消息重新开始（FR-003：每次首条消息各自走一遍确认）
  gate.block({ kind: 'message', sessionId: 's2', content: 'second' });
  assert.equal(gate.currentPhase, 'confirm');
  assert.equal(
    gate.takeBlocked()?.kind === 'message' ? 'second' : null,
    'second',
  );
});

test('打开对话的拦截项没有消息内容（取消时无可回填）', () => {
  const { gate } = makeGate();

  gate.block({ kind: 'openConversation', sessionId: 's1' });
  // 取消路径据此判断是否回填输入框：openConversation 不带 content
  const blocked = gate.peekBlocked();
  assert.equal(blocked?.kind, 'openConversation');
  assert.equal(blocked !== null && 'content' in blocked, false);

  gate.cancel();
  assert.equal(gate.currentPhase, null);
  assert.equal(gate.peekBlocked(), null);
});
