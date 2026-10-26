/**
 * 跨工作区传输的两端解析与守卫矩阵（specs/028 FR-002）：
 * 缺省端 = 来源工作区；身份未命中 / 歧义报错；两端同工作区报错（仅跨工作区）；
 * 两端都不是来源报错（至少一端是本对话）。
 *
 * 运行方式：npm run test:all -- crossWorkspaceTransfer
 */

import { resolveTransferEnds } from '../host/crossWorkspaceRouting';
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
  const otherRemote = remoteWorkspaceRef(endpoint('192.168.1.11', 22), '/srv/other');
  const refs = [origin, sibling, remote, otherRemote];
  const machine = 'DEV-PC';
  // 本地身份经 workspaceAgentId 派生（生产调用方同一口径）：本地路径按宿主口径规范化，
  // 平台相关——夹具不能手写路径形态（Windows 上规范化成反斜杠、Linux 保持原样）
  const originId = workspaceAgentId(origin, machine);
  const siblingId = workspaceAgentId(sibling, machine);
  const missingId = workspaceAgentId(localWorkspaceRef('D:/repo/nope'), machine);
  const remoteId = '192.168.1.10:/srv/app';
  const otherRemoteId = '192.168.1.11:/srv/other';

  // ── 合法形态：缺省源 + 显式目标（AC-1）──
  const outbound = resolveTransferEnds(refs, origin, null, remoteId, machine);
  check(
    '缺省源 + 显式目标 → 两端解析',
    outbound.kind === 'ends' && outbound.sourceRef === origin && outbound.destRef === remote,
  );

  // ── 合法形态：显式源 + 缺省目标（AC-6 拉回）──
  const inbound = resolveTransferEnds(refs, origin, remoteId, null, machine);
  check(
    '显式源 + 缺省目标 → 两端解析',
    inbound.kind === 'ends' && inbound.sourceRef === remote && inbound.destRef === origin,
  );

  // ── 合法形态：显式源 = 来源身份（等价缺省）──
  const explicitSelf = resolveTransferEnds(refs, origin, originId, siblingId, machine);
  check(
    '显式源 = 来源身份 → 按缺省处理',
    explicitSelf.kind === 'ends' && explicitSelf.sourceRef === origin && explicitSelf.destRef === sibling,
  );

  // ── 守卫：两端都缺省（同工作区）──
  const bothDefault = resolveTransferEnds(refs, origin, null, null, machine);
  check(
    '两端都缺省 → 同工作区错误（提示用 Bash）',
    bothDefault.kind === 'error' && bothDefault.error.includes('use Bash (cp / mv)'),
  );

  // ── 守卫：显式同工作区 ──
  const sameEnds = resolveTransferEnds(refs, origin, siblingId, siblingId, machine);
  check(
    '两端显式同一工作区 → 错误',
    sameEnds.kind === 'error' && sameEnds.error.includes('two different workspaces'),
  );

  // ── 守卫：两端都不是本对话（AC-8）──
  const thirdParty = resolveTransferEnds(refs, origin, remoteId, otherRemoteId, machine);
  check(
    '两端都不是来源 → 错误',
    thirdParty.kind === 'error'
      && thirdParty.error === 'at least one end of a transfer must be the current conversation workspace',
  );

  // ── 守卫：身份未命中 / 歧义（AC-10）──
  const missing = resolveTransferEnds(refs, origin, null, missingId, machine);
  check(
    '目标未打开 → not open 错误',
    missing.kind === 'error' && missing.error === `target workspace is not open: ${missingId}`,
  );
  const ambiguousRefs = [
    remote,
    remoteWorkspaceRef(endpoint('192.168.1.10', 22, 'other'), '/srv/app'),
  ];
  const ambiguous = resolveTransferEnds(ambiguousRefs, origin, remoteId, null, machine);
  check(
    '同一身份多项 → ambiguous 错误',
    ambiguous.kind === 'error' && ambiguous.error === `target workspace identity is ambiguous: ${remoteId}`,
  );

  // ── 守卫：显式目标 = 来源身份 + 缺省另一端 → 同工作区错误 ──
  const selfTarget = resolveTransferEnds(refs, origin, originId, null, machine);
  check(
    '目标显式为来源 + 源缺省 → 同工作区错误',
    selfTarget.kind === 'error' && selfTarget.error.includes('two different workspaces'),
  );

  finish();
}

runTests('crossWorkspaceTransfer', run);
