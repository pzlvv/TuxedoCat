import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classifyFileForOpen } from '../../electron/fileTypes';
import {
  openLocalWorkspaceFile,
  openOverlayWorkspaceFile,
  openRemoteWorkspaceFile,
  OVERLAY_BINARY_UNSUPPORTED,
  resolveInitialView,
  REMOTE_BINARY_UNSUPPORTED,
  type FileOpenBridge,
  type RemoteFileReader,
} from '../../electron/fileOpen';
import { getMarkdownPreviewBodyHtml } from '../host/markdownHtml';
import { createChecker, runTests } from './helpers/harness';

/**
 * 侧栏「双击打开」的分流与 Markdown 预览正文生成（US-42 验收 6）。
 *
 * 覆盖点：
 * - `classifyFileForOpen`：markdown / 文本 / 图片 / 二进制 / 嗅探五类分流；
 * - `openLocalWorkspaceFile` / `openRemoteWorkspaceFile`：Markdown 走
 *   `openMarkdownViewer`，文本 / 图片 / 系统应用分流不回归，远程二进制仍拒绝；
 * - `getMarkdownPreviewBodyHtml`：GFM 渲染 + 内容净化（原生 HTML 转义、危险协议
 *   链接降级、安全链接带 noopener）。页面样式（标题栏 / 文本视图 / 配色）归
 *   `electron/monaco/markdown.css`，不在本模块。
 *
 * 运行方式：npm run test:all -- fileOpen
 */

/** 记录调用序列的假 bridge（编排逻辑不碰窗口，只验证「路由到哪个出口」） */
function recordingBridge(calls: { method: string; init: unknown }[]): FileOpenBridge {
  return {
    openMarkdownViewer: (init) => void calls.push({ method: 'markdown', init }),
    openImageViewer: (init) => void calls.push({ method: 'image', init }),
    openTextViewer: (init) => void calls.push({ method: 'text', init }),
    openLocalFile: (filePath) => void calls.push({ method: 'local', init: filePath }),
    openWithSystemApp: async (filePath) => void calls.push({ method: 'system', init: filePath }),
  };
}

/** 远程读原语假实现：内容预先放在 Map 里（远程编排不真连 SSH） */
function fakeReader(files: Map<string, string | Buffer>): RemoteFileReader {
  const get = (abs: string) => {
    const content = files.get(abs);
    if (content === undefined) throw new Error(`no fixture: ${abs}`);
    return content;
  };
  return {
    readText: async (abs) => String(get(abs)),
    readBytes: async (abs) => Buffer.isBuffer(get(abs)) ? (get(abs) as Buffer) : Buffer.from(String(get(abs))),
    readHead: async (abs, maxBytes) => {
      const bytes = Buffer.isBuffer(get(abs)) ? (get(abs) as Buffer) : Buffer.from(String(get(abs)));
      return bytes.subarray(0, maxBytes);
    },
  };
}

runTests('fileOpen + markdown 预览', async () => {
  const { check, finish } = createChecker();

  // ── classifyFileForOpen ──
  check('md 分流为 markdown', classifyFileForOpen('README.md') === 'markdown');
  check('markdown 分流为 markdown', classifyFileForOpen('notes.markdown') === 'markdown');
  check('大小写不敏感', classifyFileForOpen('README.MD') === 'markdown');
  check('txt 分流为 text', classifyFileForOpen('notes.txt') === 'text');
  check('代码扩展名分流为 text', classifyFileForOpen('main.ts') === 'text');
  check('png 分流为 image', classifyFileForOpen('logo.png') === 'image');
  check('zip 分流为 binary', classifyFileForOpen('a.zip') === 'binary');
  check('未知扩展名分流为 sniff', classifyFileForOpen('Makefile.orig') === 'sniff');

  // ── 本地分流 ──
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuxedo-fileopen-'));
  try {
    fs.writeFileSync(path.join(tmp, 'doc.md'), '# 标题\n\n正文 **加粗**\n');
    fs.writeFileSync(path.join(tmp, 'note.txt'), 'plain');
    fs.writeFileSync(path.join(tmp, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const localCalls: { method: string; init: unknown }[] = [];
    await openLocalWorkspaceFile(recordingBridge(localCalls), tmp, 'doc.md', 'tree', async () => ({ inGit: false, hasHeadVersion: false }));
    check('本地 md → Markdown 预览出口', localCalls.length === 1 && localCalls[0].method === 'markdown');
    check(
      '本地 md 预览带文件名与内容',
      localCalls.length === 1
        && (localCalls[0].init as { title: string; content: string }).title === 'doc.md'
        && (localCalls[0].init as { title: string; content: string }).content.includes('# 标题'),
    );
    check(
      '本地 md 带本地监听目标',
      localCalls.length === 1
        && JSON.stringify((localCalls[0].init as { watchTarget: unknown }).watchTarget)
          === JSON.stringify({ kind: 'local', filePath: path.join(tmp, 'doc.md') }),
    );

    localCalls.length = 0;
    await openLocalWorkspaceFile(recordingBridge(localCalls), tmp, 'logo.png', 'tree', async () => ({ inGit: false, hasHeadVersion: false }));
    check(
      '本地图片带本地监听目标',
      localCalls.length === 1
        && localCalls[0].method === 'image'
        && JSON.stringify((localCalls[0].init as { watchTarget: unknown }).watchTarget)
          === JSON.stringify({ kind: 'local', filePath: path.join(tmp, 'logo.png') }),
    );

    localCalls.length = 0;
    await openLocalWorkspaceFile(recordingBridge(localCalls), tmp, 'note.txt', 'tree', async () => ({ inGit: false, hasHeadVersion: false }));
    check('本地 txt 走文本查看器出口（带初始视图）', localCalls.length === 1 && localCalls[0].method === 'text'
      && (localCalls[0].init as { initialView: string }).initialView === 'full');

    localCalls.length = 0;
    let escaped = false;
    try {
      await openLocalWorkspaceFile(recordingBridge(localCalls), tmp, '../doc.md', 'tree', async () => ({ inGit: false, hasHeadVersion: false }));
    } catch {
      escaped = true;
    }
    check('越界路径仍拒绝', escaped && localCalls.length === 0);

  // 接线：hasHeadVersion 的返回值真的影响初始视图（判定只在主进程做一次）
  const diffCalls: { method: string; init: unknown }[] = [];
  // hasHeadVersion 的返回值是「文件有 HEAD 版本」（true = 非新增）
  await openLocalWorkspaceFile(
    recordingBridge(diffCalls), tmp, 'doc.md', 'changes',
    async () => ({ inGit: true, hasHeadVersion: true }),
  );
  check('changes 来源 + 有 HEAD 版本 → 初始落变更视图',
    diffCalls.length === 1
      && (diffCalls[0].init as { initialView: string }).initialView === 'changes');
  check('磁盘来源带 kind 判别值（与 overlay 来源互斥）',
    JSON.stringify((diffCalls[0]?.init as { diffSource: unknown }).diffSource)
      === JSON.stringify({ kind: 'disk', root: tmp, rel: 'doc.md' }));
  diffCalls.length = 0;
  await openLocalWorkspaceFile(
    recordingBridge(diffCalls), tmp, 'doc.md', 'changes',
    async () => ({ inGit: true, hasHeadVersion: false }),
  );
  check('changes 来源 + 新增文件 → 初始落全文',
    diffCalls.length === 1
      && (diffCalls[0].init as { initialView: string }).initialView === 'full');

  diffCalls.length = 0;
  await openLocalWorkspaceFile(
    recordingBridge(diffCalls), tmp, 'doc.md', 'changes',
    async () => ({ inGit: false, hasHeadVersion: false }),
  );
  check('非 git 工作区：不传 diffSource（变更按钮置灰，AC-9）',
    diffCalls.length === 1
      && (diffCalls[0].init as { diffSource: unknown }).diffSource === null
      && (diffCalls[0].init as { initialView: string }).initialView === 'full');

  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ── Overlay 对话分流（specs/046 FR-003 / specs/047 FR-004）──
  {
    // 内容与 HEAD 版本都由 Core 提供（宿主不读盘、也读不到视图里的 `.git`），
    // 这里用假取数原语记录请求过的相对路径
    const requested: string[] = [];
    const overlayReader = (diff: {
      ok: true; kind: 'git'; before: string | null; after: string;
    } | { ok: true; kind: 'not-a-git-workspace'; after: string }) => ({
      sessionId: 'sess-overlay',
      readDiff: async (rel: string) => {
        requested.push(rel);
        return diff;
      },
    });
    const overlayRoot = path.join(os.tmpdir(), 'tuxedo-overlay-root');

    // 有 HEAD 版本且已改动：「变更」来源 + 变更档初始视图（AC-10）
    const mdCalls: { method: string; init: unknown }[] = [];
    await openOverlayWorkspaceFile(
      recordingBridge(mdCalls),
      overlayReader({ ok: true, kind: 'git', before: 'a\nb\n', after: 'a\nB\n' }),
      overlayRoot, 'doc.md', 'changes',
    );
    check('Overlay md → Markdown 预览出口', mdCalls.length === 1 && mdCalls[0].method === 'markdown');
    check('Overlay md 内容来自 Core 而非磁盘',
      (mdCalls[0]?.init as { content: string }).content === 'a\nB\n');
    check('Overlay 视图不给 watchTarget（视图路径宿主看不到）',
      (mdCalls[0]?.init as { watchTarget: unknown }).watchTarget === null);
    check('Overlay 非新增文件给出 overlay 来源（变更视图由 Core 取两侧原文）',
      JSON.stringify((mdCalls[0]?.init as { diffSource: unknown }).diffSource)
        === JSON.stringify({ kind: 'overlay', sessionId: 'sess-overlay', rel: 'doc.md' }));
    check('Overlay 变更来源 + 有 HEAD 版本 → 初始落变更视图',
      (mdCalls[0]?.init as { initialView: string }).initialView === 'changes');

    // 新增文件（before === null）：任何来源都落全文，且不给 diffSource（AC-11）
    const txtCalls: { method: string; init: unknown }[] = [];
    await openOverlayWorkspaceFile(
      recordingBridge(txtCalls),
      overlayReader({ ok: true, kind: 'git', before: null, after: 'brand new\n' }),
      overlayRoot, 'note.txt', 'changes',
    );
    check('Overlay 文本 → 文本查看器出口', txtCalls.length === 1 && txtCalls[0].method === 'text');
    check('Overlay 新增文件初始落全文（没有可对比的旧版本）',
      (txtCalls[0]?.init as { initialView: string }).initialView === 'full');
    check('Overlay 新增文件不给 diffSource',
      (txtCalls[0]?.init as { diffSource: unknown }).diffSource === null);
    check('请求的相对路径是约定格式', requested.includes('note.txt'));

    // 非 git 工作区：只有内容，变更视图不适用（AC-9 同口径）
    const nonGitCalls: { method: string; init: unknown }[] = [];
    await openOverlayWorkspaceFile(
      recordingBridge(nonGitCalls),
      overlayReader({ ok: true, kind: 'not-a-git-workspace', after: 'plain\n' }),
      overlayRoot, 'note.txt', 'changes',
    );
    check('Overlay 非 git 工作区落全文',
      (nonGitCalls[0]?.init as { initialView: string }).initialView === 'full');
    check('Overlay 非 git 工作区不给 diffSource',
      (nonGitCalls[0]?.init as { diffSource: unknown }).diffSource === null);

    // 取数失败：错误如实上抛，不打开空窗口
    let failed = '';
    try {
      await openOverlayWorkspaceFile(
        recordingBridge([]),
        { sessionId: 'sess-overlay', readDiff: async () => ({ ok: false as const, error: '视图未建立' }) },
        overlayRoot, 'note.txt', 'tree',
      );
    } catch (err) {
      failed = err instanceof Error ? err.message : String(err);
    }
    check('Overlay 取数失败时上抛原错误', failed === '视图未建立');

    const okReader = overlayReader({ ok: true, kind: 'git', before: 'x\n', after: 'x\n' });

    // 图片 / 二进制在 Overlay 对话里不支持打开
    for (const name of ['logo.png', 'a.zip']) {
      let rejected = '';
      try {
        await openOverlayWorkspaceFile(recordingBridge([]), okReader, overlayRoot, name, 'tree');
      } catch (err) {
        rejected = err instanceof Error ? err.message : String(err);
      }
      check(`Overlay 拒绝打开 ${name}`, rejected === OVERLAY_BINARY_UNSUPPORTED);
    }

    // 越界路径与本地同一份校验
    let escaped = '';
    try {
      await openOverlayWorkspaceFile(recordingBridge([]), okReader, overlayRoot, '../etc/passwd', 'tree');
    } catch (err) {
      escaped = err instanceof Error ? err.message : String(err);
    }
    check('Overlay 拒绝越界路径', escaped.includes('escapes the workspace root'));
  }

  // ── 远程分流 ──
  const remoteFiles = new Map<string, string | Buffer>([
    ['/srv/remote/doc.md', '# 远程\n'],
    ['/srv/remote/note.txt', 'plain'],
    ['/srv/remote/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
    ['/srv/remote/pack.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04])],
  ]);
  const endpoint = { host: 'h', port: 22, user: 'u', auth: null };
  const remoteCalls: { method: string; init: unknown }[] = [];
  const bridge = recordingBridge(remoteCalls);
  const reader = fakeReader(remoteFiles);

  await openRemoteWorkspaceFile(bridge, reader, endpoint, '/srv/remote', 'doc.md', 'tree', async () => ({ inGit: false, hasHeadVersion: false }));
  check('远程 md → Markdown 预览出口', remoteCalls.length === 1 && remoteCalls[0].method === 'markdown');
  check(
    '远程 md 预览内容来自 SFTP 读出',
    remoteCalls.length === 1 && (remoteCalls[0].init as { content: string }).content === '# 远程\n',
  );
  check(
    '远程 md 带远端监听目标',
    remoteCalls.length === 1
      && JSON.stringify((remoteCalls[0].init as { watchTarget: unknown }).watchTarget)
        === JSON.stringify({ kind: 'remote', endpoint, workspacePath: '/srv/remote', absPath: '/srv/remote/doc.md' }),
  );

  remoteCalls.length = 0;
  await openRemoteWorkspaceFile(bridge, reader, endpoint, '/srv/remote', 'note.txt', 'tree', async () => ({ inGit: false, hasHeadVersion: false }));
  check('远程 txt 仍走文本查看器出口', remoteCalls.length === 1 && remoteCalls[0].method === 'text');

  remoteCalls.length = 0;
  await openRemoteWorkspaceFile(bridge, reader, endpoint, '/srv/remote', 'logo.png', 'tree', async () => ({ inGit: false, hasHeadVersion: false }));
  check(
    '远程图片带远端监听目标',
    remoteCalls.length === 1
      && remoteCalls[0].method === 'image'
      && JSON.stringify((remoteCalls[0].init as { watchTarget: unknown }).watchTarget)
        === JSON.stringify({ kind: 'remote', endpoint, workspacePath: '/srv/remote', absPath: '/srv/remote/logo.png' }),
  );

  let remoteBinaryRejected = false;
  try {
    await openRemoteWorkspaceFile(bridge, reader, endpoint, '/srv/remote', 'pack.zip', 'tree', async () => ({ inGit: false, hasHeadVersion: false }));
  } catch (err) {
    remoteBinaryRejected = err instanceof Error && err.message === REMOTE_BINARY_UNSUPPORTED;
  }
  check('远程已知二进制仍拒绝', remoteBinaryRejected);

  // ── 打开时的初始视图（specs/040 FR-003 的映射表） ──
  check('tree + 新增 → full', resolveInitialView('tree', true) === 'full');
  check('tree + 非新增 → full（AC-7）', resolveInitialView('tree', false) === 'full');
  check('changes + 新增 → full（AC-5）', resolveInitialView('changes', true) === 'full');
  check('changes + 非新增 → changes（AC-6）', resolveInitialView('changes', false) === 'changes');
  check('toolLink + 新增 → full', resolveInitialView('toolLink', true) === 'full');
  check('toolLink + 非新增 → changes', resolveInitialView('toolLink', false) === 'changes');

  // ── Markdown 预览正文 ──
  const html = await getMarkdownPreviewBodyHtml(
    '# Title\n\n<script>alert(1)</script>\n\n<b>raw</b> and [bad](javascript:alert(1)) and [good](https://example.com/a)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n',
  );
  check('GFM 表格渲染', html.includes('<table>'));
  check('标题渲染', html.includes('<h1>Title</h1>'));
  check('原生 HTML 块被转义（脚本不可执行）', !html.includes('<script') && html.includes('&lt;script&gt;'));
  check('内联原生 HTML 被转义', html.includes('&lt;b&gt;raw&lt;/b&gt;'));
  check('javascript: 链接降级为纯文本', !html.includes('href="javascript:'));
  check('https 链接带 noopener 新窗口', html.includes('href="https://example.com/a"') && html.includes('rel="noopener noreferrer"'));

  finish();
});
