#!/usr/bin/env node
/**
 * 生成「路径展开」对等对照表。
 *
 * 对照表 `src/test/fixtures/pathParity.json` 被两侧共用：
 * - `src/test/pathParity.test.ts` 用 Embedded 的 `utils/path.ts::expandPath` 断言对照表仍成立；
 * - `core-rs/src/tools_tests.rs` 的 `path_parity_tests` 用 Rust `tools::expand_path` 断言结果一致。
 *
 * 用例只在临时目录里跑；输出里的基准目录 / 主目录分别写成 `__CWD__` / `__HOME__` 占位符，
 * 分隔符统一归一化为 `/`，因此对照表与机器、盘符无关。
 *
 * `platform` 字段标出只在某个平台成立的用例（Node 的 `path.isAbsolute` / `path.normalize`
 * 在 Windows 上把 `/tmp/x` 视为「当前盘根路径」，Linux 上则是绝对路径）。
 *
 * 用法：先 `npm run compile-tests`，再 `node scripts/gen-path-parity.mjs`。
 */

import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
require(join(repoRoot, 'out', 'src', 'core', 'history', 'Config.js')).setExtensionPath(repoRoot);

const { expandPath } = require(join(repoRoot, 'out', 'src', 'core', 'utils', 'path.js'));

const CWD = '__CWD__';
const HOME = '__HOME__';

/** 输入里的占位符换成真实路径；`~` 之外一律用正斜杠，Windows / Linux 都能跑。 */
function materialize(input, cwd) {
  return input.split(CWD).join(cwd);
}

/** 输出里的真实路径换成占位符，并把分隔符统一成 `/`。 */
function canonicalize(output, cwd) {
  const forwardCwd = cwd.split('\\').join('/');
  const forwardHome = homedir().split('\\').join('/');
  return output
    .split('\\').join('/')
    .split(forwardCwd).join(CWD)
    .split(forwardHome).join(HOME);
}

const cases = [
  {
    name: 'empty',
    why: '空串是假值：回退到会话工作目录（不是主目录）',
    input: '',
  },
  {
    name: 'blank-spaces',
    why: '纯空格 trim 后为空：回退工作目录',
    input: '   ',
  },
  {
    name: 'js-whitespace-u0085',
    why: 'U+0085 在 ECMAScript 里**不是**空白：trim 不生效，按相对路径拼接',
    input: '\u0085',
  },
  {
    name: 'js-whitespace-ufeff',
    why: 'U+FEFF 在 ECMAScript 里是空白：trim 后为空，回退工作目录',
    input: '\uFEFF',
  },
  {
    name: 'tilde',
    why: '单独 `~` 展开为主目录（不做规范化）',
    input: '~',
  },
  {
    name: 'tilde-slash',
    why: '`~/x` 拼到主目录下',
    input: '~/sub/dir',
  },
  {
    name: 'tilde-slash-trailing',
    why: '`~/x/` 走 `path.join`，与 `path.normalize` 一样保留尾随分隔符',
    input: '~/sub/',
  },
  {
    name: 'tilde-slash-dotdot',
    why: '`~/x/../y` 先规范化再保留尾随分隔符（无尾随分隔符时不补）',
    input: '~/sub/../other',
  },
  {
    name: 'tilde-other',
    why: '`~foo` 不是主目录写法，按相对路径处理',
    input: '~foo',
  },
  {
    name: 'tilde-backslash',
    why: '`~\\x` 同样不匹配 `~/` 前缀，按相对路径处理（Windows 上 `\\` 也是分隔符）',
    input: '~\\sub',
  },
  {
    name: 'relative-file',
    why: '普通相对路径按工作目录解析',
    input: 'a.txt',
  },
  {
    name: 'dot',
    why: '`.` 规范化成工作目录本身',
    input: '.',
  },
  {
    name: 'nested-normalize',
    why: '`..` 与重复分隔符一起做词法规范化',
    input: 'a/../b//c',
  },
  {
    name: 'multibyte-relative',
    why: '多字节相对路径（中文）按工作目录解析',
    input: '目录/文件.txt',
  },
  {
    name: 'multibyte-short-prefix',
    why: '回归：9 字节的纯中文路径曾让 WSL 分支按字节切片比较 `/mnt/` 时 panic',
    input: '你你你',
  },
  {
    name: 'multibyte-absolute',
    why: '多字节绝对路径规范化',
    input: `${CWD}/目录/文件.txt`,
  },
  {
    name: 'trailing-slash',
    why: '尾随分隔符被去掉',
    input: 'sub/',
  },
  {
    name: 'dot-segments',
    why: '`.` 段被去掉、尾随分隔符被去掉',
    input: 'a/./b/',
  },
  {
    name: 'absolute-from-cwd',
    why: '绝对路径直接规范化，不再拼工作目录',
    input: `${CWD}/x`,
  },
  {
    name: 'absolute-normalize',
    why: '绝对路径里的 `..` 也做词法规范化',
    input: `${CWD}/a/../b`,
  },
  {
    name: 'absolute-trailing-slash',
    why: 'Node `path.normalize` 保留绝对路径的尾随分隔符（`path.resolve` 才去掉）',
    input: `${CWD}/sub/`,
  },
  {
    name: 'absolute-trailing-collapse',
    why: '多个尾随分隔符折叠成一个并保留',
    input: `${CWD}/sub//`,
  },
  {
    name: 'absolute-trailing-after-dotdot',
    why: '`..` 规范化后仍保留尾随分隔符',
    input: `${CWD}/a/../b/`,
  },
  {
    name: 'win-mnt',
    why: 'Windows 专属：WSL `/mnt/d/...` 映射成 `D:\\...`（盘符大写）',
    input: '/mnt/d/git/proj',
    platform: 'win32',
  },
  {
    name: 'win-mnt-bare',
    why: 'Windows 专属：`/mnt/d` 无尾随斜杠映射成 `D:\\`',
    input: '/mnt/d',
    platform: 'win32',
  },
  {
    name: 'win-drive-slash-lower',
    why: 'Windows 专属：`/c/Users/x` 映射成 `c:\\Users\\x`（盘符大小写原样保留）',
    input: '/c/Users/x',
    platform: 'win32',
  },
  {
    name: 'win-drive-slash-upper',
    why: 'Windows 专属：`/C/Users/x` 盘符大小写原样保留',
    input: '/C/Users/x',
    platform: 'win32',
  },
  {
    name: 'win-drive-absolute',
    why: 'Windows 专属：盘符绝对路径的 `..` 规范化',
    input: 'C:\\a\\..\\b',
    platform: 'win32',
  },
  {
    name: 'win-drive-trailing',
    why: 'Windows 专属：盘符绝对路径保留尾随分隔符',
    input: 'C:\\a\\b\\',
    platform: 'win32',
  },
  {
    name: 'win-mnt-trailing',
    why: 'Windows 专属：WSL 映射后同样保留尾随分隔符',
    input: '/mnt/d/git/',
    platform: 'win32',
  },
  {
    name: 'win-rooted-trailing',
    why: 'Windows 专属：当前盘根路径保留尾随分隔符',
    input: '/tmp/x/',
    platform: 'win32',
  },
  {
    name: 'win-rooted-only',
    why: 'Windows 专属：只有根分隔符时规范化为 `\\`',
    input: '/',
    platform: 'win32',
  },
  {
    name: 'win-incomplete-unc',
    why: 'Windows 专属：`//tmp` 没有 share，不是 UNC，退化成当前盘根路径 `\\tmp`',
    input: '//tmp',
    platform: 'win32',
  },
  {
    name: 'win-incomplete-unc-trailing',
    why: 'Windows 专属：`//tmp/` 同样退化成 `\\tmp\\`',
    input: '//tmp/',
    platform: 'win32',
  },
  {
    name: 'win-triple-slash',
    why: 'Windows 专属：多余的分隔符折叠成一个（`///a` → `\\a`）',
    input: '///a',
    platform: 'win32',
  },
  {
    name: 'win-unc-bare',
    why: 'Windows 专属：UNC 只到 share 时 Node 补一个尾随分隔符',
    input: '\\\\server\\share',
    platform: 'win32',
  },
  {
    name: 'win-unc',
    why: 'Windows 专属：UNC 路径原样规范化',
    input: '\\\\server\\share\\x',
    platform: 'win32',
  },
  {
    name: 'win-rooted-slash',
    why:
      'Windows 专属：Node 的 `path.isAbsolute("/tmp/x")` 为真（当前盘根路径），' +
      '`path.normalize` 得到 `\\tmp\\x`——**不**拼会话工作目录',
    input: '/tmp/x',
    platform: 'win32',
  },
  {
    name: 'win-rooted-backslash',
    why: 'Windows 专属：`\\tmp\\x` 同样是当前盘根路径',
    input: '\\tmp\\x',
    platform: 'win32',
  },
  {
    name: 'win-rooted-normalize',
    why: 'Windows 专属：当前盘根路径里的 `..` 不会越过根',
    input: '/xy/../b',
    platform: 'win32',
  },
];

const dir = mkdtempSync(join(tmpdir(), 'path-parity-'));
const generated = [];
try {
  for (const testCase of cases) {
    const input = materialize(testCase.input, dir);
    let expected;
    try {
      expected = canonicalize(expandPath(input, dir), dir);
    } catch (error) {
      expected = `ERR: ${error.message}`;
    }
    generated.push({ ...testCase, expected });
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const output = {
  note:
    '路径展开对照表（Embedded `utils/path.ts::expandPath` ↔ Standalone `core-rs/src/tools.rs::expand_path`）。' +
    '输入 / 期望里的 `__CWD__` / `__HOME__` 是占位符，分隔符统一为 `/`。' +
    '`platform` 标出只在对应平台成立的用例。',
  cases: generated,
};

const target = join(repoRoot, 'src', 'test', 'fixtures', 'pathParity.json');
const { writeFileSync } = await import('node:fs');
writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`);
console.log(`wrote ${generated.length} cases`);
for (const testCase of generated) {
  console.log(`  ${testCase.name}: ${JSON.stringify(testCase.expected)}`);
}
