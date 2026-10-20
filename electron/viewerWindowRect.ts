/**
 * 查看器窗口与 Spin 设计器窗口的「上次窗口矩形」决策（specs/016 FR-002 / FR-003）。
 *
 * 三类文件查看器（Monaco / 图片 / Markdown）共用一个窗口名额：新开请求顶替现存
 * 窗口并继承其矩形；无存活窗口时用 workspace-state.json 里按名额持久化的矩形，
 * 矩形必须在至少一块现存显示器的工作区上可见才复用（拔显示器后回退默认）。
 *
 * 保持纯函数（只 `import type`，不引入 electron 运行时依赖），决策与矩形校验由
 * `src/test/viewerWindows.test.ts` 单测；显示器工作区由调用方传入。
 */

import type { WindowRect, WorkspaceState } from './workspaceStateStore.js';

/** 矩形下限：低于该尺寸视为非法（对齐各类查看器默认尺寸的最小档） */
export const MIN_VIEWER_WIDTH = 300;
export const MIN_VIEWER_HEIGHT = 200;

/** 复用已存矩形的可见性下限（露出的部分要够用户拖回来） */
const MIN_VISIBLE_X = 120;
const MIN_VISIBLE_Y = 40;

/** 显示器工作区（Electron `Display.workArea` 的形状；调用方传入，本模块不依赖 electron） */
export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 开窗可用的矩形：位置可缺失（交给 OS 默认摆放），尺寸必有 */
export interface SlotBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

/** 把任意来源（状态文件 / 存活窗口）的矩形收敛成可开窗形态；非法返回 undefined */
export function sanitizeViewerRect(saved: unknown): SlotBounds | undefined {
  if (!saved || typeof saved !== 'object') return undefined;
  const record = saved as Record<string, unknown>;
  const width = Math.round(Number(record.width));
  const height = Math.round(Number(record.height));
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  if (width < MIN_VIEWER_WIDTH || height < MIN_VIEWER_HEIGHT) return undefined;
  const x = Math.round(Number(record.x));
  const y = Math.round(Number(record.y));
  const hasPosition = Number.isFinite(x) && Number.isFinite(y);
  return hasPosition ? { x, y, width, height } : { width, height };
}

/** 判断矩形是否还有足够部分落在某块工作区内（换屏 / 拔显示器后旧坐标可能失效） */
export function isRectVisibleOnSomeWorkArea(
  rect: { x: number; y: number; width: number; height: number },
  workAreas: WorkArea[],
): boolean {
  return workAreas.some((area) => {
    const overlapX = Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x);
    const overlapY = Math.min(rect.y + rect.height, area.y + area.height) - Math.max(rect.y, area.y);
    return overlapX >= MIN_VISIBLE_X && overlapY >= MIN_VISIBLE_Y;
  });
}

/**
 * 决定新查看器窗口的初始矩形：
 * 1. 存活查看器窗口的当前矩形（顶替继承——用户刚摆的位置是最新意图，窗口正开着必可见）；
 * 2. 已存矩形（带位置时须通过显示器可见性校验；只存过尺寸则只用尺寸）；
 * 3. 都没有 → undefined（调用方用各类型的默认尺寸与默认摆放）。
 */
export function planViewerSlotBounds(input: {
  liveBounds?: SlotBounds | null;
  savedRect?: SlotBounds | null;
  workAreas: WorkArea[];
}): SlotBounds | undefined {
  const live = sanitizeViewerRect(input.liveBounds ?? undefined);
  if (live) return live;
  const saved = sanitizeViewerRect(input.savedRect ?? undefined);
  if (!saved) return undefined;
  const { x, y } = saved;
  if (x === undefined || y === undefined) return { width: saved.width, height: saved.height };
  return isRectVisibleOnSomeWorkArea({ x, y, width: saved.width, height: saved.height }, input.workAreas)
    ? saved
    : undefined;
}

/** workspace-state.json 里两个窗口矩形字段的键（查看器名额 / Spin 设计器各一份） */
export type SlotRectKey = 'viewerWindowRect' | 'spinDesignWindowRect';

/** 状态文件读写口（Electron 侧传 `readWorkspaceState` / `writeWorkspaceState`，测试传假件） */
export interface RectStateStore {
  readState(): WorkspaceState;
  writeState(state: WorkspaceState): void;
}

/** 读出某名额的上次矩形（已 sanitize；无记忆返回 undefined） */
export function loadSlotRect(store: RectStateStore, key: SlotRectKey): SlotBounds | undefined {
  return sanitizeViewerRect(store.readState()[key]);
}

/** 落盘某名额的矩形（读-改-写，不覆盖其它字段；非法矩形不落盘） */
export function saveSlotRect(
  store: RectStateStore,
  key: SlotRectKey,
  rect: { x: number; y: number; width: number; height: number },
): void {
  const sanitized = sanitizeViewerRect(rect);
  if (!sanitized) return;
  const prev = store.readState();
  const next: WindowRect = {
    x: sanitized.x,
    y: sanitized.y,
    width: sanitized.width,
    height: sanitized.height,
  };
  store.writeState({ ...prev, [key]: next });
}

/** `trackWindowRect` 需要的窗口形状（结构化类型：不引入 electron，测试可用假件） */
export interface TrackedWindow {
  on(event: 'resize' | 'move' | 'close', listener: () => void): unknown;
  isDestroyed(): boolean;
  getNormalBounds(): { x: number; y: number; width: number; height: number };
}

/** 矩形落盘防抖窗口（与主窗口的拖动落盘同节奏） */
const RECT_SAVE_DEBOUNCE_MS = 2000;

/**
 * 给窗口挂矩形记忆：move / resize 防抖落盘，close 时补记一次（用户关窗前的最终
 * 位置）。`destroy()` 不触发 close——顶替路径由调用方在销毁前显式补记。
 */
export function trackWindowRect(win: TrackedWindow, store: RectStateStore, key: SlotRectKey): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const saveNow = (): void => {
    if (win.isDestroyed()) return;
    const bounds = win.getNormalBounds();
    saveSlotRect(store, key, bounds);
  };
  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      saveNow();
    }, RECT_SAVE_DEBOUNCE_MS);
  };
  win.on('resize', schedule);
  win.on('move', schedule);
  win.on('close', () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    saveNow();
  });
}
