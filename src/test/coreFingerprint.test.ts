import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createChecker, runTests } from './helpers/harness';

/**
 * 构建指纹的输入集与读取路径（`docs/core/standalone-core.md` 第 3.4 节）。
 *
 * 指纹是远端部署的槽位标识：算多了（把测试文件算进去）会让「改一个测试」变成
 * 「远端重传整份 Core」，算少了（漏掉被 `include_str!` 进产物的文件）会让两个不同
 * 版本共用同一个槽位、远端跑着旧二进制。本文件把三条边界钉住：
 *
 * 1. **输入集判据**：`isProductSourceFile` 排除 `*_tests.rs` / `test_support.rs` /
 *    `tests/` / `fixtures/` 与产物目录（`target/`、`target-*`），其余（含 `include_str!`
 *    目标 `layerfs-sqlite/sql/schema_v1.sql`）留在集合内；
 * 2. **两端同口径**：`verify-core-artifacts.mjs` 的 mtime 闸门复用同一份判据，不另写一套；
 * 3. **读写并发不影响指纹值**：预热缓存（并发读）与冷路径（同步按序读）得到同一个指纹，
 *    且进程内缓存命中后再算一次结果不变——并发只是提速，不是语义。
 *
 * 运行方式：`npm run test:all -- core-fingerprint`
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');

/** 一个能驱动 `scripts/build-core.mjs` 的 ESM 小程序（脚本是 ESM，测试编译产物是 CJS） */
function runEsm(body: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', body],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

runTests('coreFingerprint', async () => {
  const { check, markSkipped, finish } = createChecker();

  // ---------- 1. 输入集判据 ----------
  const predicate = runEsm(
    `const m = await import('./scripts/build-core.mjs');
     const cases = {
       'src/main.rs': true,
       'layerfs-sqlite/sql/schema_v1.sql': true,
       'Cargo.lock': true,
       '.cargo/config.toml': true,
       'src/engine_tests.rs': false,
       'layerfs-sqlite/src/lane_tests.rs': false,
       'src/test_support.rs': false,
       'layerfs/src/test_support.rs': false,
       'tests/parent_watchdog.rs': false,
       'fixtures/compact.json': false,
       'fixtures/xlsx/people.xlsx': false,
       'target/release/build/x.rs': false,
       'target-aarch64-pc-windows-msvc/debug/x.rs': false,
       'layerfs/target-linux/out.rs': false,
       'src/target-platform.rs': true,
       'src/mytarget.rs': true,
       'engine_tests.rs': false,
       'test_support.rs': false,
     };
     const wrong = Object.entries(cases).filter(([p, want]) => m.isProductSourceFile(p) !== want);
     console.log(JSON.stringify({ wrong, keys: Object.keys(cases).length }));`,
  );
  check('isProductSourceFile 判据可加载', predicate.status === 0);
  if (predicate.status === 0) {
    const parsed = JSON.parse(predicate.stdout.trim() || '{}') as {
      wrong?: Array<[string, boolean]>;
      keys?: number;
    };
    check(
      `isProductSourceFile 判据逐例通过（${parsed.keys ?? 0} 例）`,
      (parsed.wrong ?? [{ p: 'parse', want: false }]).length === 0,
    );
    for (const [rel, want] of parsed.wrong ?? []) {
      console.log(`     ${rel} 期望 ${want}`);
    }
  }

  // ---------- 2. 实际输入集：收窄后仍在、且不漏 include! 目标 ----------
  // 最后一条在**真实仓库**上跑一遍接线检查：把每个被收进指纹的文件交给
  // assertIncludesAreHashed，任何产品侧 include! 目标落在集合外都会抛错。这条不写死
  // 具体文件名——`include_str!` 的目标随代码演进，写死会变成「加一个 include 就红」。
  const collected = runEsm(
    `const m = await import('./scripts/build-core.mjs');
     const { readFileSync } = await import('node:fs');
     const files = m.collectCoreSourceFiles();
     const hashed = new Set(files);
     const offenders = [];
     for (const relPath of files) {
       try {
         m.assertIncludesAreHashed(relPath, readFileSync('core-rs/' + relPath), hashed);
       } catch (error) {
         offenders.push(error instanceof Error ? error.message : String(error));
       }
     }
     console.log(JSON.stringify({
       count: files.length,
       sorted: files.every((f, i) => i === 0 || files[i - 1] < f),
       posix: files.every((f) => !f.includes('\\\\')),
       offenders,
       tests: files.filter((f) => f.endsWith('_tests.rs') || f.endsWith('/test_support.rs')).length,
       fixtures: files.filter((f) => f.startsWith('fixtures/')).length,
       targetDir: files.filter((f) => f.startsWith('target/')).length,
     }));`,
  );
  check('collectCoreSourceFiles 可加载', collected.status === 0);
  if (collected.status === 0) {
    const info = JSON.parse(collected.stdout.trim() || '{}') as {
      count?: number;
      sorted?: boolean;
      posix?: boolean;
      offenders?: string[];
      tests?: number;
      fixtures?: number;
      targetDir?: number;
    };
    check(`输入集非空（${info.count ?? 0} 个文件）`, (info.count ?? 0) > 0);
    check('输入集按 POSIX 相对路径升序（喂哈希的顺序唯一）', info.sorted === true);
    check('输入集里没有反斜杠路径（跨平台一致）', info.posix === true);
    check(
      '真实仓库的产品侧 include! 目标全部在输入集内',
      (info.offenders ?? ['parse']).length === 0,
    );
    for (const message of info.offenders ?? []) console.log(`     ${message}`);
    check('输入集不含 *_tests.rs / test_support.rs', info.tests === 0);
    check('输入集不含 fixtures/', info.fixtures === 0);
    check('输入集不含 target/', info.targetDir === 0);
  }

  // ---------- 3. 行尾归一：字节级等价于按行归一，且不改非 CR 字节 ----------
  const normalization = runEsm(
    `const m = await import('./scripts/build-core.mjs');
     const cases = [
       'plain\\nlines\\n',
       'crlf\\r\\nlines\\r\\n',
       'lone\\rcr\\rlines\\r',
       'mixed\\r\\nand\\r\\nlone\\rand\\nlf\\n',
       '中文内容\\r\\n第二行\\r\\n',
       'emoji 🐱\\r\\n换行\\r\\n',
       '',
     ];
     const wrong = [];
     for (const text of cases) {
       const bytes = Buffer.from(text, 'utf8');
       const normalized = m.normalizeLineEndings(bytes);
       // 参照实现：原文（含 CJK / emoji）在字符串层按行归一后重新编回 UTF-8
       const expected = Buffer.from(text.replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n'), 'utf8');
       if (!normalized.equals(expected)) wrong.push(text);
     }
     // 无 CR 时零拷贝：同一个 Buffer 实例原样返回
     const noCr = Buffer.from('no line endings here', 'utf8');
     console.log(JSON.stringify({ wrong, identity: m.normalizeLineEndings(noCr) === noCr }));`,
  );
  check('normalizeLineEndings 可加载', normalization.status === 0);
  if (normalization.status === 0) {
    const info = JSON.parse(normalization.stdout.trim() || '{}') as {
      wrong?: string[];
      identity?: boolean;
    };
    check(
      '行尾归一对 CRLF / 孤立 CR / 混合 / CJK / emoji 都等价于按行归一',
      (info.wrong ?? ['parse']).length === 0,
    );
    for (const text of info.wrong ?? []) console.log(`     不等价：${JSON.stringify(text)}`);
    check('无 CR 的文件原样返回（零拷贝，不改字节）', info.identity === true);
  }

  // ---------- 4. include! 接线检查：产品代码 include 了未入集合的文件必须抛错 ----------
  const includes = runEsm(
    `const m = await import('./scripts/build-core.mjs');
     const hashed = new Set(['src/main.rs', 'layerfs-sqlite/sql/schema_v1.sql']);
     const probe = (relPath, body) => {
       try {
         m.assertIncludesAreHashed(relPath, Buffer.from(body, 'utf8'), hashed);
         return 'ok';
       } catch (error) {
         return error instanceof Error ? error.message : String(error);
       }
     };
     console.log(JSON.stringify({
       // 合法：include 目标在集合内（相对路径要能折回 core-rs 根）
       inside: probe('layerfs-sqlite/src/schema.rs', 'include_str!("../sql/schema_v1.sql")'),
       bytes: probe('layerfs-sqlite/src/schema.rs', 'include_bytes!("../sql/schema_v1.sql")'),
       plain: probe('src/main.rs', 'include!("main.rs")'),
       // 非法：目标落在 fixtures/（不进产物的目录）
       outside: probe('src/tools.rs', 'include_str!("../fixtures/compact.json")'),
       outsideBytes: probe('src/tools.rs', 'include_bytes!("../fixtures/big.bin")'),
       // 没有 include! 的文件不该被误判
       none: probe('src/main.rs', 'fn main() {}'),
       // 只是提到 include 这个词（注释 / 标识符）不该误判
       comment: probe('src/main.rs', '// include_str! 的说明，不是宏调用'),
     }));`,
  );
  check('assertIncludesAreHashed 可加载', includes.status === 0);
  if (includes.status === 0) {
    const info = JSON.parse(includes.stdout.trim() || '{}') as Record<string, string>;
    check('include 目标在输入集内时放行（include_str!）', info.inside === 'ok');
    check('include 目标在输入集内时放行（include_bytes!）', info.bytes === 'ok');
    check('include! 指向同集合文件时放行', info.plain === 'ok');
    check('无 include! 的文件放行', info.none === 'ok');
    check('注释里出现 include_str! 字样不误判', info.comment === 'ok');
    check('include_str! 指向 fixtures/ 时报错', /fixtures\/compact\.json/.test(info.outside ?? ''));
    check(
      'include_bytes! 指向 fixtures/ 时报错',
      /fixtures\/big\.bin/.test(info.outsideBytes ?? ''),
    );
    for (const key of ['outside', 'outsideBytes']) {
      if (info[key] === 'ok') console.log(`     ${key} 没有报错（应报错）`);
    }
  }

  // ---------- 5. 两端同口径：verify 的 mtime 闸门复用同一判据 ----------
  const verifySource = fs.readFileSync(
    path.join(REPO_ROOT, 'scripts', 'verify-core-artifacts.mjs'),
    'utf8',
  );
  check(
    'verify-core-artifacts 从 build-core 导入 isProductSourceFile',
    /isProductSourceFile/.test(verifySource) && /from '\.\/build-core\.mjs'/.test(verifySource),
  );
  check(
    'verify-core-artifacts 不再自带一份 _tests.rs 过滤',
    !/fileName\.endsWith\('_tests\.rs'\)/.test(verifySource),
  );

  // ---------- 6. 读法不影响指纹值（并发读 + 缓存） ----------
  // 预热一次（并发读）后连算两轮：缓存命中后值必须逐位相同，不同目标互不相同。
  const fingerprints = runEsm(
    `const m = await import('./scripts/build-core.mjs');
     await m.primeSourceTreeHash();
     const triples = ['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc'];
     const first = triples.map((t) => m.computeFingerprint(t, 'release'));
     const again = triples.map((t) => m.computeFingerprint(t, 'release'));
     console.log(JSON.stringify({ first, again }));`,
  );
  if (fingerprints.status !== 0) {
    // 指纹依赖编译器身份：没有 rustc 的机器上这一段跑不了。跳过要单列原因（退出码 3），
    // 不能记成一条无条件为真的断言——那是假通过。
    // `scripts/run-tests.mjs` 把这里汇总成「跳过」并打印原因。
    markSkipped('缺少可用的 rustc，指纹计算段跳过（编译器身份是指纹输入之一）');
    console.log(`     ${(fingerprints.stderr.split('\n').slice(0, 3).join(' ')).trim()}`);
    finish();
    return;
  }
  const result = JSON.parse(fingerprints.stdout.trim() || '{}') as {
    first?: string[];
    again?: string[];
  };
  const first = result.first ?? [];
  const again = result.again ?? [];
  check('每个目标都算出 64 位小写 hex 指纹', first.every((fp) => /^[0-9a-f]{64}$/.test(fp)));
  check('缓存命中后重算结果一致（并发读不改指纹值）', first.join() === again.join());
  check('不同目标三元组的指纹互不相同', new Set(first).size === first.length);

  finish();
});
