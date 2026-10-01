/**
 * 「打开远程工作区」窗口的文案（`docs/core-daemon.md` 第 12 节）。
 *
 * 这个页面是 vite 产物、不属于 webview，用不上 `src/webview/i18n/` 的字典；locale 由
 * 主进程经 `loadFile` 的 query 传进来（宿主语言，见 `src/host/i18n.ts`）。
 */

/** 页面用到的全部文案 */
export interface RemoteWorkspaceLabels {
  connectTitle: string;
  /** 接入方式的页签 */
  tabConnectionString: string;
  tabSsh: string;
  connectHint: string;
  connectionLabel: string;
  connectionPlaceholder: string;
  /** SSH 页签的说明（部署 / 启动都在这一步自动完成） */
  sshHint: string;
  sshHostLabel: string;
  sshHostPlaceholder: string;
  sshPortLabel: string;
  sshPortPlaceholder: string;
  sshUserLabel: string;
  sshUserPlaceholder: string;
  sshPasswordLabel: string;
  sshPasswordPlaceholder: string;
  /** 连接进行中的提示（SSH 首次接入要上传产物并启动 daemon） */
  connecting: string;
  connect: string;
  cancel: string;
  pickerTitle: string;
  /** 已连接的远端，形如 `192.168.1.5:10975` / `pz@192.168.1.5:22` */
  pickerSubtitle: string;
  pathPlaceholder: string;
  up: string;
  upTitle: string;
  parentEntry: string;
  newFolder: string;
  newFolderPlaceholder: string;
  create: string;
  remove: string;
  rename: string;
  renameConfirm: string;
  removeConfirm: string;
  /** 非空目录的第二次确认（会连同里面的内容一起删掉） */
  removeRecursiveConfirm: string;
  confirmRemove: string;
  /** 行内编辑（重命名 / 删除确认）的取消 */
  cancelEdit: string;
  open: string;
  empty: string;
}

const ZH: RemoteWorkspaceLabels = {
  connectTitle: '打开远程工作区',
  tabConnectionString: '连接串',
  tabSsh: 'SSH',
  connectHint: '在远端机器上执行 tuxedo-cat-core start，把打印出来的连接串整行粘贴到下面。',
  connectionLabel: '连接串',
  connectionPlaceholder: '192.168.1.5:10975#token',
  sshHint: '只开放 SSH 端口时用这个方式：会自动在 ~/.local/bin 部署 Core、启动并接入。',
  sshHostLabel: '主机 / IP',
  sshHostPlaceholder: '192.168.1.5',
  sshPortLabel: 'SSH 端口',
  sshPortPlaceholder: '22',
  sshUserLabel: '登录用户',
  sshUserPlaceholder: 'root',
  sshPasswordLabel: '登录密码',
  sshPasswordPlaceholder: '登录密码',
  connecting: '正在连接远端并准备 Core…',
  connect: '连接',
  cancel: '取消',
  pickerTitle: '选择远端目录',
  pickerSubtitle: '已连接 {endpoint}',
  pathPlaceholder: '输入绝对路径后回车',
  up: '↑',
  upTitle: '上一级',
  parentEntry: '..',
  newFolder: '新建文件夹',
  newFolderPlaceholder: '新文件夹名',
  create: '创建',
  remove: '删除',
  rename: '重命名',
  renameConfirm: '确定',
  removeConfirm: '删除「{name}」？',
  removeRecursiveConfirm: '「{name}」非空，连同其中的全部内容一起删除？',
  confirmRemove: '删除',
  cancelEdit: '取消',
  open: '打开此目录',
  empty: '（没有子目录）',
};

const EN: RemoteWorkspaceLabels = {
  connectTitle: 'Open Remote Workspace',
  tabConnectionString: 'Connection String',
  tabSsh: 'SSH',
  connectHint:
    'Run `tuxedo-cat-core start` on the remote machine, then paste one of the printed connection strings below.',
  connectionLabel: 'Connection String',
  connectionPlaceholder: '192.168.1.5:10975#token',
  sshHint:
    'Use this when only the SSH port is open: the Core is deployed to ~/.local/bin, started, and connected automatically.',
  sshHostLabel: 'Host / IP',
  sshHostPlaceholder: '192.168.1.5',
  sshPortLabel: 'SSH Port',
  sshPortPlaceholder: '22',
  sshUserLabel: 'Login User',
  sshUserPlaceholder: 'root',
  sshPasswordLabel: 'Login Password',
  sshPasswordPlaceholder: 'Login password',
  connecting: 'Connecting and preparing the remote Core…',
  connect: 'Connect',
  cancel: 'Cancel',
  pickerTitle: 'Pick a Remote Folder',
  pickerSubtitle: 'Connected to {endpoint}',
  pathPlaceholder: 'Type an absolute path and press Enter',
  up: '↑',
  upTitle: 'Parent folder',
  parentEntry: '..',
  newFolder: 'New Folder',
  newFolderPlaceholder: 'New folder name',
  create: 'Create',
  remove: 'Delete',
  rename: 'Rename',
  renameConfirm: 'OK',
  removeConfirm: 'Delete "{name}"?',
  removeRecursiveConfirm: '"{name}" is not empty. Delete it with everything inside?',
  confirmRemove: 'Delete',
  cancelEdit: 'Cancel',
  open: 'Open this folder',
  empty: '(no subdirectories)',
};

/** 取文案：非 `zh*` 一律走英文，与 `src/host/i18n.ts` 的 `tt()` 同口径 */
export function getRemoteWorkspaceLabels(locale: string | null): RemoteWorkspaceLabels {
  return locale !== null && locale.toLowerCase().startsWith('zh') ? ZH : EN;
}

/** 把 `{key}` 占位替换成实参 */
export function formatLabel(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}
