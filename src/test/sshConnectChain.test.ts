/**
 * 单测：SSH 认证链编排（`src/host/sshConnectChain.ts`，specs/053 FR-002 / FR-009）。
 *
 * 用注入的 `attempt` 记录调用顺序，锁定五条语义：
 * - 首条成功即停止尝试，后续来源零调用；
 * - `auth` 失败推进到下一条；
 * - `fatal` 失败立即中止，后续来源零调用；
 * - 全部耗尽回 `needPassword` 并带上最后一次失败原因；
 * - 一条来源都没有时也回 `needPassword`，且原因可读。
 *
 * 运行方式：npm run test:unit -- ssh-connect-chain
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createChecker, runTests } from './helpers/harness';
import { authFromSource, endpointWithAuth, runSshAuthChain } from '../host/sshConnectChain';
import type { SshAuthSource } from '../host/sshAuth';

function makeSshDir(names: readonly string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-chain-test-'));
  for (const name of names) fs.writeFileSync(path.join(dir, name), 'key', 'utf8');
  return dir;
}

/** 记录每次 attempt 的来源种类，便于断言顺序与「没有多余调用」 */
function recorder(
  behavior: (source: SshAuthSource) => 'ok' | Error,
): { attempt: (source: SshAuthSource) => Promise<string>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    attempt: async (source: SshAuthSource) => {
      calls.push(source.kind);
      const outcome = behavior(source);
      if (outcome === 'ok') return `ok:${source.kind}`;
      throw outcome;
    },
  };
}

runTests('sshConnectChain', async () => {
  const { check, finish } = createChecker();
  const created: string[] = [];
  const sshDir = (names: readonly string[]): string => {
    const dir = makeSshDir(names);
    created.push(dir);
    return dir;
  };
  const agentEnv = { SSH_AUTH_SOCK: '/tmp/agent.sock' };
  const log = (): void => {};

  // ---------- 首条成功即停 ----------

  {
    const dir = sshDir(['id_ed25519', 'id_rsa']);
    const fx = recorder(() => 'ok');
    const outcome = await runSshAuthChain({
      sshDir: dir, env: agentEnv, savedPassword: 'pw', attempt: fx.attempt, log,
    });
    check('首条成功即返回 ok', outcome.ok === true);
    check('首条成功后不再尝试后续来源', fx.calls.join(',') === 'keyFile');
    check(
      '成功的凭证是首条私钥的身份描述',
      outcome.ok && outcome.auth.kind === 'sshKey' && (outcome.auth.keyPath ?? '').endsWith('id_ed25519'),
    );
    check('成功时带回那次建链的结果', outcome.ok && outcome.result === 'ok:keyFile');
  }

  // ---------- auth 失败推进 ----------

  {
    const dir = sshDir(['id_ed25519']);
    const fx = recorder(() => new Error('All configured authentication methods failed'));
    const outcome = await runSshAuthChain({
      sshDir: dir, env: agentEnv, savedPassword: 'pw', attempt: fx.attempt, log,
    });
    check('认证不成立时逐条推进到链尾', fx.calls.join(',') === 'keyFile,agent,password');
    check('全部认证不成立回 needPassword', outcome.ok === false && outcome.reason === 'needPassword');
    check(
      'needPassword 带上最后一次失败原因',
      outcome.ok === false && outcome.cause.includes('authentication methods failed'),
    );
  }

  {
    const dir = sshDir([]);
    const fx = recorder((source) => (source.kind === 'agent' ? 'ok' : new Error('All configured authentication methods failed')));
    const outcome = await runSshAuthChain({
      sshDir: dir, env: agentEnv, savedPassword: null, attempt: fx.attempt, log,
    });
    check('中间来源成功即停（agent）', outcome.ok === true && fx.calls.join(',') === 'agent');
    check(
      'agent 成功落成 keyPath 为 null 的 sshKey 凭证',
      outcome.ok && outcome.auth.kind === 'sshKey' && outcome.auth.keyPath === null,
    );
  }

  // ---------- fatal 立即中止 ----------

  {
    const dir = sshDir(['id_ed25519']);
    const fx = recorder(() => new Error('connect ECONNREFUSED 10.0.0.1:22'));
    const outcome = await runSshAuthChain({
      sshDir: dir, env: agentEnv, savedPassword: 'pw', attempt: fx.attempt, log,
    });
    check('终止性失败立即中止', fx.calls.join(',') === 'keyFile');
    check('终止性失败回 fatal', outcome.ok === false && outcome.reason === 'fatal');
    check('fatal 原因原样带回', outcome.ok === false && outcome.cause.includes('ECONNREFUSED'));
  }

  {
    const dir = sshDir(['id_ed25519']);
    const fx = recorder(() => new Error(
      'SSH host key for 10.0.0.1:22 does not match the fingerprint recorded in known-hosts.json.',
    ));
    const outcome = await runSshAuthChain({
      sshDir: dir, env: {}, savedPassword: null, attempt: fx.attempt, log,
    });
    check('主机密钥变更不进入兜底链', outcome.ok === false && outcome.reason === 'fatal');
  }

  // ---------- 覆盖两条来源的混合场景 ----------

  {
    const dir = sshDir(['id_ed25519', 'id_rsa']);
    const fx = recorder((source) => {
      if (source.kind === 'keyFile' && source.keyPath.endsWith('id_ed25519')) {
        return new Error('private key cannot be parsed: Encrypted private OpenSSH key detected');
      }
      if (source.kind === 'keyFile') return new Error('All configured authentication methods failed');
      return 'ok';
    });
    const outcome = await runSshAuthChain({
      sshDir: dir, env: agentEnv, savedPassword: 'pw', attempt: fx.attempt, log,
    });
    check('加密私钥跳过、继续尝试下一条私钥', fx.calls.join(',') === 'keyFile,keyFile,agent');
    check('agent 最终成功', outcome.ok === true);
  }

  {
    const dir = sshDir([]);
    const fx = recorder(() => 'ok');
    const outcome = await runSshAuthChain({
      sshDir: dir, env: {}, savedPassword: 'saved-pw', attempt: fx.attempt, log,
    });
    check('只有保存的口令时只试口令', fx.calls.join(',') === 'password');
    check(
      '保存的口令成功落成 sshPassword 凭证',
      outcome.ok && outcome.auth.kind === 'sshPassword' && outcome.auth.password === 'saved-pw',
    );
  }

  // ---------- 一条来源都没有 ----------

  {
    const dir = sshDir([]);
    const fx = recorder(() => 'ok');
    const outcome = await runSshAuthChain({
      sshDir: dir, env: {}, savedPassword: null, attempt: fx.attempt, log,
    });
    check('没有任何来源时不调用 attempt', fx.calls.length === 0);
    check('没有任何来源回 needPassword', outcome.ok === false && outcome.reason === 'needPassword');
    check('没有来源时原因可读', outcome.ok === false && outcome.cause.includes('no private key'));
  }

  // ---------- 凭证 → endpoint ----------

  check(
    'authFromSource：口令',
    JSON.stringify(authFromSource({ kind: 'password', password: 'p' })) === JSON.stringify({ kind: 'sshPassword', password: 'p' }),
  );
  check(
    'authFromSource：私钥文件',
    JSON.stringify(authFromSource({ kind: 'keyFile', keyPath: '/home/pz/.ssh/id_rsa' }))
      === JSON.stringify({ kind: 'sshKey', keyPath: '/home/pz/.ssh/id_rsa' }),
  );
  check(
    'authFromSource：agent',
    JSON.stringify(authFromSource({ kind: 'agent' })) === JSON.stringify({ kind: 'sshKey', keyPath: null }),
  );
  {
    const endpoint = endpointWithAuth(
      { host: 'h', port: 22, user: 'u', auth: null },
      { kind: 'sshKey', keyPath: null },
    );
    check('endpointWithAuth 只换凭证', endpoint.host === 'h' && endpoint.port === 22 && endpoint.auth?.kind === 'sshKey');
  }

  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
  finish();
});
