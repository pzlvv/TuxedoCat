/**
 * 「打开远程工作区」窗口的页面逻辑（`docs/core-daemon.md` 第 12 节）。
 *
 * 两步：接入远端（SSH 表单）→ 选远端目录。选目录这一步按目录选择器的习惯做：
 *   - 路径可编辑，回车即跳转（`..` 那一行也能回上一级）；
 *   - 列表只列子目录，单击进入；
 *   - 工具栏提供「新建文件夹」（列表顶部内联输入）与逐行「删除」（行内二次确认）。
 *
 * 与主进程通过 preload 暴露的 `window.remoteWorkspaceAPI` 通信；文案由主进程经
 * `loadFile` 的 query 传 locale，见 `labels.ts`。
 */

import { formatLabel, getRemoteWorkspaceLabels } from './labels.js';
import { splitPathInput } from './pathInput.js';
import {
  formatSshEntry,
  matchSshEntries,
  sshHistoryKey,
  SSH_SUGGESTION_LIMIT,
  type SshHistoryCandidate,
} from '../../src/host/sshHistory.js';
import type {
  DirectoryEntry,
  DirectoryListing,
  RemoteConnectRequest,
  RemoteWorkspaceAPI,
} from './types.js';

declare global {
  interface Window {
    remoteWorkspaceAPI?: RemoteWorkspaceAPI;
  }
}

/** 页面脚本与主进程的接口：preload 未注入时直接报错，不做静默降级 */
function requireApi(): RemoteWorkspaceAPI {
  const api = window.remoteWorkspaceAPI;
  if (!api) throw new Error('remoteWorkspaceAPI is not injected');
  return api;
}

/** 取必存在的元素（缺元素是构建 / 模板出错，直接抛错而不是静默跳过） */
function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element #${id}`);
  return found as T;
}

/** 页面里正在进行的行内编辑；`create` 带名字，失败后还能原样重试 */
type InlineEdit =
  | { kind: 'create'; name: string }
  /** 重命名：`name` 是正在编辑的新名字（失败后保留，可继续改） */
  | { kind: 'rename'; path: string; name: string }
  /** `recursive` 为 true 表示已经问过一轮、这次要连内容一起删 */
  | { kind: 'remove'; path: string; recursive: boolean };

function main(): void {
  const api = requireApi();
  const locale = new URLSearchParams(window.location.search).get('locale');
  const labels = getRemoteWorkspaceLabels(locale);

  const connectView = element<HTMLElement>('connectView');
  const pickerView = element<HTMLElement>('pickerView');
  const connectError = element<HTMLElement>('connectError');
  const connectStatus = element<HTMLElement>('connectStatus');
  const sshHostInput = element<HTMLInputElement>('sshHost');
  const sshPortInput = element<HTMLInputElement>('sshPort');
  const sshUserInput = element<HTMLInputElement>('sshUser');
  const sshPasswordInput = element<HTMLInputElement>('sshPassword');
  const pickerError = element<HTMLElement>('pickerError');
  const pickerSubtitle = element<HTMLElement>('pickerSubtitle');
  const pathInput = element<HTMLInputElement>('pathInput');
  const entriesEl = element<HTMLElement>('entries');
  const upButton = element<HTMLButtonElement>('up');
  const newFolderButton = element<HTMLButtonElement>('newFolder');
  const openButton = element<HTMLButtonElement>('open');
  const contextMenu = element<HTMLElement>('contextMenu');
  const menuRenameButton = element<HTMLButtonElement>('menuRename');
  const menuDeleteButton = element<HTMLButtonElement>('menuDelete');

  let listing: DirectoryListing | null = null;
  let editing: InlineEdit | null = null;
  let busy = false;

  // ---------- 文案 ----------

  element<HTMLElement>('connectTitle').textContent = labels.connectTitle;
  element<HTMLElement>('sshHostLabel').textContent = labels.sshHostLabel;
  sshHostInput.placeholder = labels.sshHostPlaceholder;
  element<HTMLElement>('sshPortLabel').textContent = labels.sshPortLabel;
  sshPortInput.placeholder = labels.sshPortPlaceholder;
  element<HTMLElement>('sshUserLabel').textContent = labels.sshUserLabel;
  sshUserInput.placeholder = labels.sshUserPlaceholder;
  element<HTMLElement>('sshPasswordLabel').textContent = labels.sshPasswordLabel;
  sshPasswordInput.placeholder = labels.sshPasswordPlaceholder;
  // 端口给一个默认值（22）：表单里唯一有合理默认的一项
  sshPortInput.value = '22';
  element<HTMLButtonElement>('connect').textContent = labels.connect;
  element<HTMLButtonElement>('cancelConnect').textContent = labels.cancel;
  element<HTMLElement>('pickerTitle').textContent = labels.pickerTitle;
  pathInput.placeholder = labels.pathPlaceholder;
  upButton.textContent = labels.up;
  upButton.title = labels.upTitle;
  newFolderButton.textContent = labels.newFolder;
  menuRenameButton.textContent = labels.rename;
  menuDeleteButton.textContent = labels.remove;
  element<HTMLButtonElement>('cancelPicker').textContent = labels.cancel;
  openButton.textContent = labels.open;

  // ---------- 公共状态 ----------

  function setBusy(value: boolean): void {
    busy = value;
    document.querySelectorAll('button').forEach((button) => {
      button.disabled = value;
    });
    if (!value) {
      // 空闲时再按当前状态单独关掉该禁用的按钮
      upButton.disabled = !listing?.parent;
    }
  }

  function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * 拼接远端路径。远端可能是 Windows 也可能是 Linux，分隔符按当前路径的风格推断
   * （目录名里出现 `\` 就按 Windows 处理）。
   */
  function joinPath(dir: string, name: string): string {
    const separator = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
    return dir.endsWith(separator) ? `${dir}${name}` : `${dir}${separator}${name}`;
  }

  // ---------- 第一步：接入方式（SSH 表单） ----------

  /** 组装接入请求；形状校验在主进程（`buildRemoteEndpoint`） */
  function currentRequest(): RemoteConnectRequest {
    return {
      host: sshHostInput.value,
      port: sshPortInput.value,
      user: sshUserInput.value,
      password: sshPasswordInput.value,
    };
  }

  function connect(): void {
    if (busy) return;
    connectError.textContent = '';
    setBusy(true);
    // SSH 首次接入要上传产物并启动 daemon：明确告诉用户这一步会慢
    connectStatus.textContent = labels.connecting;
    api
      .connect(currentRequest())
      .then((result) => {
        connectStatus.textContent = '';
        if (!result.ok) {
          setBusy(false);
          connectError.textContent = result.error;
          return;
        }
        const { host, port, user } = result.endpoint;
        pickerSubtitle.textContent = formatLabel(labels.pickerSubtitle, {
          endpoint: user ? `${user}@${host}:${port}` : `${host}:${port}`,
        });
        connectView.classList.add('hidden');
        pickerView.classList.remove('hidden');
        listing = result.listing;
        setBusy(false);
        renderListing();
        pathInput.focus();
      })
      .catch((error: unknown) => {
        connectStatus.textContent = '';
        setBusy(false);
        connectError.textContent = describe(error);
      });
  }

  element<HTMLButtonElement>('connect').addEventListener('click', connect);
  element<HTMLButtonElement>('cancelConnect').addEventListener('click', () => api.cancel());
  for (const input of [sshHostInput, sshPortInput, sshUserInput, sshPasswordInput]) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') connect();
    });
  }

  // ---------- SSH 连接历史候选 ----------

  const sshSuggestions = element<HTMLElement>('sshSuggestions');
  /** 页面持有的候选快照（不含口令）：每次聚焦从主进程取最新（落盘是唯一事实） */
  let sshHistory: SshHistoryCandidate[] = [];

  function hideSuggestions(): void {
    sshSuggestions.classList.add('hidden');
  }

  /** 聚焦 / 输入时重画候选。排序在 `matchSshEntries`：前缀匹配 > 非前缀，同级按时间 */
  function refreshSuggestions(): void {
    // 忙时不弹：连接进行中不该再改表单（候选行的按钮也躲开全局禁用逻辑）
    if (busy || document.activeElement !== sshHostInput) {
      hideSuggestions();
      return;
    }
    const matched = matchSshEntries(sshHistory, sshHostInput.value, SSH_SUGGESTION_LIMIT);
    if (matched.length === 0) {
      hideSuggestions();
      return;
    }
    sshSuggestions.textContent = '';
    for (const entry of matched) {
      const row = document.createElement('div');
      row.className = 'suggestion';
      const text = document.createElement('span');
      text.className = 'suggestion-text';
      text.textContent = formatSshEntry(entry);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'suggestion-remove';
      remove.textContent = '×';
      remove.title = labels.sshHistoryRemove;
      remove.setAttribute('aria-label', labels.sshHistoryRemove);
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        void api.removeSshHistoryEntry(sshHistoryKey(entry)).then((entries) => {
          sshHistory = entries;
          refreshSuggestions();
        });
      });
      row.append(text, remove);
      // 选定即整表单回填：候选不含口令，按去重键向主进程取整条（含口令）
      row.addEventListener('click', () => {
        void api.sshHistoryEntry(sshHistoryKey(entry)).then((full) => {
          if (!full) return;
          sshHostInput.value = full.host;
          sshPortInput.value = String(full.port);
          sshUserInput.value = full.user;
          sshPasswordInput.value = full.password;
          hideSuggestions();
        });
      });
      sshSuggestions.appendChild(row);
    }
    sshSuggestions.classList.remove('hidden');
  }

  sshHostInput.addEventListener('focus', () => {
    // 每次聚焦取最新：上个会话里别处写入的历史也能立刻看到
    void api.sshHistory().then((entries) => {
      sshHistory = entries;
      refreshSuggestions();
    });
  });
  sshHostInput.addEventListener('input', refreshSuggestions);
  sshHostInput.addEventListener('blur', hideSuggestions);
  // 候选区按下鼠标时保住输入框焦点：blur 会先于 click 收起候选，点就落空了
  sshSuggestions.addEventListener('mousedown', (event) => event.preventDefault());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideSuggestions();
  });

  // ---------- 第二步：选目录 ----------

  /** 路径输入的即时预览防抖（毫秒） */
  const PREVIEW_DEBOUNCE_MS = 250;
  let previewTimer: number | null = null;
  /** 预览代次：快速输入时旧回包可能后到，只认最后一次发的那个 */
  let previewGeneration = 0;

  function navigate(path: string): void {
    if (busy) return;
    hideContextMenu();
    cancelPreview();
    pickerError.textContent = '';
    editing = null;
    setBusy(true);
    api
      .list(path)
      .then((result) => {
        setBusy(false);
        if (!result.ok) {
          // 跳转失败时留在原目录：路径框回到当前目录，错误显示在下方
          pickerError.textContent = result.error;
          renderListing();
          return;
        }
        listing = result.listing;
        renderListing();
      })
      .catch((error: unknown) => {
        setBusy(false);
        pickerError.textContent = describe(error);
        renderListing();
      });
  }

  /**
   * 输入框里的即时预览：输入停顿后就刷新列表。
   *
   * 两步：
   *   1. 先把输入当完整路径列一次——存在就直接展开它的内容（上一级敲完即可见里面）；
   *   2. 不存在就把最后一段当过滤词，列父目录再按前缀筛（路径补全，`/workspace/a` 只留
   *      `a` 开头的目录）。
   *
   * 与回车跳转的区别是「不打扰」：路径还没敲完是常态，所以失败既不报错也不清空列表，
   * 只有回车（`navigate`）才给明确错误。列表刷新了但输入框内容不回写，用户还在敲。
   */
  function schedulePreview(): void {
    if (previewTimer !== null) window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => {
      previewTimer = null;
      void previewPath();
    }, PREVIEW_DEBOUNCE_MS);
  }

  function cancelPreview(): void {
    if (previewTimer !== null) {
      window.clearTimeout(previewTimer);
      previewTimer = null;
    }
    // 作废在途回包，避免它盖掉随后的跳转结果
    previewGeneration += 1;
  }

  async function previewPath(): Promise<void> {
    if (busy || !listing) return;
    const typed = pathInput.value.trim();
    if (typed.length === 0 || typed === listing.path) return;
    // 每次预览都占一个新代次：慢的旧回包回来时对不上，直接丢弃
    const generation = ++previewGeneration;
    try {
      const direct = await api.list(typed);
      if (generation !== previewGeneration) return;
      if (direct.ok) {
        listing = direct.listing;
        renderListing({ keepPathInput: true });
        return;
      }
      const { dir, prefix } = splitPathInput(typed);
      if (dir.length === 0 || prefix.length === 0) return;
      const parent = await api.list(dir);
      if (generation !== previewGeneration) return;
      if (!parent.ok) return;
      // 过滤只作用于目录名：daemon 的目录列举本来就只回目录，不含文件
      const needle = prefix.toLowerCase();
      listing = {
        ...parent.listing,
        entries: parent.listing.entries.filter((entry) =>
          entry.name.toLowerCase().startsWith(needle),
        ),
      };
      renderListing({ keepPathInput: true });
    } catch {
      // 预览失败静默：回车时 navigate() 会给出具体原因
    }
  }

  /**
   * 一行子目录。破坏性操作不进常显 UI：重命名 / 删除都挂在右键菜单里，
   * 选中后在本行内联编辑（窗口是模态的，再弹一层对话框反而更绕）。
   */
  function rowFor(entry: DirectoryEntry): HTMLElement {
    const row = document.createElement('div');
    row.className = 'row';

    // 重命名中：整行换成「输入框 + 确定 / 取消」，此时点行不该进目录
    if (editing?.kind === 'rename' && editing.path === entry.path) {
      const input = document.createElement('input');
      input.className = 'text-input';
      input.type = 'text';
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.value = editing.name;
      const submit = (): void => {
        const name = input.value.trim();
        if (name.length === 0 || name === entry.name) {
          editing = null;
          renderListing();
          return;
        }
        renameDirectory(entry.path, name);
      };
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') submit();
        if (event.key === 'Escape') {
          editing = null;
          renderListing();
        }
      });
      const confirmButton = document.createElement('button');
      confirmButton.type = 'button';
      confirmButton.className = 'row-action';
      confirmButton.textContent = labels.renameConfirm;
      confirmButton.addEventListener('click', submit);
      const cancelButton = document.createElement('button');
      cancelButton.type = 'button';
      cancelButton.className = 'row-action';
      cancelButton.textContent = labels.cancelEdit;
      cancelButton.addEventListener('click', () => {
        editing = null;
        renderListing();
      });
      row.append(input, confirmButton, cancelButton);
      queueMicrotask(() => {
        input.focus();
        input.select();
      });
      return row;
    }

    const name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = entry.name;
    name.title = entry.path;
    row.appendChild(name);

    if (editing?.kind === 'remove' && editing.path === entry.path) {
      // 两阶段：先问「删不删」；daemon 回「非空」时再问「连同内容一起删」。
      const recursive = editing.recursive;
      const confirm = document.createElement('span');
      confirm.className = 'row-confirm';
      const text = document.createElement('span');
      text.className = 'row-confirm-text';
      text.textContent = recursive
        ? formatLabel(labels.removeRecursiveConfirm, { name: entry.name })
        : formatLabel(labels.removeConfirm, { name: entry.name });
      const confirmButton = document.createElement('button');
      confirmButton.type = 'button';
      confirmButton.className = 'row-action';
      confirmButton.textContent = labels.confirmRemove;
      confirmButton.addEventListener('click', (event) => {
        event.stopPropagation();
        removeDirectory(entry.path, recursive);
      });
      const cancelButton = document.createElement('button');
      cancelButton.type = 'button';
      cancelButton.className = 'row-action';
      cancelButton.textContent = labels.cancelEdit;
      cancelButton.addEventListener('click', (event) => {
        event.stopPropagation();
        editing = null;
        renderListing();
      });
      confirm.append(text, confirmButton, cancelButton);
      row.appendChild(confirm);
    }

    row.addEventListener('contextmenu', (event) => openContextMenu(event, entry));
    row.addEventListener('click', () => navigate(entry.path));
    return row;
  }

  // ---------- 右键菜单 ----------

  /** 菜单当前作用的行；菜单关掉时清空 */
  let menuTarget: DirectoryEntry | null = null;

  function openContextMenu(event: MouseEvent, entry: DirectoryEntry): void {
    event.preventDefault();
    if (busy) return;
    menuTarget = entry;
    contextMenu.classList.remove('hidden');
    // 先显示再量尺寸，才能把它夹在窗口内（右 / 下边缘贴边时向左上收）
    const rect = contextMenu.getBoundingClientRect();
    const left = Math.min(event.clientX, window.innerWidth - rect.width - 4);
    const top = Math.min(event.clientY, window.innerHeight - rect.height - 4);
    contextMenu.style.left = `${Math.max(4, left)}px`;
    contextMenu.style.top = `${Math.max(4, top)}px`;
  }

  function hideContextMenu(): void {
    contextMenu.classList.add('hidden');
    menuTarget = null;
  }

  menuRenameButton.addEventListener('click', () => {
    const entry = menuTarget;
    hideContextMenu();
    if (!entry) return;
    editing = { kind: 'rename', path: entry.path, name: entry.name };
    renderListing();
  });

  menuDeleteButton.addEventListener('click', () => {
    const entry = menuTarget;
    hideContextMenu();
    if (!entry) return;
    editing = { kind: 'remove', path: entry.path, recursive: false };
    renderListing();
  });

  // 点别处 / Esc / 窗口尺寸变化 / 列表滚动都收起菜单（右键菜单的常规行为）
  window.addEventListener('click', hideContextMenu);
  window.addEventListener('resize', hideContextMenu);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideContextMenu();
  });
  entriesEl.addEventListener('scroll', hideContextMenu);

  function createRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'row';

    const input = document.createElement('input');
    input.className = 'text-input';
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.placeholder = labels.newFolderPlaceholder;
    if (editing?.kind === 'create') input.value = editing.name;

    const submit = (): void => {
      const name = input.value.trim();
      if (name.length === 0) {
        editing = null;
        renderListing();
        return;
      }
      createDirectory(name);
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
      if (event.key === 'Escape') {
        editing = null;
        renderListing();
      }
    });

    const createButton = document.createElement('button');
    createButton.type = 'button';
    createButton.className = 'row-action';
    createButton.textContent = labels.create;
    createButton.addEventListener('click', submit);

    row.append(input, createButton);
    // 输入框要抢到焦点：渲染完再聚焦（重建 DOM 会丢焦点）
    queueMicrotask(() => input.focus());
    return row;
  }

  function parentRow(parent: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'row';
    const name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = labels.parentEntry;
    name.title = parent;
    row.appendChild(name);
    row.addEventListener('click', () => navigate(parent));
    return row;
  }

  function renderListing(options?: { keepPathInput?: boolean }): void {
    entriesEl.textContent = '';
    if (!listing) return;

    if (editing?.kind === 'create') entriesEl.appendChild(createRow());
    if (listing.parent) entriesEl.appendChild(parentRow(listing.parent));
    for (const entry of listing.entries) entriesEl.appendChild(rowFor(entry));
    if (listing.entries.length === 0 && editing?.kind !== 'create') {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = labels.empty;
      entriesEl.appendChild(empty);
    }

    // 输入框正在被编辑（即时预览）时不要回写：会把用户敲的字抹掉
    if (options?.keepPathInput !== true) pathInput.value = listing.path;
    upButton.disabled = busy || !listing.parent;
    openButton.disabled = busy;
    newFolderButton.disabled = busy || editing?.kind === 'create';
  }

  // ---------- 新建 / 删除 ----------

  function createDirectory(name: string): void {
    if (!listing || busy) return;
    const current = listing.path;
    pickerError.textContent = '';
    // 失败时保留输入的名字，重列后内联输入框还在、内容还在
    editing = { kind: 'create', name };
    setBusy(true);
    api
      .create(joinPath(current, name))
      .then((result) => {
        setBusy(false);
        if (!result.ok) {
          pickerError.textContent = result.error;
          renderListing();
          return;
        }
        navigate(current);
      })
      .catch((error: unknown) => {
        setBusy(false);
        pickerError.textContent = describe(error);
        renderListing();
      });
  }

  function renameDirectory(path: string, name: string): void {
    if (busy || !listing) return;
    const current = listing.path;
    pickerError.textContent = '';
    // 失败时保留输入的名字，重列后还能接着改
    editing = { kind: 'rename', path, name };
    setBusy(true);
    api
      .rename(path, name)
      .then((result) => {
        setBusy(false);
        if (!result.ok) {
          pickerError.textContent = result.error;
          renderListing();
          return;
        }
        navigate(current);
      })
      .catch((error: unknown) => {
        setBusy(false);
        pickerError.textContent = describe(error);
        renderListing();
      });
  }

  function removeDirectory(path: string, recursive: boolean): void {
    if (busy || !listing) return;
    const current = listing.path;
    pickerError.textContent = '';
    editing = null;
    setBusy(true);
    api
      .remove(path, recursive)
      .then((result) => {
        setBusy(false);
        if (result.ok) {
          navigate(current);
          return;
        }
        if (result.reason === 'notEmpty') {
          // 目录非空：升成第二次确认（这次带上 recursive），不是报错了事
          editing = { kind: 'remove', path, recursive: true };
          renderListing();
          return;
        }
        pickerError.textContent = result.error;
        renderListing();
      })
      .catch((error: unknown) => {
        setBusy(false);
        pickerError.textContent = describe(error);
        renderListing();
      });
  }

  // ---------- 事件 ----------

  pathInput.addEventListener('input', schedulePreview);
  pathInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const target = pathInput.value.trim();
    if (target.length > 0) navigate(target);
  });
  upButton.addEventListener('click', () => {
    if (listing?.parent) navigate(listing.parent);
  });
  newFolderButton.addEventListener('click', () => {
    if (busy || editing?.kind === 'create') return;
    pickerError.textContent = '';
    editing = { kind: 'create', name: '' };
    renderListing();
  });
  openButton.addEventListener('click', () => {
    if (busy || !listing) return;
    pickerError.textContent = '';
    setBusy(true);
    api
      .open(listing.path)
      .then((result) => {
        // 成功时主进程随即关掉窗口；失败留在这一步，把原因显示出来（不能停在全灰的忙态）
        if (!result.ok) {
          setBusy(false);
          pickerError.textContent = result.error;
        }
      })
      .catch((error: unknown) => {
        setBusy(false);
        pickerError.textContent = describe(error);
      });
  });
  element<HTMLButtonElement>('cancelPicker').addEventListener('click', () => api.cancel());

  // 接入面板不抢输入框焦点：窗口打开时保持「未选中任何字段」，由用户点进要填的那一项
}

main();
