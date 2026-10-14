/**
 * SSH 连接目标的唯一派生入口（`docs/core/core-remote.md` 第 2 节）。
 *
 * 「同一个 SSH 连接目标」在仓库里有多个消费方，各自派生缓存 / 去重键：
 * daemon 注册表、SSH 引导去重、启动探测分组、侧栏文件浏览器的连接缓存。
 * 键的口径必须只有一份——端口缺省归一（null 与 22 是同一目标）、凭证参与身份
 * （换口令必须换连接），否则会出现「一处视为同一目标复用连接、另一处视为不同
 * 目标再建一条」的分叉。全仓的连接目标键一律走 `sshTargetFor` + `sshTargetKey`。
 *
 * 只做取值与键派生，不依赖宿主 API；凭证以指纹参与键，不进日志。
 */

import { createHash } from 'node:crypto';
import type { SshTarget } from './standalone/sshClient.js';
import type { WorkspaceEndpoint } from './workspaceRef.js';

/** 从打开集合的远程引用取 SSH 连接目标（口令凭证，缺即抛错——不静默降级） */
export function sshTargetFor(endpoint: WorkspaceEndpoint): SshTarget {
  const auth = endpoint.auth;
  if (!auth || auth.kind !== 'sshPassword' || !endpoint.user) {
    throw new Error(`SSH endpoint ${endpoint.host} has no password credential or login user.`);
  }
  return { host: endpoint.host, port: endpoint.port ?? 22, user: endpoint.user, password: auth.password };
}

/** 凭证指纹（sha256 前 16 位）：区分「换过口令」的目标，不暴露明文 */
function credentialFingerprint(password: string): string {
  return createHash('sha256').update(password).digest('hex').slice(0, 16);
}

/**
 * SSH 连接目标的身份键：host / 端口（缺省归一为 22）/ 用户 / 凭证指纹共同决定。
 *
 * 对象字面量固定字段顺序，`JSON.stringify` 的键稳定；凭证只进指纹，
 * 锁定「换凭证即换目标」的语义而不把口令留在键字符串里。
 */
export function sshTargetKey(target: SshTarget): string {
  return JSON.stringify({
    host: target.host,
    port: target.port ?? 22,
    user: target.user,
    auth: credentialFingerprint(target.password),
  });
}
