#!/usr/bin/env node
/**
 * 以指定 Core 实现运行一条命令（跨平台设置 Core 实现选择变量）。
 *
 * 用法：node scripts/run-with-core-kind.mjs <embedded|standalone> <命令...>
 * 例：  node scripts/run-with-core-kind.mjs embedded run package
 *
 * 打包脚本（esbuild / electron-builder / vsce）都从环境变量读变体，
 * 但 npm script 本身没法跨平台设置环境变量，所以由本脚本代跑。
 * 变量名与运行时同一配置来源（project.json 的 envPrefix + core.envVarSuffix）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnCommandSync } from './spawn-shell.mjs';

const project = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'config', 'project.json'), 'utf8'),
);
const coreKindEnv = `${project.envPrefix}_${project.core.envVarSuffix}`;

const [kind, ...args] = process.argv.slice(2);

if (kind !== 'embedded' && kind !== 'standalone') {
  console.error('[run-with-core-kind] 第一个参数必须是 embedded 或 standalone。');
  process.exit(2);
}
if (args.length === 0) {
  console.error('[run-with-core-kind] 缺少要运行的命令。');
  process.exit(2);
}

const result = spawnCommandSync('npm', args, {
  stdio: 'inherit',
  env: { ...process.env, [coreKindEnv]: kind },
});

if (result.error) {
  console.error(`[run-with-core-kind] 无法执行 npm：${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
