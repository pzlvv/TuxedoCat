import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { test, expect } from '@playwright/test';
import {
  CORE_BINARY_NAME,
  CORE_DEPLOY_PREFIX,
  ENV_PREFIX,
  EXTENSION_NAME,
} from '../../src/config/project';

/**
 * TUI 版安装程序 e2e（docs/tui-installer.md）。
 *
 * 场景级：构建宿主平台的安装器 → 安装到临时前缀 → 验证部署布局与载荷完整性 →
 * 内嵌 Core 可执行（--version）→ 安装目录里的 TUI 可启动（--version 与
 * 非 TTY 守卫两条路径，后者同时验证「从部署前缀解析指纹槽位」的候选链）。
 *
 * 部署布局：`<prefix>/share/<产品名>/<指纹>/core + fingerprint`、
 * `<prefix>/share/<产品名>/ripgrep/rg`、`<prefix>/share/<产品名>/tui`。
 *
 * 前置产物：`npm run build:core`（宿主平台）；TUI 二进制由构建脚本自动补建。
 * workers=1 顺序执行，安装前缀在 beforeAll 建一次、全部用例共用。
 */

const run = promisify(execFile);

const repoRoot = path.resolve(__dirname, '..', '..');
/** 部署产品目录名（`src/config/project.json` 的 `core.deployPrefix`，与安装器同一来源） */
const PRODUCT = CORE_DEPLOY_PREFIX;
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
const installerPath = path.join(
  repoRoot,
  'release',
  'tui-installer',
  `${EXTENSION_NAME}-tui-installer-${pkgDir}${ext}`,
);

let prefix = '';
let fingerprint = '';
let slotDir = '';

test.beforeAll(async () => {
  prefix = mkdtempSync(path.join(os.tmpdir(), 'tui-installer-e2e-'));
  // 宿主平台 Core 产物（darwin 等无产物平台整文件跳过）
  const core = path.join(repoRoot, 'resources', 'core', pkgDir, `${CORE_BINARY_NAME}${ext}`);
  test.skip(!existsSync(core), `宿主平台 Core 产物缺失（${core}）：先 npm run build:core`);
  fingerprint = readFileSync(path.join(repoRoot, 'resources', 'core', pkgDir, 'fingerprint'), 'utf8').trim();
  slotDir = path.join(prefix, 'share', PRODUCT, fingerprint);

  // 构建宿主安装器（cargo 缓存命中时很快）
  const { stdout } = await run('node', [path.join(repoRoot, 'scripts', 'build-tui-installer.mjs'), '--host'], {
    cwd: repoRoot,
    timeout: 300_000,
  });
  expect(stdout).toContain('[build-tui-installer]');

  // 安装一次，后续用例共用同一前缀
  const installed = await run(installerPath, ['--prefix', prefix], { timeout: 120_000 });
  expect(installed.stdout).toContain(`已安装：share/${PRODUCT}/tui${ext}`);
});

test('部署布局完整（TUI + 指纹槽位 + 共享 ripgrep）', () => {
  const layout = [
    path.join(prefix, 'share', PRODUCT, `tui${ext}`),
    path.join(slotDir, `${CORE_BINARY_NAME}${ext}`),
    path.join(slotDir, 'fingerprint'),
    path.join(prefix, 'share', PRODUCT, 'ripgrep', `rg${ext}`),
  ];
  for (const file of layout) expect(existsSync(file), file).toBe(true);

  // 槽位指纹与仓库产物一致（载荷没有被换掉），且是 64 位小写 hex
  const installedFingerprint = readFileSync(path.join(slotDir, 'fingerprint'), 'utf8').trim();
  expect(installedFingerprint).toBe(fingerprint);
  expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
});

test('重复安装幂等（内容未变全部跳过）', async () => {
  const second = await run(installerPath, ['--prefix', prefix], { timeout: 120_000 });
  expect(second.stdout).toContain(`未变化：share/${PRODUCT}/tui${ext}`);
  expect(second.stdout).not.toContain(`已安装：share/${PRODUCT}/tui${ext}`);
});

test('内嵌 Core 可执行（--version 报告指纹）', async () => {
  const core = path.join(slotDir, `${CORE_BINARY_NAME}${ext}`);
  const { stdout } = await run(core, ['--version'], { timeout: 60_000 });
  expect(stdout).toContain(fingerprint);
});

test('安装目录里的 TUI 可启动（--version / 非 TTY 守卫）', async () => {
  const tui = path.join(prefix, 'share', PRODUCT, `tui${ext}`);

  const version = await run(tui, ['--version'], { timeout: 60_000 });
  expect(version.stdout).toContain(`${PRODUCT} tui`);

  // 非 TTY：启动守卫报可行动错误。此路径已先完成 Core 产物解析——
  // 若部署布局不完整会先得到「未找到 Standalone Core 产物」而失败
  const result = await run(tui, ['--workspace', prefix], {
    timeout: 60_000,
    env: { ...process.env, [`${ENV_PREFIX}_TUI_ROOT`]: prefix },
  }).then(
    (ok) => ({ stdout: ok.stdout, stderr: '' }),
    (err) => ({ stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }),
  );
  expect(result.stderr).toContain('交互式终端');
});
