/**
 * 查看器窗口名额与矩形记忆的决策（`electron/viewerWindowRect.ts`，specs/016
 * FR-002 / FR-003）。
 *
 * 覆盖点：
 * - 矩形收敛（sanitizeViewerRect）：合法 / 只存尺寸 / 非法（非数、过小）；
 * - 多屏可见性判据（isRectVisibleOnSomeWorkArea）；
 * - 开窗矩形优先级（planViewerSlotBounds）：存活窗口继承 > 已存矩形（须过可见性
 *   校验）> 默认（undefined）；
 * - 状态文件读写（loadSlotRect / saveSlotRect）：读-改-写不覆盖其它字段、非法不落盘；
 * - 矩形记忆接线（trackWindowRect）：move/resize 防抖落盘、close 立即补记并取消挂起。
 *
 * 运行方式：npm run test:all -- viewerWindows
 */

import {
  sanitizeViewerRect,
  isRectVisibleOnSomeWorkArea,
  planViewerSlotBounds,
  loadSlotRect,
  saveSlotRect,
  trackWindowRect,
  MIN_VIEWER_WIDTH,
  type RectStateStore,
  type TrackedWindow,
} from '../../electron/viewerWindowRect';
import { createChecker, runTests } from './helpers/harness';

/** 内存状态文件（workspace-state 的假件） */
function fakeStore(initial: Record<string, unknown> = {}): RectStateStore & { state: Record<string, unknown> } {
  const holder: { state: Record<string, unknown> } = { state: { ...initial } };
  return {
    get state() {
      return holder.state;
    },
    readState: () => holder.state as never,
    writeState: (next) => {
      holder.state = { ...next } as Record<string, unknown>;
    },
  };
}

/** 可控时钟：替换全局 setTimeout / clearTimeout（本测试文件独立进程，跑完恢复） */
function installFakeTimers(): { tick(ms: number): void; restore(): void } {
  const tasks: Array<{ id: number; at: number; fn: () => void }> = [];
  let nextId = 1;
  let now = 0;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number) => {
    const id = nextId++;
    tasks.push({ id, at: now + (ms ?? 0), fn });
    return id as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: unknown) => {
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx >= 0) tasks.splice(idx, 1);
  }) as typeof clearTimeout;
  return {
    tick(ms: number): void {
      now += ms;
      for (const t of tasks.filter((t) => t.at <= now)) {
        const idx = tasks.indexOf(t);
        if (idx >= 0) tasks.splice(idx, 1);
        t.fn();
      }
    },
    restore(): void {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

/** 假窗口：记录监听器、可改矩形、可触发 resize / close */
function fakeWindow(bounds = { x: 10, y: 20, width: 800, height: 600 }): TrackedWindow & {
  setBounds(b: { x: number; y: number; width: number; height: number }): void;
  userClose(): void;
} {
  const listeners: Partial<Record<'resize' | 'move' | 'close', Array<() => void>>> = {};
  let current = { ...bounds };
  const win = {
    on(event: 'resize' | 'move' | 'close', listener: () => void): void {
      (listeners[event] ??= []).push(listener);
    },
    isDestroyed(): boolean {
      return false;
    },
    getNormalBounds() {
      return { ...current };
    },
    setBounds(b: { x: number; y: number; width: number; height: number }): void {
      current = { ...b };
      for (const fn of listeners.move ?? []) fn();
      for (const fn of listeners.resize ?? []) fn();
    },
    userClose(): void {
      for (const fn of listeners.close ?? []) fn();
    },
  };
  return win;
}

runTests('viewerWindows', () => {
  const { check, finish } = createChecker();

  // ── sanitizeViewerRect ──
  {
    check('合法矩形原样（取整）返回', (() => {
      const r = sanitizeViewerRect({ x: 10.4, y: 20.6, width: 800.2, height: 600.8 });
      return r !== undefined && r.x === 10 && r.y === 21 && r.width === 800 && r.height === 601;
    })());
    check('只存尺寸（x/y 缺失）返回不带位置的矩形', (() => {
      const r = sanitizeViewerRect({ width: 1080, height: 720 });
      return r !== undefined && r.x === undefined && r.y === undefined && r.width === 1080;
    })());
    check('非对象返回 undefined', sanitizeViewerRect(null) === undefined && sanitizeViewerRect('x') === undefined);
    check('宽高非数返回 undefined', sanitizeViewerRect({ x: 1, y: 2, width: 'a', height: 600 }) === undefined);
    check('NaN 位置按缺失处理（仍可用尺寸）', sanitizeViewerRect({ x: Number.NaN, y: 2, width: 800, height: 600 })?.width === 800);
    check('宽度过小返回 undefined', sanitizeViewerRect({ x: 1, y: 2, width: MIN_VIEWER_WIDTH - 1, height: 600 }) === undefined);
    check('高度过小返回 undefined', sanitizeViewerRect({ x: 1, y: 2, width: 800, height: 100 }) === undefined);
  }

  // ── isRectVisibleOnSomeWorkArea ──
  {
    const areas = [
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 1920, y: 0, width: 2560, height: 1440 },
    ];
    check('矩形落在某块工作区内 → 可见', isRectVisibleOnSomeWorkArea({ x: 2000, y: 100, width: 800, height: 600 }, areas));
    check('矩形完全在所有屏幕外 → 不可见', !isRectVisibleOnSomeWorkArea({ x: 9999, y: 9999, width: 800, height: 600 }, areas));
    check('露出部分不足（< 120×40）→ 不可见', !isRectVisibleOnSomeWorkArea({ x: 1850, y: 0, width: 800, height: 600 }, [areas[0]]));
    check('跨屏且露出足够 → 可见', isRectVisibleOnSomeWorkArea({ x: 1800, y: 0, width: 800, height: 600 }, areas));
  }

  // ── planViewerSlotBounds：优先级 ──
  {
    const areas = [{ x: 0, y: 0, width: 1920, height: 1080 }];
    check('存活窗口矩形优先于已存矩形', (() => {
      const r = planViewerSlotBounds({
        liveBounds: { x: 100, y: 100, width: 700, height: 500 },
        savedRect: { x: 300, y: 300, width: 1200, height: 800 },
        workAreas: areas,
      });
      return r !== undefined && r.x === 100 && r.width === 700;
    })());
    check('无存活窗口时用已存矩形（过可见性校验）', (() => {
      const r = planViewerSlotBounds({ savedRect: { x: 300, y: 300, width: 1200, height: 800 }, workAreas: areas });
      return r !== undefined && r.x === 300 && r.width === 1200;
    })());
    check('已存矩形位置不可见 → 回退默认（undefined）', planViewerSlotBounds({ savedRect: { x: 9999, y: 9999, width: 1200, height: 800 }, workAreas: areas }) === undefined);
    check('已存矩形只存过尺寸 → 只继承尺寸（位置交给 OS 摆放）', (() => {
      const r = planViewerSlotBounds({ savedRect: { width: 1200, height: 800 }, workAreas: areas });
      return r !== undefined && r.x === undefined && r.width === 1200;
    })());
    check('没有任何矩形 → undefined', planViewerSlotBounds({ workAreas: areas }) === undefined);
    check('存活窗口矩形非法（过小）→ 落到已存矩形', (() => {
      const r = planViewerSlotBounds({
        liveBounds: { x: 0, y: 0, width: 50, height: 50 },
        savedRect: { x: 300, y: 300, width: 1200, height: 800 },
        workAreas: areas,
      });
      return r !== undefined && r.x === 300;
    })());
  }

  // ── loadSlotRect / saveSlotRect：读-改-写 ──
  {
    const store = fakeStore({ soundEnabled: true, viewerWindowRect: { x: 1, y: 2, width: 900, height: 700 } });
    check('读出已存查看器矩形', loadSlotRect(store, 'viewerWindowRect')?.width === 900);
    saveSlotRect(store, 'spinDesignWindowRect', { x: 5, y: 6, width: 1100, height: 720 });
    check('写入设计器矩形不动其它字段', (() => {
      const s = store.state as { soundEnabled?: boolean; viewerWindowRect?: { width: number }; spinDesignWindowRect?: { x: number } };
      return s.soundEnabled === true && s.viewerWindowRect?.width === 900 && s.spinDesignWindowRect?.x === 5;
    })());
    const before = JSON.stringify(store.state);
    saveSlotRect(store, 'viewerWindowRect', { x: 0, y: 0, width: 10, height: 10 });
    check('非法矩形不落盘（状态不变）', JSON.stringify(store.state) === before);
    saveSlotRect(store, 'viewerWindowRect', { x: 8, y: 9, width: 1080, height: 720 });
    check('覆盖同键旧值', loadSlotRect(store, 'viewerWindowRect')?.x === 8);
  }

  // ── trackWindowRect：防抖与补记 ──
  {
    const clock = installFakeTimers();
    try {
      const store = fakeStore({});
      const win = fakeWindow();
      trackWindowRect(win, store, 'viewerWindowRect');
      check('初始无矩形', loadSlotRect(store, 'viewerWindowRect') === undefined);
      win.setBounds({ x: 40, y: 50, width: 1000, height: 800 });
      check('move/resize 后未到防抖窗口不落盘', loadSlotRect(store, 'viewerWindowRect') === undefined);
      win.setBounds({ x: 60, y: 70, width: 1100, height: 900 });
      clock.tick(2100);
      check('防抖到点落盘最后一次矩形', (() => {
        const r = loadSlotRect(store, 'viewerWindowRect');
        return r !== undefined && r.x === 60 && r.width === 1100;
      })());
      win.setBounds({ x: 80, y: 90, width: 1200, height: 900 });
      win.userClose();
      check('close 立即补记（不等防抖）', loadSlotRect(store, 'viewerWindowRect')?.x === 80);
    } finally {
      clock.restore();
    }
  }

  finish();
});
