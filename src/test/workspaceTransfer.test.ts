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
  viewEndpoint,
} from '../host/workspaceTransfer';
import { createChecker, runTests } from './helpers/harness';
import type { WorkViewFileIoPayload, WorkViewFileIoResult } from '../shared/AssistantEventBus';

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

/** 每块读 4 字节：让「跨块拼接」这件事在用例里真的发生，而不是一次读完 */
const VIEW_CHUNK = 4;

interface ViewStubState {
  /** 相对路径（`'d/a.txt'`）→ 内容；`''` 是视图根 */
  files: Map<string, Buffer>;
  /** 已存在的目录（相对路径，含 `''`） */
  dirs: Set<string>;
}

/**
 * `UiRequest.workViewFileIoRequested` 的内存桩（specs/056）。
 *
 * 与 Core 侧的分支同形：路径是工作区相对的 `'/'` 分隔串；读写成对按 offset 定向；
 * `eof` 由「实读字节数小于请求量」得出。用例用它验证执行器在视图通道上的语义，
 * 真实挂载由 core-rs 的命名空间内用例覆盖。
 */
async function viewStub(
  payload: WorkViewFileIoPayload,
  state: ViewStubState,
): Promise<WorkViewFileIoResult> {
  const { files, dirs } = state;
  const parent = (p: string): string => {
    const parts = p.split('/').filter((part) => part !== '');
    parts.pop();
    return parts.join('/');
  };
  switch (payload.op) {
    case 'stat': {
      const file = files.get(payload.path);
      if (file) return { ok: true, exists: true, isFile: true, isDir: false, isSymlink: false, size: file.length };
      if (dirs.has(payload.path)) {
        return { ok: true, exists: true, isFile: false, isDir: true, isSymlink: false, size: 0 };
      }
      return { ok: true, exists: false, isFile: false, isDir: false, isSymlink: false, size: 0 };
    }
    case 'list': {
      const prefix = payload.path === '' ? '' : `${payload.path}/`;
      const names = new Map<string, 'file' | 'directory'>();
      for (const key of dirs) {
        if (key === '' || !key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest !== '' && !rest.includes('/')) names.set(rest, 'directory');
      }
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest !== '' && !rest.includes('/')) names.set(rest, 'file');
      }
      return {
        ok: true,
        entries: [...names.entries()].map(([name, kind]) => ({ name, kind })),
      };
    }
    case 'mkdirAll': {
      const parts = payload.path.split('/').filter((part) => part !== '');
      let current = '';
      dirs.add('');
      for (const part of parts) {
        current = current === '' ? part : `${current}/${part}`;
        dirs.add(current);
      }
      return { ok: true };
    }
    case 'rename': {
      const file = files.get(payload.path);
      if (file) {
        files.delete(payload.path);
        files.set(payload.to, file);
        return { ok: true };
      }
      return { ok: false, error: `rename: ${payload.path} 不存在` };
    }
    case 'unlink':
      files.delete(payload.path);
      return { ok: true };
    case 'read': {
      const file = files.get(payload.path);
      if (!file) return { ok: false, error: `read: ${payload.path} 不存在` };
      const length = Math.min(payload.length, VIEW_CHUNK);
      const slice = file.subarray(payload.offset, payload.offset + length);
      return {
        ok: true,
        bytes: [...slice],
        eof: payload.offset + slice.length >= file.length,
      };
    }
    case 'write': {
      if (payload.offset > 0 && !dirs.has(parent(payload.path))) {
        return { ok: false, error: `write: 父目录不存在（${parent(payload.path)}）` };
      }
      dirs.add(parent(payload.path) === '' ? '' : parent(payload.path));
      const existing = files.get(payload.path) ?? Buffer.alloc(0);
      const chunk = Buffer.from(payload.bytes);
      // 与 Core 同语义：从 offset 写并截断在写入末尾（分块推进时截断点是 no-op）
      const head = existing.subarray(0, payload.offset);
      const next = Buffer.concat([head, chunk]);
      files.set(payload.path, next);
      return { ok: true, size: next.length };
    }
    default:
      return { ok: false, error: 'unsupported op' };
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
    // 文件清单是卡片的事实源（specs/042 FR-001）：相对被传输子树的根、POSIX 分隔符
    check(
      '递归：清单逐项列出相对路径（POSIX 分隔符）',
      JSON.stringify(counts.paths) === JSON.stringify(['.dotfile', 'a.txt', 'sub/b.txt', 'sub/deep/c.txt']),
    );
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

  // ── 视图端点（specs/056 FR-002 / FR-003）：同一份执行器语义跑在 UiRequest 通道上 ──
  {
    const root = await makeTempDir('view');
    // 假视图：一个内存树 + 每块 4 字节的读，用来验证分块搬运与暂存改名都经请求完成
    const files = new Map<string, Buffer>();
    const dirs = new Set<string>(['']);
    const viewRequest = async (payload: Parameters<typeof viewStub>[0]): ReturnType<typeof viewStub> =>
      viewStub(payload, { files, dirs });

    const source = viewEndpoint({
      root: '/ws',
      request: viewRequest,
    });
    const dest = viewEndpoint({
      root: '/ws',
      request: viewRequest,
    });
    files.set('src/a.txt', Buffer.from('hello view'));
    files.set('src/sub/b.txt', Buffer.from('b'));
    dirs.add('src');
    dirs.add('src/sub');

    const counts = await runTransfer({
      source,
      sourcePath: '/ws/src',
      dest,
      destPath: '/ws/dst',
      signal: new AbortController().signal,
    });
    check(
      '视图端点：递归搬运的文件数与字节数正确',
      counts.files === 2 && counts.bytes === Buffer.byteLength('hello view') + 1,
    );
    check(
      '视图端点：分块读过 4 字节的边界后内容逐字节一致',
      files.get('dst/a.txt')?.toString() === 'hello view',
    );
    check('视图端点：暂存件不留在视图里', ![...files.keys()].some((k) => k.includes('.tuxedo-transfer-tmp')));
    check('视图端点：目录也建出来了', dirs.has('dst/sub'));

    // 覆盖语义 + 类型冲突 + 越界拒绝各一条
    files.set('dst/a.txt', Buffer.from('old'));
    await runTransfer({
      source,
      sourcePath: '/ws/src/a.txt',
      dest,
      destPath: '/ws/dst/a.txt',
      signal: new AbortController().signal,
    });
    check('视图端点：同名文件按覆盖语义替换', files.get('dst/a.txt')?.toString() === 'hello view');

    let outside = '';
    try {
      await source.stat('/elsewhere/a.txt');
    } catch (error) {
      outside = error instanceof Error ? error.message : String(error);
    }
    check('视图端点：工作区之外的路径被拒绝（FR-004）', outside.includes('outside the conversation workspace'));
    await fs.rm(root, { recursive: true, force: true });
  }

  // ── 视图端点失败语义：Core 回 ok:false 即抛错，不退回磁盘（FR-005）──
  {
    const broken = viewEndpoint({
      root: '/ws',
      request: async () => ({ ok: false, error: '该对话的 Overlay 视图不可用：代理缺失' }),
    });
    let message = '';
    try {
      await broken.stat('/ws/a.txt');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check('视图端点：ok:false 翻成异常并带上原因', message.includes('Overlay 视图不可用'));

    const listing = broken.readStream('/ws/a.txt');
    const failed = await new Promise<boolean>((resolve) => {
      listing.on('error', () => resolve(true));
      listing.on('data', () => undefined);
      listing.on('end', () => resolve(false));
    });
    check('视图端点：读流的失败走 stream error，不静默结束', failed);
  }

  finish();
}

runTests('workspaceTransfer', run);
