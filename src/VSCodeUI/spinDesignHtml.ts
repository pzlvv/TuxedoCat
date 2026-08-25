/**
 * Spin Design webview HTML
 *
 * 自包含的流程图编辑器（支持中/英国际化，语言优先取 settings.json 的
 * uiLanguage；auto 时再取 VS Code UI language 与操作系统系统语言，
 * 两者任一为中文即显示中文）
 */

// ── Spin Design UI 字符串（zh/en）───────────────────────────────
const spinZhDict: Record<string, string> = {
  'app.title': 'Spin 设计',
  'toolbar.addNode': '+ 添加节点',
  'toolbar.clearResults': '清除结果',
  'toolbar.refresh': '刷新',
  'toolbar.save': '保存',
  'editor.placeholder': '输入任务描述...',
  'toast.noResults': '没有结果需要清除',
  'toast.edgeExists': '该连线已存在',
  'toast.cannotSelfConnect': '不能连接到自身',
  'node.done': '已完成',
  'node.deleteTitle': '删除节点',
  'node.delete': '删除',
  'node.taskLabel': '任务描述',
  'node.taskPlaceholder': '点击输入任务描述...',
  'node.criteriaLabel': '验收标准',
  'node.addCriteria': '+ 添加验收标准',
  'node.criteriaPlaceholder': '验收标准 {n}...',
  'node.connectTitle': '拖拽创建连线',
  'node.skillsLabel': '所需技能',
  'node.addSkills': '+ 选择技能',
  'node.skillsPlaceholder': '未选择技能',
  'node.skillSelectorTitle': '选择该节点需要加载的 Skill',
  'node.skillSelectorClose': '关闭',
  'toast.saveFailed': '保存失败: ',
  'toast.unknownError': '未知错误',
};

const spinEnDict: Record<string, string> = {
  'app.title': 'Spin Design',
  'toolbar.addNode': '+ Add Node',
  'toolbar.clearResults': 'Clear Results',
  'toolbar.refresh': 'Refresh',
  'toolbar.save': 'Save',
  'editor.placeholder': 'Enter task description...',
  'toast.noResults': 'No results to clear',
  'toast.edgeExists': 'Connection already exists',
  'toast.cannotSelfConnect': 'Cannot connect to itself',
  'node.done': 'Done',
  'node.deleteTitle': 'Delete node',
  'node.delete': 'Delete',
  'node.taskLabel': 'Task Description',
  'node.taskPlaceholder': 'Click to enter task description...',
  'node.criteriaLabel': 'Acceptance Criteria',
  'node.addCriteria': '+ Add Acceptance Criteria',
  'node.criteriaPlaceholder': 'Acceptance Criteria {n}...',
  'node.connectTitle': 'Drag to create connection',
  'node.skillsLabel': 'Skills',
  'node.addSkills': '+ Select Skills',
  'node.skillsPlaceholder': 'No skills selected',
  'node.skillSelectorTitle': 'Select skills to load for this node',
  'node.skillSelectorClose': 'Close',
  'toast.saveFailed': 'Save failed: ',
  'toast.unknownError': 'Unknown error',
};

export function getSpinDesignHtml(
  existingData: any,
  isDark: boolean,
  locale: string,
  systemLocale?: string,
  uiLanguage?: 'auto' | 'zh' | 'en',
  availableSkills?: Array<{ name: string; description?: string }>,
): string {
  // 与主 webview 一致：settings.json 的 uiLanguage 优先；auto 时再按
  // VS Code UI 语言与操作系统系统语言任一为中文即使用中文
  const isZh =
    uiLanguage === 'zh'
      ? true
      : uiLanguage === 'en'
        ? false
        : (typeof locale === 'string' && locale.toLowerCase().startsWith('zh')) ||
          (typeof systemLocale === 'string' && systemLocale.toLowerCase().startsWith('zh'));
  const dict = isZh ? spinZhDict : spinEnDict;
  const t = (key: string, params?: Record<string, string | number>): string => {
    let value = dict[key] ?? spinEnDict[key] ?? key;
    if (params) {
      for (const name of Object.keys(params)) {
        value = value.split('{' + name + '}').join(String(params[name]));
      }
    }
    return value;
  };
  const initialData = existingData ? JSON.stringify(existingData) : 'null';
  const availableSkillsJson = JSON.stringify(availableSkills || []);

  // Theme colors
  const c = isDark ? {
    bg: '#1a1a1f',
    fg: '#c1c1c6',
    toolBg: '#1e1e24',
    toolBdr: '#2a2a32',
    btnBdr: '#3a3a42',
    btnHvr: '#2a2a32',
    btnTxt: '#c1c1c6',
    ndBg: '#1e1e24',
    ndBdr: '#3a3a42',
    ndShd: 'rgba(0,0,0,0.3)',
    ndShdH: 'rgba(0,0,0,0.4)',
    ndShdS: 'rgba(99,102,241,0.2)',
    hdrBg: '#25252b',
    mute: '#9f9fa9',
    inpBg: '#16161c',
    dot: '#25252b',
    dotBg: '#1a1a1f',
    ph: '#6a6a75',
  } : {
    bg: '#f5f5f7',
    fg: '#18181b',
    toolBg: '#ffffff',
    toolBdr: '#d4d4d8',
    btnBdr: '#d4d4d8',
    btnHvr: '#e4e4e7',
    btnTxt: '#18181b',
    ndBg: '#ffffff',
    ndBdr: '#d4d4d8',
    ndShd: 'rgba(0,0,0,0.08)',
    ndShdH: 'rgba(0,0,0,0.12)',
    ndShdS: 'rgba(99,102,241,0.15)',
    hdrBg: '#fafafa',
    mute: '#71717a',
    inpBg: '#ffffff',
    dot: '#d4d4d8',
    dotBg: '#f5f5f7',
    ph: '#a1a1aa',
  };

  return `<!DOCTYPE html>
<html lang="${isZh ? 'zh-CN' : 'en'}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: ${c.bg}; color: ${c.fg};
    height: 100vh; display: flex; flex-direction: column; overflow: hidden;
  }
  #toolbar {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 16px; background: ${c.toolBg};
    border-bottom: 1px solid ${c.toolBdr}; flex-shrink: 0;
  }
  #toolbar .title { font-size: 14px; font-weight: 600; color: ${c.fg}; margin-right: auto; }
  #toolbar .btn {
    padding: 5px 12px; border-radius: 5px; border: 1px solid ${c.btnBdr};
    background: transparent; color: ${c.btnTxt}; font-size: 12px;
    cursor: pointer; transition: all 0.15s; white-space: nowrap;
  }
  #toolbar .btn:hover { background: ${c.btnHvr}; border-color: #6366f1; }
  #toolbar .btn.primary { background: #6366f1; border-color: #6366f1; color: #fff; }
  #toolbar .btn.primary:hover { background: #5558e6; }
  #toolbar .btn.danger { color: #ef4444; border-color: #ef4444; }
  #toolbar .btn.danger:hover { background: rgba(239,68,68,0.15); }
  #main { display: flex; flex: 1; overflow: hidden; }
  #canvas-area {
    flex: 1; position: relative; overflow: auto;
    background: radial-gradient(circle, ${c.dot} 1px, transparent 1px);
    background-size: 24px 24px; background-color: ${c.dotBg};
  }
  #canvas { position: relative; min-width: 3000px; min-height: 3000px; }
  #connections-svg {
    position: absolute; top: 0; left: 0; width: 100%; height: 100%;
    pointer-events: none;
  }
  .node {
    position: absolute; width: 300px;
    background: ${c.ndBg}; border: 1px solid ${c.ndBdr}; border-radius: 8px;
    overflow: visible; cursor: move; user-select: none;
    box-shadow: 0 2px 8px ${c.ndShd}; transition: box-shadow 0.15s;
  }
  .node:hover { box-shadow: 0 4px 16px ${c.ndShdH}; }
  .node.selected { border-color: #6366f1; box-shadow: 0 0 0 1px #6366f1, 0 4px 16px ${c.ndShdS}; }
  .node-header {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 8px; background: ${c.hdrBg};
    border-bottom: 1px solid ${c.ndBdr};
    font-size: 13px; font-weight: 600; color: ${c.mute};
  }
  .node-header .role-select {
    font-size: 11px; font-weight: 500; padding: 2px 6px;
    border: 1px solid ${c.ndBdr}; border-radius: 4px;
    background: ${c.inpBg}; color: ${c.fg};
    cursor: pointer; outline: none; height: 22px;
  }
  .node-header .role-select:hover { border-color: #6366f1; }
  .node-header .role-select:focus { border-color: #6366f1; }
  .node-status-badge {
    font-size: 11px; color: #22c55e; font-weight: 600;
    display: flex; align-items: center; gap: 2px;
  }
  .node-header .actions { margin-left: auto; display: flex; gap: 4px; }
  .node-header .actions button {
    width: 22px; height: 22px; border-radius: 4px; border: none;
    background: transparent; color: ${c.mute}; cursor: pointer;
    font-size: 14px; display: flex; align-items: center; justify-content: center;
    transition: all 0.12s;
  }
  .node-header .actions button:hover { background: ${c.btnHvr}; }
  .node-header .actions .del-btn:hover { background: rgba(239,68,68,0.2); color: #ef4444; }
  .node-body { padding: 12px; }
  .node-body label {
    display: block; font-size: 13px; color: ${c.mute};
    margin-bottom: 4px; font-weight: 500;
  }
  .ac-section { margin-top: 8px; }
  .ac-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
  .ac-header label { margin-bottom: 0; }
  .ac-item { display: flex; align-items: flex-start; gap: 4px; margin-bottom: 3px; }
  .ac-item .ac-display {
    flex: 1; min-height: 26px; padding: 4px 6px;
    border-radius: 4px; border: 1px solid ${c.ndBdr};
    background: ${c.inpBg}; color: ${c.fg}; font-size: 13px;
    cursor: text; overflow-y: auto; white-space: pre-wrap; word-break: break-word;
    transition: border-color 0.12s; line-height: 1.4;
  }
  .ac-item .ac-display:hover { border-color: #6366f1; }
  .ac-item .ac-display.empty { color: ${c.ph}; font-style: italic; }
  .ac-item .ac-del-btn {
    width: 20px; height: 24px; border: none; background: transparent;
    color: ${c.mute}; cursor: pointer; font-size: 13px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 3px; transition: all 0.12s; flex-shrink: 0;
  }
  .ac-item .ac-del-btn:hover { background: rgba(239,68,68,0.2); color: #ef4444; }
  .connect-anchor {
    position: absolute; width: 14px; height: 14px; border-radius: 50%;
    background: #6366f1; border: 2px solid #818cf8; cursor: crosshair;
    z-index: 20; opacity: 0; transition: opacity 0.15s, transform 0.15s;
    pointer-events: all; transform: translate(-50%, -50%);
  }
  .node:hover .connect-anchor { opacity: 1; }
  .connect-anchor:hover { transform: translate(-50%, -50%) scale(1.4); background: #818cf8; }
  .connect-anchor.top { top: 0; left: 50%; }
  .connect-anchor.bottom { top: 100%; left: 50%; }
  .connect-anchor.left { top: 50%; left: 0; }
  .connect-anchor.right { top: 50%; left: 100%; }
  .task-display {
    width: 100%; min-height: 48px; max-height: 200px;
    padding: 5px 7px; border-radius: 4px; border: 1px solid ${c.ndBdr};
    background: ${c.inpBg}; color: ${c.fg}; font-size: 14px;
    cursor: text; overflow-y: auto; white-space: pre-wrap; word-break: break-word;
    transition: border-color 0.12s; line-height: 1.5;
  }
  .task-display:hover { border-color: #6366f1; }
  .task-display.empty { color: ${c.ph}; font-style: italic; }
  #task-editor-overlay { position: fixed; z-index: 9999; display: none; }
  #task-editor-overlay.show { display: block; }
  #task-editor-box { background: transparent; display: flex; flex-direction: column; }
  #task-editor-box textarea {
    width: 100%; min-height: 80px; padding: 5px 7px;
    border: 1px solid #6366f1; border-radius: 6px;
    background: ${c.inpBg}; color: ${c.fg}; font-size: 15px; font-family: inherit;
    resize: none; outline: none; line-height: 1.6; box-shadow: 0 4px 16px rgba(0,0,0,0.4);
  }
  #task-editor-box textarea:focus { border-color: #818cf8; }
  #skill-selector-overlay { position: fixed; z-index: 9998; display: none; }
  #skill-selector-overlay.show { display: block; }
  #skill-selector-box {
    background: ${c.toolBg}; border: 1px solid ${c.btnBdr}; border-radius: 8px;
    padding: 10px; max-height: 320px; overflow-y: auto;
    box-shadow: 0 4px 16px rgba(0,0,0,0.35);
  }
  .skill-selector-item {
    display: flex; align-items: flex-start; gap: 6px;
    padding: 4px 6px; border-radius: 4px; cursor: pointer;
    font-size: 12px; color: ${c.fg};
  }
  .skill-selector-item:hover { background: ${c.btnHvr}; }
  .skill-selector-item input { margin-top: 2px; }
  .skill-selector-item .skill-desc { color: ${c.mute}; font-size: 11px; }
  .skill-tag {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 6px; margin: 2px 4px 2px 0; border-radius: 4px;
    background: rgba(99,102,241,0.15); border: 1px solid rgba(99,102,241,0.35);
    color: ${c.fg}; font-size: 11px;
  }
  .skill-tag .remove {
    cursor: pointer; color: ${c.mute}; font-weight: 600; padding: 0 2px;
  }
  .skill-tag .remove:hover { color: #ef4444; }
  #toast {
    position: fixed; bottom: 60px; left: 50%;
    transform: translateX(-50%) translateY(20px);
    padding: 8px 20px; border-radius: 6px; font-size: 12px; font-weight: 500;
    z-index: 1000; opacity: 0; transition: all 0.2s ease; pointer-events: none;
  }
  #toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  #toast.success { background: rgba(34,197,94,0.9); color: #fff; }
  #toast.error { background: rgba(239,68,68,0.9); color: #fff; }
  #toast.info { background: rgba(99,102,241,0.9); color: #fff; }
</style>
</head>
<body>
  <div id="toolbar">
    <span class="title">${t('app.title')}</span>
    <button class="btn" id="btnAddNode">${t('toolbar.addNode')}</button>
    <button class="btn" id="btnClearResults">${t('toolbar.clearResults')}</button>
    <button class="btn" id="btnRefresh">${t('toolbar.refresh')}</button>
    <button class="btn primary" id="btnSave">${t('toolbar.save')}</button>
  </div>
  <div id="main">
    <div id="canvas-area">
      <div id="canvas">
      <svg id="connections-svg">
        <defs>
          <marker id="arrowhead" viewBox="0 0 8 8" refX="7" refY="4"
            markerWidth="8" markerHeight="8" orient="auto">
            <polygon points="0 0, 8 4, 0 8" fill="#6366f1" />
          </marker>
        </defs>
      </svg>
      </div>
    </div>
  </div>
  <div id="toast"></div>
  <div id="task-editor-overlay">
    <div id="task-editor-box">
      <textarea id="te-textarea" placeholder="${t('editor.placeholder')}"></textarea>
    </div>
  </div>
  <div id="skill-selector-overlay">
    <div id="skill-selector-box"></div>
  </div>

<script>
var __spinDict = ${JSON.stringify(dict)};
var __spinFallbackDict = ${JSON.stringify(spinEnDict)};
function __spinT(key, params) {
  var value = __spinDict[key];
  if (value === undefined) value = __spinFallbackDict[key];
  if (value === undefined) return key;
  if (params) {
    for (var name in params) {
      value = value.split('{' + name + '}').join(String(params[name]));
    }
  }
  return value;
}
(function() {
  'use strict';

  let nodes = [];
  let edges = [];
  let meta = {};
  let selectedNodeId = null;
  let dragState = null;
  let connectFrom = null;
  let connectLine = null;
  let nextNodeId = 1;

  const vscode = acquireVsCodeApi();
  var _isDark = ${isDark};

  const initialData = ${initialData};
  var __spinAvailableSkills = ${availableSkillsJson};

  // 数据源优先级：磁盘 spin.json（initialData）为权威数据源。
  // SpinLoop 执行时会直接更新磁盘上的 meta（已完成状态），而 webview 缓存
  // （savedState）可能滞后于磁盘；若优先使用缓存的空 meta，会导致已完成的
  // 节点在页面上不显示，且"清除结果"无法持久化到磁盘（保存不生效）。
  // 因此当磁盘有数据时优先从磁盘加载；仅在没有 spin.json 时回退到 webview 缓存。
  var savedState = vscode.getState();
  if (initialData && initialData.nodes) {
    var initialNodeError = getNodeListError(initialData.nodes);
    if (initialNodeError) {
      // 磁盘数据损坏时不要静默 fallback 成空画布，直接提示错误并禁用保存，
      // 避免用户误操作把空数据覆盖回 spin.json。
      showToast('spin.json 数据错误: ' + initialNodeError, 'error');
      updateSaveButton(false);
    } else {
      nodes = initialData.nodes.map(function(n) { return { id: n.id, x: n.x, y: n.y, task: n.task || '', criteria: n.criteria || [], role: n.role || 'Master', skills: n.skills || [] }; });
      edges = initialData.edges || [];
      meta = initialData.meta || {};
      nextNodeId = nodes.reduce(function(m, n) { return Math.max(m, n.id); }, 0) + 1;
      // 若缓存中的 nextNodeId 更大（曾删除最大 id 的节点等场景），沿用缓存值避免 id 复用
      if (savedState && typeof savedState.nextNodeId === 'number' && savedState.nextNodeId > nextNodeId) {
        nextNodeId = savedState.nextNodeId;
      }
      persistState();
      renderAll();
    }
  } else if (savedState && savedState.nodes) {
    var savedNodeError = getNodeListError(savedState.nodes);
    if (savedNodeError) {
      showToast('本地缓存数据错误: ' + savedNodeError, 'error');
      updateSaveButton(false);
    } else {
      nodes = savedState.nodes.map(function(n) { return { id: n.id, x: n.x, y: n.y, task: n.task || '', criteria: n.criteria || [], role: n.role || 'Master', skills: n.skills || [] }; });
      edges = savedState.edges || [];
      meta = savedState.meta || {};
      nextNodeId = savedState.nextNodeId || (nodes.reduce(function(m, n) { return Math.max(m, n.id); }, 0) + 1);
      renderAll();
    }
  }

  document.getElementById('btnAddNode').addEventListener('click', function() { addNode(); });
  document.getElementById('btnClearResults').addEventListener('click', function() { clearResults(); });
  document.getElementById('btnRefresh').addEventListener('click', function() { refreshDesign(); });
  document.getElementById('btnSave').addEventListener('click', function() { saveDesign(); });

  function clearResults() {
    // 即使 webview 内存中的 meta 为空（缓存过期导致磁盘上有已完成状态但页面未显示），
    // 也必须把空的 meta 写回磁盘，否则"清除结果"不生效。
    var diskMeta = (initialData && initialData.meta) || {};
    var hadResults = Object.keys(meta).length > 0 || Object.keys(diskMeta).length > 0;
    meta = {};
    persistState();
    renderAll();
    // 强制保存：清除执行结果不应受结构校验（环/不连通等）影响，
    // 否则 meta 只在内存中被清空而无法持久化到磁盘 spin.json。
    // 保存结果由 spinSaveResult 回调反馈（失败时提示）
    saveDesign(true);
    if (!hadResults) { showToast(__spinT('toast.noResults'), 'info'); }
  }

  function refreshDesign() {
    // 请求扩展端重新读取 spin.json 与 Skill 列表，并回传最新数据
    vscode.postMessage({ type: 'refreshSpinDesign' });
  }

  var canvasArea = document.getElementById('canvas-area');

  // Floating editor
  var teOverlay = document.getElementById('task-editor-overlay');
  var teTextarea = document.getElementById('te-textarea');
  var teContext = null;
  var skillSelectorNodeId = null;

  // 根据鼠标点击坐标计算目标元素内的字符偏移量（用于打开悬浮框后定位光标）。
  // 返回 -1 表示无法计算（点击在空白/元素外部），此时退回到文本末尾。
  function getTextOffset(el, clientX, clientY) {
    var range = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(clientX, clientY);
    } else if (document.caretPositionFromPoint) {
      var pos = document.caretPositionFromPoint(clientX, clientY);
      if (pos) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
      }
    }
    if (!range) return -1;
    // 点击位置必须落在目标元素内部（或就是目标元素本身）
    if (range.startContainer !== el && !el.contains(range.startContainer)) return -1;
    // 统计从元素文本开头到点击位置的字符数
    var preRange = document.createRange();
    preRange.selectNodeContents(el);
    preRange.setEnd(range.startContainer, range.startOffset);
    return preRange.toString().length;
  }

  function openFloatingEditor(context, displayEl, caretOffset) {
    teContext = context;
    var node = getNode(context.nodeId);
    if (!node) return;
    teTextarea.value = context.type === 'task' ? (node.task || '') : (node.criteria[context.idx] || '');
    // caretOffset 基于 trim 后的显示文本计算；映射回原始文本偏移（前导空白）
    if (typeof caretOffset === 'number' && caretOffset >= 0) {
      var leadingWs = teTextarea.value.length - teTextarea.value.trimStart().length;
      caretOffset += leadingWs;
    }
    var r = displayEl.getBoundingClientRect();
    var w = Math.round(r.width * 1.5);
    teOverlay.style.position = 'fixed';
    teOverlay.style.left = (r.left + r.width / 2 - w / 2) + 'px';
    teOverlay.style.width = w + 'px';
    teOverlay.className = 'show';
    // 先设 auto 让 scrollHeight 反映真实内容高度
    teTextarea.style.height = 'auto';
    teTextarea.style.overflowY = 'hidden';
    // 悬浮框至少覆盖原显示框的高度，避免原框过高时底部露在外面
    teTextarea.style.minHeight = Math.max(80, r.height) + 'px';
    teMaxHeight = Math.max(400, r.height);
    var h = teTextarea.scrollHeight;
    if (h > teMaxHeight) {
      teTextarea.style.height = teMaxHeight + 'px';
      teTextarea.style.overflowY = 'auto';
    } else {
      teTextarea.style.height = h + 'px';
    }
    // 与原框顶部对齐；若高度超出视口则向上收拢，但仍覆盖整个原框
    teOverlay.style.top = Math.max(0, Math.min(r.top, window.innerHeight - teTextarea.offsetHeight - 8)) + 'px';
    setTimeout(function() {
      teTextarea.focus();
      var pos = (typeof caretOffset === 'number' && caretOffset >= 0) ? caretOffset : teTextarea.value.length;
      if (pos > teTextarea.value.length) pos = teTextarea.value.length;
      teTextarea.selectionStart = pos;
      teTextarea.selectionEnd = pos;
    }, 50);
  }

  function closeFloatingEditor() {
    if (teContext) {
      var node = getNode(teContext.nodeId);
      if (node) {
        var changed = false;
        if (teContext.type === 'task' && node.task !== teTextarea.value) { node.task = teTextarea.value; changed = true; }
        else if (teContext.type === 'criteria' && node.criteria[teContext.idx] !== teTextarea.value) { node.criteria[teContext.idx] = teTextarea.value; changed = true; }
        if (changed) {
          // 节点内容修改，清除该节点的执行结果
          delete meta[String(teContext.nodeId)];
        }
        renderNode(teContext.nodeId);
        persistState();
        if (changed) saveDesign();
      }
    }
    teOverlay.className = '';
    teContext = null;
  }

  var skillSelectorOverlay = document.getElementById('skill-selector-overlay');
  var skillSelectorBox = document.getElementById('skill-selector-box');

  function openSkillSelector(nodeId, anchorEl) {
    var node = getNode(nodeId);
    if (!node) return;
    skillSelectorNodeId = nodeId;
    renderSkillSelector();
    var r = anchorEl.getBoundingClientRect();
    skillSelectorOverlay.style.position = 'fixed';
    skillSelectorOverlay.style.top = Math.min(window.innerHeight - 340, Math.max(8, r.bottom + 4)) + 'px';
    skillSelectorOverlay.style.left = Math.min(window.innerWidth - 320, Math.max(8, r.left)) + 'px';
    skillSelectorOverlay.style.width = '300px';
    skillSelectorOverlay.className = 'show';
  }

  function closeSkillSelector() {
    skillSelectorOverlay.className = '';
    skillSelectorNodeId = null;
  }

  function renderSkillSelector() {
    var node = getNode(skillSelectorNodeId);
    if (!node) return;
    skillSelectorBox.innerHTML = '';
    var title = document.createElement('div');
    title.style.cssText = 'font-size:13px;font-weight:600;margin-bottom:6px;color:' + (_isDark ? '#c1c1c6' : '#18181b') + ';';
    title.textContent = __spinT('node.skillSelectorTitle');
    skillSelectorBox.appendChild(title);

    if (__spinAvailableSkills.length === 0) {
      var empty = document.createElement('div');
      empty.style.cssText = 'font-size:12px;color:' + (_isDark ? '#9f9fa9' : '#71717a') + ';padding:4px 0;';
      empty.textContent = __spinT('node.skillsPlaceholder');
      skillSelectorBox.appendChild(empty);
    } else {
      __spinAvailableSkills.forEach(function(skill) {
        var label = document.createElement('label');
        label.className = 'skill-selector-item';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = node.skills.indexOf(skill.name) !== -1;
        cb.addEventListener('change', function() {
          toggleNodeSkill(node.id, skill.name, cb.checked);
        });
        var textWrap = document.createElement('div');
        textWrap.style.cssText = 'display:flex;flex-direction:column;gap:1px;min-width:0;';
        var nameEl = document.createElement('span');
        nameEl.textContent = skill.name;
        nameEl.style.fontWeight = '500';
        textWrap.appendChild(nameEl);
        if (skill.description) {
          var descEl = document.createElement('span');
          descEl.className = 'skill-desc';
          descEl.textContent = skill.description;
          textWrap.appendChild(descEl);
        }
        label.appendChild(cb);
        label.appendChild(textWrap);
        skillSelectorBox.appendChild(label);
      });
    }

    var closeBtn = document.createElement('button');
    closeBtn.textContent = __spinT('node.skillSelectorClose');
    closeBtn.style.cssText = 'margin-top:8px;padding:4px 10px;border-radius:4px;border:1px solid ' + (_isDark ? '#3a3a42' : '#d4d4d8') + ';background:transparent;color:' + (_isDark ? '#c1c1c6' : '#18181b') + ';cursor:pointer;font-size:12px;';
    closeBtn.addEventListener('click', closeSkillSelector);
    skillSelectorBox.appendChild(closeBtn);
  }

  function toggleNodeSkill(nodeId, skillName, checked) {
    var node = getNode(nodeId);
    if (!node) return;
    if (checked) {
      if (node.skills.indexOf(skillName) === -1) node.skills.push(skillName);
    } else {
      node.skills = node.skills.filter(function(s) { return s !== skillName; });
    }
    // 修改节点配置，清除该节点的执行结果
    delete meta[String(nodeId)];
    renderNode(nodeId);
    renderSkillSelector();
    persistState();
    saveDesign();
  }

  function removeNodeSkill(nodeId, skillName) {
    var node = getNode(nodeId);
    if (!node) return;
    node.skills = node.skills.filter(function(s) { return s !== skillName; });
    delete meta[String(nodeId)];
    renderNode(nodeId);
    persistState();
    saveDesign();
  }

  document.addEventListener('mousedown', function(e) {
    if (teOverlay.className === 'show' && !teOverlay.contains(e.target)) closeFloatingEditor();
    if (skillSelectorOverlay.className === 'show' && !skillSelectorOverlay.contains(e.target)) closeSkillSelector();
  });

  teTextarea.addEventListener('input', function() {
    teTextarea.style.height = 'auto';
    var h = teTextarea.scrollHeight;
    var m = teMaxHeight;
    if (h > m) { teTextarea.style.height = m + 'px'; teTextarea.style.overflowY = 'auto'; }
    else { teTextarea.style.height = h + 'px'; teTextarea.style.overflowY = 'hidden'; }
  });
  var teMaxHeight = 0;

  teTextarea.addEventListener('keydown', function(e) {
    if ((e.altKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); closeFloatingEditor(); }
  });

  // Canvas panning
  var isPanning = false;
  var panStart = { x: 0, y: 0 };
  var panScroll = { left: 0, top: 0 };

  canvasArea.addEventListener('mousedown', function(e) {
    if (e.target === canvasArea || e.target.id === 'canvas' || e.target.tagName === 'svg') {
      isPanning = true;
      panStart = { x: e.clientX, y: e.clientY };
      panScroll = { left: canvasArea.scrollLeft, top: canvasArea.scrollTop };
      canvasArea.style.cursor = 'grabbing';
      selectedNodeId = null;
      document.querySelectorAll('.node').forEach(function(el) { el.classList.remove('selected'); });
    }
  });

  window.addEventListener('mousemove', function(e) {
    if (isPanning) {
      canvasArea.scrollLeft = panScroll.left - (e.clientX - panStart.x);
      canvasArea.scrollTop = panScroll.top - (e.clientY - panStart.y);
    }
    if (dragState) {
      var node = getNode(dragState.nodeId);
      if (node) {
        node.x = Math.max(0, dragState.origX + (e.clientX - dragState.startX));
        node.y = Math.max(0, dragState.origY + (e.clientY - dragState.startY));
        updateNodePos(node);
        renderEdges();
      }
    }
    if (connectFrom && connectLine) {
      var cr = document.getElementById('canvas').getBoundingClientRect();
      connectLine.setAttribute('x1', connectFrom.x - cr.left);
      connectLine.setAttribute('y1', connectFrom.y - cr.top);
      connectLine.setAttribute('x2', e.clientX - cr.left);
      connectLine.setAttribute('y2', e.clientY - cr.top);
    }
  });

  window.addEventListener('mouseup', function(e) {
    if (isPanning) { isPanning = false; canvasArea.style.cursor = ''; }
    if (dragState) { persistState(); saveDesign(); dragState = null; }
    if (connectFrom) {
      if (connectLine) { connectLine.remove(); connectLine = null; }
      var target = document.elementFromPoint(e.clientX, e.clientY);
      var nodeEl = target ? target.closest('.node') : null;
      if (nodeEl) {
        var tid = parseInt(nodeEl.id.replace('node-', ''), 10);
        if (tid && tid !== connectFrom.nodeId) {
          // Determine entry side based on mouse position relative to target node
          var tr = nodeEl.getBoundingClientRect();
          var dx = e.clientX - (tr.left + tr.width / 2);
          var dy = e.clientY - (tr.top + tr.height / 2);
          var toSide;
          if (Math.abs(dx) > Math.abs(dy)) {
            toSide = dx > 0 ? 'right' : 'left';
          } else {
            toSide = dy > 0 ? 'bottom' : 'top';
          }
          addEdge(connectFrom.nodeId, tid, connectFrom.side, toSide);
        }
      }
      connectFrom = null;
    }
  });

  // Persist state to survive tab switches
  function persistState() {
    vscode.setState({
      nodes: nodes.map(function(n) {
        return { id: n.id, x: n.x, y: n.y, task: n.task, criteria: n.criteria.filter(function(c) { return c.trim() !== ''; }), role: n.role || 'Master', skills: n.skills || [] };
      }),
      edges: edges,
      meta: meta,
      nextNodeId: nextNodeId,
    });
  }

  // Node operations
  function addNode() {
    var id = nextNodeId++;
    var area = document.getElementById('canvas-area');
    var x = Math.max(0, area.scrollLeft + area.clientWidth / 2 - 130);
    var y = Math.max(0, area.scrollTop + area.clientHeight / 2 - 100);
    nodes.push({ id: id, x: x, y: y, task: '', criteria: [], role: 'Master', skills: [] });
    selectedNodeId = id;
    renderAll();
    persistState();
    // 新增节点暂时不自动写盘：避免在 spin.json 中留下 task/criteria 均为空的节点。
    // 用户编辑任务内容（或后续其他有意修改）时再触发 saveDesign 持久化。
    setTimeout(function() {
      var el = document.getElementById('node-' + id);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    }, 50);
  }

  function deleteNode(nodeId) {
    nodes = nodes.filter(function(n) { return n.id !== nodeId; });
    edges = edges.filter(function(e) { return e.from !== nodeId && e.to !== nodeId; });
    delete meta[String(nodeId)];
    if (selectedNodeId === nodeId) selectedNodeId = null;
    renderAll();
    persistState();
    saveDesign();
  }

  function selectNode(nodeId) {
    selectedNodeId = nodeId;
    document.querySelectorAll('.node').forEach(function(el) {
      el.classList.toggle('selected', el.id === 'node-' + nodeId);
    });
  }

  function addCriteria(nodeId) {
    var node = getNode(nodeId);
    if (node) { node.criteria.push(''); delete meta[String(nodeId)]; renderNode(nodeId); persistState(); saveDesign(); }
  }

  function deleteCriteria(nodeId, idx) {
    var node = getNode(nodeId);
    if (node) { node.criteria.splice(idx, 1); delete meta[String(nodeId)]; renderNode(nodeId); persistState(); saveDesign(); }
  }

  function addEdge(fromId, toId, fromSide, toSide) {
    if (edges.some(function(e) { return e.from === fromId && e.to === toId; })) {
      showToast(__spinT('toast.edgeExists'), 'error'); return;
    }
    if (fromId === toId) { showToast(__spinT('toast.cannotSelfConnect'), 'error'); return; }
    edges.push({ from: fromId, to: toId, fromSide: fromSide || 'right', toSide: toSide || 'left' });
    // 连线变化清除下游节点的结果（简单处理：清除两个节点的结果）
    delete meta[String(fromId)];
    delete meta[String(toId)];
    renderEdges();
    persistState();
    saveDesign();
  }

  function getNode(id) { return nodes.find(function(n) { return n.id === id; }); }

  // 严格校验节点列表，避免把损坏数据静默 fallback 成空列表/空节点。
  // 返回 null 表示通过；返回字符串表示具体的错误信息。
  function getNodeListError(list) {
    if (!Array.isArray(list)) return 'nodes 不是数组';
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      if (!n || typeof n.id !== 'number' || !isFinite(n.id)) {
        return '第 ' + (i + 1) + ' 个节点缺少有效 id';
      }
    }
    return null;
  }

  // Render
  function renderAll() {
    var canvas = document.getElementById('canvas');
    canvas.querySelectorAll('.node').forEach(function(el) { el.remove(); });
    nodes.forEach(function(node) { canvas.appendChild(createNodeElement(node)); });
    renderEdges();
    revalidateDesign();
  }

  function renderNode(nodeId) {
    var node = getNode(nodeId);
    if (!node) return;
    var el = document.getElementById('node-' + nodeId);
    if (el) el.replaceWith(createNodeElement(node));
    renderEdges();
  }

  function updateNodePos(node) {
    var el = document.getElementById('node-' + node.id);
    if (el) { el.style.left = node.x + 'px'; el.style.top = node.y + 'px'; }
  }

  function createNodeElement(node) {
    var div = document.createElement('div');
    div.className = 'node' + (selectedNodeId === node.id ? ' selected' : '');
    div.id = 'node-' + node.id;
    div.style.left = node.x + 'px';
    div.style.top = node.y + 'px';

    div.addEventListener('mousedown', function(e) {
      if (e.target.classList.contains('connect-anchor')) return;
      if (!e.target.classList.contains('task-display') && !e.target.classList.contains('ac-display')) {
        selectNode(node.id);
        dragState = { nodeId: node.id, startX: e.clientX, startY: e.clientY, origX: node.x, origY: node.y };
        div.style.cursor = 'grabbing';
      } else {
        selectNode(node.id);
      }
    });

    // Header (status badge + role select + delete button)
    var header = document.createElement('div');
    header.className = 'node-header';
    var statusBadge = document.createElement('div');
    statusBadge.className = 'node-status-badge';
    statusBadge.style.display = 'none';
    statusBadge.textContent = '\u2713 ' + __spinT('node.done');
    header.appendChild(statusBadge);
    // Role selector
    var roleSel = document.createElement('select');
    roleSel.className = 'role-select';
    var agentRoles = ['Master'];
    agentRoles.forEach(function(r) {
      var opt = document.createElement('option');
      opt.value = r;
      opt.textContent = r;
      roleSel.appendChild(opt);
    });
    roleSel.value = node.role || 'Master';
    roleSel.addEventListener('change', function(e) {
      e.stopPropagation();
      node.role = roleSel.value;
      persistState();
      saveDesign();
    });
    roleSel.addEventListener('mousedown', function(e) { e.stopPropagation(); });
    header.appendChild(roleSel);
    var actions = document.createElement('div');
    actions.className = 'actions';
    var delBtn = document.createElement('button');
    delBtn.className = 'del-btn';
    delBtn.textContent = '\u00D7';
    delBtn.title = __spinT('node.deleteTitle');
    delBtn.addEventListener('click', function(e) { e.stopPropagation(); deleteNode(node.id); });
    actions.appendChild(delBtn);
    header.appendChild(actions);
    div.appendChild(header);

    // Check meta for passed status
    var nodeMeta = meta[String(node.id)];
    if (nodeMeta && nodeMeta.passed) {
      statusBadge.style.display = '';
    }

    // Body
    var body = document.createElement('div');
    body.className = 'node-body';

    var taskLabel = document.createElement('label');
    taskLabel.textContent = __spinT('node.taskLabel');
    body.appendChild(taskLabel);

    var taskDisplay = document.createElement('div');
    taskDisplay.className = 'task-display' + ((node.task || '').trim() === '' ? ' empty' : '');
    taskDisplay.textContent = (node.task || '').trim() || __spinT('node.taskPlaceholder');
    taskDisplay.addEventListener('click', function(e) {
      e.stopPropagation();
      var offset = getTextOffset(taskDisplay, e.clientX, e.clientY);
      openFloatingEditor({ type: 'task', nodeId: node.id }, taskDisplay, offset);
    });
    body.appendChild(taskDisplay);

    // Acceptance Criteria
    var acSection = document.createElement('div');
    acSection.className = 'ac-section';

    var acHeader = document.createElement('div');
    acHeader.className = 'ac-header';
    var acLabel = document.createElement('label');
    acLabel.textContent = __spinT('node.criteriaLabel');
    acHeader.appendChild(acLabel);
    acSection.appendChild(acHeader);

    var acList = document.createElement('div');
    acList.id = 'ac-list-' + node.id;

    (node.criteria || []).forEach(function(val, i) {
      acList.appendChild(createCriteriaItem(node.id, i, val));
    });

    // Add button at bottom of list (hidden delete button for alignment)
    var addItem = document.createElement('div');
    addItem.className = 'ac-item';
    var addBtn = document.createElement('div');
    addBtn.style.flex = '1';
    addBtn.style.minHeight = '26px';
    addBtn.style.display = 'flex';
    addBtn.style.alignItems = 'center';
    addBtn.style.justifyContent = 'center';
    addBtn.style.borderRadius = '4px';
    addBtn.style.border = '1px dashed ' + (_isDark ? '#3a3a42' : '#d4d4d8');
    addBtn.style.background = (_isDark ? '#16161c' : '#ffffff');
    addBtn.style.color = (_isDark ? '#6a6a75' : '#a1a1aa');
    addBtn.style.fontSize = '13px';
    addBtn.style.fontStyle = 'italic';
    addBtn.style.cursor = 'pointer';
    addBtn.style.transition = 'border-color 0.12s, color 0.12s';
    addBtn.textContent = __spinT('node.addCriteria');
    addBtn.addEventListener('click', function(e) { e.stopPropagation(); addCriteria(node.id); });
    addBtn.addEventListener('mouseenter', function() { addBtn.style.borderColor = '#6366f1'; addBtn.style.color = (_isDark ? '#c1c1c6' : '#18181b'); });
    addBtn.addEventListener('mouseleave', function() { addBtn.style.borderColor = (_isDark ? '#3a3a42' : '#d4d4d8'); addBtn.style.color = (_isDark ? '#6a6a75' : '#a1a1aa'); });
    addItem.appendChild(addBtn);
    // Invisible placeholder for delete button alignment
    var ph = document.createElement('button');
    ph.style.width = '20px'; ph.style.height = '24px';
    ph.style.border = 'none'; ph.style.padding = '0';
    ph.style.background = 'transparent';
    ph.style.visibility = 'hidden';
    addItem.appendChild(ph);
    acList.appendChild(addItem);

    acSection.appendChild(acList);
    body.appendChild(acSection);

    // Skills section
    var skillSection = document.createElement('div');
    skillSection.className = 'ac-section';
    var skillHeader = document.createElement('div');
    skillHeader.className = 'ac-header';
    var skillLabel = document.createElement('label');
    skillLabel.textContent = __spinT('node.skillsLabel');
    skillHeader.appendChild(skillLabel);
    skillSection.appendChild(skillHeader);

    var skillList = document.createElement('div');
    (node.skills || []).forEach(function(skillName) {
      var tag = document.createElement('span');
      tag.className = 'skill-tag';
      var nameSpan = document.createElement('span');
      nameSpan.textContent = skillName;
      var remove = document.createElement('span');
      remove.className = 'remove';
      remove.textContent = '\u00D7';
      remove.addEventListener('click', function(e) {
        e.stopPropagation();
        removeNodeSkill(node.id, skillName);
      });
      tag.appendChild(nameSpan);
      tag.appendChild(remove);
      skillList.appendChild(tag);
    });
    if (!node.skills || node.skills.length === 0) {
      var emptySkills = document.createElement('div');
      emptySkills.style.cssText = 'font-size:12px;color:' + (_isDark ? '#6a6a75' : '#a1a1aa') + ';font-style:italic;padding:2px 0;';
      emptySkills.textContent = __spinT('node.skillsPlaceholder');
      skillList.appendChild(emptySkills);
    }
    skillSection.appendChild(skillList);

    var addSkillBtn = document.createElement('div');
    addSkillBtn.style.cssText = 'margin-top:6px;padding:4px 8px;border-radius:4px;border:1px dashed ' + (_isDark ? '#3a3a42' : '#d4d4d8') + ';background:' + (_isDark ? '#16161c' : '#ffffff') + ';color:' + (_isDark ? '#6a6a75' : '#a1a1aa') + ';font-size:12px;font-style:italic;cursor:pointer;text-align:center;';
    addSkillBtn.textContent = __spinT('node.addSkills');
    addSkillBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      openSkillSelector(node.id, addSkillBtn);
    });
    skillSection.appendChild(addSkillBtn);

    body.appendChild(skillSection);
    div.appendChild(body);

    // Connect anchors
    var sides = [
      { cls: 'top', getPos: function(r) { return { x: r.left + r.width / 2, y: r.top }; } },
      { cls: 'bottom', getPos: function(r) { return { x: r.left + r.width / 2, y: r.bottom }; } },
      { cls: 'left', getPos: function(r) { return { x: r.left, y: r.top + r.height / 2 }; } },
      { cls: 'right', getPos: function(r) { return { x: r.right, y: r.top + r.height / 2 }; } },
    ];
    sides.forEach(function(side) {
      var a = document.createElement('div');
      a.className = 'connect-anchor ' + side.cls;
      a.title = __spinT('node.connectTitle');
      a.addEventListener('mousedown', function(e) {
        e.stopPropagation(); e.preventDefault();
        var r = document.getElementById('node-' + node.id).getBoundingClientRect();
        var p = side.getPos(r);
        connectFrom = { nodeId: node.id, side: side.cls, x: p.x, y: p.y };
        var svg = document.getElementById('connections-svg');
        var ns = 'http://www.w3.org/2000/svg';
        var line = document.createElementNS(ns, 'line');
        line.setAttribute('stroke', '#6366f1');
        line.setAttribute('stroke-width', '2');
        line.setAttribute('stroke-dasharray', '6,3');
        line.style.pointerEvents = 'none';
        svg.appendChild(line);
        connectLine = line;
      });
      div.appendChild(a);
    });

    return div;
  }

  function createCriteriaItem(nodeId, idx, value) {
    var item = document.createElement('div');
    item.className = 'ac-item';
    var disp = document.createElement('div');
    disp.className = 'ac-display' + ((value || '').trim() === '' ? ' empty' : '');
    disp.textContent = (value || '').trim() || __spinT('node.criteriaPlaceholder', { n: idx + 1 });
    disp.addEventListener('click', function(e) {
      e.stopPropagation();
      var offset = getTextOffset(disp, e.clientX, e.clientY);
      openFloatingEditor({ type: 'criteria', nodeId: nodeId, idx: idx }, disp, offset);
    });
    item.appendChild(disp);
    var db = document.createElement('button');
    db.className = 'ac-del-btn';
    db.textContent = '\u00D7';
    db.title = __spinT('node.delete');
    db.addEventListener('click', function(e) { e.stopPropagation(); deleteCriteria(nodeId, idx); });
    item.appendChild(db);
    return item;
  }

  // Edge rendering
  function renderEdges() {
    var svg = document.getElementById('connections-svg');
    svg.querySelectorAll('g').forEach(function(el) { el.remove(); });
    var ns = 'http://www.w3.org/2000/svg';

    edges.forEach(function(edge) {
      var fn = getNode(edge.from), tn = getNode(edge.to);
      if (!fn || !tn) return;
      var fe = document.getElementById('node-' + edge.from);
      var te = document.getElementById('node-' + edge.to);
      if (!fe || !te) return;
      var c = document.getElementById('canvas');
      var fr = fe.getBoundingClientRect(), tr = te.getBoundingClientRect(), cr = c.getBoundingClientRect();

      // Compute source point based on fromSide, offset outward by 1px
      var x1, y1;
      var fs = edge.fromSide;
      if (fs === 'left') { x1 = fr.left - cr.left + 1; y1 = fr.top + fr.height / 2 - cr.top; }
      else if (fs === 'top') { x1 = fr.left + fr.width / 2 - cr.left; y1 = fr.top - cr.top + 1; }
      else if (fs === 'bottom') { x1 = fr.left + fr.width / 2 - cr.left; y1 = fr.bottom - cr.top - 1; }
      else { x1 = fr.right - cr.left - 1; y1 = fr.top + fr.height / 2 - cr.top; }

      // Compute target point based on toSide, offset inward by 1px for arrow marker
      var x2, y2;
      var ts = edge.toSide;
      if (ts === 'right') { x2 = tr.right - cr.left - 1; y2 = tr.top + tr.height / 2 - cr.top; }
      else if (ts === 'top') { x2 = tr.left + tr.width / 2 - cr.left; y2 = tr.top - cr.top + 1; }
      else if (ts === 'bottom') { x2 = tr.left + tr.width / 2 - cr.left; y2 = tr.bottom - cr.top - 1; }
      else { x2 = tr.left - cr.left + 1; y2 = tr.top + tr.height / 2 - cr.top; }

      // Compute bezier control point offsets based on side directions
      var dx = Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1)) * 0.4;
      var c1x, c1y, c2x, c2y;
      if (fs === 'left') { c1x = x1 - dx; c1y = y1; }
      else if (fs === 'right') { c1x = x1 + dx; c1y = y1; }
      else if (fs === 'top') { c1x = x1; c1y = y1 - dx; }
      else { c1x = x1; c1y = y1 + dx; }
      if (ts === 'left') { c2x = x2 - dx; c2y = y2; }
      else if (ts === 'right') { c2x = x2 + dx; c2y = y2; }
      else if (ts === 'top') { c2x = x2; c2y = y2 - dx; }
      else { c2x = x2; c2y = y2 + dx; }

      var g = document.createElementNS(ns, 'g');

      // Invisible wide path for hover detection (18px)
      var hitPath = document.createElementNS(ns, 'path');
      hitPath.setAttribute('d', 'M ' + x1 + ' ' + y1 + ' C ' + c1x + ' ' + c1y + ', ' + c2x + ' ' + c2y + ', ' + x2 + ' ' + y2);
      hitPath.setAttribute('fill', 'none');
      hitPath.setAttribute('stroke', 'transparent');
      hitPath.setAttribute('stroke-width', '18');
      hitPath.style.pointerEvents = 'stroke';
      hitPath.style.cursor = 'pointer';
      hitPath.addEventListener('click', function() { removeEdge(edge.from, edge.to); });
      hitPath.addEventListener('mousedown', function(e) { e.stopPropagation(); });
      g.appendChild(hitPath);

      // Visible path (thin line)
      var path = document.createElementNS(ns, 'path');
      path.setAttribute('d', 'M ' + x1 + ' ' + y1 + ' C ' + c1x + ' ' + c1y + ', ' + c2x + ' ' + c2y + ', ' + x2 + ' ' + y2);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', '#6366f1');
      path.setAttribute('stroke-width', '2');
      path.setAttribute('marker-end', 'url(#arrowhead)');
      path.style.pointerEvents = 'none';
      g.appendChild(path);

      hitPath.addEventListener('mouseenter', function() {
        if (delGroup._hideTimer) { clearTimeout(delGroup._hideTimer); delGroup._hideTimer = null; }
        delGroup.style.display = '';
      });
      hitPath.addEventListener('mouseleave', function() {
        delGroup._hideTimer = setTimeout(function() { delGroup.style.display = 'none'; }, 100);
      });

      // Delete button (visible only on hover)
      var pathLen = path.getTotalLength();
      var midPt = path.getPointAtLength(pathLen / 2);
      var mx = midPt.x, my = midPt.y;
      var delGroup = document.createElementNS(ns, 'g');
      delGroup.style.display = 'none';
      delGroup.addEventListener('mouseenter', function() {
        if (delGroup._hideTimer) { clearTimeout(delGroup._hideTimer); delGroup._hideTimer = null; }
        delGroup.style.display = '';
      });
      delGroup.addEventListener('mouseleave', function() {
        delGroup.style.display = 'none';
      });
      var circ = document.createElementNS(ns, 'circle');
      circ.setAttribute('cx', mx); circ.setAttribute('cy', my);
      circ.setAttribute('r', '12');
      circ.setAttribute('fill', 'rgba(239,68,68,0.15)');
      circ.style.cursor = 'pointer'; circ.style.pointerEvents = 'all';
      circ.addEventListener('click', function(e) { e.stopPropagation(); removeEdge(edge.from, edge.to); });
      circ.addEventListener('mouseenter', function() { circ.setAttribute('fill', 'rgba(239,68,68,0.4)'); });
      circ.addEventListener('mouseleave', function() { circ.setAttribute('fill', 'rgba(239,68,68,0.15)'); });
      delGroup.appendChild(circ);
      var icon = document.createElementNS(ns, 'path');
      icon.setAttribute('d', 'M -5 -5 L 5 5 M 5 -5 L -5 5');
      icon.setAttribute('stroke', '#ef4444');
      icon.setAttribute('stroke-width', '2.5');
      icon.setAttribute('stroke-linecap', 'round');
      icon.style.pointerEvents = 'none';
      icon.setAttribute('transform', 'translate(' + mx + ',' + my + ')');
      delGroup.appendChild(icon);
      g.appendChild(delGroup);
      svg.appendChild(g);
    });
  }

  function removeEdge(fromId, toId) {
    edges = edges.filter(function(e) { return !(e.from === fromId && e.to === toId); });
    delete meta[String(fromId)];
    delete meta[String(toId)];
    renderEdges();
    persistState();
    saveDesign();
  }

  // 校验设计是否合法（无环路、连通）
  function revalidateDesign() {
    // 先校验节点本身，避免 nodes 中出现 null/缺 id 时下方 map 直接抛错。
    for (var vi = 0; vi < nodes.length; vi++) {
      if (!nodes[vi] || typeof nodes[vi].id !== 'number' || !isFinite(nodes[vi].id)) {
        updateSaveButton(false);
        return false;
      }
      // 不允许保存 task 为空的节点：空节点没有可执行任务，写进 spin.json
      // 会导致 SpinLoop 执行一个空任务，也容易让原文件被“空节点”污染。
      if ((nodes[vi].task || '').trim() === '') {
        updateSaveButton(false);
        return false;
      }
    }

    var nodeIds = nodes.map(function(n) { return n.id; });
    if (nodeIds.length === 0) { updateSaveButton(true); return true; }

    var idSet = {};
    nodeIds.forEach(function(id) { idSet[id] = true; });

    var adj = {};
    var inDeg = {};
    nodeIds.forEach(function(id) { adj[id] = []; inDeg[id] = 0; });
    edges.forEach(function(e) {
      if (!idSet[e.from] || !idSet[e.to]) return;
      adj[e.from].push(e.to);
      inDeg[e.to] = (inDeg[e.to] || 0) + 1;
    });

    // Kahn
    var queue = [];
    nodeIds.forEach(function(id) { if (inDeg[id] === 0) queue.push(id); });
    var sorted = [];
    while (queue.length > 0) {
      var id = queue.shift();
      sorted.push(id);
      (adj[id] || []).forEach(function(neighbor) {
        inDeg[neighbor]--;
        if (inDeg[neighbor] === 0) queue.push(neighbor);
      });
    }
    if (sorted.length !== nodeIds.length) { updateSaveButton(false); return false; }

    // 连通性检查
    if (nodeIds.length > 0) {
      var visited = {};
      var stack = [nodeIds[0]];
      visited[nodeIds[0]] = true;
      while (stack.length > 0) {
        var cur = stack.pop();
        var reachable = {};
        (adj[cur] || []).forEach(function(nb) { reachable[nb] = true; });
        edges.forEach(function(e) {
          if (e.to === cur && idSet[e.from]) reachable[e.from] = true;
        });
        Object.keys(reachable).forEach(function(nb) {
          if (!visited[nb]) { visited[nb] = true; stack.push(nb); }
        });
      }
      if (Object.keys(visited).length !== nodeIds.length) { updateSaveButton(false); return false; }
    }

    updateSaveButton(true);
    return true;
  }

  function updateSaveButton(valid) {
    var btn = document.getElementById('btnSave');
    if (valid) {
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.style.cursor = 'pointer';
    } else {
      btn.disabled = true;
      btn.style.opacity = '0.4';
      btn.style.cursor = 'default';
    }
  }

  // Save with topological sort check
  // force=true 时跳过结构校验（用于清除执行结果等不修改结构的操作）
  function saveDesign(force) {
    if (!force && !revalidateDesign()) return; // 不符合规则，不保存也不报错

    // 严格校验，不静默过滤/丢弃问题节点。
    // 宁可报错中止，也不能把空节点或损坏数据 fallback 成空值写回 spin.json。
    for (var ni = 0; ni < nodes.length; ni++) {
      var n = nodes[ni];
      if (!n || typeof n.id !== 'number' || !isFinite(n.id)) {
        showToast('保存失败: 存在无效节点数据', 'error');
        return;
      }
      if ((n.task || '').trim() === '') {
        showToast('保存失败: 存在空任务节点，请先填写任务描述', 'error');
        return;
      }
    }

    var saveNodes = nodes.slice();
    var nodeIds = saveNodes.map(function(n) { return n.id; });
    var idSet = {};
    nodeIds.forEach(function(id) { idSet[id] = true; });

    // 连线引用不存在的节点时同样报错，而不是静默丢弃连线。
    for (var ei = 0; ei < edges.length; ei++) {
      var e = edges[ei];
      if (!idSet[e.from] || !idSet[e.to]) {
        showToast('保存失败: 存在指向缺失节点的连线', 'error');
        return;
      }
    }

    var adj = {};
    var inDeg = {};
    nodeIds.forEach(function(id) { adj[id] = []; inDeg[id] = 0; });
    edges.forEach(function(e) {
      adj[e.from].push(e.to);
      inDeg[e.to] = (inDeg[e.to] || 0) + 1;
    });

    // Kahn
    var queue = [];
    nodeIds.forEach(function(id) { if (inDeg[id] === 0) queue.push(id); });
    var sorted = [];
    while (queue.length > 0) {
      var id = queue.shift();
      sorted.push(id);
      (adj[id] || []).forEach(function(neighbor) {
        inDeg[neighbor]--;
        if (inDeg[neighbor] === 0) queue.push(neighbor);
      });
    }

    // Sort nodes array by topological order
    var sortedNodes = sorted.map(function(id) {
      return saveNodes.find(function(n) { return n.id === id; });
    }).filter(function(n) { return n; });

    // 非 force 保存不应走到这里（revalidateDesign 已拦截）；
    // force 保存（如清除结果）遇到拓扑不完整时保留原始顺序，但不丢弃节点。
    if (sortedNodes.length !== saveNodes.length) {
      if (!force) {
        showToast('保存失败: 拓扑排序不完整', 'error');
        return;
      }
      sortedNodes = saveNodes.slice();
    }

    var data = {
      nodes: sortedNodes.map(function(n) {
        return { id: n.id, x: n.x, y: n.y, task: n.task, criteria: n.criteria.filter(function(c) { return c.trim() !== ''; }), role: n.role || 'Master', skills: n.skills || [] };
      }),
      edges: edges.map(function(e) { return { from: e.from, to: e.to, fromSide: e.fromSide, toSide: e.toSide }; }),
      meta: meta,
    };
    vscode.postMessage({ type: 'saveSpinDesign', data: data });
    persistState();
  }

  window.addEventListener('message', function(event) {
    var msg = event.data;
    if (msg.type === 'spinSaveResult') {
      if (!msg.success) showToast(__spinT('toast.saveFailed') + (msg.error || __spinT('toast.unknownError')), 'error');
    } else if (msg.type === 'spinDesignData') {
      if (Array.isArray(msg.skills)) {
        __spinAvailableSkills = msg.skills;
      }
      if (msg.data && Array.isArray(msg.data.nodes)) {
        var refreshNodeError = getNodeListError(msg.data.nodes);
        if (refreshNodeError) {
          // 刷新到损坏数据时不覆盖当前画布，直接报错，避免静默变成空列表。
          showToast('刷新数据错误: ' + refreshNodeError, 'error');
        } else {
          nodes = msg.data.nodes.map(function(n) { return { id: n.id, x: n.x, y: n.y, task: n.task || '', criteria: n.criteria || [], role: n.role || 'Master', skills: n.skills || [] }; });
          edges = msg.data.edges || [];
          meta = msg.data.meta || {};
          nextNodeId = nodes.reduce(function(m, n) { return Math.max(m, n.id); }, 0) + 1;
          if (savedState && typeof savedState.nextNodeId === 'number' && savedState.nextNodeId > nextNodeId) {
            nextNodeId = savedState.nextNodeId;
          }
          closeSkillSelector();
          persistState();
          renderAll();
        }
      } else if (skillSelectorNodeId !== null) {
        // 即使没有可用的 spin.json，也刷新技能选择器列表
        renderSkillSelector();
      }
    }
  });

  function showToast(message, type) {
    var el = document.getElementById('toast');
    el.textContent = message;
    el.className = type + ' show';
    clearTimeout(el._timeout);
    el._timeout = setTimeout(function() { el.className = ''; }, 2000);
  }
})();
</script>
</body>
</html>`;
}
