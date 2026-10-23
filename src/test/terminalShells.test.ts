/**
 * 单测：远程终端的标签 / 通道状态机（`electron/terminalShells.ts`，docs/hosts/electron-multi-workspace.md 第 14 节）。
 *
 * 用假通道驱动（不连真实 SSH；真实通路按 US-42 口径豁免，见
 * `docs/features/user-stories.md` 的未覆盖段）：
 * - 生命周期：建标签（号递增、connecting→ready）、closeTab、dispose；
 * - 数据面：键入写通道与背压（write false → 等 drain → flush）、输出字节流转发；
 * - 结束语义：`exit` → `close` 判「正常退出」自动关标签；无 `exit` 的 `close`
 *   判「连接断开」转断开态（原因取通道 error，缺省给固定文案）；reconnect 重建；
 * - 时序边界：resize 早于就绪（记账补齐）、connecting 期键入丢弃、关标签后的迟到事件；
 * - 纯函数：`canOpenRemoteTerminal` / `terminalFontSizePx` / 三个 IPC 载荷校验。
 *
 * 运行方式：npm run test:all -- terminal-shells
 */

import { createChecker, runTests } from './helpers/harness';
import {
  TerminalSessionGroup,
  canOpenRemoteTerminal,
  terminalFontSizePx,
  parseTerminalSize,
  parseTabId,
  parseTerminalInput,
  type TerminalChannel,
  type TerminalSize,
  type TerminalTab,
} from '../../electron/terminalShells';
import { localWorkspaceRef, remoteWorkspaceRef } from '../host/workspaceRef';

/** 可编程的假通道：记录写与 resize，测试用 emit* 驱动事件 */
class FakeChannel implements TerminalChannel {
  readonly writes: string[] = [];
  readonly resizes: TerminalSize[] = [];
  destroyed = false;
  private writeOk = true;
  private drainListener: (() => void) | null = null;
  private dataListeners: ((chunk: Uint8Array) => void)[] = [];
  private errorListeners: ((message: string) => void)[] = [];
  private remoteExitListeners: (() => void)[] = [];
  private closeListeners: (() => void)[] = [];

  write(data: string): boolean {
    this.writes.push(data);
    return this.writeOk;
  }

  onceDrain(listener: () => void): void {
    this.drainListener = listener;
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    this.dataListeners.push(listener);
  }

  onError(listener: (message: string) => void): void {
    this.errorListeners.push(listener);
  }

  onRemoteExit(listener: () => void): void {
    this.remoteExitListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  resize(rows: number, cols: number): void {
    this.resizes.push({ cols, rows });
  }

  destroy(): void {
    this.destroyed = true;
  }

  /** 测试驱动：切写满 / 可写状态 */
  setWriteOk(ok: boolean): void {
    this.writeOk = ok;
  }

  emitDrain(): void {
    this.drainListener?.();
    this.drainListener = null;
  }

  emitData(text: string): void {
    const bytes = new TextEncoder().encode(text);
    for (const listener of this.dataListeners) listener(bytes);
  }

  emitError(message: string): void {
    for (const listener of this.errorListeners) listener(message);
  }

  emitRemoteExit(): void {
    for (const listener of this.remoteExitListeners) listener();
  }

  emitClose(): void {
    for (const listener of this.closeListeners) listener();
  }
}

/** 状态机夹具：openChannel 返回手工 settle 的延迟 promise */
function makeGroup() {
  const deferreds: { resolve: (channel: TerminalChannel) => void; reject: (err: Error) => void }[] = [];
  const channels: FakeChannel[] = [];
  const tabHistory: TerminalTab[][] = [];
  const outputs: { tabId: number; data: Uint8Array }[] = [];
  const group = new TerminalSessionGroup({
    openChannel: (size) => new Promise<TerminalChannel>((resolve, reject) => {
      void size;
      deferreds.push({ resolve, reject });
    }),
    onTabsChanged: (tabs) => tabHistory.push(tabs.map((tab) => ({ ...tab }))),
    onOutput: (tabId, data) => outputs.push({ tabId, data }),
    log: () => {},
  });
  return {
    group,
    channels,
    tabHistory,
    outputs,
    /** 把最早一个待建的通道兑现成新假通道 */
    settle(): FakeChannel {
      const deferred = deferreds.shift();
      if (!deferred) throw new Error('no pending openChannel');
      const channel = new FakeChannel();
      channels.push(channel);
      deferred.resolve(channel);
      return channel;
    },
    failWith(error: Error): void {
      const deferred = deferreds.shift();
      if (!deferred) throw new Error('no pending openChannel');
      deferred.reject(error);
    },
  };
}

const SIZE = { cols: 80, rows: 24 };

/** 开一个标签并把它的建链兑现成假通道（newTab 的 promise 要等 settle 才落定） */
async function openTab(fx: ReturnType<typeof makeGroup>, size: TerminalSize = SIZE): Promise<FakeChannel> {
  const opened = fx.group.newTab(size);
  const channel = fx.settle();
  await opened;
  return channel;
}

function sshRef(auth: { kind: 'sshPassword'; password: string } | null) {
  return remoteWorkspaceRef({ host: '10.0.0.1', port: 22, user: 'root', auth }, '/srv/demo');
}

runTests('terminalShells', async () => {
  const { check, finish } = createChecker();

  // ---------- 生命周期 ----------

  {
    const fx = makeGroup();
    const p1 = fx.group.newTab(SIZE);
    const p2 = fx.group.newTab(SIZE);
    fx.settle();
    fx.settle();
    await Promise.all([p1, p2]);
    const tabs = fx.group.listTabs();
    check('标签号自增且名为 bash N', tabs.length === 2
      && tabs[0].id === 1 && tabs[0].label === 'bash 1'
      && tabs[1].id === 2 && tabs[1].label === 'bash 2');
    check('建链后状态 ready、无失败原因', tabs.every((tab) => tab.status === 'ready' && tab.failure === null));
  }

  {
    const fx = makeGroup();
    const channel = await openTab(fx);
    fx.group.closeTab(1);
    check('closeTab 销毁通道并移除标签', channel.destroyed && fx.group.listTabs().length === 0);
  }

  {
    const fx = makeGroup();
    const channel = await openTab(fx);
    fx.group.dispose();
    check('dispose 销毁全部通道并清空标签表', channel.destroyed && fx.group.listTabs().length === 0);
  }

  // ---------- 数据面 ----------

  {
    const fx = makeGroup();
    const channel = await openTab(fx);
    fx.group.input(1, 'ls\r');
    check('键入原样写进通道', channel.writes.join('') === 'ls\r');
  }

  {
    const fx = makeGroup();
    const channel = await openTab(fx);
    channel.setWriteOk(false);
    fx.group.input(1, 'a');
    fx.group.input(1, 'b');
    check('通道写满时键入进缓冲', channel.writes.join('') === 'a' && channel.writes.length === 1);
    channel.setWriteOk(true);
    channel.emitDrain();
    check('drain 后缓冲整批 flush', channel.writes.join('') === 'ab');
    channel.setWriteOk(false);
    fx.group.input(1, 'c');
    channel.setWriteOk(true);
    channel.emitDrain();
    check('flush 中途再写满能重挂 drain 继续写', channel.writes.join('') === 'abc');
  }

  {
    const fx = makeGroup();
    const channel = await openTab(fx);
    channel.emitData('hello');
    check('通道输出以字节流转发给渲染端', fx.outputs.length === 1
      && fx.outputs[0].tabId === 1
      && new TextDecoder().decode(fx.outputs[0].data) === 'hello');
  }

  // ---------- 结束语义（FR-003 / FR-007） ----------

  {
    const fx = makeGroup();
    const channel = await openTab(fx);
    channel.emitRemoteExit();
    channel.emitClose();
    check('远端进程退出（exit→close）自动关标签', fx.group.listTabs().length === 0);
  }

  {
    const fx = makeGroup();
    const channel = await openTab(fx);
    channel.emitClose();
    const tabs = fx.group.listTabs();
    check('无 exit 的 close 判连接断开：转断开态带缺省原因', tabs.length === 1
      && tabs[0].status === 'disconnected'
      && tabs[0].failure !== null && tabs[0].failure.length > 0);
  }

  {
    const fx = makeGroup();
    const channel = await openTab(fx);
    channel.emitError('read ECONNRESET');
    channel.emitClose();
    check('断开原因优先取通道 error 文案', fx.group.listTabs()[0].failure === 'read ECONNRESET');
  }

  {
    const fx = makeGroup();
    const opened = fx.group.newTab(SIZE);
    fx.failWith(new Error('All authentication methods failed'));
    await opened;
    check('建链失败转断开态并带 opener 错误原因', fx.group.listTabs()[0].status === 'disconnected'
      && fx.group.listTabs()[0].failure === 'All authentication methods failed');
  }

  {
    const fx = makeGroup();
    await openTab(fx);
    fx.channels[0].emitClose();
    void fx.group.reconnect(1, SIZE);
    // 标签对象是活引用：connecting 这一瞬间的状态要立刻取值
    const statusDuringReconnect = fx.group.listTabs()[0].status;
    const channel = fx.settle();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    check('reconnect 重建通道并回到 ready', statusDuringReconnect === 'connecting'
      && fx.group.listTabs()[0].status === 'ready'
      && fx.channels.length === 2 && channel.writes.length === 0);
    fx.group.input(1, 'x');
    check('重连后的通道可输入', channel.writes.join('') === 'x');
  }

  {
    const fx = makeGroup();
    const channel = await openTab(fx);
    void fx.group.reconnect(1, SIZE);
    check('非断开态的 reconnect 是 no-op（渲染端迟到消息）', fx.channels.length === 1 && !channel.destroyed);
  }

  // ---------- 时序边界 ----------

  {
    const fx = makeGroup();
    const pending = fx.group.newTab(SIZE);
    fx.group.input(1, 'early');
    fx.group.resize(1, { cols: 100, rows: 30 });
    const channel = fx.settle();
    await pending;
    check('connecting 期键入丢弃、resize 记账后补齐', channel.writes.length === 0
      && channel.resizes.length === 1
      && channel.resizes[0].cols === 100 && channel.resizes[0].rows === 30);
  }

  {
    const fx = makeGroup();
    const channel = await openTab(fx);
    fx.group.closeTab(1);
    const outputsBefore = fx.outputs.length;
    channel.emitData('late');
    check('关标签后的通道输出不再转发', fx.outputs.length === outputsBefore && channel.destroyed);
  }

  // ---------- 纯函数 ----------

  check('canOpenRemoteTerminal：远程带口令凭证可用', canOpenRemoteTerminal(sshRef({ kind: 'sshPassword', password: 'pw' })));
  check('canOpenRemoteTerminal：本地工作区不可用', !canOpenRemoteTerminal(localWorkspaceRef('/tmp')));
  check('canOpenRemoteTerminal：远程无凭证不可用', !canOpenRemoteTerminal(sshRef(null)));
  check('canOpenRemoteTerminal：未打开工作区不可用', !canOpenRemoteTerminal(undefined));

  check('字号映射：medium/large/xlarge/缺省', terminalFontSizePx('medium') === 14
    && terminalFontSizePx('large') === 16
    && terminalFontSizePx('xlarge') === 18
    && terminalFontSizePx(undefined) === 14);

  check('载荷校验：合法尺寸', parseTerminalSize({ cols: 80.9, rows: 24 }).cols === 80
    && parseTerminalSize({ cols: 80.9, rows: 24 }).rows === 24);
  check('载荷校验：非法尺寸抛错', (() => {
    try {
      parseTerminalSize({ cols: -1, rows: 0 });
      return false;
    } catch {
      return true;
    }
  })());
  check('载荷校验：标签 id 必须正整数', parseTabId(3) === 3 && (() => {
    try {
      parseTabId(0);
      return false;
    } catch {
      return true;
    }
  })());
  check('载荷校验：键入必须带字符串 data', parseTerminalInput({ tabId: 1, data: 'x' }).data === 'x' && (() => {
    try {
      parseTerminalInput({ tabId: 1 });
      return false;
    } catch {
      return true;
    }
  })());

  finish();
});
