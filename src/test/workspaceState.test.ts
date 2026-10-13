/**
 * 单测：宿主状态文件里工作区引用的序列化 / 反序列化（`src/host/workspaceState.ts`）。
 *
 * 锁住四件事（`docs/core/client-connection.md` 第 4 / 9 节）：
 * - 本地项：旧版本的路径字符串按本地引用迁移（目录是否存在由调用方判定，打开集合不丢项）；
 * - 远程项：`scheme` / `path` / endpoint 与**凭证**（SSH 口令）逐项往返；
 * - 形状不合法（缺字段 / 端口越界 / 认不出的凭证种类）一律丢弃，不猜、不补默认值；
 * - 旧版本状态文件的打开集合 / 活动项字段迁移（目录已不存在也保留，不静默丢标签页）。
 *
 * 运行方式：npm run test:all -- workspace-state
 */

import { createChecker, runTests } from './helpers/harness';
import {
  migrateLegacyWorkspaceFields,
  parseSerializedAuth,
  parseSerializedEndpoint,
  parseWorkspaceEntry,
  serializeWorkspaceRef,
} from '../host/workspaceState';
import { localWorkspaceRef, type WorkspaceRef } from '../host/workspaceRef';
import { normalizeWorkspacePath } from '../host/workspacePaths';

/** 往返一次：序列化 → JSON → 反序列化（与真实落盘路径同口径） */
function roundTrip(ref: WorkspaceRef): WorkspaceRef | null {
  const persisted = JSON.parse(JSON.stringify(serializeWorkspaceRef(ref)));
  return parseWorkspaceEntry(persisted, () => true);
}

runTests('workspaceState', () => {
  const { check, finish } = createChecker();

  // ---------- 本地项 ----------

  const local = localWorkspaceRef('/srv/app');
  const localRoundTrip = roundTrip(local);
  check('本地项往返保留 scheme', localRoundTrip?.scheme === 'file');
  check('本地项往返保留路径', localRoundTrip?.path === local.path);
  check('本地项往返没有 endpoint', localRoundTrip?.endpoint === null);
  check('本地目录已不存在即丢弃', parseWorkspaceEntry('/srv/gone', () => false) === null);
  check('旧版本路径字符串按本地引用迁移', parseWorkspaceEntry('/srv/app', () => true)?.scheme === 'file');

  // ---------- 远程项：SSH 口令 ----------

  const ssh: WorkspaceRef = {
    scheme: 'ssh',
    path: '/home/pz/proj',
    endpoint: {
      host: '172.20.56.28',
      port: 22,
      user: 'pz',
      auth: { kind: 'sshPassword', password: '617287Pz' },
    },
  };
  let probedLocal = 0;
  const sshRoundTrip = parseWorkspaceEntry(
    JSON.parse(JSON.stringify(serializeWorkspaceRef(ssh))),
    () => {
      probedLocal += 1;
      return false;
    },
  );
  check('SSH 项往返保留 scheme', sshRoundTrip?.scheme === 'ssh');
  check('SSH 项往返保留路径', sshRoundTrip?.path === '/home/pz/proj');
  check('SSH 项往返保留主机', sshRoundTrip?.endpoint?.host === '172.20.56.28');
  check('SSH 项往返保留端口', sshRoundTrip?.endpoint?.port === 22);
  check('SSH 项往返保留用户', sshRoundTrip?.endpoint?.user === 'pz');
  check(
    'SSH 项往返保留口令',
    sshRoundTrip?.endpoint?.auth?.kind === 'sshPassword'
      && sshRoundTrip.endpoint.auth.password === '617287Pz',
  );
  check('远程项不检查本地目录', probedLocal === 0);

  // ---------- 形状不合法：整项丢弃 ----------

  check('非对象非字符串丢弃', parseWorkspaceEntry(42, () => true) === null);
  check('数组丢弃', parseWorkspaceEntry([], () => true) === null);
  check('空对象丢弃', parseWorkspaceEntry({}, () => true) === null);
  check('缺 path 丢弃', parseWorkspaceEntry({ scheme: 'ssh', endpoint: null }, () => true) === null);
  check('空 scheme 丢弃', parseWorkspaceEntry({ scheme: '', path: '/a' }, () => true) === null);

  check('endpoint 非对象丢弃', parseSerializedEndpoint('nope') === null);
  check('endpoint 缺主机丢弃', parseSerializedEndpoint({ port: 22, auth: { kind: 'sshPassword', password: 't' } }) === null);
  check(
    'endpoint 端口非数字丢弃',
    parseSerializedEndpoint({ host: 'h', port: '22', auth: { kind: 'sshPassword', password: 't' } }) === null,
  );
  check(
    'endpoint 端口越界丢弃',
    parseSerializedEndpoint({ host: 'h', port: 70000, auth: { kind: 'sshPassword', password: 't' } }) === null,
  );
  check(
    'endpoint 端口 0 丢弃',
    parseSerializedEndpoint({ host: 'h', port: 0, auth: { kind: 'sshPassword', password: 't' } }) === null,
  );
  check(
    'endpoint 允许 port/user 为 null',
    parseSerializedEndpoint({ host: 'h', port: null, user: null, auth: { kind: 'sshPassword', password: 't' } })
      ?.port === null,
  );
  check(
    'endpoint 用户类型不对丢弃',
    parseSerializedEndpoint({ host: 'h', port: 22, user: 7, auth: { kind: 'sshPassword', password: 't' } }) === null,
  );

  check('认不出的凭证种类丢弃', parseSerializedAuth({ kind: 'password', password: 'x' }) === null);
  check('缺凭证丢弃', parseSerializedAuth(null) === null);
  check('空口令丢弃', parseSerializedAuth({ kind: 'sshPassword', password: '' }) === null);
  check('口令凭证解析', parseSerializedAuth({ kind: 'sshPassword', password: 'p' })?.kind === 'sshPassword');
  check(
    '凭证带额外字段不影响解析',
    parseSerializedAuth({ kind: 'sshPassword', password: 'p', extra: 1 })?.kind === 'sshPassword',
  );

  // ---------- 旧版本状态文件的工作目录字段迁移 ----------

  const legacyLast = migrateLegacyWorkspaceFields({
    lastWorkspace: '/srv/old',
    recentWorkspaces: ['/srv/old'],
  });
  check('单个 lastWorkspace 提升为打开集合', legacyLast?.openWorkspaces.length === 1);
  check('迁移保留 lastWorkspace 路径', legacyLast?.openWorkspaces[0] === normalizeWorkspacePath('/srv/old'));
  check('迁移活动项取 lastWorkspace', legacyLast?.activeWorkspace === normalizeWorkspacePath('/srv/old'));
  // 目录已不存在（本地检查不到）时同样保留：读取路径负责标不可用，迁移不得静默丢标签页
  check(
    '目录不存在的 lastWorkspace 不丢弃',
    migrateLegacyWorkspaceFields({ lastWorkspace: '/srv/gone' })?.openWorkspaces[0]
      === normalizeWorkspacePath('/srv/gone'),
  );

  const legacyOpen = migrateLegacyWorkspaceFields({
    openWorkspaces: ['/srv/a', '/srv/b'],
    activeWorkspace: '/srv/a',
  });
  check('旧版 openWorkspaces 整体迁移', legacyOpen?.openWorkspaces.length === 2);
  check('旧版 activeWorkspace 命中时作为活动项', legacyOpen?.activeWorkspace === normalizeWorkspacePath('/srv/a'));
  check(
    'activeWorkspace 不在集合内时回退最后一项',
    migrateLegacyWorkspaceFields({ openWorkspaces: ['/srv/a', '/srv/b'], activeWorkspace: '/srv/gone' })
      ?.activeWorkspace === normalizeWorkspacePath('/srv/b'),
  );
  check(
    'openWorkspaces 非字符串项丢弃、合法项保留',
    migrateLegacyWorkspaceFields({ openWorkspaces: ['/srv/a', 7, '', null] })?.openWorkspaces.length === 1,
  );
  check(
    '旧版 openWorkspaces 优先于 lastWorkspace',
    migrateLegacyWorkspaceFields({ openWorkspaces: ['/srv/a'], lastWorkspace: '/srv/old' })
      ?.openWorkspaces[0] === normalizeWorkspacePath('/srv/a'),
  );
  check(
    '空 lastWorkspace 不产生打开项',
    migrateLegacyWorkspaceFields({ lastWorkspace: '   ' })?.openWorkspaces.length === 0,
  );
  check('没有任何工作目录字段即空集合', migrateLegacyWorkspaceFields({ theme: 'dark' })?.openWorkspaces.length === 0);
  check('非对象入参不迁移', migrateLegacyWorkspaceFields('nope') === null);
  check('数组入参不迁移', migrateLegacyWorkspaceFields([]) === null);

  finish();
});
