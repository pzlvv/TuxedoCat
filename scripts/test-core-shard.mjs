#!/usr/bin/env node
/**
 * `cargo test` 的分片入口（CI 用）：跑第 `--shard-index i`（0 起）片，共 `--shard-count n` 片。
 *
 * 为什么需要分片：`npm run test:core` 里 core-rs 的 1256 条用例是**串行吞吐**——CI 实测
 * 197s，占冒烟闸门 242s 的 81%。它跟编译缓存无关（编译已缓存，197s 是跑用例本身），
 * 只能靠并行进程切时间。cargo test 自带 `--test-threads` 但那是**进程内线程**，而且
 * 本仓库大量用例持 `serial()` 进程级互斥、或改写 HOME / 全局静态缓存，线程级并发会被
 * 自己锁成一列（`--test-threads=16` 实测与 1 无差别）。所以要分到**进程级**。
 *
 * 分片依据：`cargo test -- --list` 列出的**全部**用例名（`mod::path::name: test`），
 * 按名字排序后取 `index % count === shard-index` 的那些，用重复的 `--exact` 逐个点名。
 * - 按名字取模而不是按耗时：耗时分布不稳定（机器负载、网络假服务），按名字能保证
 *   「各片的用例集合互不重叠、并集等于全集」，这是分片的正确性底线。
 * - 名字排序后取模而不是按出现顺序：cargo 的 list 顺序可能随构建变化，排序后各片的
 *   归属才是稳定的（同一份源码重跑分片，某条用例不会在两片之间跳来跳去）。
 * - 不按模块分：`engine` 208 条、`tools` 170 条，两个模块就占 30%，按模块切会让某片
 *   明显更慢。按名字取模在统计上更均匀。
 *
 * 用法（CI / 本地一致）：
 *   npm run test:core:shard -- --shard-index 0 --shard-count 4
 *   其余参数原样透传给 `cargo test`（如 `--manifest-path`）。
 *
 * `--all-crates`：对 `test:core` 覆盖的两个 crate 各跑一遍本片（core-rs 与
 * mount-proxy-rs）。**不能用 `npm run test:core -- --shard-index ...` 代替**：那条脚本是
 * 两条命令用 `&&` 串起来的，`--` 之后的参数只会追加到**第二条**，core-rs 那半边拿不到
 * 分片参数，会退化成「每片都跑全量」——四片各跑 197s，比不分片更慢。
 *
 * 不做的事：不安装 cargo-nextest（要额外下载二进制、且与现有 `serial()` 语义无关）；
 * 不并发起多个 cargo（同一 target 目录会抢锁，分片由 CI 的 matrix 并行）。
 */

import { spawn, spawnSync } from 'node:child_process';
import { crossToolchainEnv } from './build-core.mjs';

/** 宿主三元组 → rust 三元组（与 `scripts/test-core.mjs` 同源口径） */
const HOST_TRIPLES = new Map([
  ['win32:x64', 'x86_64-pc-windows-msvc'],
  ['win32:arm64', 'aarch64-pc-windows-msvc'],
  ['linux:x64', 'x86_64-unknown-linux-musl'],
  ['linux:arm64', 'aarch64-unknown-linux-musl'],
]);
const triple = HOST_TRIPLES.get(`${process.platform}:${process.arch}`) ?? null;
const env = { ...process.env, ...(triple ? crossToolchainEnv(triple) : {}) };
const cargo = process.platform === 'win32' ? 'cargo.exe' : 'cargo';

/** `test:core` 覆盖的两个 crate（与 package.json 的 test:core 同源） */
const ALL_CRATES = [
  'core-rs/Cargo.toml',
  'mount-proxy-rs/Cargo.toml',
];

// ==================== 参数 ====================

const argv = process.argv.slice(2);

/** `--flag value` 与 `--flag=value` 都认；同一 flag 出现多次视为错误（分片号有歧义） */
function readOption(name) {
  const values = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name) {
      values.push(argv[i + 1] ?? '');
      i += 1;
    } else if (argv[i].startsWith(`${name}=`)) {
      values.push(argv[i].slice(name.length + 1));
    }
  }
  if (values.length > 1) {
    console.error(`${name} 给了 ${values.length} 次，分片号 / 片数有歧义；只保留一处。`);
    process.exit(2);
  }
  return values[0];
}

/** 选项对在 argv 里的下标位置（透传时要剔除，否则 cargo 会报未知参数） */
function optionIndexes(name) {
  const drop = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name) {
      drop.add(i);
      drop.add(i + 1);
      i += 1;
    } else if (argv[i].startsWith(`${name}=`)) {
      drop.add(i);
    }
  }
  return drop;
}

const rawIndex = readOption('--shard-index');
const rawCount = readOption('--shard-count');
if (rawIndex === undefined || rawCount === undefined) {
  console.error(
    '用法: node scripts/test-core-shard.mjs --shard-index <0 起> --shard-count <总片数> [cargo test 参数...]',
  );
  process.exit(2);
}
const shardIndex = Number.parseInt(rawIndex, 10);
const shardCount = Number.parseInt(rawCount, 10);
if (!Number.isInteger(shardIndex) || !Number.isInteger(shardCount) || shardCount < 1) {
  console.error(`分片参数非法：--shard-index ${rawIndex} / --shard-count ${rawCount}`);
  process.exit(2);
}
if (shardIndex < 0 || shardIndex >= shardCount) {
  console.error(`--shard-index ${shardIndex} 越界（应在 0..${shardCount - 1}）`);
  process.exit(2);
}

// 透传给 cargo test 的参数（剔除分片选项与 --all-crates）
const drop = new Set([
  ...optionIndexes('--shard-index'),
  ...optionIndexes('--shard-count'),
]);
const allCratesFlag = argv.filter((arg) => arg === '--all-crates').length > 0;
const passthrough = argv.filter(
  (arg, index) => arg !== '--all-crates' && !drop.has(index),
);

// `--all-crates` 与显式 `--manifest-path` 互斥：同时给的话「跑哪些 crate」有歧义，
// 与其猜一个，不如直接报错（宁可红也不静默少跑一个 crate）。
if (allCratesFlag && passthrough.some((arg) => arg.startsWith('--manifest-path'))) {
  console.error('--all-crates 与 --manifest-path 不能同时使用：前者已覆盖两个 crate。');
  process.exit(2);
}

// 待跑的 crate 清单：`--all-crates` 展开成两个，否则沿用调用方给的 --manifest-path
// （没给就由 cargo 用当前目录的默认 manifest）。
const manifests = allCratesFlag
  ? ALL_CRATES
  : [null];

// ==================== 列用例 ====================

/**
 * `cargo test -- --list` 的输出形如：
 *   `   Compiling ...` 等编译行
 *   `mod::path::name: test`
 *   `mod::path::name: bench`
 * 只取 `: test` 结尾的行——bench 目标不跑，doc-test 也不在这里。
 */
function listTests(manifest) {
  const args = ['test', ...passthrough];
  if (manifest) args.push('--manifest-path', manifest);
  args.push('--', '--list');
  const result = spawnSync(cargo, args, { encoding: 'utf8', env });
  if (result.error) {
    console.error(`无法执行 cargo test --list：${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    // 列不出来就是编译失败：把 cargo 的原话透出去，不自己编解释
    process.stderr.write(result.stderr ?? '');
    process.stdout.write(result.stdout ?? '');
    process.exit(result.status ?? 1);
  }
  const names = [];
  for (const line of (result.stdout ?? '').split('\n')) {
    const match = /^(\S+): test$/.exec(line.trim());
    if (match) names.push(match[1]);
  }
  return names;
}

/**
 * 跑一个 crate 的本片用例；返回退出码。
 *
 * 每个 crate 独立「列 → 取模 → 跑」：用例名在每个 crate 内取模，因此同一片的
 * core-rs 用例与 mount-proxy 用例互不相关，但四片的并集仍是两个 crate 的全集。
 */
function runShardForManifest(manifest) {
  const label = manifest ?? '(默认 manifest)';
  const all = listTests(manifest);
  if (all.length === 0) {
    console.error(`${label}: cargo test -- --list 一条用例都没列出来——参数写错（如误传了 --exact）？`);
    return 1;
  }

  const mine = [...all]
    .sort()
    .filter((_, index) => index % shardCount === shardIndex);

  if (mine.length === 0) {
    // 空片不是错误：片数多于用例数时必然出现，如实说明并成功
    console.log(`[shard ${shardIndex}/${shardCount}] ${label}: 无用例（共 ${all.length} 条，本片为空）`);
    return 0;
  }

  console.log(
    `[shard ${shardIndex}/${shardCount}] ${label}: 本片 ${mine.length} / ${all.length} 条用例`,
  );

  // `--exact` + 逐个点名：不带 `--exact` 时 cargo 按子串匹配，`engine::foo` 会连带跑
  // `engine::foo_bar`，各片就重叠了。点名是唯一能精确控制集合的方式。
  const args = ['test', ...passthrough];
  if (manifest) args.push('--manifest-path', manifest);
  args.push('--', '--exact', ...mine);
  const result = spawnSync(cargo, args, { stdio: 'inherit', env });
  if (result.error) {
    console.error(`无法启动 cargo test：${result.error.message}`);
    return 1;
  }
  if (result.signal) {
    console.error(`cargo test 被信号 ${result.signal} 终止`);
    return 1;
  }
  return result.status ?? 1;
}

// 依次跑各 crate 的本片。不用 Promise / 并发：两个 crate 共用一个 target 目录，
// 并发 cargo 会抢锁；而且 mount-proxy 只有 35 条、耗时可忽略。
let exitCode = 0;
for (const manifest of manifests) {
  const code = runShardForManifest(manifest);
  if (code !== 0) {
    exitCode = code;
    // 不 break：一个 crate 红了，另一个也跑完再报——那部分的结论同样有价值
  }
}
process.exit(exitCode);
