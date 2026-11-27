/**
 * SSH 车道的远端进程口径（`e2e/helpers/remoteCoreProcess.ts`）。
 *
 * 缺陷背景（`e2e/README.md` 已知坑 23）：远端是共享机器，同机并存多个部署槽位
 * `~/.local/share/<core.deployPrefix>/<指纹>/`。四条 ssh 车道原先只用 `<core.binaryName>`
 * 匹配进程，run `45877287618` 上踩到两条后果——`US-65 离场完成` 的「本层孤儿 Core 已收尾」
 * 被另一个槽位的 Core 永远挡住，清场 `pkill -f` 又会误杀别人的 daemon。
 *
 * 这里锁的是**模式串本身**：它必须带上本机指纹槽位，且必须带 `[]` 防自匹配。用真实字符串
 * 比对而不是读源码猜——模式串拼错一个分隔符，远端一行都匹配不到（表现为「清场没生效」或
 * 「断言恒真」），比匹配过头更难发现。
 *
 * 跑法：`npm run test:unit -- e2eRemoteCoreProcess`。
 */

import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  coreProcessPattern,
  daemonProcessPattern,
  localCoreFingerprint,
  requireLocalCoreFingerprint,
  repoRoot,
} from '../../e2e/helpers/remoteCoreProcess';
import { CORE_BINARY_NAME, CORE_DEPLOY_PREFIX } from '../../src/config/project';
import { runTests } from './helpers/harness';

const FINGERPRINT = 'f'.repeat(64);
const OTHER_FINGERPRINT = 'e'.repeat(64);

/** 用正则判断某条远端命令行是否会被 `pgrep -f <pattern>` 命中 */
function matches(pattern: string, commandLine: string): boolean {
  return new RegExp(pattern).test(commandLine);
}

runTests('e2eRemoteCoreProcess', () => {
  // RT-1：模式里带部署槽位与本机指纹，且二进制名首字符加了 [] 防自匹配
  {
    const pattern = coreProcessPattern(FINGERPRINT);
    assert.ok(
      pattern.includes(`${CORE_DEPLOY_PREFIX}/${FINGERPRINT}/`),
      `模式应带部署槽位 ${CORE_DEPLOY_PREFIX}/${FINGERPRINT}/：${pattern}`,
    );
    assert.ok(pattern.includes(`[${CORE_BINARY_NAME[0]}]`), `二进制名首字符应加 []：${pattern}`);
    assert.ok(
      !pattern.includes(`/${CORE_BINARY_NAME} `),
      `模式里不应出现未加方括号的裸二进制名：${pattern}`,
    );
  }

  // RT-2：只命中自己指纹槽位的 Core，另一个槽位的一律不命中——这正是 run 45877287618
  // 上「别人的 Core 被算成自己的残留」的直接成因
  {
    const pattern = coreProcessPattern(FINGERPRINT);
    const own = `/home/dev/.local/share/${CORE_DEPLOY_PREFIX}/${FINGERPRINT}/${CORE_BINARY_NAME} stdio`;
    const foreign = `/home/dev/.local/share/${CORE_DEPLOY_PREFIX}/${OTHER_FINGERPRINT}/${CORE_BINARY_NAME} stdio`;
    assert.ok(matches(pattern, own), `应命中本指纹槽位的 Core：${own}`);
    assert.ok(!matches(pattern, foreign), `不应命中另一个槽位的 Core：${foreign}`);
  }

  // RT-3：不匹配执行 pgrep / pkill 的远端 shell 自身（它的命令行里带着模式原文；
  // 不加 [] 时 pkill 会杀掉半途的清场 shell，清场看似执行实则中断）
  {
    const pattern = coreProcessPattern(FINGERPRINT);
    const self = `bash -c pgrep -u 1000 -af '${pattern}' || true`;
    assert.ok(!matches(pattern, self), `模式不应命中执行它的 shell 自身：${self}`);
  }

  // RT-4：daemon 模式在 Core 模式之上再收一层 `start-daemon`——SIGSTOP / SIGCONT / -9
  // 只针对 daemon 本身，不碰工作区 Core
  {
    const daemon = daemonProcessPattern(FINGERPRINT);
    const ownDaemon = `/home/dev/.local/share/${CORE_DEPLOY_PREFIX}/${FINGERPRINT}/${CORE_BINARY_NAME} start-daemon --idle-exit 30`;
    const ownCore = `/home/dev/.local/share/${CORE_DEPLOY_PREFIX}/${FINGERPRINT}/${CORE_BINARY_NAME} stdio`;
    assert.ok(matches(daemon, ownDaemon), `应命中本指纹槽位的 daemon：${ownDaemon}`);
    assert.ok(!matches(daemon, ownCore), `不应命中工作区 Core：${ownCore}`);
    assert.ok(
      !matches(daemon, ownDaemon.replace(FINGERPRINT, OTHER_FINGERPRINT)),
      '不应命中另一个槽位的 daemon',
    );
  }

  // RT-5：指纹缺失时抛错而不是静默退回名字口径（静默降级正是本条要消除的东西）
  {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-remote-core-'));
    try {
      assert.strictEqual(
        localCoreFingerprint(emptyRoot),
        null,
        '没有产物时 localCoreFingerprint 应返回 null',
      );
      assert.throws(
        () => requireLocalCoreFingerprint(emptyRoot),
        /build:core:linux-x64/,
        '没有产物时 requireLocalCoreFingerprint 应抛错并点出前置命令',
      );
    } finally {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  }

  // RT-6：cwd 是 `e2e/` 时也能找到仓库根（四条车道都在这个 cwd 下运行）
  {
    assert.strictEqual(repoRoot(path.join(path.sep, 'repo', 'e2e')), path.join(path.sep, 'repo'));
    assert.strictEqual(repoRoot(path.join(path.sep, 'repo')), path.join(path.sep, 'repo'));
  }

  console.log('全部通过');
});
