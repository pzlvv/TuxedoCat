#!/usr/bin/env node
/***
 * 静态资源落位（`npm run copy-assets`）。
 *
 * 把 `assets/` 与 `resources/` 复制进 `dist/`，再清掉 `dist/resources/<tool>/` 这些构建源目录：
 * 内置工具（rg / fd）由 Core 自带（`resources/core/<arch-platform>/<tool>/`，
 * 定位见 `core-rs/src/bundled_tools.rs`），`dist/resources/ripgrep/` 与 `dist/resources/fd/`
 * 无任何读取方，不清就白带几十兆。
 *
 * 源目录 `resources/<tool>/<dir>/` 仍要留着：`build-core.mjs::copyBundledTools` 拿它当
 * Core 自带工具的源。清理只发生在 `dist/`，不动源目录。
 */

import { cpSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';

import { BUNDLED_TOOLS } from './build-core.mjs';

const require = createRequire(import.meta.url);
const project = require('../project.config.cjs');

// project.resolve 是「相对项目根拼接」，各段一律用相对路径，不要拿它拼已绝对化的结果。
cpSync(
  project.resolve('assets'),
  project.resolve(project.build.dist, 'assets'),
  { recursive: true },
);
cpSync(
  project.resolve('resources'),
  project.resolve(project.build.dist, 'resources'),
  { recursive: true },
);

// 清理清单由 build-core.mjs 的 BUNDLED_TOOLS 派生（不手抄目录名：加一件新工具时这里
// 自动跟上）。构建源目录在 dist 下没有读取方。
const staleToolDirs = BUNDLED_TOOLS.map((tool) =>
  project.resolve(project.build.dist, 'resources', tool.dir));
for (const stale of staleToolDirs) {
  rmSync(stale, { recursive: true, force: true });
}

console.log(`[copy-assets] 静态资源已落位，已清理 ${staleToolDirs.join(' / ')}`);
