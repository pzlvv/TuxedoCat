/**
 * 用户消息内容 / usage / meta 时间戳对等测试（Embedded ↔ Standalone）。
 *
 * 三个小口径，都是两侧必须逐字一致的：
 * 1. `buildUserContent`：`images?.filter((img) => img && img.dataUrl)` —— 空串 dataUrl
 *    是假值，不产出 image block；显式 `mediaType` 优先于 dataUrl 前缀。
 *    Standalone 侧见 `core-rs/src/engine.rs` 的 `build_user_message`，
 *    对应用例 `core-rs/src/engine_tests.rs` 的
 *    `build_user_message_skips_falsy_file_path_and_data_url`。
 * 2. `extractChatUsage`：OpenAI usage 恒带 cache 两键（缺省 0），
 *    `streamEnd` 事件的 usage 不能省略它们。Standalone 侧见 `core-rs/src/llm.rs`
 *    的 `Usage::to_json`，对应用例 `core-rs/src/llm_tests.rs` 的
 *    `usage_json_always_carries_cache_keys_and_omits_absent_reasoning`。
 * 3. `updateMetadataForNewMessage`：`updatedAt` 只由用户主动发送的消息
 *    （`_userInitiated`）刷新，后台自动消息只累加 `messageCount`。
 *    Standalone 侧见 `core-rs/src/history.rs` 的 `touch_metadata`，
 *    对应用例 `core-rs/src/history_tests.rs` 的
 *    `touch_metadata_keeps_updated_at_for_background_messages`。
 *
 * 运行方式：npm run test:all -- user-message-and-usage-parity
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createEventBus } from '../host/EventBus';
import { setGlobalEventBus, resetGlobalEventBus } from '../core/AssistantEventBus';
import { createChecker, runTests } from './helpers/harness';
import { createRecordingCoreEventHandlers, makeTempDir } from './helpers/fixtures';
import { setSessionWorkspace, getProjectConversationDir } from '../core/history/Config';
import { appendMessage } from '../core/history/Conversation';
import { buildUserContent } from '../core/utils/contentBlocks';
import { extractChatUsage } from '../core/llm/OpenAiApi';

const IMAGE_DATA_URL = 'data:image/png;base64,AAAA';

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // ===== 1. buildUserContent 的真值判定与 mediaType 优先级 =====
  check(
    '空串 dataUrl 被过滤：保留纯文本形态',
    buildUserContent('hi', [{ dataUrl: '' }]) === 'hi',
  );
  check(
    '无图片：保留纯文本形态',
    buildUserContent('hi', []) === 'hi',
  );
  {
    const blocks = buildUserContent('hi', [{ dataUrl: IMAGE_DATA_URL }]);
    assert.ok(Array.isArray(blocks));
    check('有图片：产出 text + image block', blocks.length === 2 && blocks[1].type === 'image');
    check(
      'image block 使用 dataUrl 里的 media_type',
      (blocks[1] as { source: { media_type: string } }).source.media_type === 'image/png',
    );
    check(
      'image block 使用 dataUrl 里的 data',
      (blocks[1] as { source: { data: string } }).source.data === 'AAAA',
    );
  }
  {
    const blocks = buildUserContent('', [
      { dataUrl: IMAGE_DATA_URL, mediaType: 'image/webp' },
      { dataUrl: '' },
    ]);
    assert.ok(Array.isArray(blocks));
    check('文本为空时不插入空 text block', blocks.length === 1 && blocks[0].type === 'image');
    check(
      '显式 mediaType 优先于 dataUrl 前缀',
      (blocks[0] as { source: { media_type: string } }).source.media_type === 'image/webp',
    );
  }

  // ===== 2. OpenAI usage 的 cache 键恒存在 =====
  {
    const usage = extractChatUsage({ prompt_tokens: 11, completion_tokens: 22 });
    assert.ok(usage);
    check('input_tokens 取自 prompt_tokens', usage.input_tokens === 11);
    check('output_tokens 取自 completion_tokens', usage.output_tokens === 22);
    check('缺省 cache_read_input_tokens 为 0', usage.cache_read_input_tokens === 0);
    check('缺省 cache_creation_input_tokens 为 0', usage.cache_creation_input_tokens === 0);
    check('没有 reasoning 明细时不带 reasoning_tokens', !('reasoning_tokens' in usage));
  }
  {
    const usage = extractChatUsage({
      prompt_tokens: 1,
      completion_tokens: 2,
      prompt_tokens_details: { cached_tokens: 3 },
      completion_tokens_details: { reasoning_tokens: 4 },
    });
    assert.ok(usage);
    check('cache_read_input_tokens 取 cached_tokens', usage.cache_read_input_tokens === 3);
    check('reasoning_tokens 取 reasoning_tokens', usage.reasoning_tokens === 4);
  }
  check('usage 缺失时返回 undefined', extractChatUsage(undefined) === undefined);

  // ===== 3. meta.json 的 updatedAt 只由用户主动消息刷新 =====
  const bus = createEventBus();
  bus.onCoreEvents(createRecordingCoreEventHandlers().handlers);
  setGlobalEventBus(bus);
  const root = makeTempDir('user-message-and-usage-parity');
  setSessionWorkspace('s1', root);
  try {
    const sessionId = 's1';
    const metaPath = path.join(getProjectConversationDir(root), `${sessionId}.meta.json`);

    await appendMessage(
      {
        type: 'user',
        message: { role: 'user', content: '你好' },
        uuid: 'u1',
        _userInitiated: true,
      } as never,
      sessionId,
    );
    const afterUser = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as {
      messageCount: number;
      updatedAt: number;
    };
    check('用户消息累加 messageCount', afterUser.messageCount === 1);
    check('用户消息刷新 updatedAt', afterUser.updatedAt > 1_600_000_000_000);

    // 后台自动消息（无 _userInitiated）：只累加计数，不动 updatedAt
    await appendMessage(
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: '收到' }] },
        uuid: 'a1',
      } as never,
      sessionId,
    );
    const afterAssistant = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as {
      messageCount: number;
      updatedAt: number;
    };
    check('后台消息累加 messageCount', afterAssistant.messageCount === 2);
    check('后台消息不刷新 updatedAt', afterAssistant.updatedAt === afterUser.updatedAt);
  } finally {
    resetGlobalEventBus();
    finish();
  }
}

runTests('user-message-and-usage-parity', run);
