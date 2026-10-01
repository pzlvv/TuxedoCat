#!/usr/bin/env node
/**
 * Standalone Core（Rust）构建脚本（见 docs/standalone-core.md 第 4.1 节）。
 *
 * 用法：
 *   node scripts/build-core.mjs                        # 打包要携带的全部目标，release
 *   node scripts/build-core.mjs --host                 # 只建当前平台 / 架构
 *   node scripts/build-core.mjs --target <triple>      # 只建指定目标三元组
 *   node scripts/build-core.mjs --debug                # debug 构建（保留控制台）
 *
 * 产物落位：resources/<core.resourceDir>/<arch>-<platform>/<core.binaryName>[.exe]
 * 目录命名与 resources/ripgrep/ 一致；copy-assets 会把它带进 dist/resources。
 * 同一目录下还会落一份自带的 `ripgrep/rg[.exe]`（Grep / Glob 用的 rg）：
 * Core 以**自己的可执行文件目录**为基准定位自带资源，本地与远端都是这一个位置。
 *
 * 产品名与产物名一律取自 src/config/project.json（`core.binaryName` /
 * `core.resourceDir`），本脚本不写死。Rust 侧的包名固定为中性的 `standalone-core`，
 * 这里按配置重命名后落位。
 *
 * 默认构建的是**打包要携带的全部目标**（`PACKAGE_DIRS`），不是只建当前平台：
 * 只建当前平台时，打包会静默带上一次构建的旧 Linux 产物（docs/standalone-core.md
 * 第 4.3 节）。矩阵里其余两项为预留：目标三元组已登记，装好对应 target 即可构建。
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import project from '../project.config.cjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(repoRoot, 'core-rs', 'Cargo.toml');

/** Rust 侧的包 / 二进制名；产品名不进入 Rust 侧 */
const CRATE_BIN_NAME = 'standalone-core';

/** 落位目录与文件名（来自工程配置） */
const RESOURCE_DIR = project.core.resourceDir;
const BINARY_NAME = project.core.binaryName;

/**
 * 平台矩阵：`<platform>-<arch>` → 目标三元组与产物目录。
 *
 * Linux 一律用 **musl**：静态链接，不依赖目标机器的 glibc 版本——这个 core 是要拷到
 * 别人的远端机器上跑的，发行版未知，gnu 目标很容易撞上 glibc 版本太旧。
 */
export const TARGETS = [
  { platform: 'win32', arch: 'x64', triple: 'x86_64-pc-windows-msvc', dir: 'x64-win32', ext: '.exe' },
  { platform: 'win32', arch: 'arm64', triple: 'aarch64-pc-windows-msvc', dir: 'arm64-win32', ext: '.exe' },
  { platform: 'linux', arch: 'x64', triple: 'x86_64-unknown-linux-musl', dir: 'x64-linux', ext: '' },
  { platform: 'linux', arch: 'arm64', triple: 'aarch64-unknown-linux-musl', dir: 'arm64-linux', ext: '' },
];

/**
 * 打包要携带的目标（`resources/<core.resourceDir>/` 下必须齐的那几个目录）。
 *
 * 这是**唯一一份**平台列表：`scripts/verify-core-artifacts.mjs` 直接 import 它，
 * 不再各写一遍，免得「构建的」与「校验的」漂移（docs/standalone-core.md 第 4.3 节）。
 */
export const PACKAGE_DIRS = ['x64-win32', 'x64-linux'];

/**
 * 本机能否直接构建该目标。
 *
 * - Linux musl：任意宿主都能交叉编译（链接器 rust-lld，C / 汇编那部分由 zig 提供，
 *   见 `crossToolchainEnv`）；
 * - Windows msvc：只能在 Windows 上（MSVC 链接器不跨平台）。
 *
 * 只用来过滤**默认目标集合**；显式 `--target` 时不看这个，构建失败就如实报错。
 */
function buildableOnHost(target) {
  return target.platform === 'linux' || target.platform === process.platform;
}

/**
 * 交叉编译到 Linux 时的 C 工具链。
 *
 * Rust 那部分不需要系统工具链（rustup 自带 musl 的 crt / libc，链接器用 rust-lld，
 * 见 `core-rs/.cargo/config.toml`）；但 `ring` 里有 C + 汇编，cc-rs 需要一个能产出
 * 该目标文件的 C 编译器。用 zig：它自带 clang 与 musl 头文件 / libc，
 * 一个可执行文件就够，不用装交叉 gcc。
 *
 * 本机就是 Linux 时不注入：系统自带的 cc 能直接编 musl（装了 musl-tools 的话）。
 */
function crossToolchainEnv(target) {
  const isLinuxTriple = target.triple.endsWith('-linux-musl');
  if (!isLinuxTriple || process.platform === 'linux') return {};

  const zig = process.env.ZIG || 'zig';
  const probe = spawnSync(zig, ['version'], { stdio: 'ignore', shell: false });
  if (probe.error || probe.status !== 0) {
    console.error(
      `[build-core] 交叉编译 ${target.triple} 需要 zig（ring 的 C / 汇编要一个 C 编译器）：` +
        `找不到 \`${zig}\`。安装方式见 docs/standalone-core.md 第 4.1 节；` +
        '已装在别处时用环境变量 ZIG 指定可执行文件路径。',
    );
    process.exit(1);
  }

  // cc-rs 认 `zig cc`，但它会按 **Rust 三元组** 补 `--target=x86_64-unknown-linux-musl`；
  // zig 0.16 起不再接受 `unknown` 这个 OS 名（报 UnknownOperatingSystem），
  // 所以要再用 CFLAGS 追加一个 zig 认的目标（clang 取最后一个 --target）。
  const key = target.triple.replace(/-/g, '_');
  const zigTarget = target.triple.replace('-unknown-', '-');
  return {
    [`CC_${key}`]: `${zig} cc`,
    [`CFLAGS_${key}`]: `--target=${zigTarget}`,
    [`AR_${key}`]: `${zig} ar`,
  };
}

function parseArgs(argv) {
  const options = { debug: false, host: false, target: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--debug') {
      options.debug = true;
    } else if (arg === '--host') {
      options.host = true;
    } else if (arg === '--target') {
      options.target = argv[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith('--target=')) {
      options.target = arg.slice('--target='.length);
    } else {
      console.error(`未知参数：${arg}`);
      process.exit(2);
    }
  }
  return options;
}

/** 按三元组取平台矩阵里的一条；不在矩阵内直接报错，不猜目标 */
function findTarget(triple) {
  const match = TARGETS.find((entry) => entry.triple === triple);
  if (!match) {
    console.error(
      `目标三元组 ${triple} 不在平台矩阵内。可用：\n` +
        TARGETS.map((entry) => `  ${entry.triple}  (${entry.dir})`).join('\n'),
    );
    process.exit(2);
  }
  return match;
}

/** 当前平台 / 架构对应的那条 */
function hostTarget() {
  const match = TARGETS.find(
    (entry) => entry.platform === process.platform && entry.arch === process.arch,
  );
  if (!match) {
    console.error(
      `当前平台 ${process.platform}/${process.arch} 不在平台矩阵内；` +
        '请用 --target 指定目标三元组。',
    );
    process.exit(2);
  }
  return match;
}

/**
 * 解析出本次要构建的目标列表。
 *
 * - `--target`：只建指定的那一个；
 * - `--host`：只建当前平台 / 架构；
 * - 默认：打包要携带的全部目标（`PACKAGE_DIRS`），按本机能否构建过滤。
 */
function resolveTargets(options) {
  if (options.target && options.host) {
    console.error('--target 与 --host 不能同时使用。');
    process.exit(2);
  }
  if (options.target) return [findTarget(options.target)];
  if (options.host) return [hostTarget()];

  const required = PACKAGE_DIRS.map((dir) => {
    const entry = TARGETS.find((item) => item.dir === dir);
    if (!entry) {
      console.error(`PACKAGE_DIRS 里的 ${dir} 不在平台矩阵内。`);
      process.exit(2);
    }
    return entry;
  });

  // 本机构建不了的组合显式说明后跳过（不是静默降级）：Windows msvc 目标只能在
  // Windows 上构建，其余平台靠显式 --target 表达意图。
  for (const entry of required.filter((item) => !buildableOnHost(item))) {
    console.log(
      `[build-core] 跳过 ${entry.triple}：当前宿主 ${process.platform} 构建不了它。` +
        `要在本机产出，用 --target ${entry.triple} 显式指定。`,
    );
  }

  const targets = required.filter(buildableOnHost);
  if (targets.length === 0) {
    console.error('[build-core] 当前宿主构建不了打包要携带的任何目标。');
    process.exit(2);
  }
  return targets;
}

/** 构建单个目标并把产物落位到 resources/ */
function buildTarget(target, options) {
  const profile = options.debug ? 'debug' : 'release';

  const cargoArgs = ['build', '--manifest-path', manifestPath, '--target', target.triple];
  if (!options.debug) cargoArgs.push('--release');

  console.log(`[build-core] cargo ${cargoArgs.join(' ')}`);
  const env = { ...process.env, ...crossToolchainEnv(target) };
  // cwd 必须是 crate 目录：cargo 只从**当前目录**往上找 `.cargo/config.toml`，
  // 而 musl 的链接器（rust-lld）就配在 `core-rs/.cargo/config.toml` 里。
  // target 目录不受影响（由 manifest 所在的 workspace 决定）。
  const result = spawnSync('cargo', cargoArgs, {
    stdio: 'inherit',
    cwd: dirname(manifestPath),
    env,
  });
  if (result.error) {
    console.error(`[build-core] 无法执行 cargo：${result.error.message}`);
    console.error('请安装 Rust 工具链：https://rustup.rs');
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(
      `[build-core] cargo 构建失败（exit ${result.status}）。` +
        `若提示目标未安装，执行：rustup target add ${target.triple}`,
    );
    process.exit(result.status ?? 1);
  }

  const built = join(
    repoRoot,
    'core-rs',
    'target',
    target.triple,
    profile,
    `${CRATE_BIN_NAME}${target.ext}`,
  );
  if (!existsSync(built)) {
    console.error(`[build-core] 未找到构建产物：${built}`);
    process.exit(1);
  }

  const outDir = join(repoRoot, 'resources', RESOURCE_DIR, target.dir);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${BINARY_NAME}${target.ext}`);
  copyFileSync(built, outPath);
  console.log(`[build-core] ${target.triple} → ${outPath}`);

  copyBundledRipgrep(target, outDir);
}

/**
 * 把 ripgrep 可执行文件复制到 Core 可执行文件同级。
 *
 * Core 自带资源的定位基准是**自己的可执行文件所在目录**（`tools.rs::ripgrep_path`）：
 * 本地由宿主从 `resources/<core.resourceDir>/<dir>/` 起进程，远端由 Host 的 SSH 引导
 * 上传同一个位置（`src/host/standalone/sshDaemonBootstrap.ts`）。因此 Core 与它的
 * `ripgrep/rg[.exe]` 必须落在一起——少了它 Grep / Glob 只能靠目标机器 PATH 上的 `rg`。
 */
function copyBundledRipgrep(target, outDir) {
  const name = target.platform === 'win32' ? 'rg.exe' : 'rg';
  const source = join(repoRoot, 'resources', 'ripgrep', target.dir, name);
  if (!existsSync(source)) {
    console.error(
      `[build-core] 缺少该平台的 ripgrep 产物：${source}\n` +
        `             Core 自带的 ripgrep 必须与可执行文件一起落位（docs/standalone-core.md 第 4 节）。`,
    );
    process.exit(1);
  }
  const dest = join(outDir, 'ripgrep');
  mkdirSync(dest, { recursive: true });
  copyFileSync(source, join(dest, name));
  console.log(`[build-core] ${target.dir} 自带 ripgrep → ${join(dest, name)}`);
}

function main() {
  // embedded 变体走进程内 TypeScript Core，不需要 Rust Core 产物；打包流程照样调用本脚本。
  if (project.coreKind === 'embedded') {
    console.log('[build-core] TUXEDO_CAT_CORE=embedded：embedded 变体不需要 Rust Core，跳过。');
    return;
  }

  const options = parseArgs(process.argv.slice(2));
  const targets = resolveTargets(options);

  if (!existsSync(manifestPath)) {
    console.error(`找不到 Rust 包：${manifestPath}`);
    process.exit(1);
  }

  for (const target of targets) buildTarget(target, options);
}

// 被 import 时（`scripts/verify-core-artifacts.mjs` 复用平台列表）只暴露数据，不执行构建。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
