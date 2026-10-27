/**
 * openFile 路径 → 远程工作区引用的解析纯函数（specs/defects/remote-open-file-outside-workspace.md）。
 *
 * `src/host/remoteFileResolve.ts` 按顺序做两级解析：
 * 1. 打开集合的 `/` 前缀匹配（活动项优先，ElectronUIHost 既有语义原样搬入）；
 * 2. 前缀不中时回落到「来源视图所属工作区」——远程会话的工具路径是那台机器上的
 *    POSIX 绝对路径，即使在工作区外（/etc/hosts 等）也按该视图的 endpoint 打开。
 * 无来源视图、本地视图、非 `/` 开头路径一律返回 null（维持本地语义，不猜机器）。
 *
 * 运行方式：npm run test:unit -- remote-file-resolve
 */

import { createChecker, runTests } from './helpers/harness';
import { localWorkspaceRef, remoteWorkspaceRef, type WorkspaceRef } from '../host/workspaceRef';
import { resolveRemoteFileWorkspace } from '../host/remoteFileResolve';

function endpointOf(ref: WorkspaceRef): string {
  return ref.endpoint ? `${ref.endpoint.user}@${ref.endpoint.host}` : 'local';
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  const remoteA = remoteWorkspaceRef(
    { host: 'lab-a', port: 22, user: 'pz', auth: { kind: 'sshPassword', password: 'x' } },
    '/home/pz/proj',
  );
  const remoteB = remoteWorkspaceRef(
    { host: 'lab-b', port: 22, user: 'pz', auth: { kind: 'sshPassword', password: 'x' } },
    '/home/pz/other',
  );
  const localWin = localWorkspaceRef('D:\\work\\demo');
  // refs 已按「活动项优先」排好序（宿主职责），纯函数按序取第一个命中

  // RT-2：工作区外路径 + 远程来源视图 → 该视图的 endpoint
  const outside = resolveRemoteFileWorkspace('/etc/hosts', [remoteA], remoteA);
  check('工作区外路径按来源视图解析为远程', outside !== null && endpointOf(outside.ref) === 'pz@lab-a');
  check('解析结果携带原始绝对路径', outside?.abs === '/etc/hosts');

  // RT-3：不变量
  const inRoot = resolveRemoteFileWorkspace('/home/pz/proj/src/main.ts', [remoteA, remoteB], remoteB);
  check('root 内路径仍按打开集合解析（活动项优先）', inRoot !== null && endpointOf(inRoot.ref) === 'pz@lab-a');

  const inSecondRoot = resolveRemoteFileWorkspace('/home/pz/other/x.ts', [remoteA, remoteB], remoteA);
  check('第二个远程 root 内路径命中它自己的引用', inSecondRoot !== null && endpointOf(inSecondRoot.ref) === 'pz@lab-b');

  check(
    'Windows 本地路径不判远程',
    resolveRemoteFileWorkspace('D:\\work\\demo\\src\\main.ts', [remoteA], remoteA) === null
      && resolveRemoteFileWorkspace('C:/Users/pz/x.ts', [remoteA], remoteA) === null,
  );
  check('相对路径不判远程', resolveRemoteFileWorkspace('src/main.ts', [remoteA], remoteA) === null);
  check('非字符串路径不判远程', resolveRemoteFileWorkspace(undefined as unknown as string, [remoteA], remoteA) === null);

  const localView = localWorkspaceRef('/home/pz/proj');
  check('本地来源视图的 root 外路径不判远程', resolveRemoteFileWorkspace('/etc/hosts', [localView], localView) === null);
  check('无来源视图（undefined）的 root 外路径不判远程', resolveRemoteFileWorkspace('/etc/hosts', [remoteA], undefined) === null);

  const underLocalRoot = resolveRemoteFileWorkspace('/home/pz/proj/a.ts', [localWin, localView], remoteB);
  check(
    '路径落在已打开本地 root 内但来源视图是远程时按远程解析',
    underLocalRoot !== null && endpointOf(underLocalRoot.ref) === 'pz@lab-b',
  );

  check('root 恰等路径按前缀命中', (() => {
    const hit = resolveRemoteFileWorkspace('/home/pz/proj', [remoteA], undefined);
    return hit !== null && endpointOf(hit.ref) === 'pz@lab-a';
  })());
  check('同名前缀目录不算命中（root 边界）', resolveRemoteFileWorkspace('/home/pz/proj-x/a.ts', [remoteA], undefined) === null);

  finish();
}

runTests('remoteFileResolve', run);
