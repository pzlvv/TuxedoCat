/**
 * 查看器文件监听控制器（`electron/viewerWatch.ts`，specs/018 FR-001 ～ FR-006）。
 *
 * 覆盖点：
 * - 远程 Core 事件按 watchId 路由、迟到事件丢弃、内容判重；
 * - 删除 / 重建、注册失败、读取失败、Core 重启重注册；
 * - 关闭 / 顶替注销、工作区路由；
 * - 本地 watcher 的 changed / deleted / error 分支。
 *
 * 运行方式：npm run test:all -- viewerWatch
 */

import type {
  WatchWorkspaceFileResult,
} from '../shared/AssistantEventBus';
import type { WorkspaceRef } from '../host/workspaceRef';
import {
  ViewerWatchController,
  type ViewerContent,
  type ViewerKind,
  type ViewerMarker,
  type ViewerWatchDeps,
  type ViewerWatchTarget,
} from '../../electron/viewerWatch';
import type { LocalWatchEvent, LocalWatchHandle } from '../../electron/localFileWatch';
import { createChecker, runTests } from './helpers/harness';

const ENDPOINT = { host: 'host', port: 22, user: 'user', auth: null };
const REMOTE_TARGET: ViewerWatchTarget = {
  kind: 'remote',
  endpoint: ENDPOINT,
  workspacePath: '/workspace',
  absPath: '/workspace/README.md',
};
const REMOTE_REF: WorkspaceRef = { scheme: 'ssh', path: '/workspace', endpoint: ENDPOINT };
const LOCAL_TARGET: ViewerWatchTarget = { kind: 'local', filePath: 'C:/workspace/README.md' };
const REMOTE_TARGET_B: ViewerWatchTarget = {
  kind: 'remote',
  endpoint: ENDPOINT,
  workspacePath: '/workspace',
  absPath: '/workspace/B.md',
};

interface FakeState {
  watchCalls: Array<{ watchId: string; workspacePath: string; path: string }>;
  unwatchCalls: Array<{ watchId: string; workspacePath: string }>;
  delivered: Array<{ kind: ViewerKind; content: ViewerContent }>;
  titles: string[];
  readQueue: Array<ViewerContent | Error>;
  defaultRead: ViewerContent;
  watchResult: WatchWorkspaceFileResult;
  nextWatchId: number;
  localClosed: number;
  localEvent: ((event: LocalWatchEvent) => void) | null;
  logs: string[];
}

function fakeDeps(state: FakeState): ViewerWatchDeps {
  return {
    watchRemote: async (request) => {
      state.watchCalls.push(request);
      return state.watchResult;
    },
    unwatchRemote: async (request) => {
      state.unwatchCalls.push(request);
    },
    readContent: async () => {
      const next = state.readQueue.shift();
      if (next instanceof Error) throw next;
      return next ?? state.defaultRead;
    },
    deliver: (_target, kind, content) => {
      state.delivered.push({ kind, content });
    },
    setTitle: (title) => {
      state.titles.push(title);
    },
    markerText: (marker: ViewerMarker) => `[${marker}]`,
    createLocalWatcher: (_filePath, onEvent): LocalWatchHandle => {
      state.localEvent = onEvent;
      return {
        close: () => {
          state.localClosed++;
        },
      };
    },
    makeWatchId: () => `watch-${state.nextWatchId++}`,
    log: (...args) => {
      state.logs.push(args.map(String).join(' '));
    },
  };
}

function initialState(): FakeState {
  return {
    watchCalls: [],
    unwatchCalls: [],
    delivered: [],
    titles: [],
    readQueue: [],
    defaultRead: { kind: 'text', text: 'old' },
    watchResult: { ok: true },
    nextWatchId: 1,
    localClosed: 0,
    localEvent: null,
    logs: [],
  };
}

/** 让控制器里连续的 async 分支跑完 */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function changed(watchId = 'watch-1') {
  return {
    type: 'workspaceFileChanged' as const,
    watchId,
    path: '/workspace/README.md',
    kind: 'changed' as const,
    mtimeMs: 1,
    size: 1,
    error: null,
  };
}

function deleted(watchId = 'watch-1') {
  return {
    type: 'workspaceFileChanged' as const,
    watchId,
    path: '/workspace/README.md',
    kind: 'deleted' as const,
    mtimeMs: 0,
    size: 0,
    error: null,
  };
}

async function run(): Promise<void> {
  const check = createChecker();

  // ── 远程 changed：读新内容并投递 ──
  {
    const state = initialState();
    const controller = new ViewerWatchController(fakeDeps(state));
    controller.open(REMOTE_TARGET, 'markdown', 'README.md', { kind: 'text', text: 'old' });
    await flush();
    state.readQueue.push({ kind: 'text', text: 'new' });
    controller.handleCoreEvent(changed());
    await flush();
    check.check('远程 changed 注册一次监听', state.watchCalls.length === 1);
    check.check('远程 changed 投递新内容', state.delivered.at(-1)?.content.kind === 'text'
      && (state.delivered.at(-1)?.content as { text: string }).text === 'new');
  }

  // ── 迟到 watchId 丢弃 ──
  {
    const state = initialState();
    const controller = new ViewerWatchController(fakeDeps(state));
    controller.open(REMOTE_TARGET, 'markdown', 'README.md', { kind: 'text', text: 'old' });
    await flush();
    controller.handleCoreEvent(changed('stale-watch'));
    await flush();
    check.check('迟到 watchId 不读取、不投递', state.delivered.length === 0);
  }

  // ── 注册后补读：覆盖打开读盘 → 监听就绪之间的修改 ──
  {
    const state = initialState();
    state.defaultRead = { kind: 'text', text: 'changed-during-open' };
    const controller = new ViewerWatchController(fakeDeps(state));
    controller.open(REMOTE_TARGET, 'markdown', 'README.md', { kind: 'text', text: 'old' });
    await flush();
    check.check('注册后补读覆盖打开期间的修改',
      (state.delivered.at(-1)?.content as { text: string }).text === 'changed-during-open');
  }

  // ── 本地打开后补读：覆盖读盘 → watcher 就绪之间的修改（不靠任何 watcher 事件）──
  {
    const state = initialState();
    state.defaultRead = { kind: 'text', text: 'changed-during-open' };
    const controller = new ViewerWatchController(fakeDeps(state));
    controller.open(LOCAL_TARGET, 'markdown', 'README.md', { kind: 'text', text: 'old' });
    await flush();
    check.check('本地打开后补读覆盖打开期间的修改',
      (state.delivered.at(-1)?.content as { text: string }).text === 'changed-during-open');
  }

  // ── 内容未变不刷新 ──
  {
    const state = initialState();
    state.defaultRead = { kind: 'text', text: 'same' };
    const controller = new ViewerWatchController(fakeDeps(state));
    controller.open(REMOTE_TARGET, 'markdown', 'README.md', { kind: 'text', text: 'same' });
    await flush();
    state.readQueue.push({ kind: 'text', text: 'same' });
    controller.handleCoreEvent(changed());
    await flush();
    check.check('相同内容不投递刷新', state.delivered.length === 0);
  }

  // ── 删除标记与重建恢复 ──
  {
    const state = initialState();
    const controller = new ViewerWatchController(fakeDeps(state));
    controller.open(REMOTE_TARGET, 'markdown', 'README.md', { kind: 'text', text: 'old' });
    await flush();
    controller.handleCoreEvent(deleted());
    check.check('删除后标题带标记', state.titles.at(-1) === 'README.md[deleted]');
    state.readQueue.push({ kind: 'text', text: 'recreated' });
    controller.handleCoreEvent(changed());
    await flush();
    check.check('重建后清除标记并刷新', state.titles.at(-1) === 'README.md'
      && (state.delivered.at(-1)?.content as { text: string }).text === 'recreated');
  }

  // ── 注册失败标记 + Connection ready 重试 ──
  {
    const state = initialState();
    state.watchResult = { ok: false, error: 'watch limit' };
    const controller = new ViewerWatchController(fakeDeps(state));
    controller.open(REMOTE_TARGET, 'markdown', 'README.md', { kind: 'text', text: 'old' });
    await flush();
    check.check('注册失败显示自动刷新不可用', state.titles.at(-1) === 'README.md[auto-refresh-unavailable]');
    state.watchResult = { ok: true };
    state.readQueue.push({ kind: 'text', text: 'after-ready' });
    controller.handleConnectionReady(REMOTE_REF);
    await flush();
    check.check('Connection ready 重试注册', state.watchCalls.length === 2);
    check.check('重试后补读并清除标记', state.titles.at(-1) === 'README.md'
      && (state.delivered.at(-1)?.content as { text: string }).text === 'after-ready');
  }

  // ── 读取失败标记 + 下次成功清除 ──
  {
    const state = initialState();
    const controller = new ViewerWatchController(fakeDeps(state));
    controller.open(REMOTE_TARGET, 'markdown', 'README.md', { kind: 'text', text: 'old' });
    await flush();
    state.readQueue.push(new Error('sftp down'));
    controller.handleCoreEvent(changed());
    await flush();
    check.check('读取失败显示标记', state.titles.at(-1) === 'README.md[read-failed]');
    state.readQueue.push({ kind: 'text', text: 'recovered' });
    controller.handleCoreEvent(changed());
    await flush();
    check.check('下次成功读取清除标记并刷新', state.titles.at(-1) === 'README.md'
      && (state.delivered.at(-1)?.content as { text: string }).text === 'recovered');
  }

  // ── 关闭 / 顶替注销 ──
  {
    const state = initialState();
    const controller = new ViewerWatchController(fakeDeps(state));
    controller.open(REMOTE_TARGET, 'markdown', 'README.md', { kind: 'text', text: 'old' });
    await flush();
    controller.close();
    await flush();
    check.check('关闭查看器发注销', state.unwatchCalls.length === 1);

    controller.open(REMOTE_TARGET, 'markdown', 'README.md', { kind: 'text', text: 'old' });
    await flush();
    controller.open(LOCAL_TARGET, 'text', 'README.md', { kind: 'text', text: 'old' });
    await flush();
    check.check('远程被本地顶替后旧监听注销且新 watcher 存活',
      state.unwatchCalls.length === 2 && state.localClosed === 0);
  }

  // ── 本地被本地顶替：旧 watcher 关闭 ──
  {
    const state = initialState();
    const controller = new ViewerWatchController(fakeDeps(state));
    controller.open(LOCAL_TARGET, 'image', 'a.png', { kind: 'image', dataUrl: 'data:a' });
    controller.open({ kind: 'local', filePath: 'C:/workspace/B.md' }, 'text', 'B.md', {
      kind: 'text',
      text: 'b',
    });
    check.check('本地顶替关闭旧 watcher', state.localClosed === 1);
  }

  // ── Core 重启重注册（同一工作区）──
  {
    const state = initialState();
    const controller = new ViewerWatchController(fakeDeps(state));
    controller.open(REMOTE_TARGET, 'markdown', 'README.md', { kind: 'text', text: 'old' });
    await flush();
    state.readQueue.push({ kind: 'text', text: 'after-restart' });
    controller.handleConnectionReady(REMOTE_REF);
    await flush();
    check.check('Core 重启后重注册', state.watchCalls.length === 2);
    check.check('Core 重启后补读', (state.delivered.at(-1)?.content as { text: string }).text === 'after-restart');
  }

  // ── 其它工作区 ready 不触发重注册 ──
  {
    const state = initialState();
    const controller = new ViewerWatchController(fakeDeps(state));
    controller.open(REMOTE_TARGET, 'markdown', 'README.md', { kind: 'text', text: 'old' });
    await flush();
    controller.handleConnectionReady({ scheme: 'ssh', path: '/other', endpoint: ENDPOINT });
    await flush();
    check.check('其它工作区 ready 不重注册', state.watchCalls.length === 1);
  }

  // ── 同一窗口切换文件：旧 watch 注销、旧事件丢弃、新 watch 生效 ──
  {
    const state = initialState();
    state.defaultRead = { kind: 'text', text: 'a' };
    const controller = new ViewerWatchController(fakeDeps(state));
    controller.open(REMOTE_TARGET, 'markdown', 'A.md', { kind: 'text', text: 'a' });
    await flush();
    state.defaultRead = { kind: 'text', text: 'b' };
    controller.open(REMOTE_TARGET_B, 'markdown', 'B.md', { kind: 'text', text: 'b' });
    await flush();
    check.check('切换文件注销旧 watch', state.unwatchCalls.some((call) => call.watchId === 'watch-1'));
    state.readQueue = [{ kind: 'text', text: 'b2' }];
    controller.handleCoreEvent(changed('watch-1'));
    await flush();
    check.check('旧 watch 事件不刷新', state.delivered.length === 0);
    controller.handleCoreEvent(changed('watch-2'));
    await flush();
    check.check('新 watch 事件刷新', (state.delivered.at(-1)?.content as { text: string }).text === 'b2');
  }

  // ── 本地 changed / deleted / close ──
  {
    const state = initialState();
    state.defaultRead = { kind: 'image', dataUrl: 'data:old' };
    const controller = new ViewerWatchController(fakeDeps(state));
    controller.open(LOCAL_TARGET, 'image', 'a.png', { kind: 'image', dataUrl: 'data:old' });
    state.readQueue.push({ kind: 'image', dataUrl: 'data:new' });
    state.localEvent?.({ kind: 'changed' });
    await flush();
    check.check('本地 changed 投递新图片', (state.delivered.at(-1)?.content as { dataUrl: string }).dataUrl === 'data:new');
    state.localEvent?.({ kind: 'deleted' });
    check.check('本地删除显示标记', state.titles.at(-1) === 'a.png[deleted]');
    controller.close();
    check.check('关闭本地 watcher', state.localClosed === 1);
  }

  check.finish();
}

runTests('viewerWatch', run);
