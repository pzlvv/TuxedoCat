/**
 * 侧栏对话列表（Electron 原生 UI，独立于 webview）
 * 通过 preload 暴露的 sidebarAPI 与主进程通信：
 *   - getConversations()        读取对话列表
 *   - openConversation(id)      点击对话 → 主进程打开对应聊天 webview
 *   - newConversation()         新建对话
 *   - deleteConversation(id)    删除对话（含子对话）
 *   - closeConversation(id)     关闭对话聊天视图（释放资源）
 *   - renameConversation(id)    重命名
 *   - smartNameConversation(id) 智能命名（LLM 生成标题）
 *   - onConversationsUpdated()  主进程推送列表变化（纯磁盘元数据）
 *   - onSessionStatesUpdated()  主进程推送会话运行时状态（idle / waiting 全量）
 *   - onSessionLoadedChanged()  主进程推送「已打开会话」集合变化（视图层状态）
 *   - getLoadedSessions()       读取当前已打开会话集合（初始化用）
 *
 * 工作目录（多工作目录）：
 *   - getWorkspaces()           读取打开集合 + 活动项 + 最近工作目录
 *   - addWorkspaces(paths?)     添加工作目录（不传 paths 时弹出系统目录选择框）
 *   - activateWorkspace(path)   切换活动工作目录
 *   - closeWorkspace(path)      关闭工作目录
 *   - onWorkspacesChanged()     主进程推送打开集合变化
 * 文件浏览器（US-42 / US-43，侧栏底部可折叠分区）：
 *   - filesList(root, dir)      读取目录内容（rel 为 '/' 分隔相对路径，懒加载）
 *   - filesReveal(id, rel)      在系统文件资源管理器中定位（单项语义）
 *   - filesCopyPaths(...)       复制完整 / 相对路径（多项换行拼接）
 *   - filesDelete(id, rels)     删除（移入回收站，主进程先弹原生确认框）
 *   - filesOpen(id, rel)        双击打开：文本 / 图片进内置窗口，二进制调系统应用（US-42）
 * 侧栏宽度（US-44）：
 *   - setSidebarWidth(w, final) 右缘手柄拖拽改宽度；final 时主进程落盘，null 恢复默认
 * 侧栏头部为「搜索框 + 新对话」：搜索框按标题过滤当前活动工作目录的对话列表；
 * 打开集合为空时空态展示「打开本地工作区」+ 最近工作区（点击即添加）。
 * 对话列表有独立的等待态：列表尚未取到（启动 / 刚切换活动目录）时留白，超过
 * 100ms（LOADING_SHOW_DELAY_MS）仍未取到才显示「加载中」——快速切换的列表毫秒级
 * 回包，转圈闪现像闪烁；「暂无对话」只表示列表已取到且为空，不能把未知猜成空。
 *
 * 三条流各自单一 owner（docs/architecture/contracts.md 第 4 节规则 8）：
 *   列表（磁盘元数据）+ 运行时状态（core sessionRuntime）+ loaded（ChatViewManager 视图层），
 *   在 render() 时合并，列表载荷本身不再携带 loaded / idle / waitingForUser 标记。
 *
 * 交互参考插件 webview 版本（ConversationTreeItem.tsx）：
 * 根对话 hover 时显示 重命名/智能命名/删除/关闭 按钮（2 行 2 列）；重命名为行内输入框；
 * 删除需二次确认；智能命名进行中显示转圈。
 * 子代理（subagent）对话 hover 时只提供「关闭」——关闭其聊天视图、释放资源，
 * 不提供重命名/智能命名/删除（子代理历史由父会话管理，避免误删）；
 * 其余 3 格用不可见占位符撑住，使关闭按钮与根对话落在同一格、位置完全一致。
 *
 * 布局：每条对话左侧预留固定宽度的一列（.item-rail）——
 *   上槽位显示绿点（该对话已打开/已加载），下槽位显示子对话折叠按钮。
 * 两个槽位无论是否有内容都占位，因此所有对话的标题/副标题左边缘始终对齐。
 */

import { PRODUCT_NAME } from '../../src/config/project.js';
// 类型扩展名集合、打开分流与「远程二进制不支持」常量的根在 electron/fileTypes.ts
// （US-42 验收 6）：图标说是文本的，双击就进内置文本窗口，一份事实一个写入点
import {
  classifyFileForOpen,
  FILE_CODE_EXTS,
  FILE_CONFIG_EXTS,
  FILE_IMAGE_EXTS,
  FILE_MARKDOWN_EXTS,
  FILE_TEXT_EXTS,
  REMOTE_BINARY_UNSUPPORTED,
} from '../fileTypes.js';

interface ConversationMeta {
  sessionId: string;
  title: string;
  updatedAt: number;
  createdAt: number;
  messageCount: number;
  parentSessionId?: string;
  role?: string;
  /** 该对话所属的工作目录（绝对路径）：打开对话时回传主进程，按对话解析工作目录 */
  project?: string;
}

/** 工作区项（主进程取好目录名下发；id 是稳定身份，path 是展示路径） */
interface WorkspaceTab {
  id: string;
  path: string;
  name: string;
  /** 是否远程工作区 */
  remote: boolean;
}

/** 打开集合 + 活动项（id）+ 最近工作区（与标签页同形态：本地与远程都能点开） */
interface WorkspacesState {
  workspaces: WorkspaceTab[];
  active: string | null;
  recent: WorkspaceTab[];
}

/**
 * 会话运行时状态（core `SessionRuntimeState` 中侧栏消费的字段子集，
 * 见 docs/architecture/events.md 第 2 节）：侧栏只关心忙不忙，不读 abort 按钮用的根事实。
 */
interface SessionRuntimeState {
  sessionId: string;
  /** 会话是否空闲（false = 有活跃查询 / 压缩 / 后台 Bash / 递归子代理） */
  idle: boolean;
  /** 正在等待用户操作（ask user / 权限确认） */
  waiting: boolean;
}

/** 文件树条目（主进程 listDirectory 的产物；与 SSH 层同一份契约一个名字） */
type DirectoryEntry = import('../../src/host/standalone/sshClient').DirectoryEntry;

/** 文件列表回执（判别联合）：失败带 error 文案，成功必带 entries——渲染层不用双重判空 */
type FilesListResult = { ok: true; entries: DirectoryEntry[] } | { ok: false; error: string };

/** 文件操作回执（判别联合）；'cancelled' = 用户在删除确认框点了取消 */
type FilesOpResult = { ok: true } | { ok: false; error: string };

interface SidebarAPI {
  getConversations: () => Promise<ConversationMeta[]>;
  getLoadedSessions: () => Promise<string[]>;
  /** 运行时状态全量快照（初始化 / 重载时拉取播种；推送只在状态变化时发生） */
  getSessionStates: () => Promise<SessionRuntimeState[]>;
  getActiveSession: () => Promise<string | null>;
  getWorkspaces: () => Promise<WorkspacesState>;
  addWorkspaces: (paths?: string[]) => void;
  /** 打开（或激活）工作区；`id` 是下发项里的稳定身份（远程项也能定位） */
  openWorkspace: (id: string) => void;
  activateWorkspace: (path: string) => void;
  closeWorkspace: (path: string) => void;
  openConversation: (sessionId: string, project?: string) => void;
  newConversation: () => void;
  deleteConversation: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
  closeConversation: (sessionId: string) => void;
  renameConversation: (sessionId: string, title: string) => Promise<{ ok: boolean; error?: string }>;
  smartNameConversation: (sessionId: string) => Promise<{ ok: boolean; title?: string; error?: string }>;
  onConversationsUpdated: (cb: (list: ConversationMeta[]) => void) => void;
  onSessionStatesUpdated: (cb: (states: SessionRuntimeState[]) => void) => void;
  /** 未读完成的会话集合（「任务完成」绿色呼吸；对话成为当前对话后由主进程清除） */
  onSessionCompletion: (cb: (sessionIds: string[]) => void) => void;
  onSessionLoadedChanged: (cb: (sessionIds: string[]) => void) => void;
  onActiveSessionChanged: (cb: (sessionId: string | null) => void) => void;
  onWorkspacesChanged: (cb: (state: WorkspacesState) => void) => void;
  // ── 文件浏览器（US-42 / US-43） ──
  // rel 一律是 '/' 分隔的相对路径（约定格式，见 electron/sidebarFiles.ts）；
  // root 是侧栏工作区项的稳定 id（refKey），主进程按 id 回查打开集合里的工作区引用
  filesList: (workspaceId: string, dir: string) => Promise<FilesListResult>;
  /** 在系统文件资源管理器中定位（只作用于单个条目） */
  filesReveal: (workspaceId: string, relPath: string) => Promise<FilesOpResult>;
  /** 在该目录打开系统命令行（只作用于单个目录；本地工作区专属） */
  filesOpenTerminal: (workspaceId: string, dirRel: string) => Promise<FilesOpResult>;
  /** 复制路径：relative 为 true 时复制相对路径；多项以换行拼接 */
  filesCopyPaths: (workspaceId: string, relPaths: string[], relative: boolean) => Promise<FilesOpResult>;
  /** 删除（移入回收站）：主进程先弹自绘确认框 */
  filesDelete: (workspaceId: string, relPaths: string[]) => Promise<FilesOpResult>;
  /** 双击打开（US-42 验收 6）：主进程按类型分流——文本 / 图片进内置窗口，二进制调系统应用 */
  filesOpen: (workspaceId: string, relPath: string) => Promise<FilesOpResult>;
  // ── 侧栏宽度（US-44） ──
  /** 拖拽手柄改宽度；width 为 null 恢复默认。final 为 true 时主进程把值落盘 */
  setSidebarWidth: (width: number | null, final: boolean) => void;
}

declare global {
  interface Window {
    sidebarAPI?: SidebarAPI;
  }
}

const listEl = document.getElementById('list')!;
const footerEl = document.getElementById('footer')!;
const newChatBtn = document.getElementById('newChat') as HTMLButtonElement;
const searchInputEl = document.getElementById('searchInput') as HTMLInputElement;
// 文件浏览器（US-42 / US-43）
const filesSectionEl = document.getElementById('filesSection')!;
const filesHeaderEl = document.getElementById('filesHeader')!;
const filesBodyEl = document.getElementById('filesBody')!;
const filesRefreshBtn = document.getElementById('filesRefresh') as HTMLButtonElement;
const filesTreeEl = document.getElementById('filesTree')!;
// 侧栏宽度拖拽手柄（US-44，吸附在侧栏右缘）
const resizeHandleEl = document.getElementById('resizeHandle')!;

/**
 * 活动工作目录的对话列表。
 *
 * `null` = 当前目录的列表尚未取到（启动 / 刚切换活动目录）：这是**等待态**，
 * 不是「没有对话」。与 workspacesState 的 null 同一语义（docs/architecture/principles.md
 * 规则 7：事实未到达表示等待态，不猜值）——列表要等 core 连接就绪才能读到，
 * 用 `[]` 占位会把「未知」错渲染成「暂无对话」；取到列表后 `null` 不再出现，
 * 「确实为空」由非 null 的空数组表达。
 */
let conversations: ConversationMeta[] | null = null;
let activeSessionId: string | null = null;
/**
 * 打开集合 + 活动项 + 最近工作目录（来自 `sidebar:workspaces-changed` / getWorkspaces）。
 *
 * `null` = 尚未从宿主取到：这是**等待态**，不是「没有工作区」。工作区状态是宿主
 * 本地事实、不依赖 core；对话列表却要等 core 连接就绪（远程工作区连不上时会一直等）。
 * 用 `null` 把两者分开，避免 core 未就绪时把侧栏错渲染成「尚未打开工作区」。
 */
let workspacesState: WorkspacesState | null = null;
/** 搜索框内容：按标题过滤当前活动工作目录的对话列表 */
let searchQuery = '';
/**
 * 活动工作目录代次：每次收到 workspaces-changed 时 +1。
 * 异步拉取（getConversations / getLoadedSessions / getActiveSession）的回包
 * 只在自己发起时的代次仍是最新时才应用，避免快速切换目录时旧目录的结果覆盖新目录。
 */
let listGeneration = 0;
let subscribed = false;

/** 会话运行时状态（idle / waiting），来自 `sidebar:session-states-updated` 全量推送 */
let sessionStates = new Map<string, SessionRuntimeState>();
/** 已打开（有活动视图）的会话集合，来自 `sidebar:session-loaded-changed` */
let loadedSessions = new Set<string>();

/** 「任务完成」呼吸动画的时长（与 styles.css 的 animation 周期一致） */
const COMPLETION_BREATH_MS = 1600;
/**
 * 未读完成的会话（「任务完成」绿色呼吸）：sessionId → 推送到达时刻。
 * 主进程推**全量集合快照**（幂等）：灯条呼吸一次（到达后一个周期内带动画，之后
 * 常亮），直到该对话被打开（成为当前对话）——主进程清除并重推，条目随之熄灭。
 * 已有条目保留首次到达时刻：重复推送不给已亮的灯条重播呼吸。
 */
let completionAttention = new Map<string, number>();

/** 归一化 IPC 传来的运行时状态（跨进程边界，做一次防御性校验） */
function normalizeSessionStates(states: unknown): Map<string, SessionRuntimeState> {
  const map = new Map<string, SessionRuntimeState>();
  if (!Array.isArray(states)) return map;
  for (const s of states as SessionRuntimeState[]) {
    if (s && typeof s.sessionId === 'string') {
      // idle 缺省视为 true（空闲），避免旧格式 / 字段缺失时误亮流水灯
      map.set(s.sessionId, { sessionId: s.sessionId, idle: s.idle !== false, waiting: !!s.waiting });
    }
  }
  return map;
}

/** 归一化 IPC 传来的 loaded sessionId 列表 */
function normalizeLoadedSessions(sessionIds: unknown): Set<string> {
  if (!Array.isArray(sessionIds)) return new Set();
  return new Set(sessionIds.filter((id): id is string => typeof id === 'string'));
}

/** 应用一份未读完成集合快照：整体替换（已有条目保留原到达时刻，不重播呼吸） */
function applySessionCompletion(sessionIds: unknown): void {
  if (!Array.isArray(sessionIds)) return;
  const next = new Map<string, number>();
  for (const sessionId of sessionIds) {
    if (typeof sessionId !== 'string' || !sessionId) continue;
    next.set(sessionId, completionAttention.get(sessionId) ?? Date.now());
  }
  completionAttention = next;
  render();
}

// 交互状态（render 重建 DOM 后仍需保留）
let renamingSessionId: string | null = null;
let renameValue = '';
/** 等待二次确认删除的会话 */
let confirmDeleteId: string | null = null;
/** 正在智能命名的会话集合 */
const namingSessions = new Set<string>();
/**
 * 子会话展开状态（父会话 sessionId -> 是否展开）。
 * 与 webview 版本一致：未显式设置时，仅当该父会话（或其某个后代）是当前活跃
 * 会话时才默认展开，否则折叠，避免子代理对话把列表撑得很长。
 */
const expandedSubSessions: Record<string, boolean> = {};

/**
 * 增量渲染缓存（避免整列表重建导致闪烁）：
 * - itemEls:      sessionId -> 已渲染的 .item 元素（复用 DOM，保留 hover / 焦点 / 动画）
 * - itemHtmlCache: sessionId -> 上次渲染该项的 HTML（内容没变就不动 DOM）
 * active 高亮不写进 HTML，改由 setActive() 单独 toggle class，
 * 因此切换/打开对话（仅 active、loaded 变化）时不会再重建整列表。
 */
const itemEls = new Map<string, HTMLElement>();
const itemHtmlCache = new Map<string, string>();

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days <= 7) return `${days} 天前`;
  const d = new Date(ts);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function escapeHtml(s: string): string {
  // 引号也要转义：标题会写进重命名输入框的 value="..." 属性
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 无工作区空态：显示「打开本地工作区」按钮，下方列出最近工作区（点击即打开 / 重连）。
 * 聊天区保持纯提示，不提供添加入口。
 */
function renderEmptyState(): void {
  // 调用方 render() 已保证状态已到达；这里再取一次局部变量做类型收窄
  const state = workspacesState;
  if (!state) return;
  resetList();
  const recents = state.recent;
  const recentHtml = recents.length
    ? `<div class="recent-title">最近打开的工作区</div>
       <div class="recent-list">
         ${recents
           .map(
             (item) =>
               `<button class="recent-item" data-id="${escapeHtml(item.id)}" title="${escapeHtml(item.path)}">` +
               `<span class="recent-name">${escapeHtml(item.name)}</span>` +
               `<span class="recent-path">${escapeHtml(item.path)}</span></button>`,
           )
           .join('')}
       </div>`
    : '';
  listEl.innerHTML = `
    <div class="workspace-placeholder">
      <div class="workspace-title">尚未打开工作区</div>
      <div class="workspace-desc">添加一个工作区后即可开始使用 ${PRODUCT_NAME}</div>
      <button class="workspace-btn" id="addWorkspaceBtn">打开本地工作区</button>
      ${recentHtml}
    </div>`;
  footerEl.textContent = '';
  newChatBtn.style.display = 'none';
  searchInputEl.style.display = 'none';
  document.getElementById('addWorkspaceBtn')?.addEventListener('click', () => {
    window.sidebarAPI?.addWorkspaces();
  });
  listEl.querySelectorAll<HTMLElement>('.recent-item').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      if (id) window.sidebarAPI?.openWorkspace(id);
    });
  });
  setActive(null);
}

/* ── SVG 图标（与 webview 版本一致，智能命名使用 Sparkles） ── */
const ICON_RENAME = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
const ICON_SMART_NAME = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/></svg>`;
const ICON_DELETE = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;
const ICON_CLOSE = `<svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round"><path d="M9 3L3 9M3 3L9 9"/></svg>`;

/** 清空列表与增量渲染缓存（切到空态 / 工作区引导态时调用） */
function resetList(): void {
  itemEls.clear();
  itemHtmlCache.clear();
  listEl.innerHTML = '';
}

/** 把 itemHtml 生成的字符串解析成 .item 元素 */
function createItemElement(html: string): HTMLElement {
  const tmp = document.createElement('div');
  tmp.innerHTML = html.trim();
  return tmp.firstElementChild as HTMLElement;
}

/**
 * 等待态转圈的显示延时：进入等待态后 100ms 内只留白，超过仍没等到列表才画「加载中」。
 * 正常切换工作区时列表毫秒级回包（core 已就绪，请求即刻回），转圈闪现十几毫秒
 * 看起来像闪烁；真正需要转圈的是首次启动拉起 core、远程建链这类长等待。
 */
const LOADING_SHOW_DELAY_MS = 100;
/** 转圈显示延时的定时器；触发时置回 null 并登记 loadingSpinnerShown */
let loadingShowTimer: ReturnType<typeof setTimeout> | null = null;
/** 转圈是否已画出（定时器已触发过）：区分「延时未到」与「已过延时仍在等待」 */
let loadingSpinnerShown = false;

/** 离开等待态：清掉定时器与转圈标记（转圈从未画出就当没等待过） */
function clearLoadingWait(): void {
  if (loadingShowTimer !== null) {
    clearTimeout(loadingShowTimer);
    loadingShowTimer = null;
  }
  loadingSpinnerShown = false;
}

/**
 * 增量渲染：按 sessionId 复用已有 DOM 元素，只重建内容发生变化的项。
 *
 * 此前每次都整体替换 listEl.innerHTML：打开对话（只有 loaded 标记变化）也会
 * 把整列表销毁重建，造成列表闪烁、hover 丢失、滚动位置回到顶部、流水灯动画重播。
 * 现在：
 *   - 内容未变的项原样保留（完全不触碰 DOM，动画 / hover / 焦点不受影响）；
 *   - 内容变化的项才替换元素；
 *   - 顺序变化用 insertBefore 移动，已删除的项单独移除。
 */
function render(): void {
  // 工作区状态尚未从宿主取到：保持等待态（不渲染空态）。
  // 列表 / 状态推送可能先于 getWorkspaces 回包到达，此时按默认空集合渲染会错报
  // 「尚未打开工作区」——这正是启动期（core 未就绪）一直显示空态的根因。
  const state = workspacesState;
  if (!state) return;
  // 打开集合为空：显示打开本地工作区引导 + 最近工作区
  if (state.workspaces.length === 0) {
    clearLoadingWait();
    renderEmptyState();
    return;
  }
  newChatBtn.style.display = '';
  searchInputEl.style.display = '';

  // 列表尚未取到：等待态。延时未到只留白，超过 LOADING_SHOW_DELAY_MS 才画转圈；
  // 始终不渲染「暂无对话」（见 conversations 的注释）。
  if (!conversations) {
    if (loadingShowTimer === null && !loadingSpinnerShown) {
      // 刚进入等待态：起显示延时的定时器，触发后重渲染补画转圈
      loadingShowTimer = setTimeout(() => {
        loadingShowTimer = null;
        loadingSpinnerShown = true;
        // 触发时可能已取到列表：只在仍在等待时才需要转圈
        if (conversations === null) render();
      }, LOADING_SHOW_DELAY_MS);
    }
    footerEl.textContent = '';
    if (loadingShowTimer !== null) {
      // 延时未到：留白（快速切换时列表很快到达，转圈从未画出）
      resetList();
    } else if (!listEl.querySelector('.list-loading')) {
      // 已过延时：显示转圈（幂等，状态推送反复触发 render 时不重播动画）
      resetList();
      listEl.innerHTML =
        '<div class="list-loading"><span class="spinner"></span><span>加载中…</span></div>';
    }
    return;
  }
  clearLoadingWait();
  const list = conversations;

  // 搜索框按标题过滤当前活动工作目录的对话列表
  const filtered = searchQuery
    ? list.filter((c) => (c.title || '').toLowerCase().includes(searchQuery))
    : list;

  if (!filtered.length) {
    resetList();
    listEl.innerHTML = searchQuery
      ? '<div class="empty">没有匹配的对话</div>'
      : '<div class="empty">暂无对话</div>';
    footerEl.textContent = '';
    return;
  }

  // 父会话在前，子会话（parentSessionId 非空）缩进排列
  // 统一按修改时间（最后一条用户消息）倒序排序（与 webview 版本一致）；
  // 只有用户主动发消息才会刷新 updatedAt，后台消息不影响排序。
  const sorted = [...filtered].sort(
    (a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt),
  );

  // 按 parentSessionId 构建子会话映射（父会话不存在的视为根，避免孤儿丢失）
  const byId = new Map(sorted.map((c) => [c.sessionId, c]));
  const childrenMap = new Map<string, ConversationMeta[]>();
  const roots: ConversationMeta[] = [];
  for (const c of sorted) {
    const pid = c.parentSessionId;
    if (pid && pid !== c.sessionId && byId.has(pid)) {
      const arr = childrenMap.get(pid) || [];
      arr.push(c);
      childrenMap.set(pid, arr);
    } else {
      roots.push(c);
    }
  }

  // 子树是否包含当前活跃会话（用于决定默认展开状态）
  const subtreeHasActive = (id: string, depth = 0): boolean => {
    if (depth > 20) return false;
    if (id === activeSessionId) return true;
    const kids = childrenMap.get(id) || [];
    return kids.some((k) => subtreeHasActive(k.sessionId, depth + 1));
  };
  const isSubExpanded = (id: string): boolean => {
    const explicit = expandedSubSessions[id];
    if (explicit !== undefined) return explicit;
    // 默认：当前活跃会话所在的分支展开，其余折叠（参考 webview 对话列表）
    return subtreeHasActive(id);
  };

  // 按前序展开成「父在前、展开的子紧随其后」的渲染序列
  const ordered: Array<{ c: ConversationMeta; html: string }> = [];
  const collect = (c: ConversationMeta, depth: number): void => {
    const kids = childrenMap.get(c.sessionId) || [];
    const expanded = kids.length > 0 && isSubExpanded(c.sessionId);
    ordered.push({ c, html: itemHtml(c, depth, kids.length, expanded) });
    if (expanded) {
      for (const child of kids) collect(child, depth + 1);
    }
  };
  for (const c of roots) collect(c, 0);

  // 阶段 1：确保每个会话都有元素，并按目标顺序排列（复用已有元素，不触碰其内容）
  const seen = new Set<string>();
  const elements: HTMLElement[] = [];
  for (const node of ordered) {
    const sid = node.c.sessionId;
    seen.add(sid);
    let el = itemEls.get(sid);
    if (!el) {
      el = createItemElement(node.html);
      itemEls.set(sid, el);
      itemHtmlCache.set(sid, node.html);
    }
    elements.push(el);
  }
  let anchor: Node | null = listEl.firstChild;
  for (const el of elements) {
    if (el !== anchor) listEl.insertBefore(el, anchor);
    anchor = el.nextSibling;
  }
  // 移除已不存在的会话元素
  for (const [sid, el] of [...itemEls]) {
    if (!seen.has(sid)) {
      el.remove();
      itemEls.delete(sid);
      itemHtmlCache.delete(sid);
    }
  }
  // 清掉空态占位 / 空白文本节点，只保留对话项
  for (const node of Array.from(listEl.childNodes)) {
    if (!(node instanceof HTMLElement) || !node.classList.contains('item')) {
      node.remove();
    }
  }

  // 阶段 2：内容变化的项才替换元素（未变化的项完全不触碰，避免闪烁）
  for (const node of ordered) {
    const sid = node.c.sessionId;
    if (itemHtmlCache.get(sid) === node.html) continue;
    const el = itemEls.get(sid);
    if (!el) continue;
    const next = createItemElement(node.html);
    el.replaceWith(next);
    itemEls.set(sid, next);
    itemHtmlCache.set(sid, node.html);
  }

  footerEl.textContent = searchQuery
    ? `${filtered.length} / ${list.length} 个对话`
    : `${filtered.length} 个对话`;

  // 重建 DOM 后重新应用当前活跃会话高亮
  setActive(activeSessionId);

  // 重命名输入框：元素被重建后恢复焦点（不覆盖用户已输入的内容）
  if (renamingSessionId) {
    const input = listEl.querySelector<HTMLInputElement>('input.rename-input');
    if (input && document.activeElement !== input) {
      input.focus();
      const end = input.value.length;
      try { input.setSelectionRange(end, end); } catch { /* ignore */ }
    }
  }
}

function itemHtml(c: ConversationMeta, depth: number, childCount: number, isExpanded: boolean): string {
  const title = c.title && c.title.trim() ? c.title : '(未命名对话)';
  const roleTag = c.role && c.role !== 'Master' ? ` · ${escapeHtml(c.role)}` : '';
  // 已打开（视图层状态）与运行状态（core 运行时状态）来自各自的流，不挂在列表项上
  const dot = loadedSessions.has(c.sessionId) ? '<span class="loaded-dot" title="已打开"></span>' : '';
  const state = sessionStates.get(c.sessionId);
  // 非 idle 对话显示左边流水灯条（与 webview 对话列表一致；当前活跃会话同样显示）
  // 正在等待用户输入（ask user / 权限确认）时显示黄色；
  // 空闲但未读完成（用户没看到的任务结束）显示绿色：呼吸一次后常亮，直到该对话
  // 被打开——当前对话不亮（正在看的就是「已读」，主进程的清除推送也会随之到达）；
  // 只挂顶层对话行（depth === 0）：子会话（subagent）的完成属于对话整体，由父会话的灯表达
  const completionAt = completionAttention.get(c.sessionId);
  const completionBar = completionAt !== undefined && depth === 0 && state?.idle !== false && c.sessionId !== activeSessionId
    ? `<div class="running-bar running-bar--completed${Date.now() - completionAt < COMPLETION_BREATH_MS ? ' running-bar--completed-breath' : ''}"></div>`
    : '';
  const runningBar = state && !state.idle
    ? `<div class="running-bar${state.waiting ? ' running-bar--waiting' : ''}"></div>`
    : completionBar;
  const isRenaming = renamingSessionId === c.sessionId;
  const isNaming = namingSessions.has(c.sessionId);
  const isConfirming = confirmDeleteId === c.sessionId;

  // 折叠按钮（仅在有关联子对话时显示，参考 webview 对话列表的 chevron），
  // 放在左侧预留列的下槽位。
  const toggleHtml = childCount > 0
    ? `<button class="toggle-btn${isExpanded ? ' expanded' : ''}" data-action="toggle-sub" data-session-id="${c.sessionId}" title="${isExpanded ? '折叠子对话' : '展开子对话'}">
         <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
           <path d="M2 0L6 4L2 8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
         </svg>
       </button>`
    : '';

  // 标题区域：重命名时显示行内输入框
  const titleHtml = isRenaming
    ? `<input class="rename-input" type="text" value="${escapeHtml(renameValue)}" spellcheck="false" />`
    : `<div class="title">${escapeHtml(title)}${isNaming ? ' <span class="naming-hint">智能命名中…</span>' : ''}</div>`;

  // 操作按钮（hover 显示，与 webview 版本一致），固定 2 行 2 列：
  // 重命名 / 智能命名 / 删除 / 关闭。
  // - 根对话：四个按钮全部可用。
  // - 子代理（subagent）：只保留「关闭」（关闭其聊天视图、释放资源），
  //   不提供重命名 / 智能命名 / 删除——子代理历史由父会话管理，避免误删。
  //   其余 3 格用不可见占位符占住，保证关闭按钮仍在第 2 列第 2 行，
  //   与根对话的关闭按钮位置完全一致（只是其余 3 个按钮不显示）。
  const actionsHtml = isRenaming || isConfirming
    ? ''
    : depth === 0
      ? `<div class="item-actions">
         <button class="action-btn" data-action="rename" data-session-id="${c.sessionId}" title="重命名">${ICON_RENAME}</button>
         <button class="action-btn" data-action="smart-name" data-session-id="${c.sessionId}" title="智能命名" ${isNaming ? 'disabled' : ''}>${isNaming ? '<span class="spinner"></span>' : ICON_SMART_NAME}</button>
         <button class="action-btn danger" data-action="delete" data-session-id="${c.sessionId}" title="删除此对话">${ICON_DELETE}</button>
         <button class="action-btn" data-action="close" data-session-id="${c.sessionId}" title="关闭对话（释放资源）">${ICON_CLOSE}</button>
       </div>`
      : `<div class="item-actions">
         <span class="action-ghost" aria-hidden="true"></span>
         <span class="action-ghost" aria-hidden="true"></span>
         <span class="action-ghost" aria-hidden="true"></span>
         <button class="action-btn" data-action="close" data-session-id="${c.sessionId}" title="关闭子代理对话（释放资源）">${ICON_CLOSE}</button>
       </div>`;

  // 删除二次确认条
  const confirmHtml = isConfirming
    ? `<div class="confirm-bar">
         <span>删除该对话？</span>
         <button class="confirm-btn danger" data-action="confirm-delete" data-session-id="${c.sessionId}">删除</button>
         <button class="confirm-btn" data-action="cancel-delete" data-session-id="${c.sessionId}">取消</button>
       </div>`
    : '';

  // 按层级缩进（子会话每层 14px）
  const indent = depth > 0 ? ` style="margin-left: ${depth * 14}px"` : '';

  return `
    <div class="item${depth > 0 ? ' child' : ''}"${indent} data-session-id="${c.sessionId}">
      ${runningBar}
      <div class="item-rail">
        <span class="rail-slot">${dot}</span>
        <span class="rail-slot">${toggleHtml}</span>
      </div>
      <div class="item-main">
        ${titleHtml}
        <div class="sub">
          <span>${relativeTime(c.updatedAt ?? c.createdAt)}</span>
          <span>${c.messageCount} 条${roleTag}</span>
        </div>
        ${confirmHtml}
      </div>
      ${actionsHtml}
    </div>`;
}

/** 切换子会话展开/折叠状态并重渲染 */
function toggleSubSession(sessionId: string): void {
  // 与默认展开规则保持一致：首次点击时基于当前默认状态取反
  const subtreeHasActive = (id: string, depth = 0): boolean => {
    if (depth > 20) return false;
    if (id === activeSessionId) return true;
    // 列表在等待态时没有可点的条目，这里不可达；`?? []` 只为类型收窄
    return (conversations ?? [])
      .filter((k) => k.parentSessionId === id)
      .some((k) => subtreeHasActive(k.sessionId, depth + 1));
  };
  const current = expandedSubSessions[sessionId] !== undefined
    ? expandedSubSessions[sessionId]
    : subtreeHasActive(sessionId);
  expandedSubSessions[sessionId] = !current;
  render();
}

/* ── 交互逻辑 ── */

function startRename(sessionId: string): void {
  const c = conversations?.find((x) => x.sessionId === sessionId);
  renamingSessionId = sessionId;
  renameValue = c?.title || '';
  confirmDeleteId = null;
  render();
  // 进入重命名：聚焦并全选，方便直接覆盖输入
  const input = listEl.querySelector<HTMLInputElement>('input.rename-input');
  input?.focus();
  input?.select();
}

function cancelRename(): void {
  renamingSessionId = null;
  render();
}

function commitRename(): void {
  const sessionId = renamingSessionId;
  if (!sessionId) return; // 已提交/取消（如元素重建触发的 focusout），避免重复处理
  renamingSessionId = null;
  const newTitle = renameValue.trim();
  renameValue = '';
  render();
  if (!newTitle) return;
  window.sidebarAPI?.renameConversation(sessionId, newTitle)
    .catch((err) => console.error('[sidebar] rename failed:', err));
  // 列表由主进程推送刷新
}

function armDelete(sessionId: string): void {
  confirmDeleteId = sessionId;
  renamingSessionId = null;
  render();
}

function cancelDelete(): void {
  confirmDeleteId = null;
  render();
}

function doDelete(sessionId: string): void {
  confirmDeleteId = null;
  window.sidebarAPI?.deleteConversation(sessionId)
    .catch((err) => console.error('[sidebar] delete failed:', err));
  // 列表由主进程推送刷新
}

/** 关闭指定会话的聊天视图（释放渲染进程资源），列表由主进程推送刷新 */
function closeConversation(sessionId: string): void {
  window.sidebarAPI?.closeConversation(sessionId);
}

function smartName(sessionId: string): void {
  if (namingSessions.has(sessionId)) return;
  namingSessions.add(sessionId);
  render();
  window.sidebarAPI?.smartNameConversation(sessionId)
    .catch((err) => console.error('[sidebar] smart naming failed:', err))
    .finally(() => {
      namingSessions.delete(sessionId);
      render();
    });
}

/* ── 高亮 / 订阅 ── */

function setActive(sessionId: string | null): void {
  activeSessionId = sessionId;
  listEl.querySelectorAll<HTMLElement>('.item').forEach((el) => {
    el.classList.toggle('active', el.dataset.sessionId === sessionId);
  });
}

/**
 * 列表事件代理（只绑定一次）。
 *
 * 增量渲染会不断增删 / 替换 .item 元素，逐元素绑定会随重建失效且开销大；
 * 统一在 listEl 上委托，元素怎么重建都不受影响。
 */
function bindListEvents(): void {
  listEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    // 操作按钮优先：按钮在 .item 内部，处理完直接返回，避免同时触发「打开对话」
    const actionEl = target.closest<HTMLElement>('[data-action]');
    if (actionEl) {
      e.stopPropagation();
      const { action, sessionId } = actionEl.dataset;
      if (!action || !sessionId) return;
      if (action === 'rename') startRename(sessionId);
      else if (action === 'smart-name') smartName(sessionId);
      else if (action === 'delete') armDelete(sessionId);
      else if (action === 'close') closeConversation(sessionId);
      else if (action === 'confirm-delete') doDelete(sessionId);
      else if (action === 'cancel-delete') cancelDelete();
      else if (action === 'toggle-sub') toggleSubSession(sessionId);
      return;
    }

    // 点击交互控件时不打开对话
    if (target.closest('.item-actions, .rename-input, .confirm-bar')) return;

    const item = target.closest<HTMLElement>('.item');
    const sessionId = item?.dataset.sessionId;
    if (!item || !sessionId) return;
    // 回传该对话自己的工作目录：主进程据此给聊天视图注入正确的 --workspace=
    const project = conversations?.find((c) => c.sessionId === sessionId)?.project;
    window.sidebarAPI?.openConversation(sessionId, project);
    setActive(sessionId);
  });

  // 重命名输入框：回车提交 / Esc 取消
  listEl.addEventListener('keydown', (e) => {
    const input = (e.target as HTMLElement).closest('.rename-input');
    if (!input) return;
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
    else if (e.key === 'Escape') { cancelRename(); }
  });
  listEl.addEventListener('input', (e) => {
    const input = (e.target as HTMLElement).closest('.rename-input') as HTMLInputElement | null;
    if (input) renameValue = input.value;
  });
  // blur 不冒泡，用 focusout 代理；元素已被移除时忽略（避免重建触发误提交）
  listEl.addEventListener('focusout', (e) => {
    const input = (e.target as HTMLElement).closest('.rename-input') as HTMLInputElement | null;
    if (!input || !input.isConnected) return;
    commitRename();
  });
}

function subscribe(): void {
  if (subscribed || !window.sidebarAPI) return;
  subscribed = true;

  window.sidebarAPI.onConversationsUpdated((list) => {
    conversations = list;
    // 被删除/已不存在的会话清理交互状态
    const ids = new Set(list.map((c) => c.sessionId));
    if (renamingSessionId && !ids.has(renamingSessionId)) renamingSessionId = null;
    if (confirmDeleteId && !ids.has(confirmDeleteId)) confirmDeleteId = null;
    for (const sid of [...namingSessions]) {
      if (!ids.has(sid)) namingSessions.delete(sid);
    }
    render();
  });
  window.sidebarAPI.onSessionStatesUpdated((states) => {
    sessionStates = normalizeSessionStates(states);
    render();
  });
  window.sidebarAPI.onSessionCompletion((sessionIds) => {
    applySessionCompletion(sessionIds);
  });
  window.sidebarAPI.onSessionLoadedChanged((sessionIds) => {
    loadedSessions = normalizeLoadedSessions(sessionIds);
    render();
  });
  window.sidebarAPI.onActiveSessionChanged((sessionId) => {
    setActive(sessionId);
  });
  window.sidebarAPI.onWorkspacesChanged((state) => {
    const next = state ?? { workspaces: [], active: null, recent: [] };
    // 活动工作目录是否变化：决定要不要丢掉旧目录的列表 / 搜索关键字
    const activeChanged = workspacesState?.active !== next.active;
    workspacesState = next;
    // 文件浏览器跟随活动工作目录（root 变化时整树重置，见 setFilesWorkspace）
    setFilesWorkspace(next);
    // 代次 +1：此前发出的 getConversations 回包已属于旧目录，回来时必须丢弃
    listGeneration += 1;
    const generation = listGeneration;
    // 列表按目录重新拉取；loaded 也重拉（视图集合的 owner 是 ChatViewManager）。
    // 运行时状态（流水灯 / 等待标记）不清空：sessionRuntime 是跨工作目录的全局快照，
    // 会话视图切目录时保留，而状态流「只在变化时推」——清空后没有任何通道能补回来，
    // 流水灯就会在切换标签页 / 切到别目录的对话后一直不亮。
    loadedSessions = new Set();
    if (activeChanged) {
      // 旧目录的列表不能继续展示（否则切换后一瞬间还能看到/点开上一个目录的对话）；
      // 新目录的列表尚未取到，置回等待态（null）：延时内留白，超过 100ms 显示「加载中」
      conversations = null;
      // 搜索关键字属于上一个目录：清空，避免新目录被旧关键字过滤成空列表
      searchQuery = '';
      searchInputEl.value = '';
    }
    render();
    window.sidebarAPI?.getConversations()
      .then((list) => {
        if (generation !== listGeneration) return; // 目录已再次变化，丢弃过期回包
        conversations = list;
        render();
      })
      .catch((err) => console.error('[sidebar] reload conversations failed:', err));
    window.sidebarAPI?.getLoadedSessions()
      .then((ids) => {
        if (generation !== listGeneration) return;
        loadedSessions = normalizeLoadedSessions(ids);
        render();
      })
      .catch(() => undefined);
    window.sidebarAPI?.getActiveSession()
      .then((sid) => {
        if (generation !== listGeneration) return;
        setActive(sid);
      })
      .catch(() => undefined);
  });
}

/* ═══ 文件浏览器（US-42 / US-43） ═══
 *
 * 展示当前活动工作目录的文件树：分区条默认折叠在侧栏底部，展开占侧栏 50% 高度，
 * 对话列表相应收窄。数据是宿主本地事实（不依赖 core，与工作区状态同一可信度）：
 * 目录懒加载——点开哪层读哪层；rel 全程用 '/' 分隔的相对路径，绝对路径只在主进程
 * 解析（electron/sidebarFiles.ts 负责越界校验）。
 *
 * **每个工作区一套独立的树状态**（US-42 验收 1 / 3）：目录缓存、目录展开、选中与
 * 分区展开/折叠都挂在 `WorkspaceFilesState` 上、按工作区 id 存放——切换标签页只是
 * 换一套状态来渲染，原工作区的树不动、也不作废在途请求（回包仍写回它自己的状态）；
 * 工作区关闭时其状态整体丢弃。折叠状态按工作区落 localStorage（键 → 是否展开）。
 *
 * 交互（与 VS Code 资源管理器一致）：
 * - 点击选中（目录单击即展开 / 折叠）、Ctrl+点击切换（多选）、Shift+点击从上次点击项
 *   连选到当前项（范围按当前可见行序计算）、Ctrl+A 全选可见项；Esc / 点击空白清空。
 * - 右键项弹出菜单：复制完整路径 / 复制相对路径（作用于全部选中项，多行拼接）、
 *   在文件资源管理器中打开（只作用于右键项）、删除（作用于全部选中项，原生确认）。
 * - 右键未选中的项时先把它置为唯一选中项（资源管理器的标准行为）。
 */

/** 单个目录的读取状态：loading（在途）/ loaded / error（读盘失败，点错误行重试） */
interface DirListing {
  state: 'loading' | 'loaded' | 'error';
  entries: DirectoryEntry[];
  error?: string;
}

/** 一个工作区的文件树状态（独立于其它工作区，切标签页互不影响） */
interface WorkspaceFilesState {
  /** 分区是否展开（按工作区记忆，US-42 验收 1） */
  expanded: boolean;
  /** 代次：手动刷新 / 状态重建时 +1，作废该工作区在途的目录读取回包 */
  generation: number;
  /** relDir（'' 为根）→ 读取状态 */
  tree: Map<string, DirListing>;
  /** 已展开的相对目录集合（懒加载：展开时才读该层） */
  expandedDirs: Set<string>;
  /** 选中项（相对路径集合） */
  selected: Set<string>;
  /** Shift 连选锚点（上次点击项） */
  anchor: string | null;
}

/** 折叠状态落 localStorage 的键（值是「工作区 id → 是否展开」的 JSON 表，US-42 验收 1） */
const FILES_EXPANDED_KEY = 'tuxedo.sidebar.filesExpanded';
/** 行缩进：基础留白 + 每层目录一格（与 .file-row 的行高共同决定层级观感） */
const FILE_ROW_BASE_INDENT = 8;
const FILE_ROW_INDENT = 14;

/** 工作区 id（refKey）→ 文件树状态 */
const filesStateByWorkspace = new Map<string, WorkspaceFilesState>();
/**
 * 当前显示的工作区标识（侧栏工作区项的稳定 id，即 refKey）。
 *
 * 刻意不存路径：工作区项的 `path` 是**展示路径**（远程项是 `ssh://user@host/…`），
 * 与真实路径不同，且同一路径可以在多台机器上出现——文件操作一律按 id 回查，
 * 由主进程解析成真实路径（与「最近打开」点击按 id 回查同一约定）。
 * null = 没有可浏览的目录（未打开工作区）。
 */
let activeFilesId: string | null = null;
let filesRemote = false;
/** 当前右键菜单目标（「在文件资源管理器中打开」只作用于它） */
let filesMenuTarget: string | null = null;
/** 右键目标的条目类型：「在此处打开命令行」对文件取其父目录，对目录就是它自己 */
let filesMenuKind: 'file' | 'directory' = 'file';
let filesMenuEl: HTMLDivElement | null = null;

function readStoredExpandedMap(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(FILES_EXPANDED_KEY);
    // 旧格式是全局 '1' / '0'（单工作区时代）：不再使用，按无记录处理
    if (!raw || raw === '0' || raw === '1') return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const map: Record<string, boolean> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'boolean') map[id] = value;
    }
    return map;
  } catch {
    // localStorage 不可用（禁用存储等）：退回默认折叠
    return {};
  }
}

function storeExpandedMap(map: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(FILES_EXPANDED_KEY, JSON.stringify(map));
  } catch { /* 存不了就每次启动按各工作区默认折叠 */ }
}

/** 取（或按需创建）某工作区的文件树状态；新状态从 localStorage 读折叠偏好 */
function filesStateFor(id: string): WorkspaceFilesState {
  let state = filesStateByWorkspace.get(id);
  if (!state) {
    state = {
      expanded: readStoredExpandedMap()[id] === true,
      generation: 0,
      tree: new Map(),
      expandedDirs: new Set(),
      selected: new Set(),
      anchor: null,
    };
    filesStateByWorkspace.set(id, state);
  }
  return state;
}

/** 当前显示的工作区的文件树状态；未打开工作区时为 null */
function activeFilesState(): WorkspaceFilesState | null {
  return activeFilesId !== null ? filesStateByWorkspace.get(activeFilesId) ?? null : null;
}

/** 把各工作区的折叠状态写进 localStorage（只在变化时调用） */
function persistFilesExpanded(): void {
  const map: Record<string, boolean> = {};
  for (const [id, state] of filesStateByWorkspace) map[id] = state.expanded;
  storeExpandedMap(map);
}

/* ── 图标（lucide，与既有 ICON_* 常量同一来源与描边风格；不用 emoji） ── */

function lucideSvg(paths: string): string {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}
const FICON_CHEVRON = lucideSvg('<path d="m9 18 6-6-6-6"/>');
const FICON_FOLDER = lucideSvg('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>');
const FICON_FOLDER_OPEN = lucideSvg('<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>');
const FICON_FILE = lucideSvg('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>');
const FICON_FILE_TEXT = lucideSvg('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>');
const FICON_FILE_CODE = lucideSvg('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m10 12-2 2 2 2"/><path d="m14 16 2-2-2-2"/>');
const FICON_FILE_JSON = lucideSvg('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1"/><path d="M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1"/>');
const FICON_IMAGE = lucideSvg('<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>');
const FICON_ARCHIVE = lucideSvg('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9h2"/><path d="M10 13h2"/><path d="M10 17h2"/><path d="m10 5 1-1-1-1"/>');

/** 压缩包扩展名：只用于图标着色（双击打开归「系统应用」分流，不参与类型判定） */
const FILE_ARCHIVE_EXTS = new Set(['zip', 'gz', 'tar', 'rar', '7z', 'bz2', 'xz', 'zst']);

/** 文件名 → 图标与配色 class（lucide 按类型区分，US-42 验收 5）；未识别类型用通用文件图标 */
function fileIconFor(name: string): { cls: string; svg: string } {
  const lower = name.toLowerCase();
  if (lower === 'dockerfile' || lower === 'makefile') return { cls: 'ficon-code', svg: FICON_FILE_CODE };
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  if (FILE_CODE_EXTS.has(ext)) return { cls: 'ficon-code', svg: FICON_FILE_CODE };
  if (FILE_CONFIG_EXTS.has(ext)) return { cls: 'ficon-config', svg: FICON_FILE_JSON };
  // Markdown 着色与文本同类（双击才分流出 Markdown 预览窗口，图标不另设一档）
  if (FILE_MARKDOWN_EXTS.has(ext)) return { cls: 'ficon-text', svg: FICON_FILE_TEXT };
  if (FILE_TEXT_EXTS.has(ext)) return { cls: 'ficon-text', svg: FICON_FILE_TEXT };
  if (FILE_IMAGE_EXTS.has(ext)) return { cls: 'ficon-image', svg: FICON_IMAGE };
  if (FILE_ARCHIVE_EXTS.has(ext)) return { cls: 'ficon-archive', svg: FICON_ARCHIVE };
  return { cls: 'ficon-file', svg: FICON_FILE };
}

/* ── 渲染 ── */

function fileHintRowHtml(text: string, depth: number): string {
  const indent = FILE_ROW_BASE_INDENT + depth * FILE_ROW_INDENT;
  return `<div class="file-row file-hint" style="padding-left:${indent}px">${escapeHtml(text)}</div>`;
}

/** 加载中占位行：转圈动画 + 文案（读盘在途的可视反馈，与文字提示区分开） */
function fileLoadingRowHtml(depth: number): string {
  const indent = FILE_ROW_BASE_INDENT + depth * FILE_ROW_INDENT;
  return `<div class="file-row file-hint" style="padding-left:${indent}px"><span class="spinner file-hint-spinner"></span>加载中…</div>`;
}

function fileRowHtml(files: WorkspaceFilesState, rel: string, name: string, kind: 'file' | 'directory', depth: number, expanded: boolean): string {
  const indent = FILE_ROW_BASE_INDENT + depth * FILE_ROW_INDENT;
  // 目录才占折叠箭头位：文件用等宽空位占住，图标与名称在两层间对齐
  const chevron = kind === 'directory'
    ? `<span class="file-chevron${expanded ? ' expanded' : ''}">${FICON_CHEVRON}</span>`
    : '<span class="file-chevron leaf"></span>';
  const icon = kind === 'directory'
    ? { cls: expanded ? 'ficon-folder-open' : 'ficon-folder', svg: expanded ? FICON_FOLDER_OPEN : FICON_FOLDER }
    : fileIconFor(name);
  return `<div class="file-row${files.selected.has(rel) ? ' selected' : ''}" data-path="${escapeHtml(rel)}" data-kind="${kind}" style="padding-left:${indent}px" title="${escapeHtml(rel)}">` +
    `${chevron}<span class="file-icon ${icon.cls}">${icon.svg}</span><span class="file-name">${escapeHtml(name)}</span></div>`;
}

function renderFiles(): void {
  const id = activeFilesId;
  const files = activeFilesState();
  // 分区折叠时不渲染也不读目录：折叠期渲染会经 renderDirRows 触发根目录的懒加载，
  // 把「启动时刻」的目录内容缓存下来，用户之后展开时命中陈旧缓存（US-42 的懒加载
  // 语义是「点开才读该层」，根目录的第一个读取点必须是首次展开）。
  if (!files || id === null || !files.expanded) {
    filesTreeEl.innerHTML = '';
    return;
  }
  const rows: string[] = [];
  renderDirRows(files, id, '', 0, rows);
  filesTreeEl.innerHTML = rows.join('');
}

/**
 * 递归铺平可见行：展开且已加载的目录继续下钻，未读过的目录挂「加载中」占位并触发
 * 懒加载（loadDir 同步置 loading，回包后重渲染，不会形成渲染循环）。
 */
function renderDirRows(files: WorkspaceFilesState, workspaceId: string, rel: string, depth: number, rows: string[]): void {
  const listing = files.tree.get(rel);
  if (!listing) {
    loadDir(workspaceId, rel);
    rows.push(fileLoadingRowHtml(depth));
    return;
  }
  if (listing.state === 'loading') {
    rows.push(fileLoadingRowHtml(depth));
    return;
  }
  if (listing.state === 'error') {
    rows.push(`<div class="file-row file-hint file-error" data-retry-dir="${escapeHtml(rel)}" style="padding-left:${FILE_ROW_BASE_INDENT + depth * FILE_ROW_INDENT}px" title="${escapeHtml(listing.error || '')}">读取失败，点击重试</div>`);
    return;
  }
  if (listing.entries.length === 0) {
    rows.push(fileHintRowHtml(rel === '' ? '此目录为空' : '（空）', depth));
    return;
  }
  for (const entry of listing.entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const expandedDir = entry.kind === 'directory' && files.expandedDirs.has(childRel);
    rows.push(fileRowHtml(files, childRel, entry.name, entry.kind, depth, expandedDir));
    if (expandedDir) renderDirRows(files, workspaceId, childRel, depth + 1, rows);
  }
}

/**
 * 读取一个工作区的某层目录。回包写回**它自己的状态**：切到别的标签页不会作废在途
 * 请求（回来时树已就绪），只有该工作区被关闭（状态丢弃）或手动刷新（代次 +1）才丢弃。
 * 只有正在显示的工作区才触发重渲染，后台工作区的回包静默入缓存。
 */
function loadDir(workspaceId: string, rel: string): void {
  const files = filesStateByWorkspace.get(workspaceId);
  if (!files) return;
  const existing = files.tree.get(rel);
  // 已加载 / 在途不重读；error 允许重试（点错误行）
  if (existing && existing.state !== 'error') return;
  const generation = files.generation;
  files.tree.set(rel, { state: 'loading', entries: [] });
  window.sidebarAPI?.filesList(workspaceId, rel)
    .then((res) => {
      // 回包时该工作区已关闭（状态丢弃）或已刷新（代次变化）：丢弃
      if (filesStateByWorkspace.get(workspaceId) !== files || files.generation !== generation) return;
      if (res.ok) files.tree.set(rel, { state: 'loaded', entries: res.entries });
      else files.tree.set(rel, { state: 'error', entries: [], error: res.error || '读取失败' });
      if (workspaceId === activeFilesId) renderFiles();
    })
    .catch((err) => {
      if (filesStateByWorkspace.get(workspaceId) !== files || files.generation !== generation) return;
      files.tree.set(rel, { state: 'error', entries: [], error: String(err) });
      if (workspaceId === activeFilesId) renderFiles();
    });
}

/**
 * 文件浏览器跟随活动工作区。**只切换显示哪一套状态，不清不重建**：每个工作区的
 * 树缓存 / 目录展开 / 选中 / 折叠状态都独立保存（US-42 验收 1 / 3），切走再切回
 * 原样保留；被关闭的工作区状态整体丢弃，重新打开按新工作区处理。
 * 远程（SSH）工作区同样浏览：读盘 / 删除在主进程走 SFTP（electron/sidebarFilesRemote.ts），
 * 渲染层只感知 filesRemote 的差异（右键菜单少一项「在文件资源管理器中打开」）。
 */
function setFilesWorkspace(state: WorkspacesState | null): void {
  // 关闭掉的工作区状态丢弃（含树缓存与折叠记忆）；重新打开同一目录按全新工作区处理
  if (state) {
    const openIds = new Set(state.workspaces.map((w) => w.id));
    for (const id of [...filesStateByWorkspace.keys()]) {
      if (!openIds.has(id)) filesStateByWorkspace.delete(id);
    }
  }
  const active = state?.workspaces.find((w) => w.id === state.active) ?? null;
  if (!active) {
    filesSectionEl.classList.add('hidden');
    activeFilesId = null;
    filesRemote = false;
    return;
  }
  filesSectionEl.classList.remove('hidden');
  const changed = activeFilesId !== active.id || filesRemote !== active.remote;
  activeFilesId = active.id;
  filesRemote = active.remote;
  const files = filesStateFor(active.id);
  filesSectionEl.classList.toggle('expanded', files.expanded);
  // 展开且根目录还没读过（新工作区 / 重启后恢复展开）才补一次读取；切回已浏览过的
  // 工作区直接命中缓存，不打断它的树
  if (files.expanded && !files.tree.has('')) loadDir(active.id, '');
  if (changed) {
    closeFilesMenu();
    renderFiles();
  }
}

function setFilesExpanded(expanded: boolean): void {
  const id = activeFilesId;
  if (!id) return;
  const files = filesStateFor(id);
  files.expanded = expanded;
  persistFilesExpanded();
  filesSectionEl.classList.toggle('expanded', expanded);
  // 展开 / 折叠都必须重画（US-42 验收 1）：renderFiles 在折叠态会清空树 DOM
  // （折叠时不渲染也不读目录），折叠期间任何一次 renderFiles（切换工作区、在途目录
  // 回包）都会把已缓存的树清掉；此时只切 class 不重画，展开就命中「有缓存、无 DOM」
  // 的状态，用户看到空树、只能手动刷新。展开时 renderDirRows 会顺手触发根目录懒加载
  // （首个读取点仍是这次展开，不会把折叠期内容缓存下来）。
  renderFiles();
}

/** 整树刷新（刷新按钮 / 删除后）：丢弃该工作区的全部缓存，重读根与已展开目录，保留展开状态 */
function refreshFiles(): void {
  const id = activeFilesId;
  const files = activeFilesState();
  if (!id || !files) return;
  files.generation += 1;
  files.tree.clear();
  loadDir(id, '');
  for (const dir of files.expandedDirs) loadDir(id, dir);
  renderFiles();
}

/* ── 选择 ── */

/** 当前可见行（带 data-path 的）按显示顺序取相对路径：Shift 连选的范围基准 */
function visibleFilePaths(): string[] {
  return Array.from(filesTreeEl.querySelectorAll<HTMLElement>('.file-row[data-path]'))
    .map((el) => el.dataset.path || '');
}

function applyFileSelectionClasses(): void {
  const files = activeFilesState();
  if (!files) return;
  filesTreeEl.querySelectorAll<HTMLElement>('.file-row[data-path]').forEach((el) => {
    el.classList.toggle('selected', files.selected.has(el.dataset.path || ''));
  });
}

function clearFileSelection(): void {
  const files = activeFilesState();
  if (!files || files.selected.size === 0) return;
  files.selected.clear();
  files.anchor = null;
  applyFileSelectionClasses();
}

function toggleDirExpanded(rel: string): void {
  const files = activeFilesState();
  if (!files) return;
  if (files.expandedDirs.has(rel)) files.expandedDirs.delete(rel);
  else files.expandedDirs.add(rel);
  // 展开未读过的目录时 renderDirRows 会顺手触发懒加载
  renderFiles();
}

/* ── 右键菜单与动作 ── */

function ensureFilesMenuEl(): HTMLDivElement {
  if (filesMenuEl) return filesMenuEl;
  filesMenuEl = document.createElement('div');
  filesMenuEl.className = 'files-context-menu';
  filesMenuEl.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('[data-menu]');
    if (!item) return;
    e.stopPropagation();
    const action = item.dataset.menu;
    // closeFilesMenu 会把 filesMenuTarget 清空：「在文件资源管理器中打开」与
    // 「在此处打开命令行」只作用于右键项（不吃选中集合），必须先把目标取下来再关菜单
    const target = filesMenuTarget;
    const targetKind = filesMenuKind;
    closeFilesMenu();
    if (action === 'copy-full') copySelectedFilePaths(false);
    else if (action === 'copy-rel') copySelectedFilePaths(true);
    else if (action === 'reveal' && target !== null) revealFilesTarget(target);
    else if (action === 'terminal' && target !== null) openTerminalHere(targetKind === 'directory' ? target : parentRelPath(target));
    else if (action === 'delete') deleteSelectedFiles();
  });
  document.body.appendChild(filesMenuEl);
  return filesMenuEl;
}

function openFilesMenu(x: number, y: number, targetPath: string, targetKind: 'file' | 'directory'): void {
  filesMenuTarget = targetPath;
  filesMenuKind = targetKind;
  const el = ensureFilesMenuEl();
  // 「在文件资源管理器中打开」「在此处打开命令行」只对本地工作区有意义：远程工作区
  // 不显示这两项（主进程对远程同样拒绝，双保险）。
  el.innerHTML = `
    <button class="files-menu-item" data-menu="copy-full">复制完整路径</button>
    <button class="files-menu-item" data-menu="copy-rel">复制相对路径</button>
    ${filesRemote ? '' : '<button class="files-menu-item" data-menu="reveal">在文件资源管理器中打开</button><button class="files-menu-item" data-menu="terminal">在此处打开命令行</button>'}
    <button class="files-menu-item" data-menu="delete">删除</button>`;
  el.classList.add('open');
  // 夹取进视口：靠近右缘 / 底部时向左 / 向上收（先量尺寸再定位）
  const rect = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
}

function closeFilesMenu(): void {
  filesMenuTarget = null;
  if (filesMenuEl) filesMenuEl.classList.remove('open');
}

function copySelectedFilePaths(relative: boolean): void {
  const id = activeFilesId;
  const files = activeFilesState();
  if (!id || !files || files.selected.size === 0) return;
  window.sidebarAPI?.filesCopyPaths(id, [...files.selected], relative)
    .then((res) => {
      if (!res.ok) console.error('[sidebar] copy file paths failed:', res.error);
    })
    .catch((err) => console.error('[sidebar] copy file paths failed:', err));
}

function revealFilesTarget(targetPath: string): void {
  if (!activeFilesId || filesRemote) return;
  window.sidebarAPI?.filesReveal(activeFilesId, targetPath)
    .then((res) => {
      if (!res.ok) console.error('[sidebar] reveal in file explorer failed:', res.error);
    })
    .catch((err) => console.error('[sidebar] reveal in file explorer failed:', err));
}

/** 相对路径的父目录（'a/b/c' → 'a/b'，顶层 → 根 ''）：rel 一律 '/' 分隔（约定格式） */
function parentRelPath(rel: string): string {
  const index = rel.lastIndexOf('/');
  return index < 0 ? '' : rel.slice(0, index);
}

/** 在目录上打开系统命令行（右键「在此处打开命令行」）：本地工作区专属，主进程拉起终端 */
function openTerminalHere(dirRel: string): void {
  if (!activeFilesId || filesRemote) return;
  window.sidebarAPI?.filesOpenTerminal(activeFilesId, dirRel)
    .then((res) => {
      if (!res.ok) console.error('[sidebar] open terminal failed:', res.error);
    })
    .catch((err) => console.error('[sidebar] open terminal failed:', err));
}

function deleteSelectedFiles(): void {
  const id = activeFilesId;
  const files = activeFilesState();
  if (!id || !files || files.selected.size === 0) return;
  window.sidebarAPI?.filesDelete(id, [...files.selected])
    .then((res) => {
      // 用户取消 → 不动树；其余（成功 / 部分失败）都刷新：被删项消失、失败项仍在。
      // 删除后清空选中：被删的路径已无意义，残留选中只会在树上高亮不存在的行。
      if (!res.ok && res.error === 'cancelled') return;
      files.selected.clear();
      files.anchor = null;
      refreshFiles();
    })
    .catch((err) => console.error('[sidebar] delete files failed:', err));
}

/**
 * 双击文件行：打开方式（内置文本 / 图片窗口 / 系统应用）由主进程按类型分流。
 * 远程工作区的已知二进制在这里直接跳过（US-42 验收 6：远程二进制不支持打开），
 * 不发 IPC——避免为「注定打不开」的文件去做 SFTP 嗅探；未知扩展名仍交给主进程嗅探。
 */
function openFileRow(rel: string): void {
  const id = activeFilesId;
  if (!id) return;
  if (filesRemote && classifyFileForOpen(rel) === 'binary') return;
  window.sidebarAPI?.filesOpen(id, rel)
    .then((res) => {
      if (!res.ok && res.error !== REMOTE_BINARY_UNSUPPORTED) {
        console.error('[sidebar] open file failed:', res.error);
      }
    })
    .catch((err) => console.error('[sidebar] open file failed:', err));
}

/* ── 事件绑定（init 调用一次；树内容重建不受影响，全部委托在固定容器上） ── */

function bindFilesEvents(): void {
  filesHeaderEl.addEventListener('click', () => {
    const files = activeFilesState();
    if (files) setFilesExpanded(!files.expanded);
  });
  filesRefreshBtn.addEventListener('click', (e) => {
    // 刷新按钮在分区条内：不要顺带触发分区条的展开 / 折叠
    e.stopPropagation();
    refreshFiles();
  });

  filesTreeEl.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.file-row');
    if (!row) {
      // 点击空白处清空选择（资源管理器行为）
      clearFileSelection();
      return;
    }
    const files = activeFilesState();
    if (!files) return;
    // 读取失败的目录行：点击重试
    const retryDir = row.dataset.retryDir;
    if (retryDir !== undefined) {
      files.tree.delete(retryDir);
      if (activeFilesId !== null) loadDir(activeFilesId, retryDir);
      return;
    }
    const path = row.dataset.path;
    if (!path) return; // 提示行（加载中 / 空目录）不可选
    // 双击的第二下不再翻转目录（e.detail >= 2）：否则目录双击 = 展开 + 折叠来回抖。
    // 双击的第一下已经翻过一次，净效果仍是「展开」。
    if (e.detail >= 2 && row.dataset.kind === 'directory') return;
    // 折叠箭头只切换目录展开，不改选中（与 VS Code 资源管理器一致）
    if (row.dataset.kind === 'directory' && (e.target as HTMLElement).closest('.file-chevron')) {
      toggleDirExpanded(path);
      return;
    }
    const visible = visibleFilePaths();
    if (e.shiftKey && files.anchor !== null) {
      // Shift 连选：以锚点为界取当前可见行序的连续段（锚点不在可见行里时退化为单选）
      const from = visible.indexOf(files.anchor);
      const to = visible.indexOf(path);
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from <= to ? [from, to] : [to, from];
        files.selected.clear();
        for (let i = lo; i <= hi; i++) files.selected.add(visible[i]);
      } else {
        files.selected.clear();
        files.selected.add(path);
        files.anchor = path;
      }
    } else if (e.ctrlKey || e.metaKey) {
      if (files.selected.has(path)) files.selected.delete(path);
      else files.selected.add(path);
      files.anchor = path;
    } else {
      files.selected.clear();
      files.selected.add(path);
      files.anchor = path;
      // 目录单击即展开 / 折叠（US-42：单展开，不要双击）；Ctrl / Shift 多选不触发。
      // 双击的第二下不再翻转（上面已整体 return），目录双击不会来回抖
      if (row.dataset.kind === 'directory') toggleDirExpanded(path);
    }
    applyFileSelectionClasses();
  });

  // 双击文件行打开（US-42 验收 6）：目录不响应双击（单击已展开 / 折叠），
  // 提示行（无 data-path）与错误行（data-retry-dir）也不响应
  filesTreeEl.addEventListener('dblclick', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.file-row[data-kind="file"][data-path]');
    if (!row || row.dataset.retryDir !== undefined) return;
    openFileRow(row.dataset.path || '');
  });

  filesTreeEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const row = (e.target as HTMLElement).closest<HTMLElement>('.file-row[data-path]');
    const files = activeFilesState();
    if (!row || !row.dataset.path || !files) {
      closeFilesMenu();
      return;
    }
    // 右键未选中的项：先把它置为唯一选中项，再弹菜单（资源管理器标准行为）
    const path = row.dataset.path;
    if (!files.selected.has(path)) {
      files.selected.clear();
      files.selected.add(path);
      files.anchor = path;
      applyFileSelectionClasses();
    }
    openFilesMenu(e.clientX, e.clientY, path, row.dataset.kind === 'directory' ? 'directory' : 'file');
  });

  // 键盘：Ctrl/Cmd+A 全选可见项、Delete 删除选中、Esc 清空
  filesTreeEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeFilesMenu();
      clearFileSelection();
      return;
    }
    const files = activeFilesState();
    if (!files) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      files.selected.clear();
      for (const p of visibleFilePaths()) files.selected.add(p);
      applyFileSelectionClasses();
      return;
    }
    if (e.key === 'Delete' && files.selected.size > 0) {
      e.preventDefault();
      deleteSelectedFiles();
    }
  });
  // 行不是 focusable 的：按下时把焦点移到树容器，Delete / Ctrl+A 才有接收者
  filesTreeEl.addEventListener('mousedown', () => filesTreeEl.focus({ preventScroll: true }));

  // 菜单的关闭路径：点树外任意处、滚树、窗口失焦 / 缩放；Esc 在树 keydown 与 document 兜底
  document.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('.files-context-menu')) closeFilesMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeFilesMenu();
  });
  filesBodyEl.addEventListener('scroll', closeFilesMenu, true);
  window.addEventListener('blur', closeFilesMenu);
  window.addEventListener('resize', closeFilesMenu);
}

/* ── 侧栏宽度拖拽（US-44） ── */

/**
 * 拖拽手柄：按住沿水平方向拖动改侧栏宽度，松手（final: true）时主进程落盘，
 * 双击恢复默认宽度。宽度事实在主进程（layout 用它摆侧栏 + 聊天区），渲染层只上报
 * 「想要的宽度」，夹取（最小 / 最大 / 不挤掉聊天区）也在主进程做。
 *
 * setPointerCapture 让按住后的 pointermove / pointerup 持续送达手柄——拖出侧栏
 * 视图边界（变宽时越过手柄 / 覆盖到聊天区）也不丢事件；合成事件（e2e）没有活动
 * pointer，capture 会抛错，try/catch 兜住后靠 window 级监听照常工作。
 */
function bindResizeHandle(): void {
  let dragging = false;
  let startPointerX = 0;
  let startWidth = 0;

  const applyMove = (clientX: number, final: boolean): void => {
    if (!dragging) return;
    window.sidebarAPI?.setSidebarWidth(startWidth + (clientX - startPointerX), final);
  };

  resizeHandleEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startPointerX = e.clientX;
    startWidth = window.innerWidth;
    resizeHandleEl.classList.add('dragging');
    document.body.classList.add('sidebar-resizing');
    e.preventDefault();
    try { resizeHandleEl.setPointerCapture(e.pointerId); } catch { /* 合成事件没有活动 pointer */ }
  });
  resizeHandleEl.addEventListener('pointermove', (e) => applyMove(e.clientX, false));
  // move / up 同时挂 window：capture 生效时事件本就送达手柄，两处都收到时
  // dragging 状态保证只应用一次
  window.addEventListener('pointermove', (e) => applyMove(e.clientX, false));
  const endDrag = (e: PointerEvent): void => {
    if (!dragging) return;
    applyMove(e.clientX, true);
    dragging = false;
    resizeHandleEl.classList.remove('dragging');
    document.body.classList.remove('sidebar-resizing');
    try { resizeHandleEl.releasePointerCapture(e.pointerId); } catch { /* 未 capture 过 */ }
  };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', (e) => {
    // pointercancel（拖拽被系统打断）：保留已拖出的宽度并落盘，与松手同一收尾
    endDrag(e);
  });

  // 双击恢复默认宽度（语义见主进程 SIDEBAR_DEFAULT_WIDTH）
  resizeHandleEl.addEventListener('dblclick', () => {
    window.sidebarAPI?.setSidebarWidth(null, true);
  });
}

// 点击空白处取消重命名/删除确认
document.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('.item')) return;
  if (renamingSessionId || confirmDeleteId) {
    renamingSessionId = null;
    renameValue = '';
    confirmDeleteId = null;
    render();
  }
});

async function init(): Promise<void> {
  if (!window.sidebarAPI) {
    listEl.innerHTML = '<div class="empty">Sidebar API 不可用</div>';
    return;
  }
  bindListEvents();
  bindFilesEvents();
  bindResizeHandle();
  subscribe();

  newChatBtn.addEventListener('click', () => {
    window.sidebarAPI?.newConversation();
  });

  // 搜索框：按标题过滤当前活动工作目录的对话列表（即时过滤）
  searchInputEl.addEventListener('input', () => {
    searchQuery = searchInputEl.value.trim().toLowerCase();
    render();
  });

  const generation = listGeneration;

  // 工作区状态先取：它是宿主本地事实，不依赖 core。对话列表（getConversations）要等
  // core 连接就绪，远程工作区连不上 / core 启动慢时会一直等；若和它一起 await，
  // 打开集合 / 空态就永远画不出来，侧栏会一直停在「尚未打开工作区」。
  try {
    const workspaces = await window.sidebarAPI.getWorkspaces();
    // 初始化期间用户已切换工作目录（workspaces-changed 已把状态更新并重新拉取）：
    // 这批结果属于旧状态，丢弃，避免覆盖新目录的状态
    if (generation !== listGeneration) return;
    workspacesState = workspaces ?? { workspaces: [], active: null, recent: [] };
    // 文件浏览器跟随活动工作目录（首个工作区状态到达后才显示分区）
    setFilesWorkspace(workspacesState);
    render();
  } catch (err) {
    listEl.innerHTML = `<div class="empty">加载失败: ${escapeHtml(String(err))}</div>`;
    return;
  }

  // 其余数据依赖 core，可能较慢或挂起：工作区 UI 已经渲染，这里失败 / 挂起都不再
  // 影响打开集合的展示。
  try {
    const [list, active, loaded, states] = await Promise.all([
      window.sidebarAPI.getConversations(),
      window.sidebarAPI.getActiveSession(),
      window.sidebarAPI.getLoadedSessions(),
      window.sidebarAPI.getSessionStates(),
    ]);
    // 初始化期间用户已切换工作目录（workspaces-changed 已把状态更新并重新拉取）：
    // 这批结果属于旧状态，丢弃，避免覆盖新目录的列表
    if (generation !== listGeneration) return;
    conversations = list;
    activeSessionId = active;
    loadedSessions = normalizeLoadedSessions(loaded);
    // 播种运行时状态：状态流只在变化时推，若推送早于侧栏就绪（或侧栏刚重载），
    // 不主动拉一次就会永远缺这份快照，流水灯 / 等待标记不亮。
    // 仅在本进程尚无推送时播种，避免晚到的旧快照覆盖订阅期间收到的更新状态。
    if (sessionStates.size === 0) sessionStates = normalizeSessionStates(states);
    render();
  } catch (err) {
    // 对话列表拉取失败不覆盖已经渲染好的工作区 UI，只记日志
    console.error('[sidebar] load conversations failed:', err);
  }
}

void init();
