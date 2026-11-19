/**
 * SSH 连接目标的唯一派生入口（`docs/core/core-remote.md` 第 2.8 节）。
 *
 * 「同一个 SSH 连接目标」在仓库里有多个消费方，各自派生缓存 / 去重键：
 * daemon 注册表、SSH 引导去重、启动探测分组、侧栏文件浏览器的连接缓存。
 * 键的口径必须只有一份——端口缺省归一（null 与 22 是同一目标）、凭证参与身份
 * （换凭证必须换连接），否则会出现「一处视为同一目标复用连接、另一处视为不同
 * 目标再建一条」的分叉。全仓的连接目标键一律走 `sshTargetFor` + `sshTargetKey`。
 *
 * 凭证有两种形态（specs/052）：口令与私钥身份。两者都参与身份键，且都只以公开描述
 * （哈希 / 固定串）进键——口令明文与私钥正文都不留在键字符串里。
 */

import { sshAuthIdentity, type SshAuthSource } from './sshAuth.js';
import type { SshTarget } from './standalone/sshClient.js';
import type { WorkspaceAuth, WorkspaceEndpoint } from './workspaceRef.js';

/**
 * 落盘凭证 → 本次建链要用的认证来源。
 *
 * 私钥正文不在这里读：这里只把「哪个文件 / 走 agent」翻成来源描述，读盘发生在建链那一刻
 * （`SshClient` 的 `authOptions`，specs/052 FR-007）。
 */
export function authSourceFor(auth: WorkspaceAuth): SshAuthSource {
  if (auth.kind === 'sshPassword') return { kind: 'password', password: auth.password };
  return auth.keyPath === null ? { kind: 'agent' } : { kind: 'keyFile', keyPath: auth.keyPath };
}

/** 从打开集合的远程引用取 SSH 连接目标（缺凭证 / 登录用户即抛错——不静默降级） */
export function sshTargetFor(endpoint: WorkspaceEndpoint): SshTarget {
  const auth = endpoint.auth;
  if (!auth || !endpoint.user) {
    throw new Error(`SSH endpoint ${endpoint.host} has no credential or login user.`);
  }
  return {
    host: endpoint.host,
    port: endpoint.port ?? 22,
    user: endpoint.user,
    auth: authSourceFor(auth),
  };
}

/**
 * SSH 连接目标的身份键：host / 端口（缺省归一为 22）/ 用户 / 凭证身份共同决定。
 *
 * 对象字面量固定字段顺序，`JSON.stringify` 的键稳定；凭证只进公开描述，
 * 锁定「换凭证即换目标」的语义而不把口令或私钥正文留在键字符串里。
 */
export function sshTargetKey(target: SshTarget): string {
  return JSON.stringify({
    host: target.host,
    port: target.port ?? 22,
    user: target.user,
    auth: sshAuthIdentity(target.auth),
  });
}
