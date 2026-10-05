import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { test, expect } from '@playwright/test';

/**
 * TUI 版安装程序 e2e（docs/tui-installer.md）。
 *
 * 场景级：构建宿主平台的安装器 → 安装到临时前缀 → 验证布局与载荷完整性 →
 * 内嵌 Core 可执行（--version）→ 安装目录里的 TUI 可启动（--version 与
 * 非 TTY 守卫两条路径，后者同时验证「从安装位置解析 Core 产物」的候选链）。
 *
 * 前置产物：`npm run build:core`（宿主平台）；TUI bundle 由构建脚本自动补建。
 * workers=1 顺序执行，安装前缀在 beforeAll 建一次、全部用例共用。
 */

const run = promisify(execFile);

const repoRoot = path.resolve(__dirname, '..', '..');
const hostPlatform = process.platform as 'win32' | 'linux' | 'darwin';
const hostArch = process.arch as 'x64' | 'arm64';

function hostPkgDir(): string {
  if (hostPlatform === 'win32') return hostArch === 'arm64' ? 'arm64-win32' : 'x64-win32';
  return hostArch === 'arm64' ? 'arm64-linux' : 'x64-linux';
}

function hostExt(): string {
  return hostPlatform === 'win32' ? '.exe' : '';
}

const pkgDir = hostPkgDir();
const ext = hostExt();
const installerPath = path.join(repoRoot, 'release', 'tui-installer', `tuxedo-cat-tui-installer-${pkgDir}${ext}`);

let prefix = '';

test.beforeAll(async () => {
  prefix = mkdtempSync(path.join(os.tmpdir(), 'tui-installer-e2e-'));
  // 宿主平台 Core 产物（darwin 等无产物平台整文件跳过）
  const core = path.join(repoRoot, 'resources', 'core', pkgDir, `tuxedo-cat-core${ext}`);
  test.skip(!existsSync(core), `宿主平台 Core 产物缺失（${core}）：先 npm run build:core`);

  // 构建宿主安装器（cargo 缓存命中时很快）
  const { stdout } = await run('node', [path.join(repoRoot, 'scripts', 'build-tui-installer.mjs'), '--host'], {
    cwd: repoRoot,
    timeout: 300_000,
  });
  expect(stdout).toContain('[build-tui-installer]');

  // 安装一次，后续用例共用同一前缀
  const installed = await run(installerPath, ['--prefix', prefix], { timeout: 120_000 });
  expect(installed.stdout).toContain('已安装：tui.mjs');
});

test('安装布局完整（tui.mjs + Core + ripgrep + 指纹）', () => {
  const layout = [
    path.join(prefix, 'tui.mjs'),
    path.join(prefix, 'resources', 'core', pkgDir, `tuxedo-cat-core${ext}`),
    path.join(prefix, 'resources', 'core', pkgDir, 'ripgrep', `rg${ext}`),
    path.join(prefix, 'resources', 'core', pkgDir, 'fingerprint'),
  ];
  for (const file of layout) expect(existsSync(file), file).toBe(true);

  // 指纹与仓库产物一致（载荷没有被换掉）
  const fingerprint = readFileSync(path.join(prefix, 'resources', 'core', pkgDir, 'fingerprint'), 'utf8').trim();
  const repoFingerprint = readFileSync(path.join(repoRoot, 'resources', 'core', pkgDir, 'fingerprint'), 'utf8').trim();
  expect(fingerprint).toBe(repoFingerprint);
  expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
});

test('重复安装幂等（内容未变全部跳过）', async () => {
  const second = await run(installerPath, ['--prefix', prefix], { timeout: 120_000 });
  expect(second.stdout).toContain('未变化：tui.mjs');
  expect(second.stdout).not.toContain('已安装：tui.mjs');
});

test('内嵌 Core 可执行（--version 报告指纹）', async () => {
  const core = path.join(prefix, 'resources', 'core', pkgDir, `tuxedo-cat-core${ext}`);
  const { stdout } = await run(core, ['--version'], { timeout: 60_000 });
  expect(stdout.trim().length).toBeGreaterThan(0);
});

test('安装目录里的 TUI 可启动（--version / 非 TTY 守卫）', async () => {
  const tui = path.join(prefix, 'tui.mjs');

  const version = await run(process.execPath, [tui, '--version'], { timeout: 60_000 });
  expect(version.stdout).toContain('tuxedo-cat tui');

  // 非 TTY：启动守卫报可行动错误。此路径已先完成 Core 产物解析——
  // 若安装布局不完整会先得到「未找到 Standalone Core 产物」而失败
  const result = await run(process.execPath, [tui, '--workspace', prefix], {
    timeout: 60_000,
    env: { ...process.env, TUXEDO_CAT_TUI_ROOT: prefix },
  }).then(
    (ok) => ({ stdout: ok.stdout, stderr: '' }),
    (err) => ({ stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }),
  );
  expect(result.stderr).toContain('交互式终端');
});
