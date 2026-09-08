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
  'toolbar.export': '导出',
  'toolbar.variables': '变量列表',
  'toolbar.save': '保存',
  'toolbar.saveNotDag': '未构成无环有向图（DAG）',
  'toolbar.saveEmptyNode': '存在空节点（缺少任务描述）',
  'editor.placeholder': '输入任务描述...',
  'toast.noResults': '没有结果需要清除',
  'toast.edgeExists': '该连线已存在',
  'toast.cannotSelfConnect': '不能连接到自身',
  'node.done': '已完成',
  'node.deleteTitle': '删除节点',
  'node.delete': '删除',
  'node.taskLabel': '任务描述',
  'node.taskPlaceholder': '点击输入任务描述...',
  'node.titlePlaceholder': '双击添加标题...',
  'node.criteriaLabel': '验收标准',
  'node.addCriteria': '+ 添加验收标准',
  'node.criteriaPlaceholder': '验收标准 {n}...',
  'node.connectTitle': '拖拽创建连线',
  'node.skillsLabel': '所需技能',
  'node.addSkills': '+ 选择技能',
  'node.skillsPlaceholder': '未选择技能',
  'node.skillSelectorTitle': '选择该节点需要加载的 Skill',
  'node.skillSelectorClose': '关闭',
  'node.menuTitle': '节点操作',
  'node.markDone': '标记为已完成',
  'node.clearDone': '清除已完成标记',
  'node.duplicate': '复制',
  'node.rolloutLabel': '执行次数',
  'node.rolloutMinus': '减少执行次数',
  'node.rolloutPlus': '增加执行次数',
  'node.rolloutHint': '每次执行会提供不同的 ${ROLLOUT_ID}（从 0 开始）',
  'node.forEachLabel': 'For Each',
  'node.forEachPlaceholder': '不遍历',
  'node.forEachHint': '按该变量每行执行，${LINE} 为当前行',
  'toolbar.saveForEachVarMissing': '节点 {id}: For Each 变量 "{name}" 不存在',
  'toolbar.saveBuiltinVarConflict': '变量名与内置变量冲突: {names}',
  'toast.saveFailed': '保存失败: ',
  'toast.exportSuccess': '已导出到 {path}',
  'toast.exportFailed': '导出失败: ',
  'toast.unknownError': '未知错误',
  'variables.title': '变量定义',
  'variables.add': '+ 添加变量',
  'variables.variablePlaceholder': '变量',
  'variables.valuePlaceholder': '变量值',
  'variables.empty': '暂无变量',
  'variables.delete': '删除变量',
  'variables.editComment': '编辑注释',
  'variables.commentPlaceholder': '输入变量说明...',
  'variables.commentTitle': '编辑变量注释',
  'variables.commentSave': '保存',
  'variables.commentCancel': '取消',
  'variables.duplicate': '变量名重复: ',
  'variables.invalidNameHint': '变量名非法',
  'variables.builtinNameHint': '${ROLLOUT_ID}、${LINE} 是内置变量，不能作为用户变量名',
  'variables.close': '关闭',
  'variables.confirmRename': '共 {count} 次引用，是否替换？',
  'variables.renameYes': '替换',
  'variables.renameNo': '不替换',
};

const spinEnDict: Record<string, string> = {
  'app.title': 'Spin Design',
  'toolbar.addNode': '+ Add Node',
  'toolbar.clearResults': 'Clear Results',
  'toolbar.refresh': 'Refresh',
  'toolbar.export': 'Export',
  'toolbar.variables': 'Variable List',
  'toolbar.save': 'Save',
  'toolbar.saveNotDag': 'Not a directed acyclic graph (DAG)',
  'toolbar.saveEmptyNode': 'Contains empty nodes (missing task description)',
  'editor.placeholder': 'Enter task description...',
  'toast.noResults': 'No results to clear',
  'toast.edgeExists': 'Connection already exists',
  'toast.cannotSelfConnect': 'Cannot connect to itself',
  'node.done': 'Done',
  'node.deleteTitle': 'Delete node',
  'node.delete': 'Delete',
  'node.taskLabel': 'Task Description',
  'node.taskPlaceholder': 'Click to enter task description...',
  'node.titlePlaceholder': 'Double-click to add title...',
  'node.criteriaLabel': 'Acceptance Criteria',
  'node.addCriteria': '+ Add Acceptance Criteria',
  'node.criteriaPlaceholder': 'Acceptance Criteria {n}...',
  'node.connectTitle': 'Drag to create connection',
  'node.skillsLabel': 'Skills',
  'node.addSkills': '+ Select Skills',
  'node.skillsPlaceholder': 'No skills selected',
  'node.skillSelectorTitle': 'Select skills to load for this node',
  'node.skillSelectorClose': 'Close',
  'node.menuTitle': 'Node Actions',
  'node.markDone': 'Mark as Done',
  'node.clearDone': 'Clear Done Mark',
  'node.duplicate': 'Duplicate',
  'node.rolloutLabel': 'Rollout',
  'node.rolloutMinus': 'Decrease rollout',
  'node.rolloutPlus': 'Increase rollout',
  'node.rolloutHint': 'Each run provides a different ${ROLLOUT_ID} (starting at 0)',
  'node.forEachLabel': 'For Each',
  'node.forEachPlaceholder': 'None',
  'node.forEachHint': 'Executes once per line of this variable; ${LINE} is the current line',
  'toolbar.saveForEachVarMissing': 'Node {id}: For Each variable "{name}" does not exist',
  'toolbar.saveBuiltinVarConflict': 'Variable name conflicts with built-in variable: {names}',
  'toast.saveFailed': 'Save failed: ',
  'toast.exportSuccess': 'Exported to {path}',
  'toast.exportFailed': 'Export failed: ',
  'toast.unknownError': 'Unknown error',
  'variables.title': 'Variable Definitions',
  'variables.add': '+ Add Variable',
  'variables.variablePlaceholder': 'Variable',
  'variables.valuePlaceholder': 'Value',
  'variables.empty': 'No variables',
  'variables.delete': 'Delete variable',
  'variables.editComment': 'Edit Comment',
  'variables.commentPlaceholder': 'Enter variable description...',
  'variables.commentTitle': 'Edit Variable Comment',
  'variables.commentSave': 'Save',
  'variables.commentCancel': 'Cancel',
  'variables.duplicate': 'Duplicate variable name: ',
  'variables.invalidNameHint': 'Invalid variable name',
  'variables.builtinNameHint': '${ROLLOUT_ID} and ${LINE} are built-in variables and cannot be used as user variable names',
  'variables.close': 'Close',
  'variables.confirmRename': '{count} reference(s) found. Replace?',
  'variables.renameYes': 'Replace',
  'variables.renameNo': "Don't Replace",
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
  #main { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
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
  .node-header .node-title {
    flex: 1 1 0; min-width: 0;
    font-size: 11px; font-weight: 500; color: ${c.mute};
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    cursor: text;
  }
  .node-header .node-title.empty {
    color: ${c.ph};
    font-style: italic;
  }
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
  #node-menu-overlay { position: fixed; z-index: 9998; display: none; }
  #node-menu-overlay.show { display: block; }
  #node-menu-box {
    background: ${c.toolBg}; border: 1px solid ${c.btnBdr}; border-radius: 8px;
    padding: 4px; min-width: 160px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.35);
  }
  .node-menu-item {
    display: block; width: 100%; text-align: left;
    padding: 6px 10px; border: none; background: transparent;
    color: ${c.fg}; font-size: 12px; cursor: pointer;
    border-radius: 5px; white-space: nowrap;
  }
  .node-menu-item:hover { background: ${c.btnHvr}; }
  .node-menu-section {
    margin-top: 4px; padding-top: 4px;
    border-top: 1px solid ${c.btnBdr};
  }
  .node-menu-label {
    display: block; padding: 2px 10px 4px;
    font-size: 11px; color: ${c.mute};
  }
  .rollout-stepper {
    display: flex; align-items: center; justify-content: center; gap: 4px;
    padding: 0 10px;
  }
  .rollout-btn {
    width: 24px; height: 22px; flex-shrink: 0;
    border: 1px solid ${c.btnBdr}; border-radius: 4px;
    background: transparent; color: ${c.btnTxt};
    font-size: 14px; line-height: 1; cursor: pointer; text-align: center;
    transition: all 0.12s;
  }
  .rollout-btn:hover { background: ${c.btnHvr}; border-color: #6366f1; }
  .rollout-input {
    width: 64px; height: 22px;
    border: 1px solid ${c.ndBdr}; border-radius: 4px;
    background: ${c.inpBg}; color: ${c.fg};
    font-size: 12px; text-align: center; outline: none;
    -moz-appearance: textfield;
  }
  .rollout-input::-webkit-outer-spin-button,
  .rollout-input::-webkit-inner-spin-button {
    -webkit-appearance: none; margin: 0;
  }
  .rollout-input:focus { border-color: #6366f1; }
  .rollout-hint {
    padding: 4px 10px 6px;
    font-size: 10px; line-height: 1.4; color: ${c.mute};
  }
  .for-each-row { padding: 0 10px; }
  .for-each-input {
    width: 100%; height: 26px;
    padding: 2px 6px;
    border: 1px solid ${c.ndBdr}; border-radius: 4px;
    background: ${c.inpBg}; color: ${c.fg};
    font-size: 12px; outline: none; cursor: pointer;
  }
  .for-each-input:focus { border-color: #6366f1; }
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
  #variables-sidebar {
    flex: 0 0 40%; display: flex; flex-direction: column;
    background: ${c.toolBg}; border-top: 1px solid ${c.toolBdr};
    overflow: hidden;
  }
  #variables-sidebar.hidden { display: none; }
  .variables-header {
    display: flex; align-items: center; gap: 6px;
    padding: 8px 10px; border-bottom: 1px solid ${c.toolBdr};
    font-size: 13px; font-weight: 600; color: ${c.fg};
  }
  .variables-header .close-btn {
    margin-left: auto; width: 22px; height: 22px;
    border: 1px solid ${c.btnBdr}; border-radius: 4px;
    background: transparent; color: ${c.mute}; cursor: pointer;
    font-size: 14px; line-height: 1;
  }
  .variables-header .close-btn:hover { background: ${c.btnHvr}; color: ${c.fg}; }
  #variables-list { flex: 1; min-height: 0; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
  .variables-empty {
    padding: 12px 6px; font-size: 12px; color: ${c.ph}; font-style: italic; text-align: center;
  }
  .variables-row { display: flex; flex-wrap: wrap; gap: 4px; align-items: flex-start; }
  .variables-row input {
    flex: 1; min-width: 0; height: 26px; padding: 3px 6px;
    border-radius: 4px; border: 1px solid ${c.ndBdr};
    background: ${c.inpBg}; color: ${c.fg}; font-size: 12px;
    outline: none; transition: border-color 0.12s;
  }
  .variables-row .variable-key-input { flex: 0 0 300px; }
  /* 变量值输入框跟随内容自适应高度：最多 3 行，超出后滚动，不允许手动拖拽缩放 */
  .variables-row .variable-value-input {
    flex: 1 1 auto; min-width: 200px;
    height: 26px; min-height: 26px;
    padding: 3px 6px;
    border: 1px solid ${c.ndBdr}; border-radius: 4px;
    background: ${c.inpBg}; color: ${c.fg};
    font-size: 12px; line-height: 1.4;
    font-family: inherit; resize: none;
    overflow-y: hidden;
    outline: none; transition: border-color 0.12s;
  }
  .variables-row input:focus,
  .variables-row textarea:focus { border-color: #6366f1; }
  .variables-row .variable-key-input.invalid,
  .variables-row .variable-key-input.invalid:focus { border-color: #ef4444; }
  .variables-row .field-error {
    flex-basis: 100%; display: none; color: #ef4444;
    font-size: 11px; padding: 2px 2px 0; line-height: 1.3;
  }
  .variables-row .field-error.show { display: block; }
  .variables-row .variable-comment {
    flex-basis: 100%;
    margin: 2px 0;
    padding: 4px 6px;
    border-left: 2px solid #6366f1;
    border-radius: 3px;
    background: rgba(99,102,241,0.1);
    color: ${c.fg};
    font-size: 11px;
    line-height: 1.4;
    word-break: break-word;
    white-space: pre-wrap;
  }
  .variables-row .comment-btn {
    height: 26px; flex-shrink: 0;
    padding: 0 6px;
    border: 1px solid ${c.btnBdr}; border-radius: 4px;
    background: transparent; color: ${c.mute};
    cursor: pointer; font-size: 11px;
  }
  .variables-row .comment-btn:hover {
    background: ${c.btnHvr}; color: ${c.fg}; border-color: #6366f1;
  }
  .variables-row .del-btn {
    width: 24px; height: 26px; flex-shrink: 0;
    border: none; background: transparent; color: ${c.mute};
    cursor: pointer; font-size: 14px; border-radius: 4px;
  }
  .variables-row .del-btn:hover { background: rgba(239,68,68,0.2); color: #ef4444; }
  #btnAddVariable {
    display: block; width: 100%; margin-top: 6px; padding: 5px 10px; border-radius: 5px;
    border: 1px dashed ${c.btnBdr}; background: transparent; color: ${c.btnTxt};
    font-size: 12px; cursor: pointer; text-align: center;
  }
  #btnAddVariable:hover { border-color: #6366f1; color: ${c.fg}; }
  #var-autocomplete {
    position: fixed; z-index: 10000; display: none;
    background: ${c.toolBg}; border: 1px solid ${c.btnBdr};
    border-radius: 6px; box-shadow: 0 4px 16px rgba(0,0,0,0.35);
    overflow-y: auto; max-height: 200px; padding: 4px;
  }
  #var-autocomplete.show { display: block; }
  .var-ac-item {
    padding: 5px 8px; border-radius: 4px; font-size: 12px;
    color: ${c.fg}; cursor: pointer; white-space: nowrap;
  }
  .var-ac-item:hover { background: ${c.btnHvr}; }
  .var-ac-item.active { background: #6366f1; color: #fff; }
  #rename-confirm-overlay {
    position: fixed; inset: 0; z-index: 10001; display: none;
    background: rgba(0,0,0,0.35); align-items: center; justify-content: center;
  }
  #rename-confirm-overlay.show { display: flex; }
  #rename-confirm-box {
    min-width: 280px; max-width: 90vw; padding: 16px;
    background: ${c.toolBg}; border: 1px solid ${c.btnBdr}; border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
  }
  #rename-confirm-text {
    font-size: 13px; color: ${c.fg}; line-height: 1.5; margin-bottom: 14px;
    word-break: break-word;
  }
  #rename-confirm-actions {
    display: flex; justify-content: flex-end; gap: 8px;
  }
  #rename-confirm-box .btn {
    padding: 5px 12px; border-radius: 5px; border: 1px solid ${c.btnBdr};
    background: transparent; color: ${c.btnTxt}; font-size: 12px; cursor: pointer;
    transition: all 0.15s;
  }
  #rename-confirm-box .btn:hover { background: ${c.btnHvr}; border-color: #6366f1; }
  #rename-confirm-box .btn.primary { background: #6366f1; border-color: #6366f1; color: #fff; }
  #rename-confirm-box .btn.primary:hover { background: #5558e6; }
  #comment-editor-overlay {
    position: fixed; inset: 0; z-index: 10002; display: none;
    background: rgba(0,0,0,0.35); align-items: center; justify-content: center;
  }
  #comment-editor-overlay.show { display: flex; }
  #comment-editor-box {
    min-width: 320px; max-width: 90vw; padding: 16px;
    background: ${c.toolBg}; border: 1px solid ${c.btnBdr}; border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
  }
  #comment-editor-title {
    font-size: 13px; font-weight: 600; color: ${c.fg}; margin-bottom: 10px;
  }
  #comment-editor-textarea {
    width: 100%; min-height: 80px; padding: 6px 8px;
    border-radius: 5px; border: 1px solid ${c.btnBdr};
    background: ${c.inpBg}; color: ${c.fg}; font-size: 12px;
    outline: none; resize: vertical; box-sizing: border-box;
  }
  #comment-editor-textarea:focus { border-color: #6366f1; }
  #comment-editor-actions {
    display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px;
  }
  #comment-editor-actions .btn {
    padding: 5px 12px; border-radius: 5px; border: 1px solid ${c.btnBdr};
    background: transparent; color: ${c.btnTxt}; font-size: 12px; cursor: pointer;
    transition: all 0.15s;
  }
  #comment-editor-actions .btn:hover { background: ${c.btnHvr}; border-color: #6366f1; }
  #comment-editor-actions .btn.primary { background: #6366f1; border-color: #6366f1; color: #fff; }
  #comment-editor-actions .btn.primary:hover { background: #5558e6; }
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
    <button class="btn" id="btnToggleVariables">${t('toolbar.variables')}</button>
    <button class="btn" id="btnExport">${t('toolbar.export')}</button>
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
    <div id="variables-sidebar" class="hidden">
      <div class="variables-header">
        <span>${t('variables.title')}</span>
        <button class="close-btn" id="btnCloseVariables" title="${t('variables.close')}">&times;</button>
      </div>
      <div id="variables-list"></div>
    </div>
  </div>
  <div id="var-autocomplete"></div>
  <div id="rename-confirm-overlay">
    <div id="rename-confirm-box">
      <div id="rename-confirm-text"></div>
      <div id="rename-confirm-actions">
        <button class="btn" id="btnRenameConfirmNo">${t('variables.renameNo')}</button>
        <button class="btn primary" id="btnRenameConfirmYes">${t('variables.renameYes')}</button>
      </div>
    </div>
  </div>
  <div id="comment-editor-overlay">
    <div id="comment-editor-box">
      <div id="comment-editor-title">${t('variables.commentTitle')}</div>
      <textarea id="comment-editor-textarea" placeholder="${t('variables.commentPlaceholder')}"></textarea>
      <div id="comment-editor-actions">
        <button class="btn" id="btnCommentCancel">${t('variables.commentCancel')}</button>
        <button class="btn primary" id="btnCommentSave">${t('variables.commentSave')}</button>
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
  <div id="node-menu-overlay">
    <div id="node-menu-box"></div>
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
  let variables = [];
  let selectedNodeId = null;
  let dragState = null;
  let connectFrom = null;
  let connectLine = null;
  let nextNodeId = 1;

  const vscode = acquireVsCodeApi();
  var _isDark = ${isDark};

  const initialData = ${initialData};
  var __spinAvailableSkills = ${availableSkillsJson};

  function variablesFromData(data) {
    if (!data || !data.variables) return [];
    var comments = (data.variableComments && typeof data.variableComments === 'object') ? data.variableComments : {};
    if (Array.isArray(data.variables)) {
      return data.variables.map(function(v) {
        var key = String((v && v.key) || '');
        return {
          key: key,
          value: String((v && v.value) || ''),
          comment: (v && typeof v.comment === 'string') ? v.comment : (Object.prototype.hasOwnProperty.call(comments, key) ? String(comments[key]) : '')
        };
      }).filter(function(v) { return v.key.trim() !== ''; });
    }
    if (typeof data.variables === 'object') {
      return Object.keys(data.variables).map(function(k) {
        return { key: k, value: String(data.variables[k] || ''), comment: Object.prototype.hasOwnProperty.call(comments, k) ? String(comments[k]) : '' };
      });
    }
    return [];
  }

  function variablesToObject() {
    var obj = {};
    var seen = {};
    variables.forEach(function(v) {
      var key = (v.key || '').trim();
      if (key && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !seen[key]) {
        seen[key] = true;
        Object.defineProperty(obj, key, {
          value: v.value || '',
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    });
    return obj;
  }

  function variablesCommentsToObject() {
    var obj = {};
    variables.forEach(function(v) {
      var key = (v.key || '').trim();
      var comment = (v.comment || '').trim();
      if (key && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && comment) {
        Object.defineProperty(obj, key, {
          value: comment,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    });
    return obj;
  }

  function normalizeRolloutValue(value) {
    var n = Number(value);
    if (Number.isInteger(n) && n >= 1) return n;
    return 1;
  }

  function normalizeForEachValue(value) {
    return (typeof value === 'string' && value.trim() !== '') ? value.trim() : undefined;
  }

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
      nodes = initialData.nodes.map(function(n) { return { id: n.id, x: n.x, y: n.y, task: n.task || '', criteria: n.criteria || [], rollout: normalizeRolloutValue(n.rollout), forEach: normalizeForEachValue(n.forEach), role: 'Master', skills: n.skills || [], title: (typeof n.title === 'string' && n.title.trim() !== '') ? n.title : undefined }; });
      edges = initialData.edges || [];
      meta = initialData.meta || {};
      variables = variablesFromData(initialData);
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
      nodes = savedState.nodes.map(function(n) { return { id: n.id, x: n.x, y: n.y, task: n.task || '', criteria: n.criteria || [], rollout: normalizeRolloutValue(n.rollout), forEach: normalizeForEachValue(n.forEach), role: 'Master', skills: n.skills || [], title: (typeof n.title === 'string' && n.title.trim() !== '') ? n.title : undefined }; });
      edges = savedState.edges || [];
      meta = savedState.meta || {};
      variables = variablesFromData(savedState);
      nextNodeId = savedState.nextNodeId || (nodes.reduce(function(m, n) { return Math.max(m, n.id); }, 0) + 1);
      renderAll();
    }
  }

  document.getElementById('btnAddNode').addEventListener('click', function() { addNode(); });
  document.getElementById('btnClearResults').addEventListener('click', function() { clearResults(); });
  document.getElementById('btnRefresh').addEventListener('click', function() { refreshDesign(); });
  document.getElementById('btnExport').addEventListener('click', function() { exportDesign(); });
  document.getElementById('btnToggleVariables').addEventListener('click', function() { toggleVariablesSidebar(); });
  document.getElementById('btnCloseVariables').addEventListener('click', function() { toggleVariablesSidebar(false); });
  document.getElementById('btnRenameConfirmYes').addEventListener('click', function() { closeRenameConfirm(true); });
  document.getElementById('btnRenameConfirmNo').addEventListener('click', function() { closeRenameConfirm(false); });
  document.getElementById('btnCommentSave').addEventListener('click', function() { closeCommentEditor(true); });
  document.getElementById('btnCommentCancel').addEventListener('click', function() { closeCommentEditor(false); });
  window.addEventListener('keydown', function(e) {
    if (renameConfirmOverlay.className === 'show' && e.key === 'Escape') {
      e.preventDefault();
      closeRenameConfirm(false);
    } else if (commentEditorOverlay.className === 'show' && e.key === 'Escape') {
      e.preventDefault();
      closeCommentEditor(false);
    }
  });
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
    saveDesign();
    if (!hadResults) { showToast(__spinT('toast.noResults'), 'info'); }
  }

  function refreshDesign() {
    // 请求扩展端重新读取 spin.json 与 Skill 列表，并回传最新数据
    vscode.postMessage({ type: 'refreshSpinDesign' });
  }

  function toggleVariablesSidebar(forceOpen) {
    var sidebar = document.getElementById('variables-sidebar');
    var open = typeof forceOpen === 'boolean' ? forceOpen : sidebar.classList.contains('hidden');
    sidebar.classList.toggle('hidden', !open);
    if (open) renderVariables();
  }

  function addVariable() {
    variables.push({ key: '', value: '', comment: '' });
    renderVariables();
    var rows = document.querySelectorAll('#variables-list .variables-row');
    var last = rows[rows.length - 1];
    if (last) {
      var input = last.querySelector('input');
      if (input) input.focus();
    }
  }

  function renderVariables() {
    var list = document.getElementById('variables-list');
    list.innerHTML = '';
    if (variables.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'variables-empty';
      empty.textContent = __spinT('variables.empty');
      list.appendChild(empty);
    } else {
      variables.forEach(function(v, idx) {
        var row = createVariableRow(v, idx);
        list.appendChild(row);
        var valueInput = row.querySelector('.variable-value-input');
        if (valueInput) autoSizeVariableValue(valueInput);
      });
    }
    // 添加按钮放在已有变量下面，而不是固定在侧边栏底部
    var addBtn = document.createElement('button');
    addBtn.className = 'btn';
    addBtn.id = 'btnAddVariable';
    addBtn.textContent = __spinT('variables.add');
    addBtn.addEventListener('click', function() { addVariable(); });
    list.appendChild(addBtn);
  }

  // 变量值输入框最多 3 行：内容不足时收缩，超过 3 行后显示滚动条
  function autoSizeVariableValue(el) {
    var cs = window.getComputedStyle(el);
    var lineHeight = parseFloat(cs.lineHeight);
    if (!lineHeight || lineHeight <= 0) {
      lineHeight = parseFloat(cs.fontSize) * 1.4;
    }
    var padding = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    var border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    var maxHeight = Math.ceil(lineHeight * 3 + padding + border);
    // 先归零高度再读取 scrollHeight，确保内容减少时也能收缩
    el.style.minHeight = '0';
    el.style.height = '0px';
    var contentHeight = el.scrollHeight + border;
    el.style.minHeight = '';
    el.style.height = Math.min(contentHeight, maxHeight) + 'px';
    el.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
  }

  function createVariableRow(v, idx) {
    var row = document.createElement('div');
    row.className = 'variables-row';

    var commentEl = null;
    var commentText = (v.comment || '').trim();
    if (commentText) {
      commentEl = document.createElement('div');
      commentEl.className = 'variable-comment';
      commentEl.textContent = commentText;
      commentEl.title = commentText;
    }

    var keyInput = document.createElement('input');
    keyInput.className = 'variable-key-input';
    keyInput.value = v.key;
    keyInput.placeholder = __spinT('variables.variablePlaceholder');
    keyInput.spellcheck = false;
    keyInput._oldKey = v.key;
    var errorEl = document.createElement('div');
    errorEl.className = 'field-error';
    keyInput.addEventListener('input', function() {
      v.key = keyInput.value;
      persistState();
      updateVariableKeyValidation(v, idx, keyInput, errorEl);
      revalidateDesign();
    });
    keyInput.addEventListener('blur', function() {
      normalizeVariableKey(v, idx, keyInput, errorEl);
    });
    keyInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        keyInput.blur();
      }
    });

    var valueInput = document.createElement('textarea');
    valueInput.className = 'variable-value-input';
    valueInput.value = v.value;
    valueInput.placeholder = __spinT('variables.valuePlaceholder');
    valueInput.spellcheck = false;
    valueInput.addEventListener('input', function() {
      v.value = valueInput.value;
      autoSizeVariableValue(valueInput);
      persistState();
    });
    valueInput.addEventListener('blur', function() {
      saveDesign();
    });

    var commentBtn = document.createElement('button');
    commentBtn.className = 'comment-btn';
    commentBtn.textContent = __spinT('variables.editComment');
    commentBtn.title = __spinT('variables.editComment');
    commentBtn.addEventListener('click', function() {
      openCommentEditor(idx);
    });

    var delBtn = document.createElement('button');
    delBtn.className = 'del-btn';
    delBtn.textContent = '\u00D7';
    delBtn.title = __spinT('variables.delete');
    delBtn.addEventListener('click', function() {
      variables.splice(idx, 1);
      renderVariables();
      persistState();
      saveDesign();
      revalidateDesign();
    });

    if (commentEl) row.appendChild(commentEl);
    row.appendChild(keyInput);
    row.appendChild(valueInput);
    row.appendChild(commentBtn);
    row.appendChild(delBtn);
    row.appendChild(errorEl);
    return row;
  }

  function validateVariableKey(v, idx) {
    var key = (v.key || '').trim();
    if (key && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return { valid: false, message: __spinT('variables.invalidNameHint') };
    }
    if (key === 'ROLLOUT_ID' || key === 'LINE') {
      return { valid: false, message: __spinT('variables.builtinNameHint') };
    }
    if (key) {
      var dup = variables.some(function(other, i) {
        return i !== idx && (other.key || '').trim() === key;
      });
      if (dup) {
        return { valid: false, message: __spinT('variables.duplicate') + key };
      }
    }
    return { valid: true, message: '' };
  }

  function updateVariableKeyValidation(v, idx, input, errorEl) {
    var result = validateVariableKey(v, idx);
    input.classList.toggle('invalid', !result.valid);
    errorEl.textContent = result.message;
    errorEl.classList.toggle('show', !result.valid);
    return result.valid;
  }

  function normalizeVariableKey(v, idx, input, errorEl) {
    var oldKey = (input._oldKey || '').trim();
    var key = (v.key || '').trim();
    v.key = key;
    input.value = key;
    persistState();
    var valid = updateVariableKeyValidation(v, idx, input, errorEl);
    if (!valid) return false;
    if (oldKey && key && oldKey !== key) {
      input._oldKey = key;
      var refCount = countVariableReferences(oldKey);
      if (refCount > 0) {
        confirmRenameVariable(oldKey, key, refCount);
      } else {
        saveDesign();
        revalidateDesign();
      }
    } else {
      saveDesign();
      revalidateDesign();
    }
    return true;
  }

  var renameConfirmOverlay = document.getElementById('rename-confirm-overlay');
  var renameConfirmText = document.getElementById('rename-confirm-text');
  var renameConfirmCallback = null;

  function confirmRenameVariable(oldKey, newKey, refCount) {
    renameConfirmText.textContent = __spinT('variables.confirmRename', { count: refCount });
    renameConfirmCallback = function(update) {
      if (update) {
        replaceVariableReferences(oldKey, newKey);
        renderAll();
      }
      saveDesign();
    };
    renameConfirmOverlay.className = 'show';
  }

  function closeRenameConfirm(update) {
    renameConfirmOverlay.className = '';
    var cb = renameConfirmCallback;
    renameConfirmCallback = null;
    if (cb) cb(update);
  }

  var commentEditorOverlay = document.getElementById('comment-editor-overlay');
  var commentEditorTextarea = document.getElementById('comment-editor-textarea');
  var commentEditorIdx = null;

  function openCommentEditor(idx) {
    var v = variables[idx];
    if (!v) return;
    commentEditorIdx = idx;
    commentEditorTextarea.value = (v.comment || '');
    commentEditorOverlay.className = 'show';
    commentEditorTextarea.focus();
  }

  function closeCommentEditor(save) {
    if (commentEditorIdx === null) return;
    var v = variables[commentEditorIdx];
    if (save && v) {
      v.comment = commentEditorTextarea.value;
      persistState();
      renderVariables();
      saveDesign();
    }
    commentEditorOverlay.className = '';
    commentEditorIdx = null;
  }

  function countVariableReferencesInText(text, oldKey) {
    var s = text || '';
    var needle = '\${' + oldKey + '}';
    var count = 0;
    var i = 0;
    while (i < s.length) {
      if (s.charAt(i) === '$' && s.charAt(i + 1) === '$') {
        // $$ 是字面量 $ 的转义，不把它后面的内容当作变量引用
        i += 2;
      } else if (s.substr(i, needle.length) === needle) {
        count++;
        i += needle.length;
      } else {
        i++;
      }
    }
    return count;
  }

  function countVariableReferences(oldKey) {
    var count = 0;
    nodes.forEach(function(node) {
      count += countVariableReferencesInText(node.task, oldKey);
      (node.criteria || []).forEach(function(c) {
        count += countVariableReferencesInText(c, oldKey);
      });
      if (normalizeForEachValue(node.forEach) === oldKey) count++;
    });
    return count;
  }

  function replaceVariableReferencesInText(text, oldKey, newKey) {
    var s = text || '';
    var needle = '\${' + oldKey + '}';
    var replacement = newKey ? '\${' + newKey + '}' : '';
    var out = '';
    var i = 0;
    while (i < s.length) {
      if (s.charAt(i) === '$' && s.charAt(i + 1) === '$') {
        // $$ 是字面量 $ 的转义，不把它后面的内容当作变量引用
        out += '$$';
        i += 2;
      } else if (s.substr(i, needle.length) === needle) {
        out += replacement;
        i += needle.length;
      } else {
        out += s.charAt(i);
        i++;
      }
    }
    return out;
  }

  function replaceVariableReferences(oldKey, newKey) {
    var count = 0;
    nodes.forEach(function(node) {
      var newTask = replaceVariableReferencesInText(node.task, oldKey, newKey);
      if (newTask !== node.task) {
        node.task = newTask;
        count++;
      }
      node.criteria = (node.criteria || []).map(function(c) {
        var newC = replaceVariableReferencesInText(c, oldKey, newKey);
        if (newC !== c) count++;
        return newC;
      });
      if (normalizeForEachValue(node.forEach) === oldKey) {
        node.forEach = newKey || undefined;
        count++;
      }
    });
    return count;
  }

  var canvasArea = document.getElementById('canvas-area');

  // Floating editor
  var teOverlay = document.getElementById('task-editor-overlay');
  var teTextarea = document.getElementById('te-textarea');
  var teContext = null;
  var skillSelectorNodeId = null;
  var varAcEl = document.getElementById('var-autocomplete');
  var varAcItems = [];
  var varAcIndex = -1;

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
    if (context.type === 'title') {
      teTextarea.value = node.title || '';
      teTextarea.placeholder = __spinT('node.titlePlaceholder');
    } else {
      teTextarea.value = context.type === 'task' ? (node.task || '') : (node.criteria[context.idx] || '');
      teTextarea.placeholder = __spinT('editor.placeholder');
    }
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
    teTextarea.style.minHeight = Math.max(context.type === 'title' ? 40 : 80, r.height) + 'px';
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
        if (teContext.type === 'title') {
          var newTitle = teTextarea.value.trim();
          var normalizedTitle = newTitle !== '' ? newTitle : undefined;
          if ((node.title || '') !== (normalizedTitle || '')) {
            node.title = normalizedTitle;
            changed = true;
          }
        } else if (teContext.type === 'task' && node.task !== teTextarea.value) {
          node.task = teTextarea.value;
          changed = true;
        } else if (teContext.type === 'criteria' && node.criteria[teContext.idx] !== teTextarea.value) {
          node.criteria[teContext.idx] = teTextarea.value;
          changed = true;
        }
        renderNode(teContext.nodeId);
        persistState();
        if (changed) saveDesign();
      }
    }
    teOverlay.className = '';
    teContext = null;
    closeVarAutocomplete();
  }

  function getVarPrefixAtCaret() {
    var text = teTextarea.value.substring(0, teTextarea.selectionStart);
    var idx = text.lastIndexOf('\${');
    if (idx === -1) return null;
    // $$ 转义为字面量 $，\${ 不触发自动补全
    if (idx > 0 && text.charAt(idx - 1) === '$') return null;
    var after = text.substring(idx + 2);
    if (after === '') return { prefix: '', start: idx };
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(after)) return null;
    return { prefix: after, start: idx };
  }

  function getVariableKeyList(node) {
    var keys = [];
    var seen = {};
    variables.forEach(function(v) {
      var key = (v.key || '').trim();
      if (key && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !seen[key]) {
        seen[key] = true;
        keys.push(key);
      }
    });
    // 内置变量只在对应功能开启时提示：
    // - \${ROLLOUT_ID}：节点执行次数 rollout > 1
    // - \${LINE}：节点配置了 For Each
    if (node && normalizeRolloutValue(node.rollout) > 1 && !seen['ROLLOUT_ID']) {
      seen['ROLLOUT_ID'] = true;
      keys.push('ROLLOUT_ID');
    }
    if (node && normalizeForEachValue(node.forEach) && !seen['LINE']) {
      seen['LINE'] = true;
      keys.push('LINE');
    }
    return keys;
  }

  function updateVarAutocomplete() {
    if (!teContext || teContext.type === 'title') { closeVarAutocomplete(); return; }
    var info = getVarPrefixAtCaret();
    if (!info) { closeVarAutocomplete(); return; }
    var prefix = info.prefix;
    var node = getNode(teContext.nodeId);
    var matches = getVariableKeyList(node).filter(function(key) {
      return key.indexOf(prefix) === 0;
    }).sort();
    if (matches.length === 0) { closeVarAutocomplete(); return; }
    renderVarAutocomplete(matches);
  }

  function renderVarAutocomplete(matches) {
    varAcItems = matches;
    varAcIndex = 0;
    varAcEl.innerHTML = '';
    matches.forEach(function(key, i) {
      var item = document.createElement('div');
      item.className = 'var-ac-item' + (i === 0 ? ' active' : '');
      item.textContent = '\${' + key + '}';
      item.addEventListener('mousedown', function(e) {
        e.preventDefault();
        e.stopPropagation();
        selectVarAutocomplete(key);
      });
      varAcEl.appendChild(item);
    });
    var r = teTextarea.getBoundingClientRect();
    varAcEl.style.left = r.left + 'px';
    varAcEl.style.top = (r.bottom + 2) + 'px';
    varAcEl.style.minWidth = Math.max(180, r.width) + 'px';
    varAcEl.className = 'show';
  }

  function moveVarAc(delta) {
    if (varAcItems.length === 0) return;
    varAcIndex = (varAcIndex + delta + varAcItems.length) % varAcItems.length;
    Array.prototype.forEach.call(varAcEl.children, function(child, i) {
      child.classList.toggle('active', i === varAcIndex);
    });
  }

  function selectVarAutocomplete(key) {
    var info = getVarPrefixAtCaret();
    if (!info) return;
    var value = teTextarea.value;
    var before = value.substring(0, info.start);
    var after = value.substring(teTextarea.selectionStart);
    var inserted = '\${' + key + '}';
    teTextarea.value = before + inserted + after;
    var pos = before.length + inserted.length;
    teTextarea.selectionStart = pos;
    teTextarea.selectionEnd = pos;
    closeVarAutocomplete();
    teTextarea.focus();
    teTextarea.dispatchEvent(new Event('input'));
    closeVarAutocomplete();
  }

  function closeVarAutocomplete() {
    varAcEl.className = '';
    varAcItems = [];
    varAcIndex = -1;
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

  var nodeMenuOverlay = document.getElementById('node-menu-overlay');
  var nodeMenuBox = document.getElementById('node-menu-box');

  function parseRolloutInput(raw) {
    var n = Math.trunc(Number(raw));
    return isNaN(n) ? NaN : n;
  }

  function commitRolloutInput(nodeId, inputEl) {
    var node = getNode(nodeId);
    if (!node) return;
    var parsed = parseRolloutInput(inputEl.value);
    var next = (!isNaN(parsed) && parsed >= 1) ? parsed : 1;
    if (inputEl.value !== String(next)) inputEl.value = String(next);
    if (node.rollout !== next) {
      node.rollout = next;
      persistState();
      saveDesign();
      renderNode(nodeId);
    }
  }

  function stepRollout(nodeId, inputEl, delta) {
    var node = getNode(nodeId);
    if (!node) return;
    var parsed = parseRolloutInput(inputEl.value);
    var current = !isNaN(parsed) ? parsed : normalizeRolloutValue(node.rollout);
    var next = Math.max(1, current + delta);
    inputEl.value = String(next);
    if (node.rollout !== next) {
      node.rollout = next;
      persistState();
      saveDesign();
      renderNode(nodeId);
    }
  }

  function appendRolloutControl(container, nodeId) {
    var node = getNode(nodeId);
    if (!node) return;

    var section = document.createElement('div');
    section.className = 'node-menu-section';

    var label = document.createElement('span');
    label.className = 'node-menu-label';
    label.textContent = __spinT('node.rolloutLabel');
    section.appendChild(label);

    var stepper = document.createElement('div');
    stepper.className = 'rollout-stepper';

    var minusBtn = document.createElement('button');
    minusBtn.type = 'button';
    minusBtn.className = 'rollout-btn';
    minusBtn.textContent = '\u2212';
    minusBtn.title = __spinT('node.rolloutMinus');

    var inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.inputMode = 'numeric';
    inputEl.className = 'rollout-input';
    inputEl.value = String(normalizeRolloutValue(node.rollout));

    var plusBtn = document.createElement('button');
    plusBtn.type = 'button';
    plusBtn.className = 'rollout-btn';
    plusBtn.textContent = '+';
    plusBtn.title = __spinT('node.rolloutPlus');

    minusBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      stepRollout(nodeId, inputEl, -1);
    });
    plusBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      stepRollout(nodeId, inputEl, 1);
    });
    inputEl.addEventListener('change', function() {
      commitRolloutInput(nodeId, inputEl);
    });
    inputEl.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitRolloutInput(nodeId, inputEl);
      }
    });

    stepper.appendChild(minusBtn);
    stepper.appendChild(inputEl);
    stepper.appendChild(plusBtn);
    section.appendChild(stepper);

    var hint = document.createElement('div');
    hint.className = 'rollout-hint';
    hint.textContent = __spinT('node.rolloutHint');
    section.appendChild(hint);

    container.appendChild(section);
  }

  function commitForEachInput(nodeId, inputEl) {
    var node = getNode(nodeId);
    if (!node) return;
    var raw = (typeof inputEl.value === 'string') ? inputEl.value.trim() : '';
    var value = raw || undefined;
    if ((node.forEach || '') !== (value || '')) {
      node.forEach = value;
      inputEl.value = raw;
      persistState();
      saveDesign();
      renderNode(nodeId);
    }
  }

  function appendForEachControl(container, nodeId) {
    var node = getNode(nodeId);
    if (!node) return;

    var section = document.createElement('div');
    section.className = 'node-menu-section';

    var label = document.createElement('span');
    label.className = 'node-menu-label';
    label.textContent = __spinT('node.forEachLabel');
    section.appendChild(label);

    var row = document.createElement('div');
    row.className = 'for-each-row';
    var selectEl = document.createElement('select');
    selectEl.className = 'for-each-input';

    var noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = __spinT('node.forEachPlaceholder');
    selectEl.appendChild(noneOpt);

    var current = normalizeForEachValue(node.forEach) || '';
    var hasCurrentOption = false;
    variables.forEach(function(v) {
      var key = (v.key || '').trim();
      if (key && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && key !== 'ROLLOUT_ID' && key !== 'LINE') {
        var opt = document.createElement('option');
        opt.value = key;
        opt.textContent = key;
        selectEl.appendChild(opt);
        if (key === current) hasCurrentOption = true;
      }
    });
    // 保留当前值选项，即使该变量已不存在，方便用户看到并改选其他变量
    if (current && !hasCurrentOption) {
      var missingOpt = document.createElement('option');
      missingOpt.value = current;
      missingOpt.textContent = current;
      selectEl.appendChild(missingOpt);
    }
    selectEl.value = current;
    selectEl.addEventListener('change', function() {
      commitForEachInput(nodeId, selectEl);
    });
    row.appendChild(selectEl);
    section.appendChild(row);

    var hint = document.createElement('div');
    hint.className = 'rollout-hint';
    hint.textContent = __spinT('node.forEachHint');
    section.appendChild(hint);

    container.appendChild(section);
  }

  function openNodeMenu(nodeId, anchorEl) {
    var node = getNode(nodeId);
    if (!node) return;
    selectNode(nodeId);
    nodeMenuBox.innerHTML = '';
    var nodeMeta = meta[String(nodeId)];
    var isDone = !!(nodeMeta && nodeMeta.passed);
    var toggleItem = document.createElement('button');
    toggleItem.className = 'node-menu-item';
    toggleItem.textContent = isDone ? __spinT('node.clearDone') : __spinT('node.markDone');
    toggleItem.addEventListener('click', function(e) {
      e.stopPropagation();
      toggleNodeDone(nodeId);
    });
    nodeMenuBox.appendChild(toggleItem);

    var duplicateItem = document.createElement('button');
    duplicateItem.className = 'node-menu-item';
    duplicateItem.textContent = __spinT('node.duplicate');
    duplicateItem.addEventListener('click', function(e) {
      e.stopPropagation();
      duplicateNode(nodeId);
    });
    nodeMenuBox.appendChild(duplicateItem);

    appendRolloutControl(nodeMenuBox, nodeId);
    appendForEachControl(nodeMenuBox, nodeId);

    var r = anchorEl.getBoundingClientRect();
    nodeMenuOverlay.style.position = 'fixed';
    nodeMenuOverlay.style.top = Math.min(window.innerHeight - 90, Math.max(8, r.bottom + 4)) + 'px';
    nodeMenuOverlay.style.left = Math.min(window.innerWidth - 180, Math.max(8, r.left)) + 'px';
    nodeMenuOverlay.className = 'show';
    var menuHeight = nodeMenuBox.offsetHeight || 160;
    nodeMenuOverlay.style.top = Math.min(window.innerHeight - menuHeight - 8, Math.max(8, r.bottom + 4)) + 'px';
  }

  function closeNodeMenu() {
    nodeMenuOverlay.className = '';
  }

  function toggleNodeDone(nodeId) {
    var key = String(nodeId);
    var nodeMeta = meta[key];
    if (nodeMeta && nodeMeta.passed) {
      // 清除已完成标记：重置 rollout 进度，保证下次执行从头开始
      meta[key] = Object.assign({}, nodeMeta, { passed: false, rolloutPassed: 0, note: '' });
    } else {
      // 标记为已完成：保留已有字段（如 note），并设置 passed
      meta[key] = Object.assign({}, nodeMeta || {}, { passed: true });
    }
    renderNode(nodeId);
    persistState();
    // 完成标记属于 meta-only 修改，不应被结构校验（如临时断开连线）阻塞
    saveDesign();
    closeNodeMenu();
  }

  function duplicateNode(nodeId) {
    var node = getNode(nodeId);
    if (!node) return;
    var newId = nextNodeId++;
    var newNode = {
      id: newId,
      x: node.x + 30,
      y: node.y + 30,
      task: node.task || '',
      criteria: (node.criteria || []).slice(),
      rollout: normalizeRolloutValue(node.rollout),
      forEach: normalizeForEachValue(node.forEach),
      role: 'Master',
      skills: (node.skills || []).slice(),
      title: node.title || undefined
    };
    nodes.push(newNode);
    selectedNodeId = newId;
    renderAll();
    persistState();
    // 复制节点默认不带连线，可能暂时不满足连通性校验；
    // 现在保存不再被非 DAG/非连通等设计校验阻止，直接写入即可。
    saveDesign();
    closeNodeMenu();
    setTimeout(function() {
      var el = document.getElementById('node-' + newId);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    }, 50);
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
    renderNode(nodeId);
    renderSkillSelector();
    persistState();
    saveDesign();
  }

  function removeNodeSkill(nodeId, skillName) {
    var node = getNode(nodeId);
    if (!node) return;
    node.skills = node.skills.filter(function(s) { return s !== skillName; });
    renderNode(nodeId);
    persistState();
    saveDesign();
  }

  document.addEventListener('mousedown', function(e) {
    if (teOverlay.className === 'show' && !teOverlay.contains(e.target) && !varAcEl.contains(e.target)) closeFloatingEditor();
    if (skillSelectorOverlay.className === 'show' && !skillSelectorOverlay.contains(e.target)) closeSkillSelector();
    if (nodeMenuOverlay.className === 'show' && !nodeMenuOverlay.contains(e.target)) closeNodeMenu();
    if (varAcEl.className === 'show' && !varAcEl.contains(e.target)) closeVarAutocomplete();
  });

  teTextarea.addEventListener('input', function() {
    teTextarea.style.height = 'auto';
    var h = teTextarea.scrollHeight;
    var m = teMaxHeight;
    if (h > m) { teTextarea.style.height = m + 'px'; teTextarea.style.overflowY = 'auto'; }
    else { teTextarea.style.height = h + 'px'; teTextarea.style.overflowY = 'hidden'; }
    updateVarAutocomplete();
  });
  var teMaxHeight = 0;

  teTextarea.addEventListener('keydown', function(e) {
    if (varAcEl.className === 'show') {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveVarAc(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveVarAc(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (varAcItems.length > 0 && varAcIndex >= 0) {
          e.preventDefault();
          selectVarAutocomplete(varAcItems[varAcIndex]);
          return;
        }
        if (e.key === 'Tab') closeVarAutocomplete();
      }
      if (e.key === 'Escape') { e.preventDefault(); closeVarAutocomplete(); return; }
    }
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
      if (dragState.ctrlCopy && !dragState.duplicated) {
        if (Math.abs(e.clientX - dragState.startX) < 4 && Math.abs(e.clientY - dragState.startY) < 4) {
          // 尚未真正开始拖动，先不创建副本
        } else {
          var sourceNode = getNode(dragState.sourceNodeId);
          if (sourceNode) {
            var copyId = nextNodeId++;
            var copyNode = {
              id: copyId,
              x: sourceNode.x,
              y: sourceNode.y,
              task: sourceNode.task || '',
              criteria: (sourceNode.criteria || []).slice(),
              rollout: normalizeRolloutValue(sourceNode.rollout),
              forEach: normalizeForEachValue(sourceNode.forEach),
              role: 'Master',
              skills: (sourceNode.skills || []).slice(),
              title: sourceNode.title || undefined
            };
            nodes.push(copyNode);
            dragState.nodeId = copyId;
            dragState.origX = sourceNode.x;
            dragState.origY = sourceNode.y;
            dragState.duplicated = true;
            selectedNodeId = copyId;
            renderAll();
          } else {
            dragState = null;
          }
        }
      }
      if (dragState && dragState.nodeId) {
        var node = getNode(dragState.nodeId);
        if (node) {
          node.x = Math.max(0, dragState.origX + (e.clientX - dragState.startX));
          node.y = Math.max(0, dragState.origY + (e.clientY - dragState.startY));
          updateNodePos(node);
          renderEdges();
        }
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
        return { id: n.id, x: n.x, y: n.y, task: n.task, criteria: n.criteria.filter(function(c) { return c.trim() !== ''; }), rollout: normalizeRolloutValue(n.rollout), forEach: normalizeForEachValue(n.forEach), role: 'Master', skills: n.skills || [], title: n.title || undefined };
      }),
      edges: edges,
      meta: meta,
      variables: variables.slice(),
      nextNodeId: nextNodeId,
    });
  }

  // Node operations
  function addNode() {
    var id = nextNodeId++;
    var area = document.getElementById('canvas-area');
    var x = Math.max(0, area.scrollLeft + area.clientWidth / 2 - 130);
    var y = Math.max(0, area.scrollTop + area.clientHeight / 2 - 100);
    nodes.push({ id: id, x: x, y: y, task: '', criteria: [], rollout: 1, role: 'Master', skills: [], title: undefined });
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
    if (node) { node.criteria.push(''); renderNode(nodeId); persistState(); saveDesign(); }
  }

  function deleteCriteria(nodeId, idx) {
    var node = getNode(nodeId);
    if (node) { node.criteria.splice(idx, 1); renderNode(nodeId); persistState(); saveDesign(); }
  }

  function addEdge(fromId, toId, fromSide, toSide) {
    if (edges.some(function(e) { return e.from === fromId && e.to === toId; })) {
      showToast(__spinT('toast.edgeExists'), 'error'); return;
    }
    if (fromId === toId) { showToast(__spinT('toast.cannotSelfConnect'), 'error'); return; }
    edges.push({ from: fromId, to: toId, fromSide: fromSide || 'right', toSide: toSide || 'left' });
    renderEdges();
    revalidateDesign();
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
    revalidateDesign();
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
      if (!e.target.classList.contains('task-display') && !e.target.classList.contains('ac-display') && !e.target.classList.contains('title-display')) {
        selectNode(node.id);
        if (e.ctrlKey) {
          dragState = { ctrlCopy: true, sourceNodeId: node.id, duplicated: false, nodeId: null, startX: e.clientX, startY: e.clientY, origX: node.x, origY: node.y };
        } else {
          dragState = { nodeId: node.id, startX: e.clientX, startY: e.clientY, origX: node.x, origY: node.y };
        }
        div.style.cursor = 'grabbing';
      } else {
        selectNode(node.id);
      }
    });

    // Header (status badge + title + actions)
    var header = document.createElement('div');
    header.className = 'node-header';
    var statusBadge = document.createElement('div');
    statusBadge.className = 'node-status-badge';
    statusBadge.style.display = 'none';
    statusBadge.textContent = '\u2713 ' + __spinT('node.done');
    header.appendChild(statusBadge);
    // Node title: 过长截断；双击可编辑，空标题时显示占位符也可双击添加。
    var titleSpan = document.createElement('span');
    titleSpan.className = 'node-title title-display' + ((node.title || '').trim() === '' ? ' empty' : '');
    titleSpan.textContent = (node.title || '').trim() || __spinT('node.titlePlaceholder');
    titleSpan.title = node.title || __spinT('node.titlePlaceholder');
    titleSpan.addEventListener('dblclick', function(e) {
      e.stopPropagation();
      var offset = getTextOffset(titleSpan, e.clientX, e.clientY);
      openFloatingEditor({ type: 'title', nodeId: node.id }, titleSpan, offset);
    });
    header.appendChild(titleSpan);
    var actions = document.createElement('div');
    actions.className = 'actions';
    var menuBtn = document.createElement('button');
    menuBtn.className = 'menu-btn';
    menuBtn.textContent = '\u22EF';
    menuBtn.title = __spinT('node.menuTitle');
    menuBtn.addEventListener('mousedown', function(e) { e.stopPropagation(); });
    menuBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      openNodeMenu(node.id, menuBtn);
    });
    actions.appendChild(menuBtn);
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

    // Acceptance Criteria（rollout > 1 或填写 For Each 时直接不显示）
    if (normalizeRolloutValue(node.rollout) <= 1 && !normalizeForEachValue(node.forEach)) {
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
    }

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
    renderEdges();
    revalidateDesign();
    persistState();
    saveDesign();
  }

  // 更新保存按钮状态：
  // - 节点数据损坏时禁用保存；
  // - 图不是 DAG、存在空节点、For Each 变量无效或变量与内置变量冲突时仍允许保存，
  //   但按钮显示为黄色并给出对应提示。
  function updateSaveButton(valid, notDag, hasEmptyNode, forEachErrors) {
    var btn = document.getElementById('btnSave');
    var exportBtn = document.getElementById('btnExport');
    if (!valid) {
      btn.disabled = true;
      btn.style.opacity = '0.4';
      btn.style.cursor = 'default';
      btn.style.background = '';
      btn.style.borderColor = '';
      btn.style.color = '';
      btn.title = '';
      exportBtn.disabled = true;
      exportBtn.style.opacity = '0.4';
      exportBtn.style.cursor = 'default';
      return;
    }
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
    exportBtn.disabled = false;
    exportBtn.style.opacity = '1';
    exportBtn.style.cursor = 'pointer';
    if (notDag || hasEmptyNode || (forEachErrors && forEachErrors.length > 0)) {
      btn.style.background = '#eab308';
      btn.style.borderColor = '#eab308';
      btn.style.color = '#1a1a1f';
      var tips = [];
      if (hasEmptyNode) tips.push(__spinT('toolbar.saveEmptyNode'));
      if (notDag) tips.push(__spinT('toolbar.saveNotDag'));
      (forEachErrors || []).forEach(function(tip) { tips.push(tip); });
      btn.title = tips.join('；');
    } else {
      btn.style.background = '';
      btn.style.borderColor = '';
      btn.style.color = '';
      btn.title = '';
    }
  }

  // 根据“是否为 DAG”和“是否存在空节点”刷新保存按钮外观；空节点、非连通等不再阻止保存。
  function revalidateDesign() {
    // 仍然防御节点数据损坏，避免后续 map/find 抛错。
    for (var vi = 0; vi < nodes.length; vi++) {
      if (!nodes[vi] || typeof nodes[vi].id !== 'number' || !isFinite(nodes[vi].id)) {
        updateSaveButton(false);
        return false;
      }
    }

    var hasEmptyNode = nodes.some(function(n) {
      return typeof n.task !== 'string' || n.task.trim() === '';
    });

    // For Each 变量有效性 + 用户变量与内置变量冲突检查
    var forEachErrors = [];
    var variableKeys = {};
    var reservedBuiltins = ['ROLLOUT_ID', 'LINE'];
    variables.forEach(function(v) {
      var key = (v.key || '').trim();
      if (key && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && reservedBuiltins.indexOf(key) === -1) {
        variableKeys[key] = true;
      }
    });
    nodes.forEach(function(n) {
      var fe = normalizeForEachValue(n.forEach);
      if (fe && !variableKeys[fe]) {
        forEachErrors.push(__spinT('toolbar.saveForEachVarMissing', { id: n.id, name: fe }));
      }
    });
    var builtinConflicts = [];
    variables.forEach(function(v) {
      var key = (v.key || '').trim();
      if (key && reservedBuiltins.indexOf(key) !== -1) builtinConflicts.push(key);
    });
    if (builtinConflicts.length > 0) {
      forEachErrors.push(__spinT('toolbar.saveBuiltinVarConflict', { names: builtinConflicts.join(', ') }));
    }

    var nodeIds = nodes.map(function(n) { return n.id; });
    if (nodeIds.length === 0) { updateSaveButton(true, false, false, forEachErrors); return true; }

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

    // Kahn：能完成拓扑排序即为 DAG
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

    var isDag = sorted.length === nodeIds.length;
    updateSaveButton(true, !isDag, hasEmptyNode, forEachErrors);
    return isDag;
  }

  // 保存不再因空节点、非 DAG、非连通等设计校验而阻止；
  // 仍会拦截“节点数据损坏/连线指向缺失节点”这类会导致文件无法读取的问题。
  // 保存与导出共用同一份数据构建逻辑，避免两份逻辑漂移。
  function buildDesignData(failLabel) {
    var label = failLabel || '保存失败';
    for (var ni = 0; ni < nodes.length; ni++) {
      var n = nodes[ni];
      if (!n || typeof n.id !== 'number' || !isFinite(n.id)) {
        showToast(label + ': 存在无效节点数据', 'error');
        return null;
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
        showToast(label + ': 存在指向缺失节点的连线', 'error');
        return null;
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

    // 非 DAG 时无法完整拓扑排序，直接保留当前节点顺序保存。
    if (sortedNodes.length !== saveNodes.length) {
      sortedNodes = saveNodes.slice();
    }

    var result = {
      nodes: sortedNodes.map(function(n) {
        return { id: n.id, x: n.x, y: n.y, task: n.task, criteria: n.criteria.filter(function(c) { return c.trim() !== ''; }), rollout: normalizeRolloutValue(n.rollout), forEach: normalizeForEachValue(n.forEach), role: 'Master', skills: n.skills || [], title: n.title || undefined };
      }),
      edges: edges.map(function(e) { return { from: e.from, to: e.to, fromSide: e.fromSide, toSide: e.toSide }; }),
      meta: meta,
      variables: variablesToObject(),
    };
    var comments = variablesCommentsToObject();
    if (Object.keys(comments).length > 0) {
      result.variableComments = comments;
    }
    return result;
  }

  function saveDesign() {
    var data = buildDesignData('保存失败');
    if (!data) return;
    vscode.postMessage({ type: 'saveSpinDesign', data: data });
    persistState();
  }

  function exportDesign() {
    var data = buildDesignData('导出失败');
    if (!data) return;
    vscode.postMessage({ type: 'exportSpinDesign', data: data });
  }

  window.addEventListener('message', function(event) {
    var msg = event.data;
    if (msg.type === 'spinSaveResult') {
      if (!msg.success) showToast(__spinT('toast.saveFailed') + (msg.error || __spinT('toast.unknownError')), 'error');
    } else if (msg.type === 'spinExportResult') {
      if (msg.canceled) return;
      if (msg.success) {
        showToast(__spinT('toast.exportSuccess', { path: msg.filePath || '' }), 'success');
      } else {
        showToast(__spinT('toast.exportFailed') + (msg.error || __spinT('toast.unknownError')), 'error');
      }
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
          nodes = msg.data.nodes.map(function(n) { return { id: n.id, x: n.x, y: n.y, task: n.task || '', criteria: n.criteria || [], rollout: normalizeRolloutValue(n.rollout), forEach: normalizeForEachValue(n.forEach), role: 'Master', skills: n.skills || [], title: (typeof n.title === 'string' && n.title.trim() !== '') ? n.title : undefined }; });
          edges = msg.data.edges || [];
          meta = msg.data.meta || {};
          variables = variablesFromData(msg.data);
          nextNodeId = nodes.reduce(function(m, n) { return Math.max(m, n.id); }, 0) + 1;
          if (savedState && typeof savedState.nextNodeId === 'number' && savedState.nextNodeId > nextNodeId) {
            nextNodeId = savedState.nextNodeId;
          }
          closeSkillSelector();
          closeNodeMenu();
          persistState();
          renderAll();
          if (!document.getElementById('variables-sidebar').classList.contains('hidden')) {
            renderVariables();
          }
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
    el._timeout = setTimeout(function() { el.className = ''; }, 3000);
  }
})();
</script>
</body>
</html>`;
}
