#!/usr/bin/env node
/**
 * TUI 版安装程序构建（docs/tui-installer.md 第 5 节）。
 *
 * 产出 `<releaseDir>/tui-installer/tuxedo-cat-tui-installer-<arch>-<platform>[.exe]`，
 * 覆盖四个目标：Windows x64 / arm64、Linux x64 / arm64（musl）。每个安装器内嵌
 * 对应平台的 Standalone Core、捆绑 ripgrep、指纹文件与 TUI 二进制（tui-rs release 产物）。
 *
 * 步骤（每个目标）：
 * 1. Core 产物就位检查：`resources/core/<dir>/` 缺失时先跑
 *    `node scripts/build-core.mjs --target <triple>`（arm64-win32 不在默认打包集合
 *    PACKAGE_DIRS 里，这里按需补建）；
 * 2. TUI 二进制就位检查：`tui-rs/target/<triple>/release/` 缺失时先跑
 *    `cargo build --release --manifest-path tui-rs/Cargo.toml --target <triple>`
 *    （cwd 必须在 tui-rs：musl 的 rust-lld 配置在 tui-rs/.cargo/config.toml）；
 * 3. `cargo build --release --manifest-path installer-rs/Cargo.toml --target <triple>`
 *    （cwd 必须在 installer-rs：cargo 只从当前目录往上找 .cargo/config.toml，
 *    musl 的 rust-lld 配置在那里；安装器是纯 Rust，交叉不需要 zig）；
 * 4. 复制产物到 release/tui-installer/。
 *
 * 用法：
 *   node scripts/build-tui-installer.mjs                     # 宿主可构建的全部 4 目标
 *   node scripts/build-tui-installer.mjs --host              # 只构建当前宿主平台
 *   node scripts/build-tui-installer.mjs --target <triple>   # 显式指定（不看 buildableOnHost）
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import project from '../project.config.cjs';
import { TARGETS, FINGERPRINT_FILE_NAME } from './build-core.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(repoRoot, 'installer-rs', 'Cargo.toml');
const manifestDir = dirname(manifestPath);
const BINARY_NAME = 'tuxedo-cat-tui-installer';
/** 安装器版本取包版本（src/config/project.json 不带 version 字段） */
const packageVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;

/** msvc 目标只能在 Windows 宿主构建（与 build-core 的 buildableOnHost 同口径） */
function buildableOnHost(target) {
  return target.platform === 'linux' || target.platform === process.platform;
}

function parseArgs(argv) {
  const options = { target: null, host: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target') {
      options.target = argv[++i];
    } else if (argv[i] === '--host') {
      options.host = true;
    } else {
      console.error(`[build-tui-installer] 无法识别的参数：${argv[i]}`);
      process.exit(2);
    }
  }
  return options;
}

function resolveTargets(options) {
  if (options.target) {
    const found = TARGETS.find((t) => t.triple === options.target);
    if (!found) {
      console.error(`[build-tui-installer] 未知目标：${options.target}（可用：${TARGETS.map((t) => t.triple).join('、')}）`);
      process.exit(2);
    }
    return [found];
  }
  let targets = TARGETS;
  if (options.host) {
    const hostPlatform = process.platform;
    const hostArch = process.arch;
    const hostTarget = TARGETS.find((t) => t.platform === hostPlatform && t.arch === hostArch);
    if (!hostTarget) {
      console.error(`[build-tui-installer] 当前宿主 ${hostPlatform}-${hostArch} 不在安装器目标矩阵里。`);
      process.exit(2);
    }
    targets = [hostTarget];
  } else {
    // 默认集合里构建不了的目标显式说明后跳过（不是静默降级）
    for (const target of targets.filter((t) => !buildableOnHost(t))) {
      console.log(
        `[build-tui-installer] 跳过 ${target.triple}：当前宿主 ${process.platform} 构建不了它。` +
        `要在本机产出，用 --target ${target.triple} 显式指定。`,
      );
    }
    targets = targets.filter(buildableOnHost);
  }
  if (targets.length === 0) {
    console.error('[build-tui-installer] 没有可构建的目标。');
    process.exit(2);
  }
  return targets;
}

/** Core 产物三件套是否齐（二进制 / ripgrep / 指纹） */
function coreArtifactsReady(target) {
  const dir = join(repoRoot, 'resources', project.core.resourceDir, target.dir);
  return existsSync(join(dir, `tuxedo-cat-core${target.ext}`))
    && existsSync(join(dir, 'ripgrep', `rg${target.ext}`))
    && existsSync(join(dir, FINGERPRINT_FILE_NAME));
}

/** 执行子进程；strict=false 时失败返回 null（调用方决定跳过还是中止） */
function run(command, args, cwd, env, strict = true) {
  console.log(`[build-tui-installer] ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', cwd, env: env ?? process.env });
  if (result.error) {
    const message = `[build-tui-installer] 无法执行 ${command}：${result.error.message}`;
    if (strict) {
      console.error(message);
      process.exit(1);
    }
    console.error(message);
    return null;
  }
  if (result.status !== 0) {
    const message = `[build-tui-installer] ${command} 失败（exit ${result.status}）。`;
    if (strict) {
      console.error(message);
      process.exit(1);
    }
    console.error(message);
    return null;
  }
  return result;
}

/**
 * 构建单个目标的安装器。
 *
 * @param strict 显式 `--target` 指定的目标严格失败；默认集合里 Core 交叉工具链
 *   缺失时**显式跳过**并说明补救方式（如 arm64-win32 的 ring 需要 zig 充当 clang）——打包机
 *   没装全工具链也能产出其余目标，跳过不是静默降级：输出里逐条说明
 */
function buildInstaller(target, strict) {
  const pkgDirName = join('resources', project.core.resourceDir, target.dir);

  // 1. Core 产物（缺则按目标补建；arm64-win32 不在默认打包集合，须显式目标构建）
  if (!coreArtifactsReady(target)) {
    console.log(`[build-tui-installer] ${pkgDirName} 产物缺失，先构建 Core（${target.triple}）…`);
    const built = run('node', [join(repoRoot, 'scripts', 'build-core.mjs'), '--target', target.triple], repoRoot, undefined, strict);
    if (!built || !coreArtifactsReady(target)) {
      if (strict) {
        console.error(`[build-tui-installer] Core 构建后仍缺产物：${pkgDirName}`);
        process.exit(1);
      }
      console.error(
        `[build-tui-installer] 跳过 ${target.dir} 安装器：Core 交叉构建失败` +
        `（Windows ARM64 的 ring 需要 zig 充当 clang，见 docs/standalone-core.md 第 4.3 节；` +
        `装好后重跑，或先产出 core 产物再回来）。`,
      );
      return false;
    }
  }

  // 2. TUI 二进制（tui-rs 按同一 triple 交叉构建；产物路径是 installer-rs/build.rs
  //    的默认探测位置，两侧同步改）
  const tuiBinary = join(repoRoot, 'tui-rs', 'target', target.triple, 'release', `tuxedo-cat-tui${target.ext}`);
  if (!existsSync(tuiBinary)) {
    console.log('[build-tui-installer] TUI 二进制缺失，先构建 tui-rs…');
    run('cargo', ['build', '--release', '--target', target.triple], join(repoRoot, 'tui-rs'));
    if (!existsSync(tuiBinary)) {
      console.error(`[build-tui-installer] TUI 构建后仍缺产物：${tuiBinary}`);
      process.exit(1);
    }
  }

  // 3. cargo（cwd 在 crate 目录，musl 的 .cargo/config.toml 才生效）
  const cargoArgs = ['build', '--manifest-path', manifestPath, '--target', target.triple, '--release'];
  const env = {
    ...process.env,
    TUI_INSTALL_VERSION: packageVersion,
  };
  run('cargo', cargoArgs, manifestDir, env);

  // 4. 复制产物（release/<pkg>.exe / release/embedded 变体随 releaseDir 分流）
  const built = join(manifestDir, 'target', target.triple, 'release', `${BINARY_NAME}${target.ext}`);
  if (!existsSync(built)) {
    console.error(`[build-tui-installer] 未找到构建产物：${built}`);
    process.exit(1);
  }
  const outDir = join(project.releaseDir, 'tui-installer');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${BINARY_NAME}-${target.dir}${target.ext}`);
  copyFileSync(built, outPath);
  console.log(`[build-tui-installer] ${target.triple} → ${outPath}`);
  return true;
}

function main() {
  if (project.coreKind === 'embedded') {
    console.error('[build-tui-installer] TUXEDO_CAT_CORE=embedded：TUI 只随 standalone Core 分发，embedded 变体不生成安装器。');
    process.exit(2);
  }
  if (!existsSync(manifestPath)) {
    console.error(`找不到安装器 Rust 包：${manifestPath}`);
    process.exit(1);
  }
  const options = parseArgs(process.argv.slice(2));
  const targets = resolveTargets(options);
  const strict = options.target !== null;
  let produced = 0;
  for (const target of targets) {
    if (buildInstaller(target, strict)) produced++;
  }
  if (produced === 0) {
    console.error('[build-tui-installer] 一个安装器都没有产出。');
    process.exit(1);
  }
}

main();
