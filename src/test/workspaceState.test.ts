/**
 * 单测：宿主状态文件里工作区引用的序列化 / 反序列化（`src/host/workspaceState.ts`）。
 *
 * 锁住三件事（`docs/core/client-connection.md` 第 4 / 9 节）：
 * - 本地项：旧版本的路径字符串按本地引用迁移，目录已不存在即丢弃；
 * - 远程项：`scheme` / `path` / endpoint 与**凭证**（SSH 口令）逐项往返；
 * - 形状不合法（缺字段 / 端口越界 / 认不出的凭证种类）一律丢弃，不猜、不补默认值。
 *
 * 运行方式：npm run test:all -- workspace-state
 */

import { createChecker, runTests } from './helpers/harness';
import {
  parseSerializedAuth,
  parseSerializedEndpoint,
  parseWorkspaceEntry,
  serializeWorkspaceRef,
} from '../host/workspaceState';
import { localWorkspaceRef, type WorkspaceRef } from '../host/workspaceRef';

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

  finish();
});
