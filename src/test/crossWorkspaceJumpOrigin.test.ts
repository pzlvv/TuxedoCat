/**
 * 跨工作区占位页发起方解析用例（specs/defects/cross-workspace-placeholder-jump-always-unavailable.md）。
 *
 * 缺陷病灶：占位来源的 `workspaceId` 是代理身份口径（`workspaceAgentId` = `机器名:路径`），
 * 宿主却拿它跟 `workspaceRefKey`（如 `file//localD:\a`）判等，永不相等 → 跳转链接恒不可用。
 * 这里锁死三件事：身份口径命中返回引用、refKey 口径不是身份、未命中 / 歧义不回退路径。
 *
 * 运行方式：npm run test:all -- cross-workspace-jump-origin
 */

import { resolveCrossWorkspaceJumpOrigin, workspaceAgentId } from '../host/workspaceIdentity';
import { localWorkspaceRef, remoteWorkspaceRef, workspaceRefKey, type WorkspaceEndpoint } from '../host/workspaceRef';
import { createChecker, runTests } from './helpers/harness';

function endpoint(host: string, port: number, user = 'root'): WorkspaceEndpoint {
  return { host, port, user, auth: { kind: 'sshPassword', password: 'pw' } };
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  const machine = 'DEV-PC';
  const originRef = localWorkspaceRef('D:/repo/a');
  const sibling = localWorkspaceRef('D:/repo/b');
  const remote = remoteWorkspaceRef(endpoint('192.168.1.10', 22), '/srv/app');
  const refs = [originRef, sibling, remote];

  // 身份口径命中（侧栏占位来源的真实形态）：按 workspaceAgentId 构造，平台无关
  const identity = workspaceAgentId(originRef, machine);
  check(
    '本地发起方已打开 → 命中该引用',
    resolveCrossWorkspaceJumpOrigin(refs, machine, { workspaceId: identity, sessionId: 'session_1' }, '', undefined) === originRef,
  );
  if (process.platform === 'win32') {
    // 字面量锁定拼接口径 `机器名:规范化路径`（POSIX 下 path.resolve 会并进 cwd，字面量只对 Windows 成立）
    check(
      '身份拼接口径（Windows 字面量）',
      identity === 'DEV-PC:D:\\repo\\a',
    );
  }

  // 缺陷病灶的反向锁定：refKey 口径不是身份，不得命中
  check(
    'refKey 口径不是身份 → 不命中',
    resolveCrossWorkspaceJumpOrigin(refs, machine, { workspaceId: workspaceRefKey(originRef), sessionId: 'session_1' }, '', undefined) === null,
  );

  check(
    '远程发起方已打开 → 命中远程引用',
    resolveCrossWorkspaceJumpOrigin(refs, machine, { workspaceId: '192.168.1.10:/srv/app', sessionId: 'session_1' }, '', undefined) === remote,
  );

  check(
    '发起方未打开 → null（占位页显示链接不可用）',
    resolveCrossWorkspaceJumpOrigin(refs, machine, { workspaceId: 'DEV-PC:D:/nope', sessionId: 'session_1' }, '', undefined) === null,
  );

  const ambiguousRefs = [
    remote,
    remoteWorkspaceRef(endpoint('192.168.1.10', 22, 'other'), '/srv/app'),
  ];
  check(
    '同一身份多项（不同 SSH 用户）→ null（不取第一项）',
    resolveCrossWorkspaceJumpOrigin(ambiguousRefs, machine, { workspaceId: '192.168.1.10:/srv/app', sessionId: 'session_1' }, '', undefined) === null,
  );

  // 身份是权威：来源在但未命中时，即使回退路径可命中也不回退（回退只服务来源缺省）
  check(
    '来源在但未命中 → 不走路径回退',
    resolveCrossWorkspaceJumpOrigin(refs, machine, { workspaceId: 'DEV-PC:D:/nope', sessionId: 'session_1' }, 'session_1', 'D:/repo/a') === null,
  );

  // 来源缺省：按发起方会话工作目录回退；本地写法差异按宿主口径判等
  check(
    '来源缺省 + 回退路径命中（本地）',
    resolveCrossWorkspaceJumpOrigin(refs, machine, undefined, 'session_1', 'D:/repo/a') === originRef,
  );
  check(
    '来源缺省 + 回退路径命中（远程抹尾分隔符）',
    resolveCrossWorkspaceJumpOrigin(refs, machine, undefined, 'session_1', '/srv/app/') === remote,
  );
  check(
    '来源缺省 + 回退路径不在打开集合 → null',
    resolveCrossWorkspaceJumpOrigin(refs, machine, undefined, 'session_1', 'D:/repo/none') === null,
  );
  check(
    '来源缺省 + 回退路径缺失 → null',
    resolveCrossWorkspaceJumpOrigin(refs, machine, undefined, 'session_1', undefined) === null,
  );

  finish();
}

runTests('cross-workspace-jump-origin', run);
