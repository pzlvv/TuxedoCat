/**
 * 全局快捷键工具（Electron 宿主本地）
 *
 * 唤醒快捷键以 Electron accelerator 形式保存（如 Ctrl+Alt+X），
 * 界面上按 Windows 习惯显示为 Ctrl+Alt+X。
 *
 * 持久化落在宿主本地状态（`userData/workspace-state.json` 的 `shortcut` 字段），
 * core 不读不写。
 *
 * 供三处复用：
 *  - Electron 主进程：读取偏好并注册 globalShortcut
 *  - 设置对话框：显示当前快捷键、捕获用户按下的新快捷键
 *  - 保存路径：校验并持久化用户修改
 */

/** 默认唤醒快捷键（Electron accelerator 形式） */
export const DEFAULT_WAKE_SHORTCUT = 'Ctrl+Alt+X';

/** 默认「下一标签」快捷键（工作区标签页切换，specs/021） */
export const DEFAULT_NEXT_TAB_SHORTCUT = 'Ctrl+Tab';

/** 默认「上一标签」快捷键（工作区标签页切换，specs/021） */
export const DEFAULT_PREV_TAB_SHORTCUT = 'Ctrl+Shift+Tab';

/** 可在偏好设置窗口录制改键的快捷键行（specs/021） */
export type ShortcutRow = 'wake' | 'nextTab' | 'prevTab';

/** 修饰键别名 -> Electron accelerator 名称 */
const MODIFIER_ALIASES: Record<string, string> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  cmdorctrl: 'Ctrl',
  commandorcontrol: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  altgr: 'AltGr',
  shift: 'Shift',
  super: 'Super',
  win: 'Super',
  windows: 'Super',
  meta: 'Super',
  cmd: 'Super',
  command: 'Super',
};

/** 规范化后的修饰键顺序（保证 Ctrl+Alt+X 等组合的存储顺序稳定） */
const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Super', 'Shift', 'AltGr'];

/** 特殊按键别名 -> Electron accelerator 名称 */
const SPECIAL_KEY_ALIASES: Record<string, string> = {
  space: 'Space',
  spacebar: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  ins: 'Insert',
  return: 'Return',
  enter: 'Return',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  escape: 'Escape',
  esc: 'Escape',
};

/** 将单个按键 token 规范化为 Electron 可识别的名称；无法识别时返回 null */
function canonicalizeKey(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const special = SPECIAL_KEY_ALIASES[trimmed.toLowerCase()];
  if (special) return special;

  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  if (/^[a-z]$/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  if (/^[0-9]$/.test(trimmed)) {
    return trimmed;
  }
  // 常见单字符按键（标点等）原样保留
  if (trimmed.length === 1) {
    return trimmed;
  }
  return null;
}

/**
 * 规范化 Electron accelerator 字符串。
 * 支持用户/手写配置中的 Win、Super、Ctrl、Control、Cmd、CommandOrControl 等别名。
 * 返回 null 表示无法识别。
 */
export function normalizeAccelerator(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;

  const parts = raw.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  const modifiers = new Set<string>();
  let key: string | null = null;

  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (modifier) {
      modifiers.add(modifier);
      continue;
    }
    // 只允许一个非修饰键
    if (key !== null) return null;
    key = canonicalizeKey(part);
    if (!key) return null;
  }

  if (!key) return null;
  // 为避免占用普通输入按键，未带修饰键时仅允许功能键
  if (modifiers.size === 0 && !/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) {
    return null;
  }

  const orderedModifiers = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier));
  return [...orderedModifiers, key].join('+');
}

/** 将 accelerator 转换为界面显示文本（Super -> Win） */
export function formatAcceleratorForDisplay(input: unknown): string {
  const normalized = normalizeAccelerator(input) || DEFAULT_WAKE_SHORTCUT;
  return normalized
    .split('+')
    .map((part) => (part === 'Super' ? 'Win' : part))
    .join('+');
}

/**
 * 快捷键捕获所需的最小键盘事件形状。
 * 不直接依赖 DOM 的 KeyboardEvent，便于在 Electron 主进程（无 DOM lib）中复用本模块。
 */
export interface ShortcutKeyboardEvent {
  code?: string;
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** 从键盘事件中提取按键名（优先使用 event.code，兼容不同键盘布局） */
function keyFromKeyboardEvent(event: ShortcutKeyboardEvent): string | null {
  const code = event.code;
  if (code) {
    if (code.startsWith('Key') && code.length === 4) return code.slice(3);
    if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  }

  switch (event.key) {
    case ' ':
      return 'Space';
    case 'Enter':
      return 'Return';
    case 'Escape':
      return 'Escape';
    case 'Tab':
      return 'Tab';
    case 'Backspace':
      return 'Backspace';
    case 'Delete':
      return 'Delete';
    case 'Insert':
      return 'Insert';
    case 'ArrowUp':
      return 'Up';
    case 'ArrowDown':
      return 'Down';
    case 'ArrowLeft':
      return 'Left';
    case 'ArrowRight':
      return 'Right';
    case 'Home':
      return 'Home';
    case 'End':
      return 'End';
    case 'PageUp':
      return 'PageUp';
    case 'PageDown':
      return 'PageDown';
    default:
      return event.key.length === 1 ? event.key : null;
  }
}

/**
 * 把键盘事件转换为规范化 accelerator。
 * 仅按下修饰键时返回 null（等待用户继续按主键）。
 */
export function acceleratorFromKeyboardEvent(event: ShortcutKeyboardEvent): string | null {
  if (
    event.key === 'Control'
    || event.key === 'Shift'
    || event.key === 'Alt'
    || event.key === 'Meta'
    || event.key === 'AltGraph'
  ) {
    return null;
  }

  const key = keyFromKeyboardEvent(event);
  if (!key) return null;

  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.metaKey) parts.push('Super');
  if (event.shiftKey) parts.push('Shift');
  parts.push(key);

  return normalizeAccelerator(parts.join('+'));
}

/** 已注册的既有绑定（录制冲突判定的输入，specs/021） */
export interface RegisteredShortcuts {
  /** 当前唤醒快捷键 */
  wake: string;
  /** 当前「下一标签」快捷键 */
  nextTab: string;
  /** 当前「上一标签」快捷键 */
  prevTab: string;
  /** 菜单既有组合（规范化前的 accelerator，如 Ctrl+O；标签两行的现行值不在此列） */
  menuAccelerators: readonly string[];
}

/** 冲突类别（文案由调用方按宿主语言生成，本模块不持 i18n） */
export type ShortcutConflictKind = 'wake' | 'nextTab' | 'prevTab' | 'menu';

/**
 * 录制冲突判定：候选组合与任一既有绑定相同时返回冲突类别，无冲突返回 null。
 * 全部按 normalizeAccelerator 规范化后比较——别名（Control / CommandOrControl 等）
 * 指同一组合时不误报、不漏报；与被录制行自身的现行值相同不算冲突（等价重存）。
 */
export function findShortcutConflict(
  target: 'nextTab' | 'prevTab',
  candidate: unknown,
  registered: RegisteredShortcuts,
): ShortcutConflictKind | null {
  const candidateKey = normalizeAccelerator(candidate);
  if (!candidateKey) return null;
  const others: Array<[ShortcutConflictKind, unknown]> = [
    ['wake', registered.wake],
    [target === 'nextTab' ? 'prevTab' : 'nextTab', target === 'nextTab' ? registered.prevTab : registered.nextTab],
    ...registered.menuAccelerators.map((accelerator): [ShortcutConflictKind, unknown] => ['menu', accelerator]),
  ];
  for (const [kind, value] of others) {
    if (normalizeAccelerator(value) === candidateKey) return kind;
  }
  return null;
}
