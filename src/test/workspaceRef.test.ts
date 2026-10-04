/**
 * 工作区引用用例（`docs/client-connection.md` 第 4 节）：
 * 本地 / 远程三元组、endpoint 连接目标键、展示路径与判等。
 *
 * 运行方式：npm run test:all -- workspace-ref
 */

import {
  emptyWorkspaceRef,
  isEmptyWorkspaceRef,
  localWorkspaceRef,
  remoteWorkspaceRef,
  sameWorkspaceRef,
  workspaceEndpointKey,
  workspaceRefDisplayPath,
  workspaceRefKey,
  type WorkspaceEndpoint,
} from '../host/workspaceRef';
import { createChecker, runTests } from './helpers/harness';

function endpoint(host: string, port: number, password = 'pw'): WorkspaceEndpoint {
  return { host, port, user: 'root', auth: { kind: 'sshPassword', password } };
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  const local = localWorkspaceRef('D:/repo');
  check('本地引用 scheme 为 file', local.scheme === 'file');
  check('本地引用没有 endpoint', local.endpoint === null);

  const remote = remoteWorkspaceRef(endpoint('172.20.1.5', 22), '/home/dev/repo');
  check('远程引用 scheme 为 ssh', remote.scheme === 'ssh');
  check('远程引用保留 endpoint', remote.endpoint?.host === '172.20.1.5');
  check('远程引用保留远端路径', remote.path === '/home/dev/repo');

  // 连接目标键：同一 endpoint 的多个工作区共用一个 daemon
  const remoteSibling = remoteWorkspaceRef(endpoint('172.20.1.5', 22, 'other'), '/home/dev/other');
  check('同一 endpoint 的键相同', workspaceEndpointKey(remote) === workspaceEndpointKey(remoteSibling));
  check('本地键恒为 local', workspaceEndpointKey(local) === 'local');
  check(
    '不同端口是不同 endpoint',
    workspaceEndpointKey(remote) !== workspaceEndpointKey(remoteWorkspaceRef(endpoint('172.20.1.5', 2222), '/x')),
  );
  check(
    '不同主机是不同 endpoint',
    workspaceEndpointKey(remote) !== workspaceEndpointKey(remoteWorkspaceRef(endpoint('10.0.0.1', 22), '/x')),
  );

  // 引用键与判等：endpoint 不同即不同；auth 不参与判等
  check('远程引用键区分路径', workspaceRefKey(remote) !== workspaceRefKey(remoteSibling));
  check('同一 endpoint + 同一路径判等', sameWorkspaceRef(remote, remoteWorkspaceRef(endpoint('172.20.1.5', 22, 'x'), '/home/dev/repo')));
  check('同一 endpoint + 不同路径不等', !sameWorkspaceRef(remote, remoteSibling));
  check('本地与远程不等', !sameWorkspaceRef(local, remoteWorkspaceRef(endpoint('172.20.1.5', 22), 'D:/repo')));

  // 展示路径
  check('本地展示路径就是路径', workspaceRefDisplayPath(local) === 'D:/repo' || workspaceRefDisplayPath(local).endsWith('repo'));
  check('远程展示路径带 scheme://user@host', workspaceRefDisplayPath(remote) === 'ssh://root@172.20.1.5/home/dev/repo');

  // 空引用
  check('空引用判空', isEmptyWorkspaceRef(emptyWorkspaceRef()));
  check('非空引用不为空', !isEmptyWorkspaceRef(local));

  finish();
}

runTests('workspace-ref', run);
