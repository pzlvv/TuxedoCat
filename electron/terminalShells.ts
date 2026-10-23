/**
 * 远程终端的标签 / 通道状态机（docs/hosts/electron-multi-workspace.md 第 14 节）。
 *
 * 纯 TS：不 import electron / ssh2。通道经 `TerminalChannel` 窄接口注入
 * （ssh2 `ClientChannel` 的适配在 `electron/terminalWindow.ts`），打开方式经
 * `openChannel` 注入——将来接本地 PTY 只换注入方（本地终端是 specs/022 的非目标）。
 *
 * 标签事实的 owner 在这里：状态每次变化整表经 `onTabsChanged` 推出，渲染端是
 * 纯投影、不回写状态（docs/hosts/electron-multi-workspace.md 第 14.8 节）。两种结束语义（FR-003 / FR-007）：
 * - 远端 shell 进程退出（`onRemoteExit`，ssh2 的 `exit`）→ 标签自动关闭；
 * - 连接层断开（无 `exit` 先行的 `onClose`，或 opener 失败）→ 标签转断开态 + 原因，
 *   等用户手动 `reconnect`，不自动重连。
 */

import type { WorkspaceRef } from '../src/host/workspaceRef.js';

/** 终端尺寸（PTY 的列 / 行） */
export interface TerminalSize {
  cols: number;
  rows: number;
}

export type TerminalTabStatus = 'connecting' | 'ready' | 'disconnected';

export interface TerminalTab {
  /** 窗口内自增 id（从 1 起） */
  id: number;
  /** 展示名：`bash N` */
  label: string;
  status: TerminalTabStatus;
  /** `disconnected` 时的原因；其余状态恒 `null`（契约成员全必选，不用 `?`） */
  failure: string | null;
}

/**
 * 一条 shell 通道的窄接口（ssh2 `ClientChannel` 的投影）。
 *
 * 数据是字节流：`onData` 交给渲染端 xterm 增量解码 UTF-8，宿主不重组
 * （docs/hosts/electron-multi-workspace.md 第 14.4 节）。
 */
export interface TerminalChannel {
  /** 返回 false 表示通道写满：调用方等 `onceDrain` 后续写 */
  write(data: string): boolean;
  onceDrain(listener: () => void): void;
  onData(listener: (chunk: Uint8Array) => void): void;
  /** 通道层错误（ssh2 的 `error` 事件；`close` 无参，断开原因从这里记） */
  onError(listener: (message: string) => void): void;
  /** 远端 shell 进程退出（ssh2 的 `exit`；SSH 规范里该事件可选，可能不来） */
  onRemoteExit(listener: () => void): void;
  /** 通道完全关闭（ssh2 的 `close`）：正常退出与连接断开都会走到 */
  onClose(listener: () => void): void;
  resize(rows: number, cols: number): void;
  /** 主动结束通道：尽力发 SIGHUP（远端 Windows sshd 不支持则失败被忽略），再发 EOF */
  destroy(): void;
}

/** 打开一条新 shell 通道（cwd 绑定在实现里，状态机不感知路径） */
export type TerminalChannelOpener = (size: TerminalSize) => Promise<TerminalChannel>;

export interface TerminalSessionGroupDeps {
  openChannel: TerminalChannelOpener;
  /** 标签表变化（整表快照；dispose 后推空表） */
  onTabsChanged(tabs: readonly TerminalTab[]): void;
  /** 通道输出（字节流原样转发） */
  onOutput(tabId: number, data: Uint8Array): void;
  log: (...args: unknown[]) => void;
}

interface TabEntry {
  tab: TerminalTab;
  channel: TerminalChannel | null;
  /** 通道背压中：`write` 返回 false 后直到 drain，期间的键入先缓冲（不丢键入） */
  backpressured: boolean;
  /** 背压期间待写的按键 */
  pendingInput: string[];
  /** resize 早于通道就绪时记在这里，就绪后补对齐（docs/hosts/electron-multi-workspace.md 第 14.4 节边界） */
  pendingResize: TerminalSize | null;
  /** 已收到 `onRemoteExit`：随后到来的 `onClose` 据此判定「正常退出」 */
  remoteExited: boolean;
  /** 通道 `onError` 记下的原因（`onClose` 无参，断开原因优先用它） */
  errorReason: string | null;
  /** 标签已关闭：迟到的通道事件与输出全部丢弃 */
  closed: boolean;
}

/** 一个终端窗口的全部标签与通道（docs/hosts/electron-multi-workspace.md 第 14.3 节：每标签一条独立通道） */
export class TerminalSessionGroup {
  private readonly deps: TerminalSessionGroupDeps;
  private readonly entries = new Map<number, TabEntry>();
  private nextId = 1;

  constructor(deps: TerminalSessionGroupDeps) {
    this.deps = deps;
  }

  /** 当前标签表快照（窗口层判断「最后一个标签已关 → 关窗口」用） */
  listTabs(): TerminalTab[] {
    return [...this.entries.values()].map((entry) => entry.tab);
  }

  async newTab(size: TerminalSize): Promise<void> {
    const id = this.nextId++;
    const entry: TabEntry = {
      tab: { id, label: `bash ${id}`, status: 'connecting', failure: null },
      channel: null,
      backpressured: false,
      pendingInput: [],
      pendingResize: null,
      remoteExited: false,
      errorReason: null,
      closed: false,
    };
    this.entries.set(id, entry);
    this.notifyTabs();
    await this.startChannel(entry, size);
  }

  /** 键入转发到通道 stdin */
  input(tabId: number, data: string): void {
    const entry = this.entries.get(tabId);
    if (!entry || entry.closed) return; // 渲染端迟到消息（标签已关），丢弃
    const channel = entry.channel;
    // connecting / disconnected 期间没有可写通道：界面上该标签不在可输入态，
    // 丢弃是设计允许的瞬时 no-op（docs/hosts/electron-multi-workspace.md 第 14.6 节：断开态不缓存输入）
    if (!channel) return;
    if (entry.backpressured) {
      entry.pendingInput.push(data);
      return;
    }
    if (channel.write(data)) return;
    // write 返回 false：本次数据已被通道接收（排队），只是背压——不重写它，
    // 只把 drain 前再来的键入缓冲住
    entry.backpressured = true;
    channel.onceDrain(() => this.flushPending(entry));
  }

  /** 渲染端窗口尺寸变化 → 同步远端 PTY（docs/hosts/electron-multi-workspace.md 第 14.4 节） */
  resize(tabId: number, size: TerminalSize): void {
    const entry = this.entries.get(tabId);
    if (!entry || entry.closed) return;
    const channel = entry.channel;
    if (!channel) {
      entry.pendingResize = size;
      return;
    }
    channel.resize(size.rows, size.cols);
  }

  /** 关闭一个标签（用户点 ✕ 或远端正常退出的收尾） */
  closeTab(tabId: number): void {
    const entry = this.entries.get(tabId);
    if (!entry || entry.closed) return;
    entry.closed = true;
    const channel = entry.channel;
    entry.channel = null;
    channel?.destroy();
    this.entries.delete(tabId);
    this.notifyTabs();
  }

  /** 手动重连（docs/hosts/electron-multi-workspace.md 第 14.6 节：只对断开态标签有意义，不自动触发） */
  async reconnect(tabId: number, size: TerminalSize): Promise<void> {
    const entry = this.entries.get(tabId);
    // 界面只对断开态标签给出重连按钮；其余状态收到本消息是渲染端迟到的瞬时
    // 竞态，忽略是设计允许的 no-op
    if (!entry || entry.closed || entry.tab.status !== 'disconnected') return;
    entry.tab.status = 'connecting';
    entry.tab.failure = null;
    entry.remoteExited = false;
    entry.errorReason = null;
    entry.pendingResize = null;
    this.notifyTabs();
    await this.startChannel(entry, size);
  }

  /** 关闭全部标签与通道（窗口关闭 / 应用退出时） */
  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.closed = true;
      entry.channel?.destroy();
      entry.channel = null;
    }
    this.entries.clear();
    this.deps.onTabsChanged([]);
  }

  private async startChannel(entry: TabEntry, size: TerminalSize): Promise<void> {
    try {
      const channel = await this.deps.openChannel(size);
      if (entry.closed) {
        // 等待建链期间标签已被关掉：通道直接弃置，不上报状态
        channel.destroy();
        return;
      }
      entry.channel = channel;
      entry.tab.status = 'ready';
      channel.onData((data) => {
        if (!entry.closed) this.deps.onOutput(entry.tab.id, data);
      });
      channel.onError((message) => {
        entry.errorReason = message;
      });
      channel.onRemoteExit(() => {
        entry.remoteExited = true;
      });
      channel.onClose(() => this.onChannelClosed(entry));
      if (entry.pendingResize) {
        channel.resize(entry.pendingResize.rows, entry.pendingResize.cols);
        entry.pendingResize = null;
      }
      this.notifyTabs();
    } catch (err) {
      if (entry.closed) return;
      entry.tab.status = 'disconnected';
      entry.tab.failure = err instanceof Error ? err.message : String(err);
      this.notifyTabs();
      this.deps.log(`[terminal] shell channel failed (${entry.tab.label}):`, err);
    }
  }

  private onChannelClosed(entry: TabEntry): void {
    if (entry.closed) return;
    entry.channel = null;
    if (entry.remoteExited) {
      // 远端 shell 正常退出（用户敲了 exit / logout）：标签自动关闭（docs/hosts/electron-multi-workspace.md 第 14.3 节）；
      // 「最后一个标签关闭 → 关窗口」由窗口层观察标签表收口
      this.closeTab(entry.tab.id);
      return;
    }
    entry.tab.status = 'disconnected';
    entry.tab.failure = entry.errorReason ?? 'SSH 连接已断开';
    this.notifyTabs();
  }

  private flushPending(entry: TabEntry): void {
    const channel = entry.channel;
    if (!channel || entry.closed) {
      entry.pendingInput = [];
      entry.backpressured = false;
      return;
    }
    while (entry.pendingInput.length > 0) {
      const chunk = entry.pendingInput[0];
      if (!channel.write(chunk)) {
        // 又写满：onceDrain 已消费，重挂后等下一轮
        channel.onceDrain(() => this.flushPending(entry));
        return;
      }
      entry.pendingInput.shift();
    }
    entry.backpressured = false;
  }

  private notifyTabs(): void {
    this.deps.onTabsChanged(this.listTabs());
  }
}

/** 菜单可用性口径（docs/hosts/electron-multi-workspace.md 第 14.1 节）：活动工作区为远程且带可用凭证 */
export function canOpenRemoteTerminal(ref: WorkspaceRef | null | undefined): boolean {
  const endpoint = ref?.endpoint;
  return endpoint != null && endpoint.auth != null && endpoint.auth.kind === 'sshPassword';
}

export type TerminalFontSizePreference = 'medium' | 'large' | 'xlarge';

/** 字号档位 → 终端 px 的唯一映射（docs/hosts/electron-multi-workspace.md 第 14.8 节：同一字段的默认值只有一处） */
export function terminalFontSizePx(preference: TerminalFontSizePreference | undefined): number {
  switch (preference) {
    case 'large':
      return 16;
    case 'xlarge':
      return 18;
    default:
      return 14;
  }
}

// ---------- IPC 载荷校验（形状不对直接抛错：不过度 fallback，架构铁律 4.1） ----------

export function parseTerminalSize(raw: unknown): TerminalSize {
  if (raw === null || typeof raw !== 'object') throw new Error('malformed terminal size');
  const size = raw as Record<string, unknown>;
  if (
    typeof size.cols !== 'number' || !Number.isFinite(size.cols) || size.cols <= 0
    || typeof size.rows !== 'number' || !Number.isFinite(size.rows) || size.rows <= 0
  ) {
    throw new Error('malformed terminal size');
  }
  return { cols: Math.floor(size.cols), rows: Math.floor(size.rows) };
}

export function parseTabId(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new Error('malformed terminal tab id');
  }
  return raw;
}

export function parseTerminalInput(raw: unknown): { tabId: number; data: string } {
  if (raw === null || typeof raw !== 'object') throw new Error('malformed terminal input');
  const input = raw as Record<string, unknown>;
  if (typeof input.data !== 'string') throw new Error('malformed terminal input');
  return { tabId: parseTabId(input.tabId), data: input.data };
}

/** resize / reconnect 载荷：{ tabId, cols, rows } */
export function parseTerminalResize(raw: unknown): { tabId: number; size: TerminalSize } {
  if (raw === null || typeof raw !== 'object') throw new Error('malformed terminal resize');
  const payload = raw as Record<string, unknown>;
  return { tabId: parseTabId(payload.tabId), size: parseTerminalSize(payload) };
}
