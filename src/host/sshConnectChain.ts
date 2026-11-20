/**
 * SSH 认证链的执行（`docs/core/core-remote.md` 第 2.8 节，specs/053 FR-002 / FR-009）。
 *
 * 纯编排：来源清单与失败分类来自 `sshAuth.ts`，真正建链由调用方注入的 `attempt` 完成。
 * 这样「先私钥、再 agent、再保存的口令、最后问用户」的顺序，以及「只有认证不成立才兜底」
 * 的语义，都能在没有真实 SSH 服务器的情况下被单测锁定。
 *
 * 不依赖宿主 API；不读私钥正文（那是建链器的事）。
 */

import {
  classifySshFailure,
  sshAuthChain,
  type SshAuthSource,
} from './sshAuth.js';
import type { WorkspaceAuth, WorkspaceEndpoint } from './workspaceRef.js';

/** 一条来源对应的可落盘凭证（私钥只留身份描述，不带正文与 passphrase） */
export function authFromSource(source: SshAuthSource): WorkspaceAuth {
  if (source.kind === 'password') return { kind: 'sshPassword', password: source.password };
  if (source.kind === 'agent') return { kind: 'sshKey', keyPath: null };
  return { kind: 'sshKey', keyPath: source.keyPath };
}

/** 把凭证挂回 endpoint（其余字段不变） */
export function endpointWithAuth(endpoint: WorkspaceEndpoint, auth: WorkspaceAuth): WorkspaceEndpoint {
  return { ...endpoint, auth };
}

/**
 * 认证链的结论。
 *
 * - `ok`：某条来源成功，带上它的凭证与那次建链的结果；
 * - `needPassword`：所有来源都「认证不成立」，唯一的解法是让用户提供口令；
 * - `fatal`：终止性失败，按原因报错，不询问口令。
 */
export type SshAuthOutcome<Result> =
  | { ok: true; auth: WorkspaceAuth; result: Result }
  | { ok: false; reason: 'needPassword'; cause: string }
  | { ok: false; reason: 'fatal'; cause: string };

/**
 * 依次尝试认证来源，任一成功即停。
 *
 * `savedPassword` 由调用方从连接历史取；用户经口令浮层输入的口令**不走这里**——
 * 那条路径只试一次口令（见 `electron/main.ts` 的接入处理），否则用户已经给出的答案会被
 * 私钥尝试白白拖慢、还会把服务端的失败计数算到公钥上。
 */
export async function runSshAuthChain<Result>(options: {
  /** 本机 `~/.ssh` 目录（测试可注入临时目录） */
  sshDir: string;
  /** 环境（`SSH_AUTH_SOCK`；测试可注入） */
  env: { SSH_AUTH_SOCK?: string | undefined };
  /** 连接历史里保存的口令；没有为 `null` */
  savedPassword: string | null;
  /** 用某条来源建链；失败时抛错，由本函数分类 */
  attempt: (source: SshAuthSource) => Promise<Result>;
  /** 各来源的失败原因落诊断日志（不呈现给用户） */
  log: (...args: unknown[]) => void;
}): Promise<SshAuthOutcome<Result>> {
  const sources = sshAuthChain({
    sshDir: options.sshDir,
    env: options.env,
    savedPassword: options.savedPassword,
  });
  /** 最后一次「认证不成立」的原因：浮层要显示它，否则用户不知道为什么被问了 */
  let authCause: string | null = null;
  for (const source of sources) {
    try {
      const result = await options.attempt(source);
      return { ok: true, auth: authFromSource(source), result };
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      options.log(`[ssh-auth] ${source.kind} attempt failed: ${cause}`);
      if (classifySshFailure(error) === 'fatal') {
        return { ok: false, reason: 'fatal', cause };
      }
      authCause = cause;
    }
  }
  return {
    ok: false,
    reason: 'needPassword',
    // 一条来源都没试过（没有私钥、没有 agent、没有保存口令）时也给一句可读的原因
    cause: authCause ?? 'no private key, ssh-agent identity, or saved password is available',
  };
}
