/**
 * 单测：provider key（服务商身份）的推导规则
 * （`docs/architecture/core-ui-separation.md` 第 4.3 节）。
 *
 * 锁住四件事：
 * 1. **端口进身份**——同一主机不同端口是两个服务商（面板判重、写盘建键、会话模型
 *    身份都取这个值，规则漂了会出现「配了两个本地模型只剩一个」）；
 * 2. 协议默认端口省略——`https://a:443` 与 `https://a` 是同一个键，不分裂身份；
 * 3. 路径与查询串不进身份——同一网关的 `/v1` 与 `/anthropic` 仍是一家；
 * 4. 非法 URL 的兜底分支与 URL 解析分支同口径（也保留端口）。
 *
 * 运行方式：npm run test:unit -- providerKey
 */

import { createChecker, runTests } from './helpers/harness';
import { providerKeyFromBaseURL } from '../shared/utils/providerKey';

function run(): void {
  const { check, finish } = createChecker();

  // ---- 1. 端口是身份的一部分 ----
  check(
    '同主机不同端口推出两个键',
    providerKeyFromBaseURL('http://127.0.0.1:11434/v1') === '127.0.0.1:11434'
      && providerKeyFromBaseURL('http://127.0.0.1:11435/v1') === '127.0.0.1:11435',
  );
  check(
    'localhost 带端口进键',
    providerKeyFromBaseURL('http://localhost:1234/v1') === 'localhost:1234',
  );
  check(
    '非默认端口即使写在 https 上也保留',
    providerKeyFromBaseURL('https://gateway.example:8443/v1') === 'gateway.example:8443',
  );

  // ---- 2. 协议默认端口省略，不分裂身份 ----
  check(
    'https 默认端口与不写端口同键',
    providerKeyFromBaseURL('https://api.deepseek.com:443/v1')
      === providerKeyFromBaseURL('https://api.deepseek.com/v1'),
  );
  check(
    'http 默认端口与不写端口同键',
    providerKeyFromBaseURL('http://127.0.0.1:80/v1') === '127.0.0.1',
  );
  check('无端口时键就是主机名', providerKeyFromBaseURL('https://api.deepseek.com/v1') === 'api.deepseek.com');

  // ---- 3. 路径与查询串不进身份 ----
  check('去掉路径', providerKeyFromBaseURL('https://opencode.ai/zen/go') === 'opencode.ai');
  check(
    '同主机同端口的不同路径同键',
    providerKeyFromBaseURL('https://gateway.example/v1') === providerKeyFromBaseURL('https://gateway.example/anthropic'),
  );
  check('小写化主机名', providerKeyFromBaseURL('  https://API.DeepSeek.COM/V1  ') === 'api.deepseek.com');
  check('IPv6 主机带端口', providerKeyFromBaseURL('http://[::1]:11434/v1') === '[::1]:11434');

  // ---- 4. 非法 URL 的兜底分支同口径 ----
  check('缺协议时保留端口', providerKeyFromBaseURL('127.0.0.1:11434/v1') === '127.0.0.1:11434');
  check('缺协议时去掉路径', providerKeyFromBaseURL('api.deepseek.com/v1') === 'api.deepseek.com');
  check('localhost 样式串（URL 解析取不到主机）走兜底并保留端口', providerKeyFromBaseURL('localhost:11434') === 'localhost:11434');
  check('空输入返回空串', providerKeyFromBaseURL('   ') === '');
  check('只有协议没有主机返回空串', providerKeyFromBaseURL('https://') === '');

  finish();
}

runTests('providerKey', run);
