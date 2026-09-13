/**
 * 余额查询并推送到 UI 的共享实现。
 *
 * 三个版本（webviewMessageHandler / VSCodeUI / ElectronUI）原为三份拷贝；
 * 推送通道（postToWebview / host.sendToWebview）由宿主注入。
 */

/** 推送通道：由宿主注入（VSCodeUI.postToWebview / ElectronUI.postToWebview / host.sendToWebview） */
export type BalancePush = (message: Record<string, unknown>) => void;

/** 宿主日志通道（VSCodeUI.outputChannel / ElectronUI.log） */
export type BalanceLog = (message: string) => void;

/**
 * 查询 DeepSeek 账户余额并推送 balanceUpdate 消息。
 * 统一行为：查询失败（返回 null）时回推 totalBalance: null 清空 webview 余额显示，
 * 避免继续展示旧值（与 webviewMessageHandler 版本一致，最正确的行为）。
 */
export function fetchBalanceAndPush(sessionId: string, push: BalancePush, log?: BalanceLog): void {
  import('../utils/balance.js').then(({ fetchBalance }) => {
    fetchBalance(sessionId).then(balanceInfo => {
      let message: Record<string, unknown>;
      if (balanceInfo) {
        message = {
          type: 'balanceUpdate',
          totalBalance: balanceInfo.totalBalance,
          currency: balanceInfo.currency,
          isUnlimited: balanceInfo.isUnlimited,
          fetchedAt: balanceInfo.fetchedAt,
        };
      } else {
        // 获取余额失败时清空余额，避免 webview 继续显示旧值
        message = {
          type: 'balanceUpdate',
          totalBalance: null,
          currency: null,
          isUnlimited: null,
          fetchedAt: Date.now(),
        };
      }
      push(message);
    }).catch((err: unknown) => {
      log?.(`Failed to fetch balance: ${err}`);
    });
  }).catch((err: unknown) => {
    log?.(`Failed to import balance module: ${err}`);
  });
}
