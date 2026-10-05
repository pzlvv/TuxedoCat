/**
 * TUI 的 Core 产物根目录定位（docs/tui.md 第 2.3 节 + 独立安装程序规格）。
 *
 * Standalone Core 的部署不放在 TUI 里：由独立的安装程序（installer-rs，自解压）
 * 落到 `<prefix>/resources/core/<arch-platform>/`，布局与 Electron 应用内完全一致，
 * 因此 TUI 沿用 `resolveCoreBinary(extensionPath)` 的同一搜索路径。
 *
 * 候选顺序（第一个能解析出 Core 二进制的胜出）：
 * 1. 环境变量 `TUXEDO_CAT_TUI_ROOT`（显式指定安装前缀）；
 * 2. 默认安装前缀 `~/.tuxedo-cat/tui`（安装程序的默认落点）；
 * 3. bundle 所在目录（`<prefix>/tui.mjs` 就地运行——自定义前缀直接指到 tui.mjs）；
 * 4. bundle 上一级（开发仓库：`dist/tui.mjs` → 仓库根的 `resources/core/`）。
 *
 * 全部落空直接抛错并给出安装指引——接线缺失不静默降级（DEVELOPMENT.md 第 12 章规则 1）。
 */

import { existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CONFIG_DIR_NAME } from '../config/project.js';
import { resolveCoreBinary } from '../host/standalone/coreBinary.js';

/** 显式指定安装前缀的环境变量（与 TUXEDO_CAT_CORE 同一命名族） */
export const TUI_ROOT_ENV = 'TUXEDO_CAT_TUI_ROOT';

/** 安装程序的默认安装前缀：`~/.tuxedo-cat/tui` */
export function defaultTuiInstallPrefix(): string {
  return path.join(os.homedir(), CONFIG_DIR_NAME, 'tui');
}

/** 候选根目录列表（可测试的纯函数；bundleDir 传入以便单测注入） */
export function tuiRootCandidates(bundleDir: string): string[] {
  const candidates: string[] = [];
  const fromEnv = process.env[TUI_ROOT_ENV];
  if (fromEnv) candidates.push(fromEnv);
  candidates.push(defaultTuiInstallPrefix());
  candidates.push(bundleDir);
  candidates.push(path.resolve(bundleDir, '..'));
  return [...new Set(candidates)];
}

/**
 * 解析 TUI 的 extensionPath：返回第一个含 Core 产物的候选根。
 * 找不到时抛错（附候选列表与安装指引）。
 */
export function resolveTuiExtensionPath(bundleDir: string): string {
  const candidates = tuiRootCandidates(bundleDir);
  const tried: string[] = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      tried.push(`${candidate} (不存在)`);
      continue;
    }
    try {
      resolveCoreBinary(candidate);
      return candidate;
    } catch {
      tried.push(`${candidate} (无 Core 产物)`);
    }
  }
  throw new Error(
    [
      '未找到 Standalone Core 产物，TUI 无法启动。',
      `已尝试：${tried.join('；')}`,
      `请先运行安装程序（默认前缀 ${defaultTuiInstallPrefix()}），或设置 ${TUI_ROOT_ENV} 指向安装前缀；`,
      '开发环境请先执行 npm run build:core。',
    ].join('\n'),
  );
}
