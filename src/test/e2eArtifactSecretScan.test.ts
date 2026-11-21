/**
 * 凭证外传闸门（`scripts/scan-e2e-artifacts-for-secrets.mjs`）的行为：
 * 上传 artifact 之前，`test-results/` 里只要出现口令明文就让 job 失败
 * （`e2e/README.md` 的「凭证不进 artifact」一节）。
 *
 * 为什么必须测 zip 那一支：Playwright 的 `trace.zip` 是**压缩**的，明文躲在
 * `trace.trace` 条目里，原始字节里搜不到。第一版扫描器只按字节搜，对最需要防的那个
 * 文件恰好漏检（实测：`raw.includes(plaintext) === false`，解 zip 才看得见）。
 *
 * 跑法：`npm run test:unit -- e2eArtifactSecretScan`
 */

import * as assert from 'assert';
import AdmZip from 'adm-zip';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from './helpers/harness';

/** 仓库根：编译产物在 `out/src/test/`，往上三层 */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCANNER = path.join(REPO_ROOT, 'scripts', 'scan-e2e-artifacts-for-secrets.mjs');

const PASSWORD = 'Pw-ssh-plain-aaa';
const SUDO_PASSWORD = 'Pw-sudo-plain-bbb';

interface Run {
  code: number;
  output: string;
}

function scan(dir: string, env: Record<string, string> = {}): Run {
  try {
    const output = execFileSync(process.execPath, [SCANNER, dir], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        E2E_SSH_PASSWORD: PASSWORD,
        E2E_SSH_SUDO_PASSWORD: SUDO_PASSWORD,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** 每次用独立临时目录，互不干扰 */
function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tc-secret-scan-'));
}

runTests('e2eArtifactSecretScan', () => {
  // RT-1：干净目录放行（全绿时 test-results 为空，不能因此让 job 变红）
  {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'no credentials here');
    const result = scan(dir);
    assert.strictEqual(result.code, 0, `干净目录应放行，实际退出码 ${result.code}：${result.output}`);
  }

  // RT-2：目录不存在也放行（用例全绿时 Playwright 不建目录）
  {
    const dir = path.join(tempDir(), 'not-created');
    const result = scan(dir);
    assert.strictEqual(result.code, 0, `目录不存在应放行，实际 ${result.code}：${result.output}`);
  }

  // RT-3：明文文件命中即拦截
  {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'debug.log'), `fill("${SUDO_PASSWORD}")`);
    const result = scan(dir);
    assert.strictEqual(result.code, 1, '明文文件必须被拦下');
    assert.ok(result.output.includes('debug.log'), '报错要指出命中的文件');
  }

  // RT-4：**压缩的 trace.zip** 命中即拦截（第一版漏检的正是这一支）
  {
    const dir = tempDir();
    const zip = new AdmZip();
    zip.addFile('trace.trace', Buffer.from(
      `${JSON.stringify({ method: 'fill', params: { value: PASSWORD } })}\n`,
    ));
    zip.writeZip(path.join(dir, 'trace.zip'));
    // 前提校验：明文在原始字节里确实不可见（否则这条用例测不到解压分支）
    const raw = fs.readFileSync(path.join(dir, 'trace.zip'));
    assert.ok(!raw.includes(Buffer.from(PASSWORD)), 'zip 压缩后原始字节不应含明文（用例前提）');
    const result = scan(dir);
    assert.strictEqual(result.code, 1, '压缩 trace 里的明文必须被拦下');
    assert.ok(result.output.includes('trace.zip'), '报错要指出命中的文件');
  }

  // RT-5：报错不打印命中的凭证本身（打印就是二次泄露）
  {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'leak.txt'), PASSWORD);
    const result = scan(dir);
    assert.strictEqual(result.code, 1);
    assert.ok(!result.output.includes(PASSWORD), '输出里不得出现凭证内容');
    assert.ok(!result.output.includes(SUDO_PASSWORD), '输出里不得出现另一个凭证内容');
  }

  // RT-6：缺少 secret 时不放行（不知道要防什么就不能上传）
  {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'anything.txt'), 'x');
    const result = scan(dir, { E2E_SSH_PASSWORD: '', E2E_SSH_SUDO_PASSWORD: '' });
    assert.strictEqual(result.code, 1, '缺 secret 必须失败，而不是跳过扫描');
  }

  console.log('全部通过');
});
