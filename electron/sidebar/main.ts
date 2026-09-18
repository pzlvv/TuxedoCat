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
 * 三条流各自单一 owner（DEVELOPMENT.md 第 5.4 节规则 8）：
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

interface ConversationMeta {
  sessionId: string;
  title: string;
  updatedAt: number;
  createdAt: number;
  messageCount: number;
  parentSessionId?: string;
  role?: string;
}

/** 会话运行时状态（与 core 的 SessionRuntimeState 同构，见 DEVELOPMENT.md 第 3.1 节） */
interface SessionRuntimeState {
  sessionId: string;
  /** 会话是否空闲（false = 有活跃查询 / 压缩 / 后台 Bash / 递归子代理） */
  idle: boolean;
  /** 正在等待用户操作（ask user / 权限确认） */
  waiting: boolean;
}

interface SidebarAPI {
  getConversations: () => Promise<ConversationMeta[]>;
  getLoadedSessions: () => Promise<string[]>;
  getActiveSession: () => Promise<string | null>;
  getWorkspace: () => Promise<string | null>;
  openWorkspace: () => void;
  openConversation: (sessionId: string) => void;
  newConversation: () => void;
  deleteConversation: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
  closeConversation: (sessionId: string) => void;
  renameConversation: (sessionId: string, title: string) => Promise<{ ok: boolean; error?: string }>;
  smartNameConversation: (sessionId: string) => Promise<{ ok: boolean; title?: string; error?: string }>;
  onConversationsUpdated: (cb: (list: ConversationMeta[]) => void) => void;
  onSessionStatesUpdated: (cb: (states: SessionRuntimeState[]) => void) => void;
  onSessionLoadedChanged: (cb: (sessionIds: string[]) => void) => void;
  onActiveSessionChanged: (cb: (sessionId: string | null) => void) => void;
  onWorkspaceChanged: (cb: (workspace: string | null) => void) => void;
}

declare global {
  interface Window {
    sidebarAPI?: SidebarAPI;
  }
}

const listEl = document.getElementById('list')!;
const footerEl = document.getElementById('footer')!;
const newChatBtn = document.getElementById('newChat') as HTMLButtonElement;
const workspaceNameEl = document.getElementById('workspaceName')!;

let conversations: ConversationMeta[] = [];
let activeSessionId: string | null = null;
let workspacePath: string | null = null;
let subscribed = false;

/** 会话运行时状态（idle / waiting），来自 `sidebar:session-states-updated` 全量推送 */
let sessionStates = new Map<string, SessionRuntimeState>();
/** 已打开（有活动视图）的会话集合，来自 `sidebar:session-loaded-changed` */
let loadedSessions = new Set<string>();

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

/** 更新侧边栏顶部：显示当前打开的工作目录名（无图标） */
function updateHeader(): void {
  const name = workspacePath
    ? (workspacePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || workspacePath)
    : '未选择工作目录';
  workspaceNameEl.textContent = name;
  workspaceNameEl.title = workspacePath || '';
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
  // 顶部显示当前工作目录名
  updateHeader();

  // 未选择工作区：显示引导占位（含“打开工作目录”按钮）
  if (!workspacePath) {
    resetList();
    listEl.innerHTML = `
      <div class="workspace-placeholder">
        <div class="workspace-title">请先打开一个工作目录</div>
        <div class="workspace-desc">选择项目文件夹后即可开始使用 ${PRODUCT_NAME}</div>
        <button class="workspace-btn" id="openWorkspaceBtn">打开工作目录</button>
      </div>`;
    footerEl.textContent = '';
    newChatBtn.style.display = 'none';
    document.getElementById('openWorkspaceBtn')?.addEventListener('click', () => {
      window.sidebarAPI?.openWorkspace();
    });
    setActive(null);
    return;
  }
  newChatBtn.style.display = '';

  if (!conversations.length) {
    resetList();
    listEl.innerHTML = '<div class="empty">暂无对话</div>';
    footerEl.textContent = '';
    return;
  }

  // 父会话在前，子会话（parentSessionId 非空）缩进排列
  // 统一按修改时间（最后一条用户消息）倒序排序（与 webview 版本一致）；
  // 只有用户主动发消息才会刷新 updatedAt，后台消息不影响排序。
  const sorted = [...conversations].sort(
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

  footerEl.textContent = `${conversations.length} 个对话`;

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
  // 正在等待用户输入（ask user / 权限确认）时显示黄色
  const runningBar = state && !state.idle
    ? `<div class="running-bar${state.waiting ? ' running-bar--waiting' : ''}"></div>`
    : '';
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
    return conversations
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
  const c = conversations.find((x) => x.sessionId === sessionId);
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
    window.sidebarAPI?.openConversation(sessionId);
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
  window.sidebarAPI.onSessionLoadedChanged((sessionIds) => {
    loadedSessions = normalizeLoadedSessions(sessionIds);
    render();
  });
  window.sidebarAPI.onActiveSessionChanged((sessionId) => {
    setActive(sessionId);
  });
  window.sidebarAPI.onWorkspaceChanged((workspace) => {
    workspacePath = workspace;
    // 工作区变化：清空旧工作区的视图层/运行时状态，重新拉取（主进程随后也会推送）
    sessionStates = new Map();
    loadedSessions = new Set();
    window.sidebarAPI?.getConversations()
      .then((list) => {
        conversations = list;
        render();
      })
      .catch((err) => console.error('[sidebar] reload conversations failed:', err));
    window.sidebarAPI?.getLoadedSessions()
      .then((ids) => {
        loadedSessions = normalizeLoadedSessions(ids);
        render();
      })
      .catch(() => undefined);
    window.sidebarAPI?.getActiveSession()
      .then((sid) => setActive(sid))
      .catch(() => undefined);
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
  subscribe();

  newChatBtn.addEventListener('click', () => {
    window.sidebarAPI?.newConversation();
  });

  try {
    const [list, active, ws, loaded] = await Promise.all([
      window.sidebarAPI.getConversations(),
      window.sidebarAPI.getActiveSession(),
      window.sidebarAPI.getWorkspace(),
      window.sidebarAPI.getLoadedSessions(),
    ]);
    conversations = list;
    activeSessionId = active;
    workspacePath = ws;
    loadedSessions = normalizeLoadedSessions(loaded);
    render();
  } catch (err) {
    listEl.innerHTML = `<div class="empty">加载失败: ${escapeHtml(String(err))}</div>`;
  }
}

void init();
