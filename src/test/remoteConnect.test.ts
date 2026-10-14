/**
 * 单测：远程接入请求解析（`src/host/remoteConnect.ts`）。
 *
 * 接入方式只有 SSH 表单（`docs/core/core-remote.md` 第 2 节）。这里锁住两件事：
 * - 表单校验：主机 / 用户去首尾空白，口令原样保留，端口必须是 1-65535 的数字；
 * - 接入请求收敛成 `WorkspaceEndpoint`：形状不对一律报原因码，不做静默降级。
 *
 * 运行方式：npm run test:all -- remote-connect
 */

import { createChecker, runTests } from './helpers/harness';
import { buildRemoteEndpoint, parseSshConnectionInput } from '../host/remoteConnect';
import { remoteWorkspaceRef } from '../host/workspaceRef';

runTests('remoteConnect', () => {
  const { check, finish } = createChecker();

  // ---------- SSH 表单（`docs/core/core-remote.md` 第 2 节） ----------

  const ssh = parseSshConnectionInput({
    host: ' 172.20.56.28 ',
    port: ' 22 ',
    user: ' pz ',
    password: ' pw ',
  });
  check('SSH 主机去首尾空白', ssh.ok && ssh.value.host === '172.20.56.28');
  check('SSH 端口转数字', ssh.ok && ssh.value.port === 22);
  check('SSH 用户去首尾空白', ssh.ok && ssh.value.user === 'pz');
  check('SSH 口令原样保留（含首尾空格）', ssh.ok && ssh.value.password === ' pw ');

  check(
    'SSH 端口接受数字',
    parseSshConnectionInput({ host: 'h', port: 22, user: 'pz', password: 'x' }).ok,
  );
  check(
    'SSH 缺主机报 host',
    !parseSshConnectionInput({ host: '  ', port: '22', user: 'pz', password: 'x' }).ok,
  );
  check(
    'SSH 端口非数字报 port',
    !parseSshConnectionInput({ host: 'h', port: 'ssh', user: 'pz', password: 'x' }).ok,
  );
  check(
    'SSH 端口越界报 port',
    !parseSshConnectionInput({ host: 'h', port: '70000', user: 'pz', password: 'x' }).ok,
  );
  check(
    'SSH 缺用户报 user',
    !parseSshConnectionInput({ host: 'h', port: '22', user: '', password: 'x' }).ok,
  );
  check(
    'SSH 缺口令报 password',
    !parseSshConnectionInput({ host: 'h', port: '22', user: 'pz', password: '' }).ok,
  );

  // ---------- 接入请求 → endpoint（`buildRemoteEndpoint`） ----------

  const fromSsh = buildRemoteEndpoint({
    host: '172.20.56.28',
    port: '22',
    user: 'pz',
    password: 'pw',
  });
  check('SSH 请求收敛成 sshPassword 凭证', fromSsh.ok && fromSsh.value.auth?.kind === 'sshPassword');
  check('SSH 请求保留登录用户', fromSsh.ok && fromSsh.value.user === 'pz');
  check('SSH 请求端口转数字', fromSsh.ok && fromSsh.value.port === 22);
  check(
    'SSH 请求的 scheme 是 ssh',
    fromSsh.ok && remoteWorkspaceRef(fromSsh.value, '/home/pz').scheme === 'ssh',
  );

  const sshBadPort = buildRemoteEndpoint({ host: 'h', port: 'x', user: 'u', password: 'p' });
  check('SSH 端口非法报 port', !sshBadPort.ok && sshBadPort.error === 'port');
  check('缺字段报 host', buildRemoteEndpoint({}).ok === false);
  check('非对象报 request', buildRemoteEndpoint(null).ok === false);

  finish();
});
