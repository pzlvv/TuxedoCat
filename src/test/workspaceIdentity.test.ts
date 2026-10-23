/**
 * 工作区代理身份用例（specs/022 FR-001）：
 * 机器名取法（Windows / Linux / 回退）、本地与远程身份、候选展示名、按身份解析的歧义。
 *
 * 运行方式：npm run test:all -- workspace-identity
 */

import {
  resolveMachineName,
  resolveWorkspaceByIdentity,
  workspaceAgentDisplayName,
  workspaceAgentId,
  workspaceMentionCandidates,
} from '../host/workspaceIdentity';
import { localWorkspaceRef, remoteWorkspaceRef, type WorkspaceEndpoint } from '../host/workspaceRef';
import { createChecker, runTests } from './helpers/harness';

function endpoint(host: string, port: number, user = 'root'): WorkspaceEndpoint {
  return { host, port, user, auth: { kind: 'sshPassword', password: 'pw' } };
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // ===== 机器名 =====
  check(
    'Windows 取 COMPUTERNAME',
    resolveMachineName('win32', { COMPUTERNAME: 'DEV-PC', HOSTNAME: 'ignored' }, 'fallback') === 'DEV-PC',
  );
  check(
    'Linux 取 HOSTNAME',
    resolveMachineName('linux', { COMPUTERNAME: 'ignored', HOSTNAME: 'devbox' }, 'fallback') === 'devbox',
  );
  check(
    'Windows 缺 COMPUTERNAME 回退操作系统主机名',
    resolveMachineName('win32', {}, 'os-host') === 'os-host',
  );
  check(
    'Linux 缺 HOSTNAME 回退操作系统主机名',
    resolveMachineName('linux', {}, 'os-host') === 'os-host',
  );
  check(
    '空串环境变量按缺失处理',
    resolveMachineName('win32', { COMPUTERNAME: '   ' }, 'os-host') === 'os-host',
  );
  let threw = false;
  try {
    resolveMachineName('win32', {}, '   ');
  } catch {
    threw = true;
  }
  check('机器名解析为空抛错（不产出空身份）', threw);

  // ===== 身份 =====
  const local = localWorkspaceRef('D:/repo');
  check('本地身份 = 机器名:规范化路径', workspaceAgentId(local, 'DEV-PC') === 'DEV-PC:D:\\repo');

  const remote = remoteWorkspaceRef(endpoint('192.168.1.10', 22), '/srv/app');
  check('远程身份用 SSH 目标主机', workspaceAgentId(remote, 'DEV-PC') === '192.168.1.10:/srv/app');

  check('展示名取目录名', workspaceAgentDisplayName(remote) === 'app');
  check('展示名对本地同样取最后一级', workspaceAgentDisplayName(local) === 'repo');

  // ===== 按身份解析 =====
  const refs = [local, remote];
  const hit = resolveWorkspaceByIdentity(refs, '192.168.1.10:/srv/app', 'DEV-PC');
  check('唯一命中返回引用', hit.kind === 'match' && hit.ref === remote);
  check('未命中返回 missing', resolveWorkspaceByIdentity(refs, 'DEV-PC:C:\\nope', 'DEV-PC').kind === 'missing');

  const duplicate = remoteWorkspaceRef(endpoint('192.168.1.10', 22, 'other'), '/srv/app');
  const ambiguous = resolveWorkspaceByIdentity([remote, duplicate], '192.168.1.10:/srv/app', 'DEV-PC');
  check('同一身份对应多项返回 ambiguous（不取第一项）', ambiguous.kind === 'ambiguous');

  // ===== @ 候选（specs/022 FR-007：排除本工作区） =====
  const candidates = workspaceMentionCandidates([local, remote], local, 'DEV-PC');
  check(
    '@ 候选排除来源视图自己的工作区',
    candidates.length === 1 && candidates[0]?.id === '192.168.1.10:/srv/app',
  );
  check(
    '来源工作区解析不出时返回空候选',
    workspaceMentionCandidates([local, remote], undefined, 'DEV-PC').length === 0,
  );

  finish();
}

runTests('workspace-identity', run);
