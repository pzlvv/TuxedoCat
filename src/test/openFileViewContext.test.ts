/**
 * openFile 链接的来源视图上下文传递（specs/defects/remote-open-file-outside-workspace.md）。
 *
 * 远程会话点击工作区外文件的 Read / Edit 链接打不开：根因之一是共享 handler 把
 * `openFile` 原样转交给宿主时**不带来源视图**，宿主无从得知「这个路径属于哪台机器」，
 `electron/ElectronUIHost` 只能按打开集合做 `/` 前缀匹配，工作区外路径必然落本地分支。
 * 本组用例锁 handler 侧的契约面：`handleOpenFile` 必须把 `ctx.sender` 作为第三参传给
 * `UIHost.openFile`；`selectedLines` 与空路径行为维持不变。
 *
 * 运行方式：npm run test:unit -- open-file-view-context
 */

import { createChecker, runTests } from './helpers/harness';
import { createTestHost } from './helpers/fixtures';
import { WebviewViewHandle } from '../host/UIHost';
import { remoteWorkspaceRef } from '../host/workspaceRef';
import { UserChoiceManager } from '../host/ui/userChoice';
import { WebviewMessageHandler } from '../host/ui/webviewMessageHandler';

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  const sender = new WebviewViewHandle({});
  const remoteRef = remoteWorkspaceRef(
    { host: 'lab', port: 22, user: 'pz', auth: { kind: 'sshPassword', password: 'x' } },
    '/home/pz/proj',
  );

  // rest 参数捕获：修复前后都能编译（参数个数由 UIHost 契约决定），
  // 断言落在第三参上——修复前它是 undefined，即本缺陷的红
  const calls: unknown[][] = [];
  const host = createTestHost({
    openFile: async (...args: unknown[]) => {
      calls.push(args);
    },
    getWorkspaceRefForView: (view) => (view === sender ? remoteRef : undefined),
  });
  const handler = new WebviewMessageHandler({
    host,
    postToWebview: () => undefined,
    postConversationLoaded: () => undefined,
    setTitle: () => undefined,
    userChoiceManager: new UserChoiceManager({
      outputChannel: undefined,
      postToWebview: () => undefined,
      closePreview: () => undefined,
      isSessionOpenInternal: () => false,
    }),
  });

  await handler.handleWebviewMessage(
    { type: 'openFile', filePath: '/etc/hosts' },
    { sender },
  );

  check('openFile 只转发一次', calls.length === 1);
  check('openFile 第一参是文件路径', calls[0]?.[0] === '/etc/hosts');
  check('openFile 第三参携带来源视图句柄', calls[0]?.[2] === sender);

  // 无来源视图（单视图宿主 / 宿主主动调用）：第三参必须是 null 而不是 undefined
  calls.length = 0;
  await handler.handleWebviewMessage({ type: 'openFile', filePath: '/etc/hosts' });
  check('无来源视图时第三参为 null', calls[0]?.[2] === null);

  // selectedLines 仍按第二参透传
  calls.length = 0;
  await handler.handleWebviewMessage(
    { type: 'openFile', filePath: '/home/pz/proj/src/main.ts', selectedLines: { start: 3, end: 5 } },
    { sender },
  );
  check(
    'selectedLines 仍经第二参透传',
    (calls[0]?.[1] as { start: number; end: number } | null | undefined)?.start === 3
      && (calls[0]?.[1] as { start: number; end: number } | null | undefined)?.end === 5,
  );

  finish();
}

runTests('openFileViewContext', run);
