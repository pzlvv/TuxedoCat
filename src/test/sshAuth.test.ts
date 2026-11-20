/**
 * 单测：SSH 认证来源推导与凭证身份（`src/host/sshAuth.ts`，specs/053 FR-002 / FR-003 / FR-007）。
 *
 * 锁住四件事：
 * - `sshAuthChain` 的顺序是唯一口径：私钥（按 `DEFAULT_PRIVATE_KEY_NAMES`）→ agent → 保存的口令；
 * - `discoverDefaultPrivateKeys` 只收真实存在的普通文件，缺目录不抛错；
 * - `classifySshFailure` 的 `auth` / `fatal` 二分：只有认证不成立才该继续兜底；
 * - `sshAuthIdentity` 不含明文、换内容即换身份、同一凭证稳定。
 *
 * 运行方式：npm run test:unit -- ssh-auth
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createChecker, runTests } from './helpers/harness';
import {
  agentSocketAvailable,
  classifySshFailure,
  DEFAULT_PRIVATE_KEY_NAMES,
  discoverDefaultPrivateKeys,
  sshAuthChain,
  sshAuthIdentity,
} from '../host/sshAuth';

/** 建一个临时 `~/.ssh`，`names` 里的文件写成普通文件，`dirs` 里的建成目录 */
function makeSshDir(names: readonly string[], dirs: readonly string[] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-auth-test-'));
  for (const name of names) fs.writeFileSync(path.join(dir, name), `-----BEGIN OPENSSH PRIVATE KEY-----\n${name}\n`, 'utf8');
  for (const name of dirs) fs.mkdirSync(path.join(dir, name));
  return dir;
}

runTests('sshAuth', () => {
  const { check, finish } = createChecker();
  const created: string[] = [];
  const sshDir = (names: readonly string[], dirs: readonly string[] = []): string => {
    const dir = makeSshDir(names, dirs);
    created.push(dir);
    return dir;
  };

  // ---------- 默认私钥发现 ----------

  {
    const dir = sshDir(DEFAULT_PRIVATE_KEY_NAMES);
    const found = discoverDefaultPrivateKeys(dir);
    check(
      '默认私钥按固定顺序枚举',
      found.map((p) => path.basename(p)).join(',') === DEFAULT_PRIVATE_KEY_NAMES.join(','),
    );
  }

  {
    const dir = sshDir(['id_rsa', 'id_ed25519']);
    check(
      '只枚举存在的私钥，顺序仍是固定顺序',
      discoverDefaultPrivateKeys(dir).map((p) => path.basename(p)).join(',') === 'id_ed25519,id_rsa',
    );
  }

  {
    const dir = sshDir([], ['id_rsa']);
    check('同名目录不算私钥', discoverDefaultPrivateKeys(dir).length === 0);
  }

  {
    const missing = path.join(os.tmpdir(), 'ssh-auth-test-definitely-missing-dir-1234');
    check('~/.ssh 不存在时返回空表而不是抛错', discoverDefaultPrivateKeys(missing).length === 0);
  }

  // ---------- agent 可用性 ----------

  check('SSH_AUTH_SOCK 为空视为 agent 不可用', !agentSocketAvailable({}));
  check('SSH_AUTH_SOCK 空串视为不可用', !agentSocketAvailable({ SSH_AUTH_SOCK: '' }));
  check('SSH_AUTH_SOCK 非空视为可用', agentSocketAvailable({ SSH_AUTH_SOCK: '/tmp/agent.sock' }));

  // ---------- 认证链顺序（唯一口径） ----------

  {
    const dir = sshDir(['id_ed25519', 'id_rsa']);
    const chain = sshAuthChain({ sshDir: dir, env: { SSH_AUTH_SOCK: '/tmp/agent.sock' }, savedPassword: 'pw' });
    check(
      '顺序：私钥 → agent → 保存的口令',
      chain.map((s) => s.kind).join(',') === 'keyFile,keyFile,agent,password',
    );
    check(
      '私钥项按固定顺序带出具体路径',
      chain.filter((s) => s.kind === 'keyFile').map((s) => path.basename((s as { keyPath: string }).keyPath)).join(',')
        === 'id_ed25519,id_rsa',
    );
    check(
      '口令项带出保存的口令',
      chain.some((s) => s.kind === 'password' && s.password === 'pw'),
    );
  }

  {
    const dir = sshDir([]);
    check(
      '没有私钥、没有 agent、没有保存口令时链为空',
      sshAuthChain({ sshDir: dir, env: {}, savedPassword: null }).length === 0,
    );
    check(
      '空串口令不当作可用口令',
      sshAuthChain({ sshDir: dir, env: {}, savedPassword: '' }).length === 0,
    );
    check(
      '私钥排在保存的口令之前',
      sshAuthChain({ sshDir: sshDir(['id_rsa']), env: {}, savedPassword: 'pw' })[0]?.kind === 'keyFile',
    );
  }

  // ---------- 失败分类 ----------

  const fatal = [
    'SSH connection to pz@10.0.0.1:22 failed: SSH host key for 10.0.0.1:22 does not match the fingerprint recorded in known-hosts.json.',
    'connect ECONNREFUSED 10.0.0.1:22',
    'SSH command timed out after 120000ms: uname -sm',
    'connect ETIMEDOUT 10.0.0.1:22',
    'getaddrinfo ENOTFOUND nosuchhost',
    'connection closed.',
  ];
  for (const message of fatal) {
    check(`终止性失败判 fatal：${message.slice(0, 40)}`, classifySshFailure(new Error(message)) === 'fatal');
  }

  const auth = [
    'private key /home/pz/.ssh/id_rsa cannot be parsed: Encrypted private OpenSSH key detected',
    'private key /home/pz/.ssh/id_rsa is not readable: EACCES: permission denied',
    'ssh-agent is not available (SSH_AUTH_SOCK is not set).',
    'All configured authentication methods failed',
  ];
  for (const message of auth) {
    check(`认证不成立判 auth：${message.slice(0, 40)}`, classifySshFailure(new Error(message)) === 'auth');
  }

  check('认不出的错误按 fatal 处理（不做乐观兜底）', classifySshFailure(new Error('something unexpected')) === 'fatal');
  check('非 Error 也能分类', classifySshFailure('ECONNREFUSED') === 'fatal');

  // ---------- 凭证身份 ----------

  {
    const same = sshAuthIdentity({ kind: 'password', password: 'pw' });
    check('同一口令身份稳定', same === sshAuthIdentity({ kind: 'password', password: 'pw' }));
    check('换口令即换身份', same !== sshAuthIdentity({ kind: 'password', password: 'pw2' }));
    check('口令身份不含明文', !same.includes('pw') || !same.includes('password:pw'));
  }

  check('agent 身份是固定串', sshAuthIdentity({ kind: 'agent' }) === 'agent');

  {
    const dir = sshDir(['id_ed25519']);
    const keyPath = path.join(dir, 'id_ed25519');
    const first = sshAuthIdentity({ kind: 'keyFile', keyPath });
    check('私钥身份不含私钥正文', !first.includes('PRIVATE KEY'));
    check('同一私钥文件身份稳定', first === sshAuthIdentity({ kind: 'keyFile', keyPath }));
    fs.writeFileSync(keyPath, '-----BEGIN OPENSSH PRIVATE KEY-----\nrotated\n', 'utf8');
    // mtime 粒度可能落在同一毫秒：显式改大小让缓存键失效
    fs.appendFileSync(keyPath, 'x');
    check('私钥内容变化即换身份', first !== sshAuthIdentity({ kind: 'keyFile', keyPath }));
  }

  {
    const missing = path.join(os.tmpdir(), 'ssh-auth-test-no-such-key');
    const identity = sshAuthIdentity({ kind: 'keyFile', keyPath: missing });
    check('私钥文件不存在时身份退到路径哈希而不是抛错', identity.startsWith('keyFile:') && identity.length > 9);
  }

  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
  finish();
});
