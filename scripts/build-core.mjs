#!/usr/bin/env node
/**
 * Standalone Core（Rust）构建脚本（见 docs/standalone-core.md 第 4.3 节）。
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
 * 同目录还有一份 `fingerprint` 构建指纹（见 computeFingerprint 与
 * docs/standalone-core.md 第 4.4 节）：SSH 部署按指纹落位远端部署目录
 * `~/.local/bin/share/<core.deployPrefix>/<指纹>/`，多版本 Core 在同一台机器上各占一个槽位互不干扰。
 *
 * 产品名与产物名一律取自 src/config/project.json（`core.binaryName` /
 * `core.resourceDir`），本脚本不写死。Rust 侧的包名固定为中性的 `standalone-core`，
 * 这里按配置重命名后落位。
 *
 * 默认构建的是**打包要携带的全部目标**（`PACKAGE_DIRS`），不是只建当前平台：
 * 只建当前平台时，打包会静默带上一次构建的旧 Linux 产物（docs/standalone-core.md
 * 第 4.3 节）。矩阵里其余一项为预留：目标三元组已登记，装好对应 target 即可构建。
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import project from '../project.config.cjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(repoRoot, 'core-rs', 'Cargo.toml');
/** core-rs/ 目录：构建指纹的源码树根（computeFingerprint） */
const manifestDir = dirname(manifestPath);

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
export const PACKAGE_DIRS = ['x64-win32', 'x64-linux', 'arm64-linux'];

// ==================== 构建指纹（docs/standalone-core.md 第 4.4 节）====================

/**
 * 指纹算法版本标签：参与哈希输入，输入集或归一规则变化时递增，避免新旧指纹意外同槽。
 */
const FINGERPRINT_ALGO = 'core-fingerprint-v1';

/** 产物目录里指纹文件的文件名 */
export const FINGERPRINT_FILE_NAME = 'fingerprint';

/**
 * 构建指纹：只依赖**源码内容 + 编译器身份**，与构建时间、构建路径无关——
 * 同一编译器对同一份源码的两次构建必须得到同一指纹，这样不同构建机 /
 * 不同客户端实例产出的同一版本 Core 才会共享同一个远端部署槽位。
 *
 * 语义上是「版本身份」而不是「字节一致」：指纹相同不保证二进制逐字节相同
 * （rustc 可能嵌入绝对路径、C 工具链可能有差异），只保证同一源码 + 同一
 * 编译器；因此远端部署以「指纹目录存在」为准，不再做产物哈希比对。
 *
 * 输入集：
 * - `core-rs/` 工作树全部文件（排除 `target/`），按 POSIX 相对路径排序后哈希
 *   (路径 + '\0' + 内容)。遍历**工作树**而不是 `git ls-files`：未提交的新文件
 *   也必须改变指纹，否则两个不同版本会共用一个远端槽位；`Cargo.lock` 与
 *   `.cargo/config.toml` 都在目录内，依赖版本与链接器配置自然被覆盖。
 * - 行尾归一（`\r\n` → `\n`）：`.gitattributes` 只管 `resources/**`，
 *   `autocrlf` 设置不同的构建机对同一 commit 会检出不同行尾，不归一会分裂指纹。
 * - rustc 身份：`rustc -vV` 的 release / commit-hash / commit-date 三行。
 *   **不含 host 行**：Windows 与 Linux 构建机上是「同一个编译器」，不该分裂指纹。
 * - 目标三元组与 profile（release / debug）：产物语义随它们变化，不同 profile
 *   不共享远端槽位。
 * - 不混入 zig / C 工具链版本：同源码同 rustc 下 C 部分的工具链差异不构成
 *   版本差异，混入只会让不同构建机分裂槽位（这正是要避免的）。
 */

/** 递归收集 core-rs 工作树的文件（排除 target/），返回按 POSIX 相对路径排序的列表 */
function collectCoreSourceFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'target') continue;
        walk(full);
      } else if (entry.isFile()) {
        files.push(relative(manifestDir, full).split('\\').join('/'));
      }
    }
  };
  walk(dirname(manifestPath));
  files.sort();
  return files;
}

/** `rustc -vV` 的编译器身份（release / commit-hash / commit-date 三行，不含 host） */
function rustcIdentity() {
  const result = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    console.error('[build-core] 无法读取 rustc 版本（rustc -vV 失败）：指纹计算依赖编译器身份。');
    process.exit(1);
  }
  const wanted = new Set(['release', 'commit-hash', 'commit-date']);
  const lines = result.stdout
    .split(/\r?\n/)
    .filter((line) => wanted.has(line.slice(0, line.indexOf(':')).trim()));
  if (lines.length === 0) {
    console.error('[build-core] `rustc -vV` 输出里没有 release / commit-hash / commit-date。');
    process.exit(1);
  }
  return lines.join('\n');
}

let cachedTreeHash = null;

/** core-rs 源码树的内容哈希（进程内缓存：一次构建跑多个目标只算一遍） */
function coreSourceTreeHash() {
  if (cachedTreeHash === null) {
    const hash = createHash('sha256');
    for (const relPath of collectCoreSourceFiles()) {
      // 行尾归一见 computeFingerprint 的说明；Cargo.lock 等都是文本，统一按此处理
      const content = readFileSync(join(manifestDir, relPath), 'utf8')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');
      hash.update(relPath);
      hash.update('\0');
      hash.update(content);
      hash.update('\0');
    }
    cachedTreeHash = hash.digest('hex');
  }
  return cachedTreeHash;
}

/** 计算一个构建目标的指纹（64 位小写 hex） */
export function computeFingerprint(triple, profile) {
  const hash = createHash('sha256');
  hash.update(FINGERPRINT_ALGO);
  hash.update('\0');
  hash.update(rustcIdentity());
  hash.update('\0');
  hash.update(triple);
  hash.update('\0');
  hash.update(profile);
  hash.update('\0');
  hash.update(coreSourceTreeHash());
  return hash.digest('hex');
}

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
 * ring 的 C / 汇编需要系统 C 编译器的目标：注入 zig 充当。
 *
 * Rust 那部分不需要系统工具链（musl 用 rustup 自带的 crt / libc + rust-lld，见
 * `core-rs/.cargo/config.toml`；MSVC 目标的链接由 rustc 经 Visual Studio 定位，
 * arm64 要装好 VS 的「MSVC ARM64 生成工具」组件）；但 `ring` 里有 C + 汇编，
 * cc-rs 需要一个能产出该目标文件的 C 编译器：
 *
 * - Linux musl（本机非 Linux）：系统上没有交叉 gcc，用 zig cc + zig ar；
 * - aarch64-pc-windows-msvc：ring 的 build.rs 对 Windows ARM64 **硬性要求 clang**
 *   （「On Windows AArch64 we currently must use Clang」），MSVC 的 cl.exe 不被
 *   接受，用 zig cc 充当 clang。静态库打包不注入 AR：MSVC 目标吃 `-out:` /
 *   `-nologo` 口径，必须用 VS 的 lib.exe（cc-rs 自己定位，lib.exe 对目标架构
 *   不敏感），`zig ar` 是 GNU ar 口径对不上。
 */
function crossToolchainEnv(target) {
  const isLinuxTriple = target.triple.endsWith('-linux-musl');
  const isWindowsArm64 = target.triple === 'aarch64-pc-windows-msvc';
  if (!isLinuxTriple && !isWindowsArm64) return {};
  // 本机就是 Linux 时不注入：系统自带的 cc 能直接编 musl（装了 musl-tools 的话）。
  if (isLinuxTriple && process.platform === 'linux') return {};

  const zig = process.env.ZIG || 'zig';
  const probe = spawnSync(zig, ['version'], { stdio: 'ignore', shell: false });
  if (probe.error || probe.status !== 0) {
    console.error(
      `[build-core] 构建 ${target.triple} 需要 zig（ring 的 C / 汇编要一个 C 编译器）：` +
        `找不到 \`${zig}\`。安装方式见 docs/standalone-core.md 第 4.3 节；` +
        '已装在别处时用环境变量 ZIG 指定可执行文件路径。',
    );
    process.exit(1);
  }

  // cc-rs 认 `zig cc`，但它会按 **Rust 三元组** 补 `--target=<rust 三元组>`；zig 不认
  // 三元组里的 vendor 段（`unknown` / `pc` 都报 UnknownOperatingSystem），所以要再用
  // CFLAGS 追加一个 zig 认的目标（clang 取最后一个 --target）。
  const key = target.triple.replace(/-/g, '_');
  const zigTarget = target.triple.replace(/-(unknown|pc)-/, '-');
  const env = {
    [`CC_${key}`]: `${zig} cc`,
    [`CFLAGS_${key}`]: `--target=${zigTarget}`,
  };
  if (!isWindowsArm64) env[`AR_${key}`] = `${zig} ar`;
  return env;
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

  // 指纹在构建前计算：它只依赖源码与编译器身份，不依赖产物；
  // 同时经 CORE_FINGERPRINT 传给 cargo，由 core-rs 的 build.rs 烧进二进制
  // （daemon 以它区分自己的状态文件，docs/standalone-core.md 第 4.4 节）。
  const fingerprint = computeFingerprint(target.triple, profile);

  const cargoArgs = ['build', '--manifest-path', manifestPath, '--target', target.triple];
  if (!options.debug) cargoArgs.push('--release');

  console.log(`[build-core] cargo ${cargoArgs.join(' ')} (fingerprint ${fingerprint})`);
  const env = { ...process.env, ...crossToolchainEnv(target), CORE_FINGERPRINT: fingerprint };
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

  // 指纹文件与可执行文件同级落位：宿主运行时读它确定远端部署槽位
  // 部署槽位 `~/.local/bin/share/<core.deployPrefix>/<指纹>/`；随 copy-assets 进入打包产物（Electron / vsix 携带）。
  const fingerprintPath = join(outDir, FINGERPRINT_FILE_NAME);
  writeFileSync(fingerprintPath, `${computeFingerprint(target.triple, profile)}\n`);
  console.log(`[build-core] ${target.dir} 指纹 → ${fingerprintPath}`);

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
