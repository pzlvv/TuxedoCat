/**
 * 单测：远程连接串解析（`src/host/connectionString.ts`）。
 *
 * 格式是 Standalone Core `start` 打出来的 `<IP>:<端口>#<token>`
 * （`docs/core-daemon.md` 第 12.3 节）。这里锁住两件事：
 * - 正常串解析出 host / port / token（含首尾空白与主机名形态）；
 * - 缺字段 / 端口非法 / 多个 `#` 一律返回 null，不做静默降级。
 *
 * 运行方式：npm run test:all -- connectionString
 */

import { createChecker, runTests } from './helpers/harness';
import {
  buildRemoteEndpoint,
  parseConnectionString,
  parseSshConnectionInput,
} from '../host/connectionString';
import { remoteWorkspaceRef } from '../host/workspaceRef';

runTests('connectionString', () => {
  const { check, finish } = createChecker();

  const parsed = parseConnectionString('192.168.31.228:10975#8f3c0d');
  check('解析 IPv4 连接串', !!parsed && parsed.host === '192.168.31.228');
  check('解析端口', !!parsed && parsed.port === 10975);
  check('解析 token', !!parsed && parsed.token === '8f3c0d');

  const trimmed = parseConnectionString('  127.0.0.1:10975#abc  ');
  check('去掉首尾空白', !!trimmed && trimmed.host === '127.0.0.1' && trimmed.token === 'abc');

  const hostname = parseConnectionString('build-box:10975#abc');
  check('主机名形态原样保留', !!hostname && hostname.host === 'build-box');

  check('缺 token 返回 null', parseConnectionString('192.168.1.5:10975#') === null);
  check('缺端口返回 null', parseConnectionString('192.168.1.5#abc') === null);
  check('缺主机返回 null', parseConnectionString(':10975#abc') === null);
  check('端口非数字返回 null', parseConnectionString('192.168.1.5:port#abc') === null);
  check('端口越界返回 null', parseConnectionString('192.168.1.5:70000#abc') === null);
  check('端口为 0 返回 null', parseConnectionString('192.168.1.5:0#abc') === null);
  check('多个 # 返回 null', parseConnectionString('192.168.1.5:10975#a#b') === null);
  check('空串返回 null', parseConnectionString('') === null);

  // ---------- SSH 表单（`docs/core-daemon.md` 第 12 节） ----------

  const ssh = parseSshConnectionInput({
    host: ' 172.20.56.28 ',
    port: '22',
    user: ' pz ',
    password: ' secret ',
  });
  check('SSH 表单解析成功', ssh.ok);
  check('SSH 主机去首尾空白', ssh.ok && ssh.value.host === '172.20.56.28');
  check('SSH 端口转数字', ssh.ok && ssh.value.port === 22);
  check('SSH 用户去首尾空白', ssh.ok && ssh.value.user === 'pz');
  check('SSH 口令原样保留（空格是口令的一部分）', ssh.ok && ssh.value.password === ' secret ');

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

  const fromString = buildRemoteEndpoint({ kind: 'connectionString', value: '10.0.0.1:10975#tok' });
  check('连接串请求收敛成 token 凭证', fromString.ok && fromString.value.auth?.kind === 'token');
  check(
    '连接串请求的 scheme 是 tcp',
    fromString.ok && remoteWorkspaceRef(fromString.value, '/srv').scheme === 'tcp',
  );

  const fromSsh = buildRemoteEndpoint({
    kind: 'ssh',
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

  check(
    '连接串非法报 connectionString',
    buildRemoteEndpoint({ kind: 'connectionString', value: 'nope' }).ok === false,
  );
  const sshBadPort = buildRemoteEndpoint({ kind: 'ssh', host: 'h', port: 'x', user: 'u', password: 'p' });
  check('SSH 端口非法报 port', !sshBadPort.ok && sshBadPort.error === 'port');
  check('非对象报 request', buildRemoteEndpoint(null).ok === false);
  check('未知 kind 报 request', buildRemoteEndpoint({ kind: 'wsl' }).ok === false);

  finish();
});
