/**
 * 「打开远程工作区」窗口的页面逻辑（`docs/core/core-daemon.md` 第 12 节）。
 *
 * 两步：接入远端（SSH 表单）→ 选远端目录。选目录这一步按目录选择器的习惯做：
 *   - 路径可编辑，回车即跳转（`..` 那一行也能回上一级）；
 *   - 列表只列子目录，单击进入；上下方向键 / Ctrl+N / Ctrl+P 移动选中项，选中项恒在
 *     （默认第一项，`..` 除外）；
 *   - Tab / 回车把选中项补全进路径框（回车在已补全到选中项时进入该项）；
 *   - 工具栏提供「新建文件夹」（列表顶部内联输入）与逐行「删除」（行内二次确认）。
 *
 * 列表内容始终与路径框一致：路径框是目录就列它的全部内容，末尾一段是前缀就只列匹配项。
 * 前缀过滤是**渲染期视图**（`filter`），不改写 `listing`——否则回写路径框后列表会停在
 * 上一轮的过滤结果上（路径框是 `/abc/`、列表却只剩 `/abc/def` 开头的项）。
 *
 * 与主进程通过 preload 暴露的 `window.remoteWorkspaceAPI` 通信；文案由主进程经
 * `loadFile` 的 query 传 locale，见 `labels.ts`。
 */

import { formatLabel, getRemoteWorkspaceLabels } from './labels.js';
import {
  completePathInput,
  ensureTrailingSeparator,
  sameDirectory,
  splitPathInput,
  typedDirectory,
} from './pathInput.js';
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
  /** 前缀过滤词（小写，取自路径框最后一段）；空串表示列表就是该目录的全部内容 */
  let filter = '';
  /** 选中行路径（`..` 行也算候选）；有候选时恒有选中项 */
  let selectedPath: string | null = null;
  /** 本次渲染出的可选中行：路径 → 行元素（切选中态只改 class，不重画整表） */
  const selectableRows = new Map<string, HTMLElement>();
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
   * 按尾分隔符拆成「要列的目录 + 最后一段」：
   *   - 末段**没有**分隔符（`/w/ab`）：最后一段是过滤词，列父目录按前缀筛——
   *     `ab` 与 `abc` 同时显示，不进 `ab`；
   *   - 末段**带**分隔符（`/w/ab/`）：用户明确结束了这一级，列出 `ab` 的内容。
   *
   * 与回车跳转的区别是「不打扰」：路径还没敲完是常态，所以失败既不报错也不清空
   * 列表，只有回车（`navigate`）才给明确错误。列表刷新了但输入框内容不回写，
   * 用户还在敲。
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
    // 输入框就是当前列出的目录（或已被清空）：清掉过滤词，列表回到该目录的全部内容
    if (typed.length === 0
      || typed === listing.path
      || typed === ensureTrailingSeparator(listing.path)) {
      if (filter.length > 0) {
        filter = '';
        renderListing({ keepPathInput: true });
      }
      return;
    }
    // 每次预览都占一个新代次：慢的旧回包回来时对不上，直接丢弃
    const generation = ++previewGeneration;
    try {
      const { dir, prefix } = splitPathInput(typed);
      if (dir.length === 0) return;
      const target = await api.list(dir);
      if (generation !== previewGeneration) return;
      if (!target.ok) return;
      // 整份列举原样收下：过滤只落在 `filter` 上，之后任何一次回写路径框都能立刻
      // 退回「该目录的全部内容」。过滤只作用于目录名——daemon 本来就只回目录，不含文件
      listing = target.listing;
      const nextFilter = prefix.toLowerCase();
      // 过滤词变了就回到第一项（「默认当前第一个」）：用户还在敲，选中项要跟着候选走，
      // 否则 Tab / 回车补全会落在上一轮留下的选中项上
      if (nextFilter !== filter) selectedPath = null;
      filter = nextFilter;
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

  /** 列表该显示的行：过滤是渲染期视图，`listing` 始终是整份列举 */
  function visibleEntries(): DirectoryEntry[] {
    if (!listing) return [];
    if (filter.length === 0) return listing.entries;
    return listing.entries.filter((entry) => entry.name.toLowerCase().startsWith(filter));
  }

  function renderListing(options?: { keepPathInput?: boolean }): void {
    entriesEl.textContent = '';
    selectableRows.clear();
    if (!listing) return;

    // 回写路径框 = 放弃过滤：列表必须同时退回该目录的全部内容，否则会出现
    // 「路径框是 /abc/、列表却只剩 /abc/def 开头的项」这种错位。在途预览也要作废：
    // 它的过滤词基于旧输入，落地会把过滤又贴回来。
    if (options?.keepPathInput !== true) {
      filter = '';
      cancelPreview();
      // 回写统一带尾分隔符：显示的目录始终以 `/` 结尾（点击候选即自动补上），
      // 继续敲的就是下一级。
      pathInput.value = ensureTrailingSeparator(listing.path);
    }

    const visible = visibleEntries();

    if (editing?.kind === 'create') entriesEl.appendChild(createRow());
    if (listing.parent) {
      const row = parentRow(listing.parent);
      selectableRows.set(listing.parent, row);
      entriesEl.appendChild(row);
    }
    for (const entry of visible) {
      const row = rowFor(entry);
      selectableRows.set(entry.path, row);
      entriesEl.appendChild(row);
    }
    if (visible.length === 0 && editing?.kind !== 'create') {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = labels.empty;
      entriesEl.appendChild(empty);
    }

    // 选中项恒在：当前选中项没了（被过滤掉 / 被删掉）或本来就没有时回到第一项。
    // 默认不落在 `..` 上——它是「上一级」，只有方向键才选得到。
    if (selectedPath === null || !selectableRows.has(selectedPath)) {
      selectedPath = visible[0]?.path ?? null;
    }
    for (const [path, row] of selectableRows) {
      row.classList.toggle('selected', path === selectedPath);
    }

    upButton.disabled = busy || !listing.parent;
    openButton.disabled = busy;
    newFolderButton.disabled = busy || editing?.kind === 'create';
    // 路径框是这一步的输入中心：渲染完把焦点收回来（行内编辑自己抢焦点，跳过）。
    if (editing?.kind !== 'create' && editing?.kind !== 'rename') pathInput.focus();
  }

  // ---------- 键盘：选中项 ----------

  /** 上下方向键移动选中项（`..` 也在候选里；到头即停，不循环） */
  function moveSelection(delta: number): void {
    const order = [...selectableRows.keys()];
    if (order.length === 0) return;
    const index = selectedPath === null ? -1 : order.indexOf(selectedPath);
    const next = index < 0
      ? (delta > 0 ? 0 : order.length - 1)
      : Math.min(order.length - 1, Math.max(0, index + delta));
    const path = order[next];
    if (path === selectedPath) return;
    selectedPath = path;
    for (const [key, row] of selectableRows) row.classList.toggle('selected', key === path);
    selectableRows.get(path)?.scrollIntoView({ block: 'nearest' });
  }

  /** 路径框指向的是不是当前列出的目录：末尾带分隔符是它自己，否则是「父目录 + 最后一段过滤词」 */
  function inputPointsAtListing(): boolean {
    if (!listing) return false;
    const typed = pathInput.value.trim();
    if (typed.length === 0) return false;
    return sameDirectory(typedDirectory(typed), listing.path);
  }

  /**
   * 补全输入：把选中项写进路径框（带尾分隔符，光标到末尾）。候选全是目录，选中即
   * 「这一级敲完了」——预览随即展开它的内容（Tab 连按即逐级往下）。
   */
  function completeInput(): void {
    if (selectedPath === null || !inputPointsAtListing()) return;
    pathInput.value = completePathInput(selectedPath);
    pathInput.setSelectionRange(pathInput.value.length, pathInput.value.length);
    // 补全后让列表跟上：末段成为完整名字就只剩它自己，补了分隔符就展开下一级
    schedulePreview();
  }

  /**
   * 回车：进入当前选中的目录（一次到位，`renderListing` 回写路径时自带尾分隔符）；
   * 没有选中项（路径框指向的不是当前列出的目录 / 预览失败 / 过滤无匹配）时按
   * 输入框原文跳转，由 navigate() 给出明确错误。
   */
  function submitPathInput(): void {
    if (selectedPath !== null && inputPointsAtListing()) {
      navigate(selectedPath);
      return;
    }
    const target = pathInput.value.trim();
    if (target.length > 0) navigate(target);
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
    // 上下选择：方向键 / Ctrl+N / Ctrl+P（路径框是这一步唯一常驻焦点的控件，
    // 这些键就落在它上面；不拦默认行为的话 Tab 会把焦点挪走、Ctrl+P 会冒打印）
    const key = event.key.toLowerCase();
    if (key === 'arrowdown' || (event.ctrlKey && key === 'n')) {
      event.preventDefault();
      moveSelection(1);
      return;
    }
    if (key === 'arrowup' || (event.ctrlKey && key === 'p')) {
      event.preventDefault();
      moveSelection(-1);
      return;
    }
    if (key === 'tab') {
      event.preventDefault();
      completeInput();
      return;
    }
    if (key === 'enter') submitPathInput();
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
    // 路径框停在候选前缀上时「打开」作用于选中项（与回车一致）；否则打开当前列出的目录
    const target = filter.length > 0 && selectedPath !== null ? selectedPath : listing.path;
    pickerError.textContent = '';
    setBusy(true);
    api
      .open(target)
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

  // 路径框始终保持焦点：这一步里所有鼠标按下都不抢焦点（行内编辑的输入框除外——它们
  // 自己要用）。只拦默认行为，click 照常触发：行、工具栏按钮、右键菜单都还能用。
  document.addEventListener('mousedown', (event) => {
    if (pickerView.classList.contains('hidden')) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea')) return;
    event.preventDefault();
  }, true);

  // 兜底：焦点落到这一步的容器上（行内编辑被移除、窗口切回来）就收回路径框
  document.addEventListener('focusin', () => {
    if (pickerView.classList.contains('hidden')) return;
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLButtonElement) return;
    pathInput.focus();
  });

  // 接入面板不抢输入框焦点：窗口打开时保持「未选中任何字段」，由用户点进要填的那一项
}

main();
