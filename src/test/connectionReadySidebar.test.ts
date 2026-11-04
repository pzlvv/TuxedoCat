import * as fs from 'fs';
import * as path from 'path';
import { createChecker, runTests } from './helpers/harness';
import { localWorkspaceRef, remoteWorkspaceRef, workspaceRefKey } from '../host/workspaceRef';
import { connectionReadyFileInvalidation } from '../../electron/connectionReadySidebar';

/**
 * 远程工作区重连就绪后重读侧栏文件树
 * （`specs/defects/sidebar-file-tree-stale-after-ssh-reconnect.md`）。
 *
 * 为什么这里既有纯函数断言、又有源码接线断言：
 * - RT-1 的判定本身是纯逻辑（哪个工作区在就绪时该推文件树失效），可以直接驱动；
 * - 判定与推送的接线在 `electron/ElectronUIHost.ts`——它 import `electron`，不在
 *   `tsconfig.test.json` 的可编译范围内（与本仓 `ipcChannels` / `webviewRenderInvariants`
 *   同样的静态断言口径）。删掉调用正是这个缺陷的形态（判定写好但没人调），
 *   所以接线本身必须有一条会红的用例。
 *
 * 运行方式：npm run test:unit -- connection-ready-sidebar
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');

const REMOTE = remoteWorkspaceRef(
  { host: 'lab', port: 22, user: 'pz', auth: { kind: 'sshPassword', password: 'x' } },
  '/home/pz/proj',
);
const LOCAL = localWorkspaceRef('/home/pz/local-proj');

/** 取 `ElectronUIHost.onWorkspaceConnectionReady` 的方法体（含方法签名与收尾大括号之间的原文） */
function connectionReadyMethodBody(): string | null {
  const file = path.join(REPO_ROOT, 'electron', 'ElectronUIHost.ts');
  const text = fs.readFileSync(file, 'utf8');
  const match = /onWorkspaceConnectionReady\(ref: WorkspaceRef\): void \{([\s\S]*?)\n {2}\}/.exec(text);
  return match ? match[1] : null;
}

runTests('connectionReadySidebar', () => {
  const { check, finish } = createChecker();

  // ── RT-1：判定只对远程工作区产生一个 tree 原因的失效 ──
  const remotePayload = connectionReadyFileInvalidation(REMOTE);
  check(
    '远程工作区就绪产生 tree 失效载荷',
    remotePayload !== null
      && remotePayload.workspaceId === workspaceRefKey(REMOTE)
      && remotePayload.reasons.length === 1
      && remotePayload.reasons[0] === 'tree',
  );
  check('本地工作区就绪不产生文件树失效（数据面是宿主自己的 fs）', connectionReadyFileInvalidation(LOCAL) === null);

  // ── RT-2：接线存在（判定写好了没人调 = 本缺陷的形态） ──
  const body = connectionReadyMethodBody();
  check('onWorkspaceConnectionReady 方法体可定位', body !== null);
  check(
    'onWorkspaceConnectionReady 调用判定',
    body !== null && body.includes('connectionReadyFileInvalidation('),
  );
  check(
    'onWorkspaceConnectionReady 经 pushFilesInvalidate 推送',
    body !== null && body.includes('pushFilesInvalidate('),
  );

  finish();
});
