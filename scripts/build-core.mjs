#!/usr/bin/env node
/**
 * Standalone Core（Rust）构建脚本（见 docs/standalone-core.md 第 4.1 节）。
 *
 * 用法：
 *   node scripts/build-core.mjs                        # 当前平台 / 架构，release
 *   node scripts/build-core.mjs --debug                # debug 构建（保留控制台）
 *   node scripts/build-core.mjs --target <triple>      # 指定目标三元组
 *
 * 产物落位：resources/<core.resourceDir>/<arch>-<platform>/<core.binaryName>[.exe]
 * 目录命名与 resources/ripgrep/ 一致；copy-assets 会把它带进 dist/resources。
 *
 * 产品名与产物名一律取自 src/config/project.json（`core.binaryName` /
 * `core.resourceDir`），本脚本不写死。Rust 侧的包名固定为中性的 `standalone-core`，
 * 这里按配置重命名后落位。
 *
 * 平台矩阵里 Windows x64 为当前产出，其余三项为预留：目标三元组已登记，
 * 装好对应 target 即可构建。
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import project from '../project.config.cjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(repoRoot, 'core-rs', 'Cargo.toml');

/** Rust 侧的包 / 二进制名；产品名不进入 Rust 侧 */
const CRATE_BIN_NAME = 'standalone-core';

/** 落位目录与文件名（来自工程配置） */
const RESOURCE_DIR = project.core.resourceDir;
const BINARY_NAME = project.core.binaryName;

/** 平台矩阵：`<platform>-<arch>` → 目标三元组与产物目录 */
const TARGETS = [
  { platform: 'win32', arch: 'x64', triple: 'x86_64-pc-windows-msvc', dir: 'x64-win32', ext: '.exe' },
  { platform: 'win32', arch: 'arm64', triple: 'aarch64-pc-windows-msvc', dir: 'arm64-win32', ext: '.exe' },
  { platform: 'linux', arch: 'x64', triple: 'x86_64-unknown-linux-gnu', dir: 'x64-linux', ext: '' },
  { platform: 'linux', arch: 'arm64', triple: 'aarch64-unknown-linux-gnu', dir: 'arm64-linux', ext: '' },
];

function parseArgs(argv) {
  const options = { debug: false, target: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--debug') {
      options.debug = true;
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

function resolveTarget(options) {
  if (options.target) {
    const match = TARGETS.find((entry) => entry.triple === options.target);
    if (!match) {
      console.error(
        `目标三元组 ${options.target} 不在平台矩阵内。可用：\n` +
          TARGETS.map((entry) => `  ${entry.triple}  (${entry.dir})`).join('\n'),
      );
      process.exit(2);
    }
    return match;
  }
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

function main() {
  // embedded 变体走进程内 TypeScript Core，不需要 Rust Core 产物；打包流程照样调用本脚本。
  if (project.coreKind === 'embedded') {
    console.log('[build-core] TUXEDO_CAT_CORE=embedded：embedded 变体不需要 Rust Core，跳过。');
    return;
  }

  const options = parseArgs(process.argv.slice(2));
  const target = resolveTarget(options);
  const profile = options.debug ? 'debug' : 'release';

  if (!existsSync(manifestPath)) {
    console.error(`找不到 Rust 包：${manifestPath}`);
    process.exit(1);
  }

  const cargoArgs = ['build', '--manifest-path', manifestPath, '--target', target.triple];
  if (!options.debug) cargoArgs.push('--release');

  console.log(`[build-core] cargo ${cargoArgs.join(' ')}`);
  const result = spawnSync('cargo', cargoArgs, { stdio: 'inherit', cwd: repoRoot });
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
}

main();
