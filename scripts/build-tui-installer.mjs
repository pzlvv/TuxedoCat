#!/usr/bin/env node
/**
 * TUI 版安装程序构建（docs/features/tui-installer.md 第 5 节）。
 *
 * 产出 `<releaseDir>/tui-installer/<extensionName>-tui-installer-<arch>-<platform>[.exe]`，
 * 覆盖四个目标：Windows x64 / arm64、Linux x64 / arm64（musl）。每个安装器内嵌对应
 * 平台的 Standalone Core、捆绑 ripgrep、指纹文件与 TUI 二进制（tui-rs release 产物）。
 *
 * 分发名由 `src/config/project.json` 的 `extensionName` 派生；cargo 的 crate / 二进制
 * 名保持中性（cargo 不认变量），两者在 `docs/hosts/product-identity.md` 里定死。
 *
 * 步骤（每个目标）：
 * 1. Core 产物就位检查：`resources/core/<dir>/` 缺失时先跑
 *    `node scripts/build-core.mjs --target <triple>`（四个目标都在默认打包集合
 *    PACKAGE_DIRS 里，默认 `npm run build:core` 已建齐；这里按需补建兜住单目标场景）；
 * 2. TUI 二进制：`cargo build --release --target <triple>`（cwd 必须在 tui-rs：
 *    musl 的 rust-lld 配置在 tui-rs/.cargo/config.toml）——增量构建，产物已最新
 *    时近乎免费，不做「产物在就跳过」的检查（旧二进制会被静默嵌入）；
 * 3. `cargo build --release --manifest-path installer-rs/Cargo.toml --target <triple>`
 *    （cwd 必须在 installer-rs：cargo 只从当前目录往上找 .cargo/config.toml，
 *    musl 的 rust-lld 配置在那里；安装器是纯 Rust，交叉不需要 zig）；
 * 4. 复制产物到 release/tui-installer/。
 *
 * 用法：
 *   node scripts/build-tui-installer.mjs                     # 宿主可构建的全部 4 目标
 *   node scripts/build-tui-installer.mjs --host              # 只构建当前宿主平台
 *   node scripts/build-tui-installer.mjs --arch x64          # 只构建某架构的全部平台（x64 / arm64）
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

/**
 * cargo 二进制产物名：`Cargo.toml` 的 `[[bin]] name`（cargo 产物名的单一来源）。
 *
 * 与 `installer-rs/build.rs` 的解析口径一致（同一份来源，两处消费）；排版变化直接
 * 抛错，不静默降级。
 */
function cargoBinName(manifest) {
  const sectionStart = manifest.indexOf('[[bin]]');
  if (sectionStart < 0) throw new Error(`${manifest} 缺 [[bin]] 段`);
  const match = manifest.slice(sectionStart).match(/^name\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error(`${manifest} 的 [[bin]] 缺 name`);
  return match[1];
}

/** installer-rs 的 cargo 产物名（中性，crate 不认变量） */
const BINARY_NAME = cargoBinName(readFileSync(manifestPath, 'utf8'));
/** tui-rs 的 cargo 产物名（中性） */
const TUI_BIN_NAME = cargoBinName(readFileSync(join(repoRoot, 'tui-rs', 'Cargo.toml'), 'utf8'));
/** 分发产物名：产品名派生，改名只动 project.json（docs/hosts/product-identity.md） */
const DIST_NAME = `${project.extensionName}-tui-installer`;
/** 安装器版本取包版本（src/config/project.json 不带 version 字段） */
const packageVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;

/** msvc 目标只能在 Windows 宿主构建（与 build-core 的 buildableOnHost 同口径） */
function buildableOnHost(target) {
  return target.platform === 'linux' || target.platform === process.platform;
}

function parseArgs(argv) {
  const options = { target: null, host: false, arch: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target') {
      options.target = argv[++i];
    } else if (argv[i] === '--arch') {
      options.arch = argv[++i];
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
  // 三种选定方式互斥：混用属于用法错误，不猜意图
  if ((options.target ? 1 : 0) + (options.host ? 1 : 0) + (options.arch ? 1 : 0) > 1) {
    console.error('[build-tui-installer] --target / --host / --arch 不能同时使用。');
    process.exit(2);
  }
  if (options.target) {
    const found = TARGETS.find((t) => t.triple === options.target);
    if (!found) {
      console.error(`[build-tui-installer] 未知目标：${options.target}（可用：${TARGETS.map((t) => t.triple).join('、')}）`);
      process.exit(2);
    }
    return [found];
  }
  let targets;
  if (options.arch) {
    // 架构名取矩阵登记（x64 / arm64），不认识的直接报错，不静默产出空集
    if (!TARGETS.some((t) => t.arch === options.arch)) {
      console.error(`[build-tui-installer] 未知架构：${options.arch}（可用：${[...new Set(TARGETS.map((t) => t.arch))].join('、')}）`);
      process.exit(2);
    }
    targets = TARGETS.filter((t) => t.arch === options.arch);
  } else if (options.host) {
    const hostPlatform = process.platform;
    const hostArch = process.arch;
    const hostTarget = TARGETS.find((t) => t.platform === hostPlatform && t.arch === hostArch);
    if (!hostTarget) {
      console.error(`[build-tui-installer] 当前宿主 ${hostPlatform}-${hostArch} 不在安装器目标矩阵里。`);
      process.exit(2);
    }
    targets = [hostTarget];
  } else {
    targets = TARGETS;
  }
  // 默认集合与 --arch 过滤集合里构建不了的目标显式说明后跳过（不是静默降级）
  for (const target of targets.filter((t) => !buildableOnHost(t))) {
    console.log(
      `[build-tui-installer] 跳过 ${target.triple}：当前宿主 ${process.platform} 构建不了它。` +
      `要在本机产出，用 --target ${target.triple} 显式指定。`,
    );
  }
  targets = targets.filter(buildableOnHost);
  if (targets.length === 0) {
    console.error('[build-tui-installer] 没有可构建的目标。');
    process.exit(2);
  }
  return targets;
}

/** Core 产物三件套是否齐（二进制 / ripgrep / 指纹） */
function coreArtifactsReady(target) {
  const dir = join(repoRoot, 'resources', project.core.resourceDir, target.dir);
  return existsSync(join(dir, `${project.core.binaryName}${target.ext}`))
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

  // 1. Core 产物（缺则按目标补建；默认打包集合已含四个目标，这里兜住单目标场景）
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
        `（Windows ARM64 的 ring 需要 zig 充当 clang，见 docs/core/standalone-core.md 第 3.3 节；` +
        `装好后重跑，或先产出 core 产物再回来）。`,
      );
      return false;
    }
  }

  // 2. TUI 二进制（tui-rs 按同一 triple 交叉构建；产物路径是 installer-rs/build.rs
  //    的默认探测位置，两侧同步改）。无条件 cargo build 而非「产物在就跳过」：
  //    TUI 没有指纹之类的新旧标记，existsSync 跳过会把源码改版前的旧二进制静默
  //    嵌进安装器；cargo 增量构建在已是最新时近乎免费
  run('cargo', ['build', '--release', '--target', target.triple], join(repoRoot, 'tui-rs'));
  const tuiBinary = join(repoRoot, 'tui-rs', 'target', target.triple, 'release', `${TUI_BIN_NAME}${target.ext}`);
  if (!existsSync(tuiBinary)) {
    console.error(`[build-tui-installer] TUI 构建后仍缺产物：${tuiBinary}`);
    process.exit(1);
  }

  // 3. cargo（cwd 在 crate 目录，musl 的 .cargo/config.toml 才生效）
  const cargoArgs = ['build', '--manifest-path', manifestPath, '--target', target.triple, '--release'];
  const env = {
    ...process.env,
    TUI_INSTALL_VERSION: packageVersion,
  };
  run('cargo', cargoArgs, manifestDir, env);

  // 4. 复制产物（release/<pkg>.exe）
  const built = join(manifestDir, 'target', target.triple, 'release', `${BINARY_NAME}${target.ext}`);
  if (!existsSync(built)) {
    console.error(`[build-tui-installer] 未找到构建产物：${built}`);
    process.exit(1);
  }
  const outDir = join(project.releaseDir, 'tui-installer');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${DIST_NAME}-${target.dir}${target.ext}`);
  copyFileSync(built, outPath);
  console.log(`[build-tui-installer] ${target.triple} → ${outPath}`);
  return true;
}

function main() {
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
