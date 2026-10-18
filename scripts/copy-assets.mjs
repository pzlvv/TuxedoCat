#!/usr/bin/env node
/***
 * 静态资源落位（`npm run copy-assets`）。
 *
 * 把 `assets/` 与 `resources/` 复制进 `dist/`，再清掉 `dist/resources/ripgrep/`：
 * Grep / Glob 用的 rg 由 Core 自带（`resources/core/<arch-platform>/ripgrep/`，
 * 定位见 `core-rs/src/tools.rs`），`dist/resources/ripgrep/` 无任何读取方，
 * 不清就白带约 18M。
 *
 * 源目录 `resources/ripgrep/<dir>/` 仍要留着：`build-core.mjs::copyBundledRipgrep`
 * 拿它当 Core 自带 rg 的源。清理只发生在 `dist/`，不动源目录。
 */

import { cpSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';

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

const stale = project.resolve(project.build.dist, 'resources', 'ripgrep');
rmSync(stale, { recursive: true, force: true });

console.log(`[copy-assets] 静态资源已落位，已清理 ${stale}`);
