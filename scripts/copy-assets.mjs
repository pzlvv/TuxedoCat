#!/usr/bin/env node
/**
 * 静态资源落位（`npm run copy-assets`）。
 *
 * 把 `assets/` 与 `resources/` 复制进 `dist/`，再按当前 Core 变体清掉**不属于本变体**的
 * 那份 ripgrep（见 docs/core/standalone-core.md 第 4 节）：
 *   - embedded：只有 `dist/resources/ripgrep/` 有用（TS 侧 Grep / Glob 的 rg，定位见
 *     `src/core/utils/ripgrep.ts`）；`dist/resources/core/` 是 Rust 产物，删。
 *   - standalone：只有 `dist/resources/core/<arch-platform>/ripgrep/` 有用（Core 自带的
 *     rg，定位见 `core-rs/src/tools.rs`）；`dist/resources/ripgrep/` 无人读取，删。
 *
 * 两份 rg 都读同一批源目录（`resources/ripgrep/<dir>/` 与 Core 自带的
 * `resources/core/<dir>/ripgrep/`），源目录都要留着：embedded 变体要前者，
 * `build-core.mjs::copyBundledRipgrep` 拿后者当 Core 自带 rg 的源。清理只发生在
 * `dist/`，不动源目录。
 *
 * 不清理的后果是 standalone 包（VS Code 扩展与 Electron 默认变体）里同时带上
 * `dist/resources/ripgrep/`（约 18M）与 Core 自带的 rg，前者无任何读取方。
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

// 变体互斥：每份 rg 只在自己那侧被读取（docs/core/standalone-core.md 第 4 节）。
const stale =
  project.coreKind === 'embedded'
    ? project.resolve(project.build.dist, 'resources', project.core.resourceDir)
    : project.resolve(project.build.dist, 'resources', 'ripgrep');
rmSync(stale, { recursive: true, force: true });

console.log(`[copy-assets] ${project.coreKind}：静态资源已落位，已清理 ${stale}`);
