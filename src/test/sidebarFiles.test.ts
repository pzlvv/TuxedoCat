import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import {
  deleteEachPath,
  listDirectory,
  resolveAllWithinRoot,
  resolveWithinRoot,
  sortSidebarEntries,
} from '../../electron/sidebarFiles';
import { createChecker, runTests } from './helpers/harness';

/**
 * 侧栏文件浏览器的路径校验与目录读取（`electron/sidebarFiles.ts`，纯 fs 可直接单测）。
 *
 * 覆盖点（安全面，DEVELOPMENT.md 第 5.1 节）：
 * - `resolveWithinRoot` 的越界判定：`..` 上跳、绝对路径、根目录本身（allowRoot）；
 * - posix 分支：远程路径不能按 win32 语义解析（`/home/pz` 变形 `D:\home\pz`）；
 * - `listDirectory`：目录优先排序、断链跳过；
 * - `deleteEachPath`：部分失败聚合为逐行错误（本地 / 远程删除共用一份口径）。
 *
 * 运行方式：npm run test:all -- sidebarFiles
 */

runTests('sidebarFiles', async () => {
  const { check, finish } = createChecker();
  const root = fs.mkdtempSync(join(os.tmpdir(), 'sidebar-files-test-'));
  try {
    fs.mkdirSync(join(root, 'src'));
    fs.mkdirSync(join(root, 'dirB'));
    fs.writeFileSync(join(root, 'readme.md'), 'x');
    fs.writeFileSync(join(root, 'src', 'a.ts'), 'x');
    // 断链样本：Windows 无符号链接权限时建不了（EPERM），跳过——断链分支在该平台退化
    try {
      fs.symlinkSync(join(root, 'gone-target'), join(root, 'broken-link'));
    } catch {
      // 权限不足：不建样本
    }

    check('相对路径解析到 root 内', resolveWithinRoot(root, 'src/a.ts') === join(root, 'src', 'a.ts'));

    check('`..` 上跳与绝对路径越界返回 null',
      resolveWithinRoot(root, '../x') === null
      && resolveWithinRoot(root, '..') === null
      && resolveWithinRoot(root, 'C:\\Windows') === null
      && resolveWithinRoot(root, '/etc/passwd') === null);

    check('根目录本身只在 allowRoot 下放行',
      resolveWithinRoot(root, '') === null
      && resolveWithinRoot(root, '', { allowRoot: true }) === root);

    check('posix 分支保持远端路径形态（win32 解析会变形）',
      resolveWithinRoot('/home/pz/proj', 'src/a.ts', { posix: true }) === '/home/pz/proj/src/a.ts'
      && resolveWithinRoot('/home/pz/proj', '../../etc', { posix: true }) === null);

    check('resolveAllWithinRoot：任一项越界整单返回 null',
      (() => {
        const all = resolveAllWithinRoot(root, ['src/a.ts', 'readme.md']);
        const bad = resolveAllWithinRoot(root, ['src/a.ts', '../x']);
        return Array.isArray(all) && all.length === 2 && bad === null;
      })());

    // listDirectory / deleteEachPath 是异步的：先跑完拿到布尔结果再 check
    const dirListing = await (async (): Promise<boolean> => {
      const entries = await listDirectory(root);
      const names = entries.map((e) => e.name);
      // 断链不进树；目录（dirB、src）排在文件（readme.md）之前
      return !names.includes('broken-link')
        && names.indexOf('dirB') < names.indexOf('readme.md')
        && names.indexOf('src') < names.indexOf('readme.md')
        && entries.every((e) => e.kind === 'file' || e.kind === 'directory');
    })();
    check('listDirectory：目录优先 + 断链跳过', dirListing);

    const sorted = sortSidebarEntries([
      { name: 'file10', kind: 'file' },
      { name: 'file2', kind: 'file' },
      { name: 'file2', kind: 'directory' },
    ]);
    check('sortSidebarEntries：同名目录排前 + 数字感知',
      sorted[0].name === 'file2' && sorted[0].kind === 'directory'
      && sorted[1].name === 'file2' && sorted[2].name === 'file10');

    const deleteAgg = await (async (): Promise<boolean> => {
      let aggregated = true;
      await deleteEachPath(['a', 'b'], async (rel: string) => {
        if (rel === 'b') throw new Error('EBUSY');
      }).catch((err: Error) => {
        aggregated = err.message.includes('b: EBUSY') && !err.message.includes('a:');
      });
      let silent = false;
      await deleteEachPath(['x'], async () => undefined).then(() => { silent = true; });
      return aggregated && silent;
    })();
    check('deleteEachPath：部分失败聚合为逐行错误，成功静默', deleteAgg);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  finish();
});
