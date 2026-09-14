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
 *   - onConversationsUpdated()  主进程推送列表变化
 *
 * 交互参考插件 webview 版本（ConversationTreeItem.tsx）：
 * 根对话 hover 时显示 重命名/智能命名/删除/关闭 按钮（2 行 2 列）；重命名为行内输入框；
 * 删除需二次确认；智能命名进行中显示转圈。
 * 子代理（subagent）对话 hover 时仅显示「关闭」按钮——关闭其聊天视图、释放资源，
 * 但不提供重命名/智能命名/删除（子代理历史由父会话管理，避免误删）。
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
  loaded?: boolean;
  /** 会话是否正在运行（非 idle），用于流水灯效果 */
  running?: boolean;
  /** 会话是否正在等待用户输入（ask user / 权限确认），流水灯显示黄色 */
  waitingForUser?: boolean;
}

interface SidebarAPI {
  getConversations: () => Promise<ConversationMeta[]>;
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
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

function render(): void {
  // 顶部显示当前工作目录名
  updateHeader();

  // 未选择工作区：显示引导占位（含“打开工作目录”按钮）
  if (!workspacePath) {
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

  const html: string[] = [];
  const renderNode = (c: ConversationMeta, depth: number): void => {
    const kids = childrenMap.get(c.sessionId) || [];
    const expanded = kids.length > 0 && isSubExpanded(c.sessionId);
    html.push(itemHtml(c, depth, kids.length, expanded));
    if (expanded) {
      for (const child of kids) renderNode(child, depth + 1);
    }
  };
  for (const c of roots) renderNode(c, 0);

  listEl.innerHTML = html.join('');

  // 绑定点击：打开对话
  listEl.querySelectorAll<HTMLElement>('.item').forEach((el) => {
    el.addEventListener('click', (e) => {
      // 点击交互控件时不打开对话
      if ((e.target as HTMLElement).closest('.item-actions, .rename-input, .confirm-bar')) return;
      const sessionId = el.dataset.sessionId!;
      window.sidebarAPI?.openConversation(sessionId);
      setActive(sessionId);
    });
  });

  // 绑定操作按钮
  listEl.querySelectorAll<HTMLElement>('[data-action]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const { action, sessionId } = btn.dataset;
      if (!action || !sessionId) return;
      if (action === 'rename') startRename(sessionId);
      else if (action === 'smart-name') smartName(sessionId);
      else if (action === 'delete') armDelete(sessionId);
      else if (action === 'close') closeConversation(sessionId);
      else if (action === 'confirm-delete') doDelete(sessionId);
      else if (action === 'cancel-delete') cancelDelete();
      else if (action === 'toggle-sub') toggleSubSession(sessionId);
    });
  });

  // 重命名输入框：聚焦 + 绑定键盘
  const renameInput = listEl.querySelector<HTMLInputElement>('.rename-input input');
  if (renameInput) {
    renameInput.focus();
    renameInput.select();
    renameInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
      else if (e.key === 'Escape') { cancelRename(); }
    });
    renameInput.addEventListener('input', () => { renameValue = renameInput.value; });
    renameInput.addEventListener('blur', () => commitRename());
  }

  footerEl.textContent = `${conversations.length} 个对话`;

  // render 重建了 DOM，需重新应用当前活跃会话高亮
  setActive(activeSessionId);
}

function itemHtml(c: ConversationMeta, depth: number, childCount: number, isExpanded: boolean): string {
  const title = c.title && c.title.trim() ? c.title : '(未命名对话)';
  const active = c.sessionId === activeSessionId ? ' active' : '';
  const roleTag = c.role && c.role !== 'Master' ? ` · ${escapeHtml(c.role)}` : '';
  const dot = c.loaded ? '<span class="loaded-dot" title="已打开"></span>' : '';
  // 非 idle 对话显示左边流水灯条（与 webview 对话列表一致；当前活跃会话同样显示）
  // 正在等待用户输入（ask user / 权限确认）时显示黄色
  const runningBar = c.running
    ? `<div class="running-bar${c.waitingForUser ? ' running-bar--waiting' : ''}"></div>`
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

  // 操作按钮（hover 显示，与 webview 版本一致）：
  // - 根对话：重命名 / 智能命名 / 删除 / 关闭（2 行 2 列）
  // - 子代理（subagent）：仅「关闭」（关闭其聊天视图、释放资源），
  //   不提供重命名 / 智能命名 / 删除——子代理历史由父会话管理，避免误删。
  const actionsHtml = isRenaming || isConfirming
    ? ''
    : depth === 0
      ? `<div class="item-actions">
         <button class="action-btn" data-action="rename" data-session-id="${c.sessionId}" title="重命名">${ICON_RENAME}</button>
         <button class="action-btn" data-action="smart-name" data-session-id="${c.sessionId}" title="智能命名" ${isNaming ? 'disabled' : ''}>${isNaming ? '<span class="spinner"></span>' : ICON_SMART_NAME}</button>
         <button class="action-btn danger" data-action="delete" data-session-id="${c.sessionId}" title="删除此对话">${ICON_DELETE}</button>
         <button class="action-btn" data-action="close" data-session-id="${c.sessionId}" title="关闭对话（释放资源）">${ICON_CLOSE}</button>
       </div>`
      : `<div class="item-actions item-actions--single">
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
    <div class="item${depth > 0 ? ' child' : ''}${active}"${indent} data-session-id="${c.sessionId}">
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
}

function cancelRename(): void {
  renamingSessionId = null;
  render();
}

function commitRename(): void {
  const sessionId = renamingSessionId;
  renamingSessionId = null;
  const newTitle = renameValue.trim();
  renameValue = '';
  if (!sessionId) { render(); return; }
  if (!newTitle) { render(); return; }
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
  window.sidebarAPI.onActiveSessionChanged((sessionId) => {
    setActive(sessionId);
  });
  window.sidebarAPI.onWorkspaceChanged((workspace) => {
    workspacePath = workspace;
    // 工作区变化：重新拉取对话列表（主进程随后也会推送 conversations-updated）
    window.sidebarAPI?.getConversations()
      .then((list) => {
        conversations = list;
        render();
      })
      .catch((err) => console.error('[sidebar] reload conversations failed:', err));
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
  subscribe();

  newChatBtn.addEventListener('click', () => {
    window.sidebarAPI?.newConversation();
  });

  try {
    const [list, active, ws] = await Promise.all([
      window.sidebarAPI.getConversations(),
      window.sidebarAPI.getActiveSession(),
      window.sidebarAPI.getWorkspace(),
    ]);
    conversations = list;
    activeSessionId = active;
    workspacePath = ws;
    render();
  } catch (err) {
    listEl.innerHTML = `<div class="empty">加载失败: ${escapeHtml(String(err))}</div>`;
  }
}

void init();
