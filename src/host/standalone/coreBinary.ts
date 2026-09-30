/**
 * Standalone Core 产物的定位（见 docs/standalone-core.md 第 4.1 节）。
 *
 * 产物目录命名与 `resources/ripgrep/` 一致：`<arch>-<platform>`。
 * 平台矩阵里的每个组合都有一个目录；当前只有 Windows x64 有实际产物。
 *
 * 定位基准是应用 / 扩展根目录，不用会话工作目录：
 * 优先 `dist/resources`（打包产物），其次 `resources`（开发期未 build）。
 *
 * 目录名与可执行文件名取自 `src/config/project.json`（`core.resourceDir` /
 * `core.binaryName`），本模块不写死产品名。
 */

import * as fs from 'fs';
import * as path from 'path';
import { CORE_BINARY_NAME, CORE_RESOURCE_DIR } from '../../config/project.js';

/** 产物目录名；平台 / 架构不在矩阵内时返回 null */
export function corePlatformDir(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const archName = arch === 'x64' || arch === 'arm64' ? arch : null;
  if (!archName) return null;
  if (platform === 'win32' || platform === 'linux') {
    return `${archName}-${platform}`;
  }
  return null;
}

/** 可执行文件名；Windows 带 `.exe` */
export function coreBinaryFileName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${CORE_BINARY_NAME}.exe` : CORE_BINARY_NAME;
}

/** 候选路径（按优先级）；目录不在矩阵内时返回空数组 */
export function coreBinaryCandidates(
  extensionPath: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string[] {
  const dir = corePlatformDir(platform, arch);
  if (!dir) return [];
  const name = coreBinaryFileName(platform);
  return [
    path.join(extensionPath, 'dist', 'resources', CORE_RESOURCE_DIR, dir, name),
    path.join(extensionPath, 'resources', CORE_RESOURCE_DIR, dir, name),
  ];
}

/**
 * 解析 Standalone Core 可执行文件路径。
 *
 * 未找到时抛错：Standalone 装配缺产物属于启动期错误，不回退到 PATH。
 */
export function resolveCoreBinary(
  extensionPath: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const dir = corePlatformDir(platform, arch);
  if (!dir) {
    throw new Error(
      `Standalone Core has no product for platform=${platform} arch=${arch}. ` +
      'See docs/standalone-core.md section 4.1 for the target matrix.',
    );
  }
  const candidates = coreBinaryCandidates(extensionPath, platform, arch);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Standalone Core binary not found. Looked in: ${candidates.join(', ')}. ` +
    'Run "npm run build:core" first.',
  );
}
