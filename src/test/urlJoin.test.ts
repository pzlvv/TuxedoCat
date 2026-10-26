/**
 * 单测：LLM 端点 URL 的版本段拼接口径（`src/shared/llm/urlJoin.ts`）。
 *
 * 覆盖点：
 * - baseURL 无版本段时补 `/v1`；
 * - baseURL 已带纯数字版本段（`/v1`、智谱的 `/api/paas/v4`、未来的 `/v5`）时直接拼接端点；
 * - 非纯数字后缀（`/v1beta`）不算版本段，仍补 `/v1`。
 *
 * 为什么值得单测：Core（Rust 侧 `chat_completions_url` / `messages_url` / `build_responses_url`）
 * 与本文件是同一条拼接口径的两侧实现，漂移会表现成「探测能通、真实请求 404」。
 *
 * 运行方式：npm run test:all -- urlJoin
 */

import { joinV1Path } from '../shared/llm/urlJoin';
import { createChecker, runTests } from './helpers/harness';

runTests('urlJoin', () => {
  const { check, finish } = createChecker();

  check(
    '无版本段补 /v1',
    joinV1Path('https://api.deepseek.com', 'chat/completions') === 'https://api.deepseek.com/v1/chat/completions'
  );
  check(
    '尾斜杠被去掉后再补 /v1',
    joinV1Path('https://api.deepseek.com//', 'chat/completions') === 'https://api.deepseek.com/v1/chat/completions'
  );
  check(
    '已有 /v1 不重复补',
    joinV1Path('https://api.deepseek.com/v1', 'chat/completions') === 'https://api.deepseek.com/v1/chat/completions'
  );
  check(
    '智谱 /v4 直接复用',
    joinV1Path('https://open.bigmodel.cn/api/paas/v4', 'chat/completions')
      === 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
  );
  check(
    '智谱 /v4 尾斜杠同样复用',
    joinV1Path('https://open.bigmodel.cn/api/paas/v4/', 'messages')
      === 'https://open.bigmodel.cn/api/paas/v4/messages'
  );
  check(
    '未来 /v5 /v6 按数字匹配',
    joinV1Path('https://api.example.com/v5', 'responses') === 'https://api.example.com/v5/responses'
      && joinV1Path('https://api.example.com/v6', 'responses') === 'https://api.example.com/v6/responses'
  );
  check(
    '/v1beta 不算版本段',
    joinV1Path('https://api.example.com/v1beta', 'responses')
      === 'https://api.example.com/v1beta/v1/responses'
  );

  finish();
});
