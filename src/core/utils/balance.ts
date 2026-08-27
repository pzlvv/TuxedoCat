/**
 * DeepSeek 余额查询工具
 * 调用 https://api.deepseek.com/user/balance API 获取账户余额
 */

import { fetch as undiciFetch } from 'undici';
import { getConfig } from '../llm/config.js';
import { getLLMDispatcher } from '../llm/httpDispatcher.js';
import { logger } from '../Logger.js';

export interface BalanceInfo {
  /** 账户总余额 */
  totalBalance: number;
  /** 是否无限额度（订阅制） */
  isUnlimited: boolean;
  /** 货币类型 */
  currency: string;
  /** 查询时间戳 */
  fetchedAt: number;
}

/**
 * 查询 DeepSeek 账户余额
 * @returns 余额信息，查询失败则返回 null
 */
export async function fetchBalance(sessionId?: string): Promise<BalanceInfo | null> {
  try {
    const config = await getConfig(sessionId);
    if (!config.apiKey) {
      logger.warn('fetchBalance', 'No API key configured, skipping balance fetch');
      return null;
    }

    const response = await undiciFetch('https://api.deepseek.com/user/balance', {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      dispatcher: getLLMDispatcher(),
    });

    if (!response.ok) {
      logger.warn('fetchBalance', `Balance API failed: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = await response.json() as Record<string, unknown>;
    logger.info('fetchBalance', `Balance response: ${JSON.stringify(data)}`);

    // DeepSeek balance API 返回格式: { "balance_infos": [{ "total_balance": "xxx", "currency": "xxx", "topped_up_balance": "xxx", "granted_balance": "xxx" }], "is_available": true }
    const balanceInfos = data.balance_infos as Array<Record<string, unknown>> | undefined;
    if (!balanceInfos || balanceInfos.length === 0) {
      logger.warn('fetchBalance', 'No balance info in response');
      return null;
    }

    const firstBalance = balanceInfos[0];
    return {
      totalBalance: parseFloat(String(firstBalance.total_balance || '0')),
      isUnlimited: (data as any).is_unlimited === true,
      currency: String(firstBalance.currency || 'CNY'),
      fetchedAt: Date.now(),
    };
  } catch (error) {
    logger.warn('fetchBalance', `Failed to fetch balance: ${error}`);
    return null;
  }
}
