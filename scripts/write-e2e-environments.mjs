#!/usr/bin/env node
/**
 * 从 CI Secrets 现写 `e2e/environments.json`（真实 SSH 远端车道的环境文件）。
 *
 * 为什么需要它：`e2e/environments.json` 含 SSH 凭证、被 gitignore，不入库；CI 里没有这份
 * 文件，而 `electron-ssh` 车道的用例在模块加载期就 `requireSshEnvironment()`（缺文件即
 * 收集期报错，不 skip、不兜底）。因此 job 在跑用例前把 Secrets 写成同形状的文件。
 *
 * 与产品代码同一口径（`docs/architecture/principles.md` 第 1 节「不过度 fallback」）：
 * - 缺任何一个必填 secret 就**一次报出全部缺失项**并退出非零，不补默认端口、不跳过用例；
 * - 布局与 `e2e/helpers/testEnvironment.ts` 的类型、`e2e/environments.example.json`
 *   的示例保持一致，字段名不另起一套。
 *
 * 不打印任何 secret 值：CI 日志里出现一次就等于泄露（GitHub 只遮蔽已知的 secret 串，
 * 派生值如拼接后的 JSON 不会被遮蔽）。
 *
 * 用法（CI）：
 *   E2E_SSH_HOST=... E2E_SSH_PORT=22 ... node scripts/write-e2e-environments.mjs
 */

import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(repoRoot, 'e2e', 'environments.json');

/** 必填 secret：环境变量名 → `environments.json` 里的路径（报错时好定位到字段） */
const REQUIRED = [
  ['E2E_SSH_HOST', 'ssh.host'],
  ['E2E_SSH_PORT', 'ssh.port'],
  ['E2E_SSH_USER', 'ssh.user'],
  ['E2E_SSH_PASSWORD', 'ssh.password'],
  // 挂载代理的「免密 sudo 不可用 → 三选一凭据」通道要用同一台机器上的第二个账号
  //（`e2e/README.md` 的「测试环境配置」）。缺它时 overlayMountProxyRemote 在收集期报错，
  // 那时才失败会让人误读成产品缺陷，因此在写文件的这一步就拦下。
  ['E2E_SSH_SUDO_USER', 'ssh.sudoPasswordRequired.user'],
  ['E2E_SSH_SUDO_PASSWORD', 'ssh.sudoPasswordRequired.password'],
];

const missing = REQUIRED.filter(([name]) => {
  const value = process.env[name];
  return typeof value !== 'string' || value.length === 0;
});
if (missing.length > 0) {
  console.error('缺少 CI secret，无法生成 e2e/environments.json：');
  for (const [name, field] of missing) console.error(`  - ${name}（对应 ${field}）`);
  console.error(
    '\n请在仓库 Settings → Secrets and variables → Actions 里补上这些 secret；'
    + '本脚本不补默认值、不跳过用例（口径同 e2e/README.md 的「测试环境配置」）。',
  );
  process.exit(1);
}

const port = Number(process.env.E2E_SSH_PORT);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error('E2E_SSH_PORT 必须是 1–65535 的整数（当前值不是）。');
  process.exit(1);
}

/** 可选：mock LLM 对外广播的主机（隧道优先，配了也不冲突，见 e2e/README.md） */
const advertiseHost = process.env.E2E_SSH_LLM_ADVERTISE_HOST;

const environments = {
  ssh: {
    host: process.env.E2E_SSH_HOST,
    port,
    user: process.env.E2E_SSH_USER,
    password: process.env.E2E_SSH_PASSWORD,
    // 空串按「没配」处理：GitHub 里不存在的 secret 会渲染成空串
    ...(advertiseHost ? { llmAdvertiseHost: advertiseHost } : {}),
    sudoPasswordRequired: {
      user: process.env.E2E_SSH_SUDO_USER,
      password: process.env.E2E_SSH_SUDO_PASSWORD,
    },
  },
};

// 0o600：文件里有明文口令，别让它比本机手工建的那份更宽松
writeFileSync(target, `${JSON.stringify(environments, null, 2)}\n`, { mode: 0o600 });
console.log(`已写出 ${target}（ssh 段来自 CI secrets，内容不打印）`);
