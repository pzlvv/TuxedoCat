#!/usr/bin/env node
/**
 * ASAN 变体打包：设 `<envPrefix>_CORE_ASAN=1` 后原样跑 `npm run package`。
 *
 * 为什么是包装脚本而不是一条静态 npm script
 * ----------------------------------------
 * `package:ext` 里 vsce 会强制再执行一遍 `npm run vscode:prepublish`（vsce 的
 * prepublish 没有开关），其内嵌的 `npm run build:core` 与 `verify-core-artifacts`
 * 收不到命令行参数——变体只能经环境变量贯穿全链路（npm / vsce / node / cargo 子进程
 * 都原样透传 process.env）。识别方：
 *   - `scripts/build-core.mjs`：nightly + `-Zsanitizer=address`、`[profile.asan]`、
 *     默认建本机 + Linux x64（Linux 用 gnu 三元组）、指纹 profile 段为 asan；
 *   - `scripts/verify-core-artifacts.mjs`：校验本机 + Linux x64 目录、指纹按 asan 重算；
 *   - `scripts/build-tui-installer.mjs`：只构建本机平台的安装器；
 *   - `project.config.cjs`：产物落 `release/asan/`，不覆盖正式 release 产物。
 *
 * 用法：npm run package:asan
 */
import { createRequire } from 'node:module';
import { spawnCommandSync } from './spawn-shell.mjs';
import { ASAN_ENV_VAR } from './build-core.mjs';

const require = createRequire(import.meta.url);
const project = require('../project.config.cjs');

console.log(
  `[package-asan] ASAN 变体：Core 按 asan profile 构建（nightly + -Zsanitizer=address，` +
    '本机平台 + Linux x64），产物落 release/asan/，其余步骤与 npm run package 一致。',
);

const result = spawnCommandSync('npm', ['run', 'package'], {
  stdio: 'inherit',
  cwd: project.rootDir,
  env: { ...process.env, [ASAN_ENV_VAR]: '1' },
});
if (result.error) {
  console.error(`[package-asan] 无法执行 npm run package：${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 0);
