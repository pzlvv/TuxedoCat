/**
 * 查看器文件监听控制器（specs/018 FR-001 ～ FR-006）。
 *
 * 纯宿主逻辑，不 import electron / fs：本地 watcher、远程 watch 请求、内容读取、
 * 刷新投递与标题设置全部经依赖注入。这样单元测试可以用假 Core / 假读取 / 可控
 * `watchId` 覆盖注销、顶替、重注册、内容判重与错误降级。
 *
 * 职责边界：
 * - Core 只上报 `workspaceFileChanged` 事实；本控制器按 `watchId` 路由到唯一查看器；
 * - 本地 watcher 只上报 changed / deleted / error；本控制器负责读内容与判重；
 * - 查看器窗口的缩放 / 滚动 / 光标保持由渲染端负责，本控制器只投递新内容。
 */

import type { CoreEvent, WatchWorkspaceFileResult } from '../src/shared/AssistantEventBus.js';
import type { WorkspaceEndpoint, WorkspaceRef } from '../src/host/workspaceRef.js';
import { workspaceEndpointKey } from '../src/host/workspaceRef.js';
import type { LocalWatchEvent, LocalWatchHandle } from './localFileWatch.js';

/** 查看器类型：决定读取方式与刷新消息通道 */
export type ViewerKind = 'markdown' | 'image' | 'text';

/** 监听目标：本地绝对路径，或远程 endpoint + 工作区根 + 目标绝对路径 */
export type ViewerWatchTarget =
  | { kind: 'local'; filePath: string }
  | {
      kind: 'remote';
      endpoint: WorkspaceEndpoint;
      workspacePath: string;
      absPath: string;
    };

/** 查看器内容：文本（Markdown / Monaco）或图片 data URL */
export type ViewerContent =
  | { kind: 'text'; text: string }
  | { kind: 'image'; dataUrl: string };

/** 标题标记：删除 / 读取失败 / 监听不可用 */
export type ViewerMarker = 'deleted' | 'read-failed' | 'auto-refresh-unavailable';

export interface ViewerWatchDeps {
  /** 注册远程监听；失败用 `{ ok: false, error }` 回报 */
  watchRemote(request: {
    watchId: string;
    workspacePath: string;
    path: string;
  }): Promise<WatchWorkspaceFileResult>;
  /** 注销远程监听；未知 watchId 幂等 */
  unwatchRemote(request: { watchId: string; workspacePath: string }): Promise<void>;
  /** 按目标读取内容；本地 / 远程由调用方实现 */
  readContent(target: ViewerWatchTarget, kind: ViewerKind): Promise<ViewerContent>;
  /** 把新内容投递到查看器窗口（渲染端负责保持视图状态） */
  deliver(target: ViewerWatchTarget, kind: ViewerKind, content: ViewerContent): void | Promise<void>;
  /** 更新查看器标题（基础标题 + 可选标记） */
  setTitle(title: string): void;
  /** 标题标记文案（宿主 i18n） */
  markerText(marker: ViewerMarker): string;
  /** 创建本地 watcher（测试注入假实现） */
  createLocalWatcher(
    filePath: string,
    onEvent: (event: LocalWatchEvent) => void,
  ): LocalWatchHandle;
  /** 生成 watchId（测试注入固定值） */
  makeWatchId(): string;
  log(...args: unknown[]): void;
}

interface ActiveWatch {
  watchId: string;
  target: ViewerWatchTarget;
  kind: ViewerKind;
  baseTitle: string;
  lastContent: ViewerContent;
  marker: ViewerMarker | null;
  localHandle: LocalWatchHandle | null;
  /** 远程监听是否已成功注册（用于关闭时决定是否发注销） */
  registered: boolean;
  /** 关闭 / 顶替后到达的异步结果全部丢弃 */
  disposed: boolean;
}

/**
 * 当前查看器窗口的监听状态机。同一时刻只有一个活动监听（与查看器单名额一致）。
 */
export class ViewerWatchController {
  private active: ActiveWatch | null = null;

  constructor(private readonly deps: ViewerWatchDeps) {}

  /** 当前活动 watchId；没有监听时为 null（测试与诊断用） */
  get activeWatchId(): string | null {
    return this.active?.watchId ?? null;
  }

  /**
   * 开始监听一个查看器目标。`initialContent` 是开窗时已经读到的内容，
   * 用于内容判重（Core 事件到达但内容未变时不重复刷新）。
   */
  open(
    target: ViewerWatchTarget,
    kind: ViewerKind,
    baseTitle: string,
    initialContent: ViewerContent,
  ): void {
    this.close();
    const active: ActiveWatch = {
      watchId: this.deps.makeWatchId(),
      target,
      kind,
      baseTitle,
      lastContent: initialContent,
      marker: null,
      localHandle: null,
      registered: false,
      disposed: false,
    };
    this.active = active;
    this.deps.setTitle(baseTitle);

    if (target.kind === 'local') {
      active.localHandle = this.deps.createLocalWatcher(target.filePath, (event) => {
        this.handleLocalEvent(active, event);
      });
      return;
    }
    void this.registerRemote(active);
  }

  /** 停止监听：本地关 watcher，远程发注销；之后的迟到事件全部丢弃。 */
  close(): void {
    const active = this.active;
    this.active = null;
    if (!active) return;
    active.disposed = true;
    active.localHandle?.close();
    active.localHandle = null;
    if (active.target.kind === 'remote' && active.registered) {
      void this.deps
        .unwatchRemote({
          watchId: active.watchId,
          workspacePath: active.target.workspacePath,
        })
        .catch((err) => this.deps.log(`[viewer-watch] unwatch failed: ${err}`));
    }
  }

  /** Core 上报远程文件变化：只接受当前 watchId，迟到事件丢弃。 */
  handleCoreEvent(event: Extract<CoreEvent, { type: 'workspaceFileChanged' }>): void {
    const active = this.active;
    if (!active || active.disposed || event.watchId !== active.watchId) return;
    switch (event.kind) {
      case 'changed':
        void this.refreshFromSource(active);
        return;
      case 'deleted':
        this.setMarker(active, 'deleted');
        return;
      case 'error':
        this.deps.log(`[viewer-watch] core watch error: ${event.error ?? 'unknown'}`);
        this.setMarker(active, 'auto-refresh-unavailable');
        return;
    }
  }

  /**
   * 工作区 Connection 就绪（含 Core 重启 / 快照重推）：远程监听在 Core 侧已丢失，
   * 重新注册并立即读一次内容，补齐断线期间的修改。
   */
  handleConnectionReady(ref: WorkspaceRef): void {
    const active = this.active;
    if (!active || active.disposed || active.target.kind !== 'remote') return;
    if (!sameRemoteWorkspace(ref, active.target)) return;
    active.registered = false;
    void this.registerRemote(active);
  }

  private async registerRemote(active: ActiveWatch): Promise<void> {
    if (active.disposed || active.target.kind !== 'remote') return;
    const target = active.target;
    let result: WatchWorkspaceFileResult;
    try {
      result = await this.deps.watchRemote({
        watchId: active.watchId,
        workspacePath: target.workspacePath,
        path: target.absPath,
      });
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (active.disposed || this.active !== active) {
      // 注册在途期间窗口已关闭 / 被顶替：把刚注册上的监听补注销，避免泄漏。
      if (result.ok) {
        void this.deps
          .unwatchRemote({
            watchId: active.watchId,
            workspacePath: target.workspacePath,
          })
          .catch((err) => this.deps.log(`[viewer-watch] late unwatch failed: ${err}`));
      }
      return;
    }
    if (!result.ok) {
      this.deps.log(`[viewer-watch] register failed: ${result.error}`);
      this.setMarker(active, 'auto-refresh-unavailable');
      return;
    }
    active.registered = true;
    // 注册成功后立即补读一次：覆盖「打开读盘 → 监听就绪」之间的修改。
    await this.refreshFromSource(active);
  }

  private handleLocalEvent(active: ActiveWatch, event: LocalWatchEvent): void {
    if (active.disposed || this.active !== active) return;
    switch (event.kind) {
      case 'changed':
        void this.refreshFromSource(active);
        return;
      case 'deleted':
        this.setMarker(active, 'deleted');
        return;
      case 'error':
        this.deps.log(`[viewer-watch] local watch error: ${event.error}`);
        this.setMarker(active, 'auto-refresh-unavailable');
        return;
    }
  }

  private async refreshFromSource(active: ActiveWatch): Promise<void> {
    if (active.disposed || this.active !== active) return;
    let content: ViewerContent;
    try {
      content = await this.deps.readContent(active.target, active.kind);
    } catch (err) {
      if (active.disposed || this.active !== active) return;
      this.deps.log(`[viewer-watch] read failed: ${err}`);
      this.setMarker(active, 'read-failed');
      return;
    }
    if (active.disposed || this.active !== active) return;
    if (sameContent(content, active.lastContent)) {
      // 内容未变（touch / 等长重写）：不投递刷新，但成功读取要清掉读取失败标记。
      this.setMarker(active, null);
      return;
    }
    active.lastContent = content;
    this.setMarker(active, null);
    await this.deps.deliver(active.target, active.kind, content);
  }

  private setMarker(active: ActiveWatch, marker: ViewerMarker | null): void {
    if (active.disposed || this.active !== active) return;
    if (active.marker === marker) return;
    active.marker = marker;
    this.deps.setTitle(
      marker === null ? active.baseTitle : active.baseTitle + this.deps.markerText(marker),
    );
  }
}

function sameContent(left: ViewerContent, right: ViewerContent): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === 'text'
    ? left.text === (right as { kind: 'text'; text: string }).text
    : left.dataUrl === (right as { kind: 'image'; dataUrl: string }).dataUrl;
}

/** 远程目标是否属于该 Connection：endpoint（含端口 / 用户）+ 远端路径都一致。 */
function sameRemoteWorkspace(
  ref: WorkspaceRef,
  target: Extract<ViewerWatchTarget, { kind: 'remote' }>,
): boolean {
  if (ref.scheme !== 'ssh' || ref.path !== target.workspacePath || ref.endpoint === null) {
    return false;
  }
  return workspaceEndpointKey(ref) === workspaceEndpointKey({
    scheme: 'ssh',
    path: target.workspacePath,
    endpoint: target.endpoint,
  });
}
