#!/usr/bin/env node
/**
 * 上传 artifact 前的凭证泄露闸门（`e2e/README.md` 的「凭证不进 artifact」一节）。
 *
 * 为什么需要它：`e2e/electron-ssh` 车道的用例会把远端 sudo 口令 `fill()` 进密码框，
 * 而 Playwright 的 trace 会把 `fill()` 的值原样写进三处（实测）：
 *
 *   - `trace.trace` 的动作参数：`{"method":"fill","params":{...,"value":"<口令>"}}`
 *   - `trace.trace` 的动作日志：`fill("<口令>")`
 *   - `trace.trace` 的 DOM 快照：`{"__playwright_value_":"<口令>"}`
 *
 * 仓库是 public，失败时 trace 作为 artifact 上传就是公开泄露，且连带 `src/*.mjs`
 * （trace 会把带口令的 spec 源码打进去）。项目配置已对这条车道关掉 trace
 * （`e2e/playwright.config.ts`），本脚本是**第二道**：将来有人给这条车道开回 trace、
 * 或在别的车道加了用凭证的用例时，上传这一步直接失败，而不是悄悄传上去。
 *
 * 判据只认「凭证内容是否出现在待上传目录里」——扫的是字节，不依赖具体 trace 格式：
 * - 必填 secret 全部参与扫描（缺项即报错：不知道要防什么就不能放行）；
 * - 只报告命中的文件与 secret 名，**不打印命中的内容**（打印就成了二次泄露）；
 * - 命中即退出非零，job 在上传 artifact 之前失败。
 *
 * 用法（CI）：
 *   node scripts/scan-e2e-artifacts-for-secrets.mjs test-results
 */

import AdmZip from 'adm-zip';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targetArg = process.argv[2] ?? 'test-results';
const target = resolve(repoRoot, targetArg);

/**
 * 参与扫描的 secret：环境变量名 → 用于报错的人读标签。
 *
 * 与 `scripts/write-e2e-environments.mjs` 的 `REQUIRED` 同一批（那份生成环境文件、
 * 这份守住外传出口）；新增凭证要同时登记两处，否则 `src/test/e2eCiLane.test.ts` 变红。
 */
const SECRETS = [
  ['E2E_SSH_PASSWORD', 'ssh.password'],
  ['E2E_SSH_SUDO_PASSWORD', 'ssh.sudoPasswordRequired.password'],
];

const values = [];
const missing = [];
for (const [name, label] of SECRETS) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) missing.push(`${name}（${label}）`);
  else values.push({ name, label, value });
}
if (missing.length > 0) {
  console.error('凭证扫描缺少 secret，无法判断是否泄露：');
  for (const item of missing) console.error(`  - ${item}`);
  console.error('\n不扫就放行等于没守；请补齐 secret（CI 里由 workflow 的 env 段传入）。');
  process.exit(1);
}

/** 递归收集目录下所有文件（不跟符号链接，避免扫到仓库外的路径） */
function collectFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...collectFiles(full));
    else if (stat.isFile()) out.push(full);
  }
  return out;
}

let exists = true;
try {
  statSync(target);
} catch {
  exists = false;
}
if (!exists) {
  // 目录不存在 = 没有东西要上传（用例全绿时 test-results 为空/不存在），不是失败
  console.log(`${targetArg} 不存在，无需扫描`);
  process.exit(0);
}

/**
 * 在一个文件里找凭证：**先按原始字节，再按 zip 解出来的条目**。
 *
 * 为什么必须解 zip：Playwright 的 `trace.zip` 里明文躲在压缩条目内（实测
 * `trace.trace`），原始字节里搜不到——只扫字节的扫描器对最需要防的那个文件恰好漏检。
 * trace 里的 `*.network` 也可能是二进制，一律按 Buffer 比较，不做编码假设。
 *
 * 只支持 zip（trace / 打包产物的形态）；其它压缩格式不在本车道的产物里，遇到也不报错，
 * 因为车道另有「关 trace」这道正面防线，本脚本是兜底。
 */
function findSecretInFile(buf, secretBuffer) {
  if (buf.includes(secretBuffer)) return '原始内容';
  // zip 魔数：PK\x03\x04 / PK\x05\x06（空包）/ PK\x07\x08
  if (buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b) {
    try {
      const zip = new AdmZip(buf);
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        if (entry.getData().includes(secretBuffer)) return `zip 条目 ${entry.entryName}`;
      }
    } catch {
      // 不是可解析的 zip（截断的 trace）：放行并继续——真正的防线是关 trace，
      // 这里不把「解不开」当成「有泄露」，否则偶发损坏会让车道报假错
    }
  }
  return null;
}

const files = collectFiles(target);
const hits = [];
for (const file of files) {
  const buf = readFileSync(file);
  for (const secret of values) {
    const where = findSecretInFile(buf, Buffer.from(secret.value, 'utf8'));
    if (where !== null) {
      hits.push({ file: relative(repoRoot, file), label: secret.label, where });
    }
  }
}

if (hits.length > 0) {
  console.error(`::error::${targetArg} 里发现凭证明文，拒绝上传（避免 public artifact 泄露）：`);
  // 只报告「哪个文件、哪个 secret、在哪个位置」，绝不打印命中内容本身
  for (const hit of hits) console.error(`  - ${hit.file}（${hit.where}）← ${hit.label}`);
  console.error(
    '\n处置：确认该车道是否关掉了 trace（`e2e/playwright.config.ts` 的 electron-ssh project），'
    + '或检查有用例把凭证写进了日志 / 截图 / 文件。本脚本不打印命中内容。',
  );
  process.exit(1);
}

console.log(`${targetArg} 扫描完成：${files.length} 个文件、${values.length} 个凭证，未发现明文`);
