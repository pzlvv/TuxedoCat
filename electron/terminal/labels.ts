/**
 * 远程终端页面的文案（docs/hosts/electron-multi-workspace.md 第 14 节）。主进程经 loadFile query 传 locale，页面按它选字典；
 * 形态对齐 `electron/remoteWorkspace/labels.ts`。
 */

export interface TerminalLabels {
  /** 新建标签按钮的悬浮提示 */
  newTab: string;
  /** 标签 ✕ 的悬浮提示 */
  closeTab: string;
  /** 标签的运行 / 断开状态悬浮提示 */
  statusRunning: string;
  statusDisconnected: string;
  /** 断开态面板：标题 / 重连按钮 */
  disconnectedTitle: (target: string) => string;
  reconnect: string;
  /** connecting 态面板 */
  connectingHint: (target: string) => string;
}

export function getTerminalLabels(locale: string): TerminalLabels {
  if (locale === 'en') {
    return {
      newTab: 'New terminal tab',
      closeTab: 'Close tab',
      statusRunning: 'Running',
      statusDisconnected: 'Disconnected',
      disconnectedTitle: (target) => `Connection to ${target} was lost`,
      reconnect: 'Reconnect',
      connectingHint: (target) => `Connecting to ${target} …`,
    };
  }
  return {
    newTab: '新建终端标签',
    closeTab: '关闭标签',
    statusRunning: '运行中',
    statusDisconnected: '已断开',
    disconnectedTitle: (target) => `与 ${target} 的连接已断开`,
    reconnect: '重新连接',
    connectingHint: (target) => `正在连接 ${target} …`,
  };
}
