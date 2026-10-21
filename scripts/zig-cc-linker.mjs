#!/usr/bin/env node
/**
 * `zig cc` 链接器垫片（`scripts/build-core.mjs` 的 crossToolchainEnv 生成包装脚本调用）。
 *
 * 为什么需要它
 * ------------
 * cargo 的 `linker` 配置只接受一个可执行文件，而 zig 的 C 驱动必须以 `zig cc`
 * 子命令形式启动；更要紧的是 rustc 把 ASAN 运行库以 `-Wl,<绝对路径>` 传给链接器，
 * zig 的 cc 驱动只放行已知的链接器选项，裸文件路径会被判「unsupported linker arg」
 * （`cargo +nightly build --target x86_64-unknown-linux-gnu` + `-Zsanitizer=address`
 * 的实测行为）。这里把这类参数还原成位置参数：`--whole-archive` /
 * `--no-whole-archive` 仍是 `-Wl,` 选项，顺序不变，链接结果与 rustc 预期一致。
 *
 * 目标三元组经环境变量 `ZIG_CC_TARGET` 传入（如 `--target=x86_64-linux-gnu`）。
 */
import { spawnSync } from 'node:child_process';

/** rustc 传给链接器的参数 */
const args = process.argv.slice(2);

/** 还原成位置参数的 `-Wl,<路径>`：值不以 `-` 开头即视为文件（运行库 / 目标文件） */
const rewritten = args.map((arg) => {
  if (!arg.startsWith('-Wl,')) return arg;
  const value = arg.slice('-Wl,'.length);
  return value.startsWith('-') ? arg : value;
});

const target = process.env.ZIG_CC_TARGET;
const result = spawnSync('zig', ['cc', ...(target ? [target] : []), ...rewritten], {
  stdio: 'inherit',
});

if (result.error) {
  console.error(`[zig-cc-linker] 无法执行 zig：${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
