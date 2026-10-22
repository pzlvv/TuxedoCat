import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classifyFileForOpen } from '../../electron/fileTypes';
import {
  openLocalWorkspaceFile,
  openRemoteWorkspaceFile,
  REMOTE_BINARY_UNSUPPORTED,
  type FileOpenBridge,
  type RemoteFileReader,
} from '../../electron/fileOpen';
import { getMarkdownPreviewHtml } from '../host/markdownHtml';
import { createChecker, runTests } from './helpers/harness';

/**
 * 侧栏「双击打开」的分流与 Markdown 预览 HTML 生成（US-42 验收 6）。
 *
 * 覆盖点：
 * - `classifyFileForOpen`：markdown / 文本 / 图片 / 二进制 / 嗅探五类分流；
 * - `openLocalWorkspaceFile` / `openRemoteWorkspaceFile`：Markdown 走
 *   `openMarkdownViewer`，文本 / 图片 / 系统应用分流不回归，远程二进制仍拒绝；
 * - `getMarkdownPreviewHtml`：GFM 渲染 + 内容净化（原生 HTML 转义、危险协议
 *   链接降级、安全链接带 noopener）+ 深浅色两套配色。
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
    await openLocalWorkspaceFile(recordingBridge(localCalls), tmp, 'doc.md');
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
    await openLocalWorkspaceFile(recordingBridge(localCalls), tmp, 'logo.png');
    check(
      '本地图片带本地监听目标',
      localCalls.length === 1
        && localCalls[0].method === 'image'
        && JSON.stringify((localCalls[0].init as { watchTarget: unknown }).watchTarget)
          === JSON.stringify({ kind: 'local', filePath: path.join(tmp, 'logo.png') }),
    );

    localCalls.length = 0;
    await openLocalWorkspaceFile(recordingBridge(localCalls), tmp, 'note.txt');
    check('本地 txt 仍走本地文件出口（Monaco）', localCalls.length === 1 && localCalls[0].method === 'local');

    localCalls.length = 0;
    let escaped = false;
    try {
      await openLocalWorkspaceFile(recordingBridge(localCalls), tmp, '../doc.md');
    } catch {
      escaped = true;
    }
    check('越界路径仍拒绝', escaped && localCalls.length === 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
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

  await openRemoteWorkspaceFile(bridge, reader, endpoint, '/srv/remote', 'doc.md');
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
  await openRemoteWorkspaceFile(bridge, reader, endpoint, '/srv/remote', 'note.txt');
  check('远程 txt 仍走文本查看器出口', remoteCalls.length === 1 && remoteCalls[0].method === 'text');

  remoteCalls.length = 0;
  await openRemoteWorkspaceFile(bridge, reader, endpoint, '/srv/remote', 'logo.png');
  check(
    '远程图片带远端监听目标',
    remoteCalls.length === 1
      && remoteCalls[0].method === 'image'
      && JSON.stringify((remoteCalls[0].init as { watchTarget: unknown }).watchTarget)
        === JSON.stringify({ kind: 'remote', endpoint, workspacePath: '/srv/remote', absPath: '/srv/remote/logo.png' }),
  );

  let remoteBinaryRejected = false;
  try {
    await openRemoteWorkspaceFile(bridge, reader, endpoint, '/srv/remote', 'pack.zip');
  } catch (err) {
    remoteBinaryRejected = err instanceof Error && err.message === REMOTE_BINARY_UNSUPPORTED;
  }
  check('远程已知二进制仍拒绝', remoteBinaryRejected);

  // ── Markdown 预览 HTML ──
  const html = await getMarkdownPreviewHtml(
    '# Title\n\n<script>alert(1)</script>\n\n<b>raw</b> and [bad](javascript:alert(1)) and [good](https://example.com/a)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n',
    { title: 'doc.md', isDark: false },
  );
  check('GFM 表格渲染', html.includes('<table>'));
  check('标题渲染', html.includes('<h1>Title</h1>'));
  check('原生 HTML 块被转义（脚本不可执行）', !html.includes('<script') && html.includes('&lt;script&gt;'));
  check('内联原生 HTML 被转义', html.includes('&lt;b&gt;raw&lt;/b&gt;'));
  check('javascript: 链接降级为纯文本', !html.includes('href="javascript:'));
  check('https 链接带 noopener 新窗口', html.includes('href="https://example.com/a"') && html.includes('rel="noopener noreferrer"'));
  check('标题进入 <title>', html.includes('<title>doc.md</title>'));

  const dark = await getMarkdownPreviewHtml('# T', { title: 't', isDark: true });
  const light = await getMarkdownPreviewHtml('# T', { title: 't', isDark: false });
  check('深浅色两套配色', dark !== light && dark.includes('#1e1e1e') && light.includes('#ffffff'));

  check('标题做 HTML 转义', (await getMarkdownPreviewHtml('x', { title: '<i>', isDark: false })).includes('<title>&lt;i&gt;</title>'));

  finish();
});
