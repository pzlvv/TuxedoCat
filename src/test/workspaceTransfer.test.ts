/**
 * 跨工作区传输执行器用例（specs/028 FR-003 / FR-007）：
 * 递归 / 覆盖 / 合并 / 父目录创建 / 符号链接跳过 / 暂存改名无残留 / 类型冲突 /
 * 源不存在 / 会话取消注册表。
 *
 * 运行方式：npm run test:all -- workspaceTransfer
 */

import { promises as fs, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  cancelTransfersForSession,
  fsEndpoint,
  runSessionTransfer,
  runTransfer,
  TransferTypeConflictError,
} from '../host/workspaceTransfer';
import { createChecker, runTests } from './helpers/harness';

async function makeTempDir(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), `transfer-${label}-`));
  return dir;
}

/** 递归列出目录下全部相对路径（断言树形一致用） */
async function tree(root: string, prefix = ''): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const lines: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      lines.push(rel, ...(await tree(path.join(root, entry.name), rel)));
    } else {
      lines.push(rel);
    }
  }
  return lines;
}

/** 本平台能否创建符号链接（Windows 无开发者模式时 EPERM，按既有先例跳过该项） */
function canCreateSymlink(dir: string): boolean {
  try {
    const probe = path.join(dir, 'symlink-probe');
    symlinkSync(path.join(dir, '.'), probe, 'dir');
    return true;
  } catch {
    return false;
  }
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  const endpoint = fsEndpoint();
  const abortedSignal = new AbortController();
  abortedSignal.abort();

  // ── 递归整棵：含子目录与点文件，无排除项（AC-2）──
  {
    const root = await makeTempDir('recursive');
    const source = path.join(root, 'src');
    const dest = path.join(root, 'dst', 'nested', 'target');
    await fs.mkdir(path.join(source, 'sub', 'deep'), { recursive: true });
    await fs.writeFile(path.join(source, 'a.txt'), 'a');
    await fs.writeFile(path.join(source, '.dotfile'), 'dot');
    await fs.writeFile(path.join(source, 'sub', 'b.txt'), 'b');
    await fs.writeFile(path.join(source, 'sub', 'deep', 'c.txt'), 'c');

    const counts = await runTransfer({
      source: endpoint,
      sourcePath: source,
      dest: endpoint,
      destPath: dest,
      signal: new AbortController().signal,
    });
    check('递归：文件数统计', counts.files === 4);
    check('递归：字节数统计', counts.bytes === 'a dot b c'.replace(/ /g, '').length);
    check('递归：目标树逐项一致', JSON.stringify(await tree(dest)) === JSON.stringify(await tree(source)));
    check('递归：目标端无暂存残留', !(await tree(dest)).some((name) => name.includes('tuxedo-transfer-tmp')));
    await fs.rm(root, { recursive: true, force: true });
  }

  // ── 覆盖与合并：同名文件覆盖、同名目录合并、多余项不删除（AC-4）──
  {
    const root = await makeTempDir('merge');
    const source = path.join(root, 'src');
    const dest = path.join(root, 'dst');
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, 'shared.txt'), 'new-content');
    await fs.mkdir(dest, { recursive: true });
    await fs.writeFile(path.join(dest, 'shared.txt'), 'old-content-longer');
    await fs.writeFile(path.join(dest, 'extra.txt'), 'kept');

    await runTransfer({
      source: endpoint,
      sourcePath: source,
      dest: endpoint,
      destPath: dest,
      signal: new AbortController().signal,
    });
    check('覆盖：同名文件被覆盖', (await fs.readFile(path.join(dest, 'shared.txt'), 'utf8')) === 'new-content');
    check('合并：目标端多余文件不被删除', (await fs.readFile(path.join(dest, 'extra.txt'), 'utf8')) === 'kept');
    await fs.rm(root, { recursive: true, force: true });
  }

  // ── 符号链接：不跟随、不复制、计数（AC 同 FR-003）──
  {
    const root = await makeTempDir('symlink');
    if (canCreateSymlink(root)) {
      const source = path.join(root, 'src');
      const dest = path.join(root, 'dst');
      await fs.mkdir(source, { recursive: true });
      await fs.writeFile(path.join(source, 'real.txt'), 'real');
      symlinkSync(path.join(source, 'real.txt'), path.join(source, 'link.txt'), 'file');

      const counts = await runTransfer({
        source: endpoint,
        sourcePath: source,
        dest: endpoint,
        destPath: dest,
        signal: new AbortController().signal,
      });
      check('符号链接：跳过计数', counts.skippedSymlinks === 1 && counts.files === 1);
      check('符号链接：目标端不含链接', !(await tree(dest)).includes('link.txt'));

      // 根就是符号链接：整体跳过、零文件
      const rootLink = path.join(root, 'root-link');
      symlinkSync(source, rootLink, 'dir');
      const rootCounts = await runTransfer({
        source: endpoint,
        sourcePath: rootLink,
        dest: endpoint,
        destPath: path.join(root, 'dst2'),
        signal: new AbortController().signal,
      });
      check('符号链接：根为链接时整体跳过', rootCounts.files === 0 && rootCounts.skippedSymlinks === 1);
    } else {
      check('符号链接用例按平台能力跳过（无创建权限）', true);
    }
    await fs.rm(root, { recursive: true, force: true });
  }

  // ── 类型冲突：源目录 → 目标已存在同名文件（AC 同 FR-003 边界）──
  {
    const root = await makeTempDir('conflict');
    const source = path.join(root, 'src-dir');
    const destFile = path.join(root, 'as-file');
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(destFile, 'occupies');
    let conflicted = false;
    try {
      await runTransfer({
        source: endpoint,
        sourcePath: source,
        dest: endpoint,
        destPath: destFile,
        signal: new AbortController().signal,
      });
    } catch (error) {
      conflicted = error instanceof TransferTypeConflictError;
    }
    check('类型冲突：目录 → 已存在文件报错', conflicted);
    check('类型冲突：目标端未被破坏', (await fs.readFile(destFile, 'utf8')) === 'occupies');
    await fs.rm(root, { recursive: true, force: true });
  }

  // ── 源不存在：点名路径、目标端零写入（AC-21）──
  {
    const root = await makeTempDir('missing');
    const missing = path.join(root, 'nope');
    let message = '';
    try {
      await runTransfer({
        source: endpoint,
        sourcePath: missing,
        dest: endpoint,
        destPath: path.join(root, 'dst'),
        signal: new AbortController().signal,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check('源不存在：错误点名路径', message.includes(missing));
    check('源不存在：目标端零写入', !(await fs.readdir(root)).includes('dst'));
    await fs.rm(root, { recursive: true, force: true });
  }

  // ── 会话取消：abort 后的传输立即失败；未知会话取消是 no-op（FR-007）──
  {
    const root = await makeTempDir('abort');
    const source = path.join(root, 'src');
    const dest = path.join(root, 'dst');
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, 'a.txt'), 'a');
    let aborted = false;
    try {
      await runTransfer({
        source: endpoint,
        sourcePath: source,
        dest: endpoint,
        destPath: dest,
        signal: abortedSignal.signal,
      });
    } catch (error) {
      aborted = error instanceof Error && error.name === 'AbortError';
    }
    check('取消：已中止的信号让传输立即失败', aborted);

    cancelTransfersForSession('session-without-transfers');
    check('取消：未知会话是 no-op', true);
    await fs.rm(root, { recursive: true, force: true });
  }

  // ── 会话注册表：收尾后注销（同会话可再次执行）──
  {
    const root = await makeTempDir('registry');
    const source = path.join(root, 'src');
    const dest = path.join(root, 'dst');
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, 'a.txt'), 'a');
    const first = await runSessionTransfer({
      sessionId: 's-registry',
      source: endpoint,
      sourcePath: source,
      dest: endpoint,
      destPath: dest,
    });
    const second = await runSessionTransfer({
      sessionId: 's-registry',
      source: endpoint,
      sourcePath: source,
      dest: endpoint,
      destPath: dest,
    });
    check('注册表：同会话可连续执行两次传输', first.files === 1 && second.files === 1);
    await fs.rm(root, { recursive: true, force: true });
  }

  finish();
}

runTests('workspaceTransfer', run);
