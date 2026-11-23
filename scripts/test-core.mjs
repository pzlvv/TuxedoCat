#!/usr/bin/env node
/**
 * `cargo test` 的启动器：带上宿主目标的 C 工具链（`scripts/build-core.mjs` 的同一份判据）。
 *
 * 为什么需要它：`test:core` 此前直接调 `cargo test`，绕过了 `build-core.mjs` 为目标注入
 * `CC` / `CFLAGS` 的那一步。Windows arm64 宿主上 `ring` 的 C / 汇编要求 clang
 * （`toolchainKind` 对此返回 `'zig'`），而系统没有 clang——于是单测在本机一条都跑不起来
 * （`cc-rs` 报 `failed to find tool "clang"`），只能推给 CI。判据本身是现成的，缺的只是
 * 「测试入口也走它」。
 *
 * 行为：
 * - 宿主目标在平台矩阵内 → 注入 `crossToolchainEnv(宿主三元组)` 给出的变量；
 * - 宿主不在矩阵内 → 不注入，原样跑（`hostTarget()` 对不在矩阵内的情况会报错退出，
 *   那是**构建**入口的口径；测试入口不该因为平台不在矩阵内就拒绝跑单测）；
 * - 额外参数原样透传给 `cargo test`。
 *
 * 用法：
 *   npm run test:core                                    # package.json 里挂的那个入口
 *   npm exec -- node scripts/test-core.mjs --manifest-path core-rs/Cargo.toml subagent
 *
 * 前提：PATH 要是**当前平台的原生格式**。经 `npm run` / `npm exec` 调用时天然满足；
 * 从 Git Bash 直接 `node scripts/test-core.mjs` 时 PATH 是 POSIX 格式，Windows 上
 * 找不到 cargo——那种情况走 npm 入口。
 */

import { spawn } from 'node:child_process';
import { crossToolchainEnv } from './build-core.mjs';

/**
 * 宿主三元组 → rust 三元组。与 `build-core.mjs` 的 `TARGETS` 同源口径：
 * 只列平台矩阵里的四种组合，其余返回 `null`（不注入）。
 */
const HOST_TRIPLES = new Map([
  ['win32:x64', 'x86_64-pc-windows-msvc'],
  ['win32:arm64', 'aarch64-pc-windows-msvc'],
  ['linux:x64', 'x86_64-unknown-linux-musl'],
  ['linux:arm64', 'aarch64-unknown-linux-musl'],
]);

const triple = HOST_TRIPLES.get(`${process.platform}:${process.arch}`) ?? null;
const injected = triple ? crossToolchainEnv(triple) : {};
const env = { ...process.env, ...injected };

// 让「注入了什么」在日志里可见：本机跑不通时第一眼看的就是这里
if (Object.keys(injected).length > 0) {
  console.log(
    `[test-core] 宿主 ${process.platform}/${process.arch}（${triple}）注入：${Object.keys(injected).join(', ')}`,
  );
}

// Windows 上不带 shell 时 spawn 不会补 `.exe` 后缀，直接给出带后缀的名字。
//
// 不用 `shell: true`：它会走 cmd.exe，而 cmd 只认 **Windows 格式**（分号分隔、
// 盘符路径）的 PATH。本脚本的调用方是 npm script（`npm run test:core`），那里 PATH
// 天然是 Windows 格式，带不带 shell 都能找到 cargo；但从 Git Bash 直接 `node
// scripts/test-core.mjs` 时 PATH 是 POSIX 格式（`/c/Users/.../.cargo/bin`），
// spawn 不认、cmd 也不认，会报 ENOENT 或「'cargo' 不是内部或外部命令」。
// 那种情况请走 `npm run test:core`——与 CI 和 package.json 的口径一致。
const cargo = process.platform === 'win32' ? 'cargo.exe' : 'cargo';

const child = spawn(cargo, ['test', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`cargo test 被信号 ${signal} 终止`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error(`无法启动 cargo test：${error.message}`);
  process.exit(1);
});
