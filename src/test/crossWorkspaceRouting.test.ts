/**
 * 跨工作区派发目标解析用例（specs/023 FR-002）：
 * 等于来源工作区 → 本机；未命中 / 歧义 → 错误；唯一命中 → 目标工作区。
 *
 * 运行方式：npm run test:all -- cross-workspace-routing
 */

import { resolveCrossWorkspaceTarget } from '../host/crossWorkspaceRouting';
import { workspaceAgentId } from '../host/workspaceIdentity';
import { localWorkspaceRef, remoteWorkspaceRef, type WorkspaceEndpoint } from '../host/workspaceRef';
import { createChecker, runTests } from './helpers/harness';

function endpoint(host: string, port: number, user = 'root'): WorkspaceEndpoint {
  return { host, port, user, auth: { kind: 'sshPassword', password: 'pw' } };
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  const origin = localWorkspaceRef('D:/repo/a');
  const sibling = localWorkspaceRef('D:/repo/b');
  const remote = remoteWorkspaceRef(endpoint('192.168.1.10', 22), '/srv/app');
  const refs = [origin, sibling, remote];
  // 本地身份经 workspaceAgentId 派生（生产调用方同一口径）：本地路径按宿主口径规范化，
  // 平台相关——夹具不能手写路径形态（Windows 上规范化成反斜杠、Linux 保持原样）
  const originId = workspaceAgentId(origin, 'DEV-PC');
  const siblingId = workspaceAgentId(sibling, 'DEV-PC');
  const missingId = workspaceAgentId(localWorkspaceRef('D:/repo/nope'), 'DEV-PC');

  check(
    'target 等于来源工作区 → local',
    resolveCrossWorkspaceTarget(refs, origin, originId, 'DEV-PC').kind === 'local',
  );
  check(
    'target 未打开 → missing',
    resolveCrossWorkspaceTarget(refs, origin, missingId, 'DEV-PC').kind === 'missing',
  );

  const ambiguousRefs = [
    remote,
    remoteWorkspaceRef(endpoint('192.168.1.10', 22, 'other'), '/srv/app'),
  ];
  check(
    '同一身份多项 → ambiguous',
    resolveCrossWorkspaceTarget(
      ambiguousRefs,
      origin,
      '192.168.1.10:/srv/app',
      'DEV-PC',
    ).kind === 'ambiguous',
  );

  const hit = resolveCrossWorkspaceTarget(refs, origin, siblingId, 'DEV-PC');
  check('唯一命中 → 目标工作区', hit.kind === 'target' && hit.ref === sibling);

  const remoteHit = resolveCrossWorkspaceTarget(refs, origin, '192.168.1.10:/srv/app', 'DEV-PC');
  check('远程身份命中 → 远程工作区', remoteHit.kind === 'target' && remoteHit.ref === remote);

  finish();
}

runTests('cross-workspace-routing', run);
