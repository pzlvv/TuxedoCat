#!/usr/bin/env node
/**
 * Standalone Core（Rust）构建脚本（见 docs/core/standalone-core.md 第 3.3 节）。
 *
 * 用法：
 *   node scripts/build-core.mjs                        # 打包要携带的全部目标，release
 *   node scripts/build-core.mjs --host                 # 只建当前平台 / 架构
 *   node scripts/build-core.mjs --target <triple>      # 只建指定目标三元组
 *   node scripts/build-core.mjs --debug                # debug 构建（保留控制台）
 *   node scripts/build-core.mjs --asan                 # asan 构建（nightly + -Zsanitizer=address，默认本机 + Linux x64）
 *
 * asan 变体（`npm run package:asan`）除了 `--asan` 旗标，还认环境变量
 * `<envPrefix>_CORE_ASAN=1`：vsce 会强制再跑一遍 `npm run vscode:prepublish`（其内嵌的
 * `npm run build:core` 不带任何参数），变体只能经环境变量贯穿全链路
 * （`scripts/package-asan.mjs` 负责注入）。
 *
 * 产物落位：resources/<core.resourceDir>/<arch>-<platform>/<core.binaryName>[.exe]
 * 目录命名与 resources/ripgrep/ 一致；copy-assets 会把它带进 dist/resources。
 * 同一目录下还会落一份自带的 `ripgrep/rg[.exe]`（Grep / Glob 用的 rg）：
 * Core 以**自己的可执行文件目录**为基准定位自带资源，本地与远端都是这一个位置。
 * 同目录还有一份 `fingerprint` 构建指纹（见 computeFingerprint 与
 * docs/core/standalone-core.md 第 3.4 节）：SSH 部署按指纹落位远端部署目录
 * `~/.local/share/<core.deployPrefix>/<指纹>/`，多版本 Core 在同一台机器上各占一个槽位互不干扰。
 *
 * 产品名与产物名一律取自 src/config/project.json（`core.binaryName` /
 * `core.resourceDir`），本脚本不写死。Rust 侧的包名固定为中性的 `standalone-core`，
 * 这里按配置重命名后落位。
 *
 * 默认构建的是**打包要携带的全部目标**（`PACKAGE_DIRS`），不是只建当前平台：
 * 只建当前平台时，打包会静默带上一次构建的旧产物（docs/core/standalone-core.md 第 3.3 节）。
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
 * ASAN 变体的开关环境变量（`npm run package:asan` 经 `scripts/package-asan.mjs` 注入，
 * 嵌套的 npm / vsce / node 子进程原样透传）；只认 `'1'`，避免误开。
 */
export const ASAN_ENV_VAR = project.asanEnvVar;

/** 当前进程是否处于 asan 变体 */
export function asanEnabled() {
  return process.env[ASAN_ENV_VAR] === '1';
}

/** asan 构建的 cargo profile 名（`core-rs/Cargo.toml` 的 `[profile.asan]`，继承 release） */
export const ASAN_PROFILE = 'asan';

/** asan 构建的工具链覆盖：`-Zsanitizer` 是 unstable 旗标，必须 nightly */
const ASAN_TOOLCHAIN = '+nightly';

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
 * ASAN 变体实际使用的构建三元组（按产物目录索引）。
 *
 * Windows 与 release 同三元组；Linux x64 改用 **gnu**：rustc 明确拒绝 sanitizer 与
 * 静态 libc 的组合（`sanitizer is incompatible with statically linked libc`），而发布
 * 产物用的 musl 目标默认静态链接。gnu 产物动态链接 glibc，是 ASAN 在 Linux 上可用的
 * 形态。没有登记的目标（Linux arm64）没有 ASAN 变体。
 */
export const ASAN_TRIPLES = {
  'x64-win32': 'x86_64-pc-windows-msvc',
  'arm64-win32': 'aarch64-pc-windows-msvc',
  'x64-linux': 'x86_64-unknown-linux-gnu',
};

/** 某目标在 asan 变体下的构建三元组；没有 asan 变体时返回 null */
export function asanTripleFor(target) {
  return ASAN_TRIPLES[target.dir] ?? null;
}

/**
 * ASAN 变体的默认目标集合：本机平台（有 asan 变体时）+ Linux x64。
 *
 * Linux x64 是 vsix / 桌面安装包跨平台携带的那份，也是 SSH 远端部署的主目标——
 * 内存问题经常只在 Linux 上复现，所以 asan 包必须带它。其余目标（如 Linux arm64）
 * 用 `--target` 显式指定；本机没有 asan 变体时（如 Linux arm64 宿主）只建 Linux x64。
 */
export function asanDefaultTargets() {
  const host = hostTarget();
  const linuxX64 = TARGETS.find((entry) => entry.dir === 'x64-linux');
  const candidates = [host, linuxX64];
  return candidates.filter(
    (entry, index) => entry && asanTripleFor(entry) !== null && candidates.indexOf(entry) === index,
  );
}

/**
 * 打包要携带的目标（`resources/<core.resourceDir>/` 下必须齐的那几个目录）。
 *
 * 这是**唯一一份**平台列表：`scripts/verify-core-artifacts.mjs` 直接 import 它，
 * 不再各写一遍，免得「构建的」与「校验的」漂移（docs/core/standalone-core.md 第 3.3 节）。
 * 四个目标都进包：VSIX / 安装包按运行平台选目录，缺任何一份都会让对应平台拿到旧产物。
 */
export const PACKAGE_DIRS = ['x64-win32', 'arm64-win32', 'x64-linux', 'arm64-linux'];

// ==================== 构建指纹（docs/core/standalone-core.md 第 3.4 节）====================

/**
 * 指纹算法版本标签：参与哈希输入，输入集或归一规则变化时递增，避免新旧指纹意外同槽。
 *
 * v2：输入集从「core-rs/ 工作树全部文件」收窄到「会被编译进产物的文件」
 * （排除 `*_tests.rs` / `test_support.rs` / `tests/` / `fixtures/`，见
 * `isProductSourceFile`）。v1 让改一个测试文件也换远端槽位，等于每次都得重传整份 Core。
 */
const FINGERPRINT_ALGO = 'core-fingerprint-v2';

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
 * - `core-rs/` 工作树里**会被编译进产物**的文件（排除 `target/`；`isProductSourceFile`
 *   再排除 `*_tests.rs` / `test_support.rs` / `tests/` / `fixtures/`），按 POSIX 相对路径
 *   排序后哈希 (路径 + '\0' + 内容)。遍历**工作树**而不是 `git ls-files`：未提交的新文件
 *   也必须改变指纹，否则两个不同版本会共用一个远端槽位；`Cargo.lock` 与
 *   `.cargo/config.toml` 都在目录内，依赖版本与链接器配置自然被覆盖。
 *   产品代码里的 `include_str!` 目标（如 `layerfs-sqlite/sql/schema_v1.sql`）也在集合内，
 *   由 `assertIncludesAreHashed` 兜住——漏进来就地抛错，不静默少算一个文件。
 * - 行尾归一（`\r\n` → `\n`，字节级）：`autocrlf` 设置不同的构建机对同一 commit 会检出
 *   不同行尾，不归一会分裂指纹。
 * - rustc 身份：`rustc -vV` 的 release / commit-hash / commit-date 三行。
 *   **不含 host 行**：Windows 与 Linux 构建机上是「同一个编译器」，不该分裂指纹。
 *   asan profile 由 nightly 编译，身份取 `rustc +nightly -vV`。
 * - 目标三元组与 profile（release / debug / asan）：产物语义随它们变化，不同 profile
 *   不共享远端槽位。
 * - 不混入 zig / C 工具链版本：同源码同 rustc 下 C 部分的工具链差异不构成
 *   版本差异，混入只会让不同构建机分裂槽位（这正是要避免的）。
 *
 * 读取方式不影响指纹值：`computeFingerprint` 是同步的（冷路径自己按序遍历），构建 / 校验
 * 入口先 `await primeSourceTreeHash()` 用并发读预热同一份缓存——路径排序后喂哈希，所以
 * 两种路径产出逐位相同的摘要。`.mjs` 侧并发读是为了 FUSE 之类「每次 open 一次往返」的
 * 工作区：文件数越少、同时打开越多，指纹算得越快。
 */

/**
 * cargo 的产物目录：`target/`，以及「另开一个 target 目录」时的 `target-*` 命名习惯。
 *
 * 只跳过目录（源码文件可以是 `target-platform.rs` 这种名字）。`CARGO_TARGET_DIR` 指到
 * core-rs 外面时这里不涉及；指到里面、或有人把别的机器的 `target-linux` 整份同步进来时，
 * 构建产物会被当成源码读进指纹——内容每次都变，同一份源码再也得不到稳定指纹，
 * 远端槽位等于每次都换。
 */
function isCargoOutputDir(name) {
  return name === 'target' || name.startsWith('target-');
}

/**
 * 该文件是否会被编译进产物（构建指纹的输入集判据）。
 *
 * `#[cfg(test)]` 专属文件（`*_tests.rs` / `test_support.rs`）与 `tests/`（集成测试）、
 * `fixtures/`（只被测试代码 `include_str!`）不进二进制：cargo 不会为它们重链产物，
 * 算进指纹只会让「改一个测试」变成「远端重传整份 Core」。
 *
 * `verify-core-artifacts.mjs` 复用这一份判据（产物是否比源码新的 mtime 闸门同口径）。
 * 传相对路径或裸文件名都可以：只看末段与路径段。
 */
export function isProductSourceFile(relPathOrName) {
  const segments = String(relPathOrName).split('/');
  const name = segments[segments.length - 1];
  if (name.endsWith('_tests.rs')) return false;
  if (name === 'test_support.rs') return false;
  if (segments.some((segment) => segment === 'tests' || segment === 'fixtures')) return false;
  // 路径里出现产物目录（`target/` / `target-*`）也不算源码；只看目录段，文件名
  // `target-platform.rs` 是正常源码（构建指纹跳过的是目录，不是以 target 开头的文件）
  if (segments.slice(0, -1).some(isCargoOutputDir)) return false;
  return true;
}

/** 递归收集 core-rs 工作树里参与指纹的文件（排除 `target/` 与非产物文件），按 POSIX 相对路径排序 */
export function collectCoreSourceFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (isCargoOutputDir(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        const relPath = relative(manifestDir, full).split('\\').join('/');
        if (isProductSourceFile(relPath)) files.push(relPath);
      }
    }
  };
  walk(dirname(manifestPath));
  files.sort();
  return files;
}

/**
 * 行尾归一：`\r\n` / `\r` → `\n`，**字节级**（见 computeFingerprint 的说明）。
 *
 * 不走 utf8 解码再编码：二进制文件（万一进了输入集）会被有损替换成 U+FFFD，指纹
 * 依旧确定但与字节无关；纯文本上两者等效（无 CR 时直接返回原 Buffer，零拷贝）。
 *
 * 导出供 `src/test/coreFingerprint.test.ts` 对照「字节归一 == 原文 CJK 内容按行归一」。
 */
export function normalizeLineEndings(buffer) {
  if (buffer.indexOf(13) === -1) return buffer;
  const out = Buffer.allocUnsafe(buffer.length);
  let write = 0;
  for (let read = 0; read < buffer.length; read++) {
    const byte = buffer[read];
    if (byte === 13) {
      out[write++] = 10;
      if (buffer[read + 1] === 10) read++;
    } else {
      out[write++] = byte;
    }
  }
  return out.subarray(0, write);
}

/** `include_str!("…")` / `include_bytes!("…")` / `include!("…")` 的字面量参数 */
const INCLUDE_MACRO = /\binclude(?:_str|_bytes)?!\s*\(\s*"([^"]+)"\s*\)/g;

/** 把 `include!` 的相对路径（相对所在文件）折成 core-rs 内的 POSIX 相对路径 */
function resolveIncludeTarget(fromRelPath, target) {
  const stack = fromRelPath.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') stack.pop();
    else stack.push(segment);
  }
  return stack.join('/');
}

/**
 * 产品代码 `include!` 的目标必须在指纹输入集内，否则抛错。
 *
 * 输入集收窄到「会进产物的文件」之后，一个被 `include_str!` 进二进制、却落在
 * `fixtures/` 之类的文件会被静默少算（改了它指纹不变 = 两个版本共用远端槽位）。
 * 这里是**接线检查**：缺了直接报错，由人决定是加进输入集还是把 include 挪进测试文件
 * （docs/architecture/principles.md 不过度 fallback）。
 *
 * 导出供 `src/test/coreFingerprint.test.ts` 直接覆盖：真实仓库里一旦「该报错的情形」存在
 * 就已经构建失败了，回归用例没法靠仓库现状触发它。
 */
export function assertIncludesAreHashed(relPath, content, hashedPaths) {
  if (content.indexOf('include') === -1) return;
  const text = content.toString('utf8');
  for (const match of text.matchAll(INCLUDE_MACRO)) {
    const target = resolveIncludeTarget(relPath, match[1]);
    if (hashedPaths.has(target)) continue;
    throw new Error(
      `[build-core] ${relPath} 用 include! 引入了不在构建指纹输入集里的 ${target}。` +
        '要么让它留在核心源码目录（不要在 tests/ 或 fixtures/ 下），要么把这段 include 挪进 ' +
        '`#[cfg(test)]` 文件（见 scripts/build-core.mjs 的 isProductSourceFile）。',
    );
  }
}

/** 已读出内容的源码文件（relPath + 归一后的 Buffer） */
function hashSourceEntries(entries) {
  const hashedPaths = new Set(entries.map((entry) => entry.relPath));
  const hash = createHash('sha256');
  for (const { relPath, content } of entries) {
    assertIncludesAreHashed(relPath, content, hashedPaths);
    hash.update(relPath);
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * 并发读的通道数。
 *
 * 同时挂起 16 个读请求，避免「等上一个读回来才发下一个」——真正的并行度由 libuv 的
 * 线程池决定（默认 4），16 个通道让池子始终有话干、不空转。通道数只影响「同时在途多少个
 * open」，不影响哈希结果（喂给 sha256 的顺序由排序决定），所以调大调小都不改指纹。
 */
const SOURCE_READ_CONCURRENCY = 16;

/** core-rs 源码树的内容哈希（冷路径：按序遍历） */
function sourceTreeHashSync() {
  const files = collectCoreSourceFiles();
  return hashSourceEntries(
    files.map((relPath) => ({
      relPath,
      content: normalizeLineEndings(readFileSync(join(manifestDir, relPath))),
    })),
  );
}

/** core-rs 源码树的内容哈希（热路径：并发读，摘要与冷路径逐位相同） */
async function sourceTreeHashAsync() {
  const files = collectCoreSourceFiles();
  const contents = new Array(files.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(SOURCE_READ_CONCURRENCY, files.length) }, async () => {
      while (next < files.length) {
        const index = next++;
        contents[index] = normalizeLineEndings(await readFile(join(manifestDir, files[index])));
      }
    }),
  );
  return hashSourceEntries(files.map((relPath, index) => ({ relPath, content: contents[index] })));
}

let cachedSourceTreeHash = null;
let pendingSourceTreeHash = null;

/**
 * 预热指纹的源码树哈希（并发读）。
 *
 * 构建 / 校验入口在跑多个目标前调用一次：`computeFingerprint` 保持同步（调用方不必记得
 * await，写进文件的不会是个 Promise），但命中这份缓存后不再重复读盘。不预热也照常正确，
 * 只是走冷路径。
 */
export async function primeSourceTreeHash() {
  if (cachedSourceTreeHash !== null) return cachedSourceTreeHash;
  if (pendingSourceTreeHash === null) {
    pendingSourceTreeHash = sourceTreeHashAsync().then(
      (hash) => {
        cachedSourceTreeHash = hash;
        return hash;
      },
      (error) => {
        // 失败不缓存：接线检查抛错时要能以原样冒到调用方，而不是留一个永远 reject 的
        // promise（后续调用会拿到同一个错误对象、栈也指向第一次调用）。
        pendingSourceTreeHash = null;
        throw error;
      },
    );
  }
  return pendingSourceTreeHash;
}

/** core-rs 源码树的内容哈希（进程内缓存：一次构建跑多个目标只算一遍） */
function coreSourceTreeHash() {
  if (cachedSourceTreeHash === null) cachedSourceTreeHash = sourceTreeHashSync();
  return cachedSourceTreeHash;
}

/** `rustc -vV` 的编译器身份（release / commit-hash / commit-date 三行，不含 host） */
const rustcIdentities = new Map();

function rustcIdentity(toolchainArgs = []) {
  // 一次构建要算多个目标的指纹，每次都 spawn 一个 rustc 是纯浪费（Windows 上实测
  // 每次 ~140ms）；同一工具链的身份在进程内不会变，按工具链参数缓存。
  const cacheKey = toolchainArgs.join('\0');
  const cached = rustcIdentities.get(cacheKey);
  if (cached !== undefined) return cached;
  const result = spawnSync('rustc', [...toolchainArgs, '-vV'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    const toolchain = toolchainArgs.join(' ') || '默认';
    console.error(
      `[build-core] 无法读取 rustc 版本（rustc ${toolchainArgs.join(' ')} -vV 失败）：` +
        '指纹计算依赖编译器身份。' +
        (toolchainArgs.length > 0 ? '安装：rustup toolchain install nightly' : '请安装 Rust 工具链：https://rustup.rs'),
    );
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
  const identity = lines.join('\n');
  rustcIdentities.set(cacheKey, identity);
  return identity;
}

/** 计算一个构建目标的指纹（64 位小写 hex） */
export function computeFingerprint(triple, profile) {
  const hash = createHash('sha256');
  hash.update(FINGERPRINT_ALGO);
  hash.update('\0');
  // asan profile 由 nightly 编译，编译器身份也取 nightly 的 rustc：指纹语义是
  // 「源码 + 编译器」，取默认工具链（可能是 stable）的身份会与实际编译器不符。
  hash.update(rustcIdentity(profile === ASAN_PROFILE ? [ASAN_TOOLCHAIN] : []));
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
 * 有 C 依赖的目标（ring 的 C / 汇编、Linux musl 的 mimalloc）需要系统 C 编译器：
 * 注入 zig 充当。
 *
 * Rust 那部分不需要系统工具链（musl 用 rustup 自带的 crt / libc + rust-lld，见
 * `core-rs/.cargo/config.toml`；MSVC 目标的链接由 rustc 经 Visual Studio 定位，
 * arm64 要装好 VS 的「MSVC ARM64 生成工具」组件）；但 `ring` 里有 C + 汇编，
 * cc-rs 需要一个能产出该目标文件的 C 编译器：
 *
 * - Linux musl（本机非 Linux）：系统上没有交叉 gcc，用 zig cc + zig ar；
 * - Linux gnu（ASAN 变体，本机非 Linux）：同样用 zig cc + zig ar，但链接也必须交给
 *   zig（没有 glibc 交叉 sysroot），见 `zigLinkerWrapper`；
 * - aarch64-pc-windows-msvc：ring 的 build.rs 对 Windows ARM64 **硬性要求 clang**
 *   （「On Windows AArch64 we currently must use Clang」），MSVC 的 cl.exe 不被
 *   接受，用 zig cc 充当 clang。静态库打包不注入 AR：MSVC 目标吃 `-out:` /
 *   `-nologo` 口径，必须用 VS 的 lib.exe（cc-rs 自己定位，lib.exe 对目标架构
 *   不敏感），`zig ar` 是 GNU ar 口径对不上。
 */
function crossToolchainEnv(triple) {
  const isLinuxTriple = triple.endsWith('-linux-musl') || triple.endsWith('-linux-gnu');
  const isLinuxGnu = triple.endsWith('-linux-gnu');
  const isWindowsArm64 = triple === 'aarch64-pc-windows-msvc';
  if (!isLinuxTriple && !isWindowsArm64) return {};
  // 本机就是 Linux 时不注入：系统自带的 cc 能直接编 musl / gnu（装了 musl-tools 的话）。
  if (isLinuxTriple && process.platform === 'linux') return {};

  const zig = process.env.ZIG || 'zig';
  const probe = spawnSync(zig, ['version'], { stdio: 'ignore', shell: false });
  if (probe.error || probe.status !== 0) {
    console.error(
      `[build-core] 构建 ${triple} 需要 zig（ring 的 C / 汇编与 musl 产物的 mimalloc ` +
        `都要一个 C 编译器）：找不到 \`${zig}\`。` +
        '安装方式见 docs/core/standalone-core.md 第 3.3 节；' +
        '已装在别处时用环境变量 ZIG 指定可执行文件路径。',
    );
    process.exit(1);
  }

  // cc-rs 认「命令 + 子命令」形式的 `zig cc`（按空白切成可执行文件 + 参数），
  // Linux 目标的 C 依赖（ring 与 mimalloc-sys）都经它编译，不需要额外的垫片。
  //
  // CFLAGS 追加 zig 认的目标：cc-rs 会按 **Rust 三元组** 补 `--target=<rust 三元组>`，
  // 而 zig 不认三元组里的 vendor 段（`unknown` / `pc` 都报 UnknownOperatingSystem）；
  // clang 取最后一个 --target，所以追加的这条生效。
  const key = triple.replace(/-/g, '_');
  const zigTarget = triple.replace(/-(unknown|pc)-/, '-');
  const env = {
    [`CC_${key}`]: `${zig} cc`,
    [`CFLAGS_${key}`]: `--target=${zigTarget}`,
  };
  if (!isWindowsArm64) env[`AR_${key}`] = `${zig} ar`;
  // gnu 没有像 musl 那样的自包含 crt / libc（见 core-rs/.cargo/config.toml），链接
  // 必须由 zig 的 cc 驱动完成；cargo 的 linker 只能是一个可执行文件，故经包装脚本转接
  if (isLinuxGnu) {
    env.ZIG_CC_TARGET = `--target=${zigTarget}`;
    env[`CARGO_TARGET_${key.toUpperCase()}_LINKER`] = zigLinkerWrapper();
  }
  return env;
}

/**
 * 生成 `zig cc` 链接器包装脚本（供 cargo 的 linker 配置调用）。
 *
 * cargo 的 linker 只能是一个可执行文件，而 zig 必须以 `zig cc` 子命令启动；包装脚本
 * 转给 `scripts/zig-cc-linker.mjs`（Node 垫片），由它把 rustc 的 `-Wl,<绝对路径>`
 * 还原成位置参数后再调用 zig（原因见该文件的说明）。写在 `core-rs/target/` 下：
 * 不进构建指纹、不入库，每次构建按当前路径重写。
 */
function zigLinkerWrapper() {
  const dir = join(repoRoot, 'core-rs', 'target', 'linkers');
  mkdirSync(dir, { recursive: true });
  const shim = join(repoRoot, 'scripts', 'zig-cc-linker.mjs');
  if (process.platform === 'win32') {
    const file = join(dir, 'zig-cc.cmd');
    // cmd.exe 按 CRLF 解析批处理：用 LF 会把下一行拼进命令，链接器直接报「不是内部或外部命令」
    writeFileSync(file, `@echo off\r\nnode "${shim}" %*\r\n`);
    return file;
  }
  const file = join(dir, 'zig-cc.sh');
  writeFileSync(file, `#!/bin/sh\nexec node "${shim}" "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}

function parseArgs(argv) {
  const options = { debug: false, host: false, target: null, asan: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--debug') {
      options.debug = true;
    } else if (arg === '--asan') {
      options.asan = true;
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

/**
 * 按三元组取平台矩阵里的一条；不在矩阵内直接报错，不猜目标。
 *
 * asan 变体下同时接受 ASAN 三元组（如 `x86_64-unknown-linux-gnu`），映射回对应的
 * 产物目录——用户拿 rustc 实际使用的三元组来指定时不该查不到。
 */
function findTarget(triple, asan = false) {
  const match = TARGETS.find(
    (entry) => entry.triple === triple || (asan && asanTripleFor(entry) === triple),
  );
  if (!match) {
    const available = TARGETS.map((entry) => {
      const asanTriple = asanTripleFor(entry);
      return `  ${entry.triple}  (${entry.dir})${asan ? `；asan: ${asanTriple ?? '不支持'}` : ''}`;
    }).join('\n');
    console.error(`目标三元组 ${triple} 不在平台矩阵内。可用：\n${available}`);
    process.exit(2);
  }
  return match;
}

/** 当前平台 / 架构对应的那条（verify-core-artifacts 的 asan 模式复用） */
export function hostTarget() {
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
 * - `--target`：只建指定的那一个（asan 变体接受 release 三元组或 asan 三元组）；
 * - `--host`：只建当前平台 / 架构；
 * - asan 变体（旗标或环境变量）：默认建本机平台 + Linux x64（`asanDefaultTargets`）——
 *   Linux x64 是 vsix / 桌面包跨平台携带的那份，也是 SSH 远端部署的主目标；
 *   其余目标用 `--target` 显式表达意图；
 * - 默认：打包要携带的全部目标（`PACKAGE_DIRS`），按本机能否构建过滤。
 */
function resolveTargets(options) {
  if (options.target && options.host) {
    console.error('--target 与 --host 不能同时使用。');
    process.exit(2);
  }
  if (options.asan && options.debug) {
    console.error('--asan 与 --debug 不能同时使用（asan 是独立 profile，已带行号表）。');
    process.exit(2);
  }
  if (options.target) return [findTarget(options.target, options.asan)];
  if (options.host) return [hostTarget()];
  if (options.asan) {
    const targets = asanDefaultTargets();
    console.log(
      `[build-core] asan 模式默认构建 ${targets.map((entry) => entry.dir).join(' + ')}；` +
        '其余目标用 --target 显式指定。',
    );
    return targets;
  }

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
  const profile = options.asan ? ASAN_PROFILE : options.debug ? 'debug' : 'release';
  // asan 变体的实际三元组可能与发布产物不同（Linux x64 是 gnu，见 ASAN_TRIPLES）
  const triple = options.asan ? asanTripleFor(target) : target.triple;

  // 指纹在构建前计算：它只依赖源码与编译器身份，不依赖产物；
  // 同时经 CORE_FINGERPRINT 传给 cargo，由 core-rs 的 build.rs 烧进二进制
  // （daemon 以它区分自己的状态文件，docs/core/standalone-core.md 第 3.4 节）。
  const fingerprint = computeFingerprint(triple, profile);

  // `+nightly` 是 cargo 的工具链覆盖，必须在子命令之前；asan 用独立 profile
  // （不叠在 --release 上），产物目录 target/<triple>/asan/ 与 release 互不覆写。
  const cargoArgs = options.asan ? [ASAN_TOOLCHAIN] : [];
  cargoArgs.push('build', '--manifest-path', manifestPath, '--target', triple);
  if (options.asan) {
    cargoArgs.push('--profile', ASAN_PROFILE);
  } else if (!options.debug) {
    cargoArgs.push('--release');
  }

  console.log(`[build-core] cargo ${cargoArgs.join(' ')} (fingerprint ${fingerprint})`);
  const env = { ...process.env, ...crossToolchainEnv(triple), CORE_FINGERPRINT: fingerprint };
  if (options.asan) {
    // -Zsanitizer=address 插桩 Rust 侧全部 crate；用户已带 RUSTFLAGS 时追加而不是覆盖
    env.RUSTFLAGS = [process.env.RUSTFLAGS, '-Zsanitizer=address'].filter(Boolean).join(' ');
  }
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
        `若提示目标未安装，执行：${options.asan ? 'rustup target add --toolchain nightly' : 'rustup target add'} ${triple}`,
    );
    process.exit(result.status ?? 1);
  }

  const built = join(
    repoRoot,
    'core-rs',
    'target',
    triple,
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
  console.log(`[build-core] ${triple} → ${outPath}`);

  copyDebugSymbols(built, outDir, target);

  // 指纹文件与可执行文件同级落位：宿主运行时读它确定远端部署槽位
  // 部署槽位 `~/.local/share/<core.deployPrefix>/<指纹>/`；随 copy-assets 进入打包产物（Electron / vsix 携带）。
  // 复用构建前算好的那份：指纹只依赖源码与编译器身份，重算只会多读一遍盘（且编译器身份
  // 每算一次都要 spawn 一个 rustc），值必然相同。
  const fingerprintPath = join(outDir, FINGERPRINT_FILE_NAME);
  writeFileSync(fingerprintPath, `${fingerprint}\n`);
  console.log(`[build-core] ${target.dir} 指纹 → ${fingerprintPath}`);

  copyBundledRipgrep(target, outDir);

  // asan 变体额外带 MSVC 的动态 ASAN 运行库（非 win32 目标内为 no-op）
  if (options.asan) copyAsanRuntime(outDir, target);
}

/**
 * asan 产物必须随 exe 落位的 MSVC 动态 ASAN 运行库文件名（verify-core-artifacts 复用）。
 *
 * 非 windows-msvc 目标没有这份文件：ELF 平台的 asan 运行库直接静态链接进二进制。
 */
export function asanRuntimeFileName(triple) {
  if (!triple.endsWith('-pc-windows-msvc')) return null;
  const arch = triple.startsWith('aarch64-') ? 'aarch64' : 'x86_64';
  return `clang_rt.asan_dynamic-${arch}.dll`;
}

/**
 * 复制 MSVC 的动态 ASAN 运行库到产物目录（与 exe 同级）。
 *
 * windows-msvc 的 asan 链接的是**动态**运行库：rustup 工具链不带它，链接期与运行期用的
 * 都是 VS 分发的那份（随「C++ AddressSanitizer」组件）。exe 起进程按 Windows 的 DLL
 * 搜索顺序先找自己目录——不带它，部署出去的 asan Core 一启动就报
 * 「找不到 clang_rt.asan_dynamic-x86_64.dll」。经 vswhere 定位（VS 的标准入口），
 * 找不到直接报错，不静默降级。
 */
function copyAsanRuntime(outDir, target) {
  const fileName = asanRuntimeFileName(asanTripleFor(target));
  if (!fileName) return;
  const vswhere = join(
    process.env['ProgramFiles(x86)'] ?? '',
    'Microsoft Visual Studio',
    'Installer',
    'vswhere.exe',
  );
  const found = spawnSync(vswhere, ['-latest', '-products', '*', '-find', `VC\\Tools\\MSVC\\*\\bin\\**\\${fileName}`], {
    encoding: 'utf8',
  });
  if (found.error || found.status !== 0) {
    console.error(
      `[build-core] 无法运行 vswhere 定位 ${fileName}（asan 运行库）：` +
        `${found.error?.message ?? `exit ${found.status}`}。vswhere 随 Visual Studio Installer 安装。`,
    );
    process.exit(1);
  }
  const dll = found.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0];
  if (!dll || !existsSync(dll)) {
    console.error(
      `[build-core] 没找到 ${fileName}：windows-msvc 的 asan 动态运行库随 VS 的` +
        '「C++ AddressSanitizer」组件分发，在 Visual Studio Installer 勾选该组件后重试。',
    );
    process.exit(1);
  }
  const dest = join(outDir, fileName);
  copyFileSync(dll, dest);
  console.log(`[build-core] ${target.dir} asan 运行库 → ${dest}`);
}

/**
 * 部署崩溃诊断符号：Windows（MSVC）的行号表在可执行文件旁的 `.pdb` 里，不随 exe
 * 部署则 panic 钩子输出的调用栈只有地址。debug 构建（profile=debug）本来就不 strip，
 * pdb 同样带上；Linux（musl / ELF）的行号表嵌在二进制内，无需额外产物。
 *
 * pdb 的探测名有两个：MSVC 工具链把 crate 名里的连字符换成下划线（实际产出
 * `standalone_core.pdb`），先按下划线找、再用与 exe 同名的连字符变体兜住工具链命名
 * 漂移；两个都没有时不阻塞构建（自定义 profile 关掉 debuginfo 时合法）。
 */
function copyDebugSymbols(built, outDir, target) {
  if (target.platform !== 'win32') return;
  const pdbCandidates = [
    join(dirname(built), `${CRATE_BIN_NAME.replace(/-/g, '_')}.pdb`),
    built.replace(/\.exe$/, '.pdb'),
  ];
  const pdb = pdbCandidates.find((candidate) => existsSync(candidate));
  if (!pdb) return;
  const dest = join(outDir, `${BINARY_NAME}.pdb`);
  copyFileSync(pdb, dest);
  console.log(`[build-core] ${target.dir} 调试符号 → ${dest}`);
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
        `             Core 自带的 ripgrep 必须与可执行文件一起落位（docs/core/standalone-core.md 第 3.1 节：部署单元与共享位）。`,
    );
    process.exit(1);
  }
  const dest = join(outDir, 'ripgrep');
  mkdirSync(dest, { recursive: true });
  copyFileSync(source, join(dest, name));
  console.log(`[build-core] ${target.dir} 自带 ripgrep → ${join(dest, name)}`);
}

/**
 * asan 前置检查：nightly 工具链与本次要构建的目标都必须就绪，报错带安装命令，
 * 不让人对着 rustc 的原始报错猜。
 */
function probeNightly(triples) {
  const probe = spawnSync('rustc', [ASAN_TOOLCHAIN, '-vV'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    console.error(
      `[build-core] asan 构建需要 nightly 工具链（-Zsanitizer=address 是 unstable 旗标）：` +
        `\`rustc ${ASAN_TOOLCHAIN} -vV\` 失败。安装：rustup toolchain install nightly`,
    );
    process.exit(1);
  }
  // rustup 管理的工具链顺带确认目标已安装；非 rustup 安装拿不到列表，交给 cargo 报错
  const list = spawnSync('rustup', ['target', 'list', '--installed', '--toolchain', 'nightly'], {
    encoding: 'utf8',
  });
  if (list.error || list.status !== 0) return;
  const installed = new Set(
    list.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const missing = triples.filter((triple) => !installed.has(triple));
  if (missing.length > 0) {
    console.error(
      `[build-core] asan 构建缺少 nightly 目标：${missing.join(' / ')}。安装：` +
        `rustup target add --toolchain nightly ${missing.join(' ')}`,
    );
    process.exit(1);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  // 环境变量与 --asan 旗标同效：打包链内嵌的裸 `npm run build:core` 靠环境变量进 asan 模式
  options.asan = options.asan || asanEnabled();
  const targets = resolveTargets(options);
  if (options.asan) {
    const unsupported = targets.filter((target) => asanTripleFor(target) === null);
    if (unsupported.length > 0) {
      console.error(
        `[build-core] ${unsupported.map((target) => `${target.dir}（${target.triple}）`).join(' / ')} ` +
          '没有 asan 变体：ASAN 需要动态 libc，静态 musl 目标不兼容（可用目标见 ASAN_TRIPLES）。',
      );
      process.exit(2);
    }
    probeNightly(targets.map((target) => asanTripleFor(target)));
  }

  if (!existsSync(manifestPath)) {
    console.error(`找不到 Rust 包：${manifestPath}`);
    process.exit(1);
  }

  // 源码树哈希只算一遍（并发读），之后每个目标的 computeFingerprint 直接命中缓存；
  // 见 computeFingerprint 的输入集说明与 primeSourceTreeHash。
  await primeSourceTreeHash();

  for (const target of targets) buildTarget(target, options);
}

// 被 import 时（`scripts/verify-core-artifacts.mjs` 复用平台列表）只暴露数据，不执行构建。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[build-core] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
