/**
 * Read 卡片的路径转换与行号区间派生（`docs/hosts/webview-ui.md` 的工具卡片段）。
 *
 * 守护的是「点击 Read 卡片 → 宿主 `openFile`」这条链路：
 * - WSL 路径换算错 → 打开的是一台不存在的盘符上的错文件，或组件直接抛
 *   `TypeError`（`/mnt/d/` 曾走上错误分支取到 `undefined`）；
 * - `offset` 当作 0-based → 每条卡片的跳转目标整体下移一行，带 `limit` 时区间
 *   还多出 1 行（Read 的 `offset` 契约是 1-based 起始行号）。
 *
 * 两处都是 `src/webview/tools/ReadFile.tsx` 里手写的派生，已收敛到
 * `src/webview/readFileCard.ts` 的纯函数（specs/defects/readfile-card-wsl-path-offset.md）。
 *
 * 运行方式：npm run test:all -- read-file-card
 */

import * as assert from 'assert';
import { resolveReadSelection, wslToWindowsPath } from '../webview/readFileCard';
import { createChecker, runTests } from './helpers/harness';

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // ---------------- WSL 路径 → Windows 路径 ----------------

  // RT-1：盘符取 `/mnt/` 之后的第一个字符，路径正文从盘符后起算。
  // 修复前：`p[8]` / `p.slice(9)` 把盘符取成正文首字符、路径腰斩。
  assert.strictEqual(wslToWindowsPath('/mnt/d/git/proj'), 'D:\\git\\proj', 'WSL 路径盘符与正文都对');
  assert.strictEqual(
    wslToWindowsPath('/mnt/c/Users/pz/x.ts'),
    'C:\\Users\\pz\\x.ts',
    '带更多层级的 WSL 路径不被腰斩',
  );
  check('RT-1 WSL 路径按 /mnt/<盘符>/ 换算成 <盘符>:\\...', true);

  // RT-2：裸盘符（有无尾随斜杠）都得到 `D:\`；修复前 `/mnt/d/` 抛 TypeError。
  assert.strictEqual(wslToWindowsPath('/mnt/d'), 'D:\\', '裸 /mnt/d → D:\\');
  assert.strictEqual(wslToWindowsPath('/mnt/d/'), 'D:\\', '/mnt/d/ → D:\\（修复前抛 TypeError）');
  check('RT-2 /mnt/d 与 /mnt/d/ 都得到 D:\\', true);

  // 非 WSL 形态原样返回：Linux / macOS 绝对路径、已是 Windows 形态的路径。
  for (const untouched of ['/home/pz/a.ts', 'D:\\git\\proj', '', '/mnt', '/mnt/dd/x', '/mntx/d/x']) {
    assert.strictEqual(wslToWindowsPath(untouched), untouched, `非 WSL 路径原样返回: ${untouched}`);
  }
  check('RT-4a 非 WSL 路径原样返回', true);

  // ---------------- offset / limit → 1-based 行区间 ----------------

  // RT-3：offset 是 1-based 起始行号，换算不做 +1 偏移。
  assert.deepStrictEqual(
    resolveReadSelection(50, 3),
    { start: 50, end: 52 },
    'offset=50 limit=3 → 50..52（修复前 51..53）',
  );
  assert.deepStrictEqual(
    resolveReadSelection(1, 1),
    { start: 1, end: 1 },
    'offset=1 limit=1 → 1..1（修复前 2..2）',
  );
  assert.deepStrictEqual(
    resolveReadSelection(50, null),
    { start: 50, end: 50 },
    '无 limit 时区间只覆盖起始行（修复前 51..51）',
  );
  assert.deepStrictEqual(
    resolveReadSelection(0, 5),
    { start: 1, end: 5 },
    'offset=0 按 schema 口径当成 1',
  );
  check('RT-3 offset 按 1-based 换算成行区间', true);

  // RT-4c：limit 非正数 / 非有限值时区间退化为起始行，不产生倒序或 NaN 区间。
  assert.deepStrictEqual(resolveReadSelection(7, 0), { start: 7, end: 7 }, 'limit=0 退化为起始行');
  assert.deepStrictEqual(resolveReadSelection(7, Number.NaN), { start: 7, end: 7 }, 'limit=NaN 退化为起始行');
  assert.deepStrictEqual(resolveReadSelection(7, -3), { start: 7, end: 7 }, 'limit 负数退化为起始行');
  check('RT-4c limit 非正数 / 非有限值时区间退化为起始行', true);

  finish();
}

runTests('readFileCard', run);
