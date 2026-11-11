import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { createChecker, runTests } from './helpers/harness';

/**
 * Core 构建脚本的 C 工具链与 cargo 调用形态（`docs/core/standalone-core.md` 第 3.3 节）。
 *
 * msvc 目标的构建路径取决于**宿主平台**，不是只看目标三元组：
 * - Windows 宿主本机就有 MSVC 与 Windows SDK，x64 目标直接交给 rustc 定位 `cl.exe` /
 *   `lib.exe`；arm64 目标的 C / 汇编要 clang（ring 对 Windows AArch64 硬性要求），由
 *   `zig cc` 充当；
 * - 非 Windows 宿主没有 `lib.exe` 与 SDK 库，msvc 目标经 `cargo xwin`（自带整套 SDK）。
 *
 * 本文件锁这三条边界（回归载体见
 * [specs/defects/windows-core-build-forces-cargo-xwin.md](../../specs/defects/windows-core-build-forces-cargo-xwin.md)）：
 * 宿主维度不能丢（否则本机能编的目标被判成需要外部 cargo 子命令），交叉维度也不能丢
 * （否则非 Windows 宿主失去 xwin 这条路径）。
 *
 * 运行方式：`npm run test:unit -- core-build-toolchain`
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');

/** 一个能驱动 `scripts/build-core.mjs` 的 ESM 小程序（脚本是 ESM，测试编译产物是 CJS） */
function runEsm(body: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', body], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

interface Probe {
  exported?: boolean;
  x64HostWin?: string[];
  arm64HostWin?: string[];
  x64HostLinux?: string[];
  arm64HostLinux?: string[];
  winArm64Env?: Record<string, string>;
  winX64Env?: Record<string, string>;
  linuxMuslEnv?: Record<string, string>;
  error?: string;
}

runTests('coreBuildToolchain', async () => {
  const { check, finish } = createChecker();

  const probe = runEsm(
    `const m = await import('./scripts/build-core.mjs');
     const out = { exported: false };
     try {
       if (typeof m.cargoInvocation === 'function' && typeof m.crossToolchainEnv === 'function') {
         out.exported = true;
         out.x64HostWin = m.cargoInvocation('x86_64-pc-windows-msvc', 'win32').args;
         out.arm64HostWin = m.cargoInvocation('aarch64-pc-windows-msvc', 'win32').args;
         out.x64HostLinux = m.cargoInvocation('x86_64-pc-windows-msvc', 'linux').args;
         out.arm64HostLinux = m.cargoInvocation('aarch64-pc-windows-msvc', 'linux').args;
         out.winArm64Env = m.crossToolchainEnv('aarch64-pc-windows-msvc', 'win32');
         out.winX64Env = m.crossToolchainEnv('x86_64-pc-windows-msvc', 'win32');
         out.linuxMuslEnv = m.crossToolchainEnv('x86_64-unknown-linux-musl', 'win32');
       }
     } catch (error) {
       out.error = String(error && error.message ? error.message : error);
     }
     console.log(JSON.stringify(out));`,
  );

  check('build-core.mjs 可加载并给出构建判据', probe.status === 0);
  let parsed: Probe = {};
  try {
    parsed = JSON.parse(probe.stdout.trim() || '{}') as Probe;
  } catch {
    parsed = {};
  }
  if (probe.status !== 0 || parsed.exported !== true) {
    console.log(`     ${(probe.stderr.split('\n').slice(0, 3).join(' ')).trim() || parsed.error || ''}`);
  }

  // ---------- RT-1：Windows 宿主上 msvc 目标不经 cargo xwin ----------
  check('cargoInvocation / crossToolchainEnv 已导出', parsed.exported === true);
  check(
    'RT-1：Windows 宿主上 x64 msvc 目标不带 xwin 子命令',
    Array.isArray(parsed.x64HostWin) && !parsed.x64HostWin.includes('xwin'),
  );
  check(
    'RT-1：Windows 宿主上 arm64 msvc 目标不带 xwin 子命令',
    Array.isArray(parsed.arm64HostWin) && !parsed.arm64HostWin.includes('xwin'),
  );

  // ---------- RT-2：非 Windows 宿主仍经 cargo xwin ----------
  check(
    'RT-2：非 Windows 宿主上 x64 msvc 目标经 cargo xwin',
    Array.isArray(parsed.x64HostLinux) && parsed.x64HostLinux.includes('xwin'),
  );
  check(
    'RT-2：非 Windows 宿主上 arm64 msvc 目标经 cargo xwin',
    Array.isArray(parsed.arm64HostLinux) && parsed.arm64HostLinux.includes('xwin'),
  );

  // ---------- RT-3：Windows 宿主的 C 工具链按目标架构分档 ----------
  const arm64Env = parsed.winArm64Env ?? {};
  const arm64Keys = Object.keys(arm64Env);
  check(
    'RT-3：Windows 宿主上 arm64 目标的 CC 是 zig cc',
    /zig/.test(arm64Env.CC_aarch64_pc_windows_msvc ?? '') &&
      /\bcc\b/.test(arm64Env.CC_aarch64_pc_windows_msvc ?? ''),
  );
  check(
    'RT-3：Windows 宿主上 arm64 目标的 CFLAGS 用 zig 认的三元组（去掉 vendor 段）',
    (arm64Env.CFLAGS_aarch64_pc_windows_msvc ?? '') === '--target=aarch64-windows-msvc',
  );
  check(
    'RT-3：Windows 宿主上 arm64 目标不注入 AR（静态库仍由 VS 的 lib.exe 打包）',
    !arm64Keys.some((key) => key.startsWith('AR_')),
  );
  check(
    'RT-3：Windows 宿主上 x64 目标不注入任何 C 工具链（rustc 定位本机 MSVC）',
    Object.keys(parsed.winX64Env ?? {}).length === 0,
  );

  // ---------- 不变量：Linux musl 的交叉路径不变 ----------
  const muslEnv = parsed.linuxMuslEnv ?? {};
  check(
    'Linux musl 目标仍注入 zig cc + zig ar',
    /\bcc\b/.test(muslEnv.CC_x86_64_unknown_linux_musl ?? '') &&
      /\bar\b/.test(muslEnv.AR_x86_64_unknown_linux_musl ?? ''),
  );

  finish();
});
