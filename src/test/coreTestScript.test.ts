/**
 * `scripts/test-core.mjs` 的工具链注入（`docs/core/standalone-core.md` 第 3.3 节）。
 *
 * 为什么锁这条：`test:core` 曾经直接调 `cargo test`，绕过了 `build-core.mjs` 为目标注入
 * `CC` / `CFLAGS` 的那一步。Windows arm64 宿主上 `ring` 的 C / 汇编要求 clang
 * （`toolchainKind` 对此返回 `'zig'`），而系统没有 clang——单测在本机一条都跑不起来
 * （`cc-rs` 报 `failed to find tool "clang"`），只能推给 CI。
 *
 * 回归载体见
 * [specs/defects/core-test-script-skips-toolchain-injection.md](../../specs/defects/core-test-script-skips-toolchain-injection.md)。
 *
 * 运行方式：`npm run test:unit -- core-test-script`
 */

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { createChecker, runTests } from './helpers/harness';

const REPO_ROOT = path.resolve(__dirname, '../../..');

runTests('coreTestScript', async () => {
  const { check, finish } = createChecker();

  // ---------- 语法与导入路径 ----------
  const syntaxProbe = spawnSync(
    process.execPath,
    ['--check', 'scripts/test-core.mjs'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  check(
    'test-core.mjs 语法合法（node --check）',
    syntaxProbe.status === 0,
  );
  if (syntaxProbe.status !== 0) {
    console.log(`     ${(syntaxProbe.stderr ?? '').split('\n').slice(0, 3).join(' ').trim()}`);
  }

  // ---------- test:core 走的是这个脚本，而不是裸 cargo ----------
  const pkgRaw = spawnSync(process.execPath, ['-e', `
    const pkg = require('./package.json');
    console.log(pkg.scripts['test:core']);
  `], { cwd: REPO_ROOT, encoding: 'utf8' });
  const testCoreScript = (pkgRaw.stdout ?? '').trim();
  check(
    'test:core 经 test-core.mjs 启动（不再裸调 cargo test）',
    testCoreScript.includes('scripts/test-core.mjs') && !/\bcargo test\b/.test(testCoreScript),
  );
  check(
    'test:core 覆盖 core-rs 与 mount-proxy-rs 两个 crate',
    testCoreScript.includes('core-rs/Cargo.toml') && testCoreScript.includes('mount-proxy-rs/Cargo.toml'),
  );

  // ---------- CI 分片入口（specs 见 smoke.yml 的 rust-tests 矩阵） ----------
  //
  // 这一组锁的是「分片真的覆盖全集」这件事本身，因为分片的失效方式全是静默的：
  // - 忘了 `--exact`：`engine::foo` 会连带跑 `engine::foo_bar`，各片重叠、有人被跑两遍；
  // - 分片选项只追加到 `test:core` 的第二条命令：core-rs 那半边每片都跑全量，
  //   四片各 197s，比不分片更慢——所以 CI 必须用 `test:core:shard` 而不是
  //   `test:core -- --shard-index`；
  // - 两个 crate 只分了一个：另一半静默不跑。
  const shardSyntax = spawnSync(
    process.execPath,
    ['--check', 'scripts/test-core-shard.mjs'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  check('test-core-shard.mjs 语法合法（node --check）', shardSyntax.status === 0);

  const shardScriptRaw = spawnSync(process.execPath, ['-e', `
    const pkg = require('./package.json');
    console.log(pkg.scripts['test:core:shard'] ?? '');
  `], { cwd: REPO_ROOT, encoding: 'utf8' });
  const shardScript = (shardScriptRaw.stdout ?? '').trim();
  check(
    'test:core:shard 走 test-core-shard.mjs 且覆盖两个 crate',
    shardScript.includes('test-core-shard.mjs') && shardScript.includes('--all-crates'),
  );

  // 分片脚本必须用 `--exact`：否则按子串匹配会跨片重叠
  const exactProbe = spawnSync(process.execPath, ['-e', `
    const fs = require('fs');
    console.log(fs.readFileSync('scripts/test-core-shard.mjs', 'utf8').includes("'--exact'") ? 'exact' : 'no-exact');
  `], { cwd: REPO_ROOT, encoding: 'utf8' });
  check(
    '分片按 --exact 点名（不带它会跨片重叠）',
    (exactProbe.stdout ?? '').trim() === 'exact',
  );

  // smoke.yml 的 rust-tests 矩阵必须调 `test:core:shard`，不能调 `test:core -- ...`
  const smokeRaw = spawnSync(process.execPath, ['-e', `
    const fs = require('fs');
    const text = fs.readFileSync('.github/workflows/smoke.yml', 'utf8');
    const usesShard = /npm run test:core:shard/.test(text);
    const usesPlainWithArgs = /npm run test:core --/.test(text);
    const hasMatrix = /shard: \\[0, 1, 2, 3\\]/.test(text);
    const failFastOff = /fail-fast: false/.test(text);
    console.log(JSON.stringify({ usesShard, usesPlainWithArgs, hasMatrix, failFastOff }));
  `], { cwd: REPO_ROOT, encoding: 'utf8' });
  let smokeCheck = { usesShard: false, usesPlainWithArgs: true, hasMatrix: false, failFastOff: false };
  try {
    smokeCheck = JSON.parse((smokeRaw.stdout ?? '{}').trim()) as typeof smokeCheck;
  } catch {
    // 解析失败即视为未配置（下面的断言会红，不会静默通过）
  }
  check('smoke.yml 用 test:core:shard 分片（不是 test:core -- 追加参数）',
    smokeCheck.usesShard && !smokeCheck.usesPlainWithArgs);
  check('smoke.yml 的 rust-tests 是 4 片矩阵', smokeCheck.hasMatrix);
  check('分片矩阵 fail-fast: false（一片红不掐掉其余片）', smokeCheck.failFastOff);

  // ---------- 宿主工具链判据与构建脚本同源 ----------
  // test-core.mjs 不自己复制一份判据，而是 import build-core.mjs 的 crossToolchainEnv。
  const sourceProbe = spawnSync(
    process.execPath,
    ['-e', `
      const fs = require('fs');
      const text = fs.readFileSync('scripts/test-core.mjs', 'utf8');
      console.log(text.includes("from './build-core.mjs'") ? 'imports' : 'no-import');
    `],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  check(
    '工具链判据从 build-core.mjs 复用（不各写一套分支）',
    (sourceProbe.stdout ?? '').trim() === 'imports',
  );

  // ---------- 注入的变量名与 build-core.mjs 的判据一致 ----------
  // 只验「脚本会按宿主查表 + 调判据」不够：判据返回什么、脚本就注入什么，
  // 两者必须同源。这里直接取宿主判据，比对脚本日志里报出的注入集合。
  const injectProbe = spawnSync(
    process.execPath,
    ['-e', `
      (async () => {
        const m = await import('./scripts/build-core.mjs');
        const map = new Map([
          ['win32:x64', 'x86_64-pc-windows-msvc'],
          ['win32:arm64', 'aarch64-pc-windows-msvc'],
          ['linux:x64', 'x86_64-unknown-linux-musl'],
          ['linux:arm64', 'aarch64-unknown-linux-musl'],
        ]);
        const triple = map.get(process.platform + ':' + process.arch);
        console.log(JSON.stringify(triple ? m.crossToolchainEnv(triple) : {}));
      })();
    `],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  const hostEnv = JSON.parse((injectProbe.stdout ?? '{}').trim() || '{}') as Record<string, string>;
  // 宿主是 Windows arm64 / 非 Linux 交叉时判据会给 zig 注入；为空表示该宿主本来就不需要，
  // 两种都合法——只锁「脚本用的键名与判据键名同一个来源」。
  const scriptText = require('node:fs').readFileSync(
    path.join(REPO_ROOT, 'scripts', 'test-core.mjs'),
    'utf8',
  ) as string;
  check(
    '脚本按宿主查表后调 crossToolchainEnv（键名不手抄）',
    scriptText.includes('crossToolchainEnv(triple)') &&
      (Object.keys(hostEnv).length === 0 || Object.keys(hostEnv).every((key) => /^(CC|CFLAGS|AR|CARGO_TARGET)_/.test(key))),
  );

  finish();
});
