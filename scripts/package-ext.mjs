#!/usr/bin/env node
/**
 * 打包 VS Code 扩展（.vsix）。
 *
 * 输出目录随 Core 变体变化（见 `project.config.cjs` 的 `releaseDir`）：
 * 产物落 `release/`。
 * 静态 npm script 没法在运行时按构建期 Core 变体变量（`<envPrefix>_<core.envVarSuffix>`）
 * 解析目录，所以收进本脚本；
 * 流程与原 `vsce package --out release && python scripts/fix_vsix_permissions.py` 一致。
 */
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnCommandSync } from './spawn-shell.mjs';

const require = createRequire(import.meta.url);
const project = require('../project.config.cjs');

/**
 * 以子进程运行命令；Windows 上需要 shell 才能解析 `vsce.cmd` / `python`。
 * 走 [`spawnCommandSync`]（单条命令字符串 + shell），避免 DEP0190 弃用警告。
 */
function run(command, args) {
  const result = spawnCommandSync(command, args, {
    stdio: 'inherit',
    cwd: project.rootDir,
  });
  if (result.error) {
    console.error(`[package-ext] 无法执行 ${command}：${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

mkdirSync(project.releaseDir, { recursive: true });

run('vsce', ['package', '--out', project.releaseDir]);

// fix_vsix_permissions.py 不传参时只扫 `release/`；变体目录要显式给文件路径。
const vsix = readdirSync(project.releaseDir)
  .filter((name) => name.toLowerCase().endsWith('.vsix'))
  .map((name) => join(project.releaseDir, name))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];

if (!vsix) {
  console.error(`[package-ext] ${project.releaseDir} 下没有找到 .vsix`);
  process.exit(1);
}

run('python', ['scripts/fix_vsix_permissions.py', vsix]);
