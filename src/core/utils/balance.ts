/**
 * DeepSeek 余额查询工具
 * 调用 https://api.deepseek.com/user/balance API 获取账户余额
 *
 * 服务地址固定为 DeepSeek 官方（DEEPSEEK_BASE_URL），Key 取 settings.json 中
 * 「api.deepseek.com」这个 provider 的 apiKey —— 与 active provider 无关。
 * 没有该 provider（或它没配 apiKey）时直接跳过，不发请求。
 */

import { fetch as undiciFetch } from 'undici';
import { getDeepSeekProviderApiKey, DEEPSEEK_BASE_URL } from '../llm/config.js';
import { getLLMDispatcher } from '../llm/httpDispatcher.js';
import { formatErrorChain } from '../llm/shared.js';
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

/** 余额接口（DeepSeek 官方，路径挂在 baseURL 下） */
const BALANCE_URL = `${DEEPSEEK_BASE_URL}/user/balance`;

/** 「没有 api.deepseek.com provider」这条提示只打一次，避免每次工具调用后刷屏 */
let skipReasonLogged = false;

/**
 * 查询 DeepSeek 账户余额
 * @returns 余额信息；未配置 api.deepseek.com provider 或查询失败则返回 null
 */
export async function fetchBalance(): Promise<BalanceInfo | null> {
  try {
    // 只认 api.deepseek.com 这个 provider 的 Key：其它网关的 Key 查不了 DeepSeek 余额
    const apiKey = await getDeepSeekProviderApiKey();
    if (!apiKey) {
      if (!skipReasonLogged) {
        skipReasonLogged = true;
        logger.warn(
          'fetchBalance',
          'settings.json 中没有 api.deepseek.com provider（或未配置 apiKey），跳过余额查询',
        );
      }
      return null;
    }

    const response = await undiciFetch(BALANCE_URL, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
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
    logger.warn('fetchBalance', `Failed to fetch balance: ${formatErrorChain(error)}`);
    return null;
  }
}
