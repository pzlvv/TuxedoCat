/**
 * 文件类型分类（纯数据，无任何 import——侧栏渲染层与主进程共用这份根集合）。
 *
 * 侧栏文件树的图标着色（`electron/sidebar/main.ts` 的 fileIconFor）与「双击打开」
 * 的分流（`electron/fileOpen.ts` 的 classifyFileForOpen）消费同一份扩展名集合：
 * 图标说是文本的，双击就进内置文本窗口（Markdown 是例外——着色与文本同类，
 * 双击进内置 Markdown 预览窗口）——一份事实一个写入点（DEVELOPMENT.md 第 5 章规则 4），扩类型在这里加一处即可。
 */

/** 图片扩展名（图标着色 + 内置图片查看器打开） */
export const FILE_IMAGE_EXTS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif', 'tiff',
]);
/** Markdown 扩展名（图标着色与文本同类；双击进内置 Markdown 预览窗口，US-42 验收 6） */
export const FILE_MARKDOWN_EXTS: ReadonlySet<string> = new Set(['md', 'markdown']);
/** 文本类扩展名（图标着色 + 内置文本查看器打开） */
export const FILE_TEXT_EXTS: ReadonlySet<string> = new Set(['txt', 'log', 'rst', 'adoc']);
/** 代码类扩展名（图标着色 + 内置文本查看器打开，Monaco 按扩展名选语法） */
export const FILE_CODE_EXTS: ReadonlySet<string> = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java', 'c', 'h', 'cpp', 'hpp',
  'cc', 'cs', 'rb', 'php', 'swift', 'kt', 'kts', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1',
  'vue', 'svelte', 'astro', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'sql', 'lua',
  'dart', 'scala', 'groovy', 'ex', 'exs', 'erl', 'clj', 'cljs', 'r', 'pl', 'proto',
  'graphql', 'prisma', 'cmake',
]);
/** 配置类扩展名（图标着色 + 内置文本查看器打开） */
export const FILE_CONFIG_EXTS: ReadonlySet<string> = new Set([
  'json', 'jsonc', 'json5', 'toml', 'yaml', 'yml', 'xml', 'ini', 'cfg', 'conf', 'env',
  'properties', 'lock',
]);
/** 已知二进制扩展名（直接调系统应用打开，跳过内容嗅探） */
export const FILE_BINARY_EXTS: ReadonlySet<string> = new Set([
  'zip', 'gz', 'tar', 'rar', '7z', 'bz2', 'xz', 'zst',
  'exe', 'dll', 'so', 'dylib', 'msi', 'apk', 'jar', 'class', 'wasm',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'psd', 'ai', 'mp3', 'mp4', 'mov', 'avi', 'mkv', 'wav', 'flac',
]);

/**
 * 远程二进制文件的打开请求以此消息拒绝（US-42 验收 6：远程工作区二进制不支持打开）。
 * IPC 层识别它后回 `{ ok: false, error: 'remote-binary-unsupported' }` 且不弹框，
 * 渲染层静默忽略——双击「打不开」是预期行为，不是错误。纯数据放在这里：
 * 渲染层（无 Node 环境）与主进程共用同一份常量。
 */
export const REMOTE_BINARY_UNSUPPORTED = 'remote-binary-unsupported';

/** 双击打开的分流结果：sniff = 扩展名不认识，要先嗅探内容再定（文本还是二进制） */
export type FileOpenKind = 'image' | 'markdown' | 'text' | 'binary' | 'sniff';

/** 文件名 → 打开分流。识别规则与侧栏图标一致（同一份扩展名集合，只有一份根） */
export function classifyFileForOpen(fileName: string): FileOpenKind {
  const lower = fileName.toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  if (FILE_IMAGE_EXTS.has(ext)) return 'image';
  if (FILE_MARKDOWN_EXTS.has(ext)) return 'markdown';
  if (FILE_TEXT_EXTS.has(ext) || FILE_CODE_EXTS.has(ext) || FILE_CONFIG_EXTS.has(ext)) return 'text';
  if (FILE_BINARY_EXTS.has(ext)) return 'binary';
  return 'sniff';
}

/** 扩展名 → data URL 的 MIME（图片查看器统一吃 data URL）；不认识的按 octet-stream 兜底 */
export function imageMimeFor(fileName: string): string {
  const ext = fileName.toLowerCase();
  const dot = ext.lastIndexOf('.');
  const e = dot >= 0 ? ext.slice(dot + 1) : ext;
  switch (e) {
    case 'png': return 'image/png';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg': return 'image/svg+xml';
    case 'ico': return 'image/x-icon';
    case 'bmp': return 'image/bmp';
    case 'avif': return 'image/avif';
    case 'tiff': return 'image/tiff';
    default: return 'application/octet-stream';
  }
}
