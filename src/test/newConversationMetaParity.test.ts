/**
 * 对等测试：新建会话的 meta.json（标题 + 模型身份）。
 *
 * Embedded（`appendMessage` → `updateMetadataForNewMessage`）的口径：
 * - 标题：文本优先（前 50 code unit）；仅图片时优先用消息顶层 `imageSizes` 里第一张
 *   「有宽高」的图片生成 `Image[<width>*<height>]`，缺失时退化 `Image`；`imageSizes`
 *   只与**有效图片**（能解析出 dataUrl 的 image block）按出现顺序一一对应。
 * - 模型身份：只在会话运行时已有模型身份（`engine.modelRefOverride`）时才写
 *   `model` / `provider`；否则不写该键（也不能写 `null`），让宿主回退到活动 provider
 *   的默认模型。
 *
 * Standalone 侧同一行为由 `core-rs/src/history_tests.rs`
 * （`derive_title_uses_image_size_for_image_only_messages`）与
 * `core-rs/src/engine_tests.rs`
 * （`first_message_creates_meta_json_with_the_session_model_only_when_chosen`）覆盖。
 *
 * 运行方式：npm run test:all -- new-conversation-meta-parity
 */

import * as fs from 'fs';
import * as path from 'path';
import { createEventBus } from '../host/EventBus';
import { setGlobalEventBus, resetGlobalEventBus } from '../core/AssistantEventBus';
import { createChecker, runTests } from './helpers/harness';
import { createRecordingCoreEventHandlers, makeTempDir } from './helpers/fixtures';
import { setSessionWorkspace, getProjectConversationDir } from '../core/history/Config';
import { appendMessage } from '../core/history/Conversation';
import { sessionEngines } from '../core/QueryEngine';

const IMAGE_BLOCK = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'aGk=' },
};

/** 用真实 `appendMessage` 落一条用户消息，读回 meta.json */
async function metaAfterAppend(
  projectRoot: string,
  sessionId: string,
  message: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // 会话工作目录按会话登记（core 按会话解析目录的唯一来源）
  setSessionWorkspace(sessionId, projectRoot);
  await appendMessage(message as never, sessionId);
  const metaPath = path.join(getProjectConversationDir(projectRoot), `${sessionId}.meta.json`);
  return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
}

async function titleAfterAppend(
  projectRoot: string,
  sessionId: string,
  message: Record<string, unknown>,
): Promise<string> {
  const meta = await metaAfterAppend(projectRoot, sessionId, message);
  return typeof meta.title === 'string' ? meta.title : '';
}

function imageOnlyMessage(imageSizes?: unknown): Record<string, unknown> {
  const message: Record<string, unknown> = {
    type: 'user',
    message: { role: 'user', content: [IMAGE_BLOCK] },
  };
  if (imageSizes !== undefined) {
    message.imageSizes = imageSizes;
  }
  return message;
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  const bus = createEventBus();
  bus.onCoreEvents(createRecordingCoreEventHandlers().handlers);
  setGlobalEventBus(bus);
  const root = makeTempDir('new-conversation-meta-parity');

  // ===== 标题：图片尺寸 =====
  check(
    '仅图片 + 宽高：Image[<w>*<h>]',
    (await titleAfterAppend(root, 's1', imageOnlyMessage([{ width: 800, height: 600 }]))) ===
      'Image[800*600]',
  );

  check(
    '仅图片 + 宽高缺失：退化 Image',
    (await titleAfterAppend(root, 's2', imageOnlyMessage())) === 'Image',
  );

  check(
    '宽高为 0：退化 Image',
    (await titleAfterAppend(root, 's3', imageOnlyMessage([{ width: 0, height: 0 }]))) === 'Image',
  );

  check(
    '文本优先于图片尺寸',
    (await titleAfterAppend(root, 's4', {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '看这张图' }, IMAGE_BLOCK] },
      imageSizes: [{ width: 800, height: 600 }],
    })) === '看这张图',
  );

  check(
    'imageSizes 只与有效图片对齐（无效图片不占位）',
    (await titleAfterAppend(root, 's5', {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'url', url: 'x' } },
          IMAGE_BLOCK,
        ],
      },
      imageSizes: [{ width: 10, height: 20 }, { width: 800, height: 600 }],
    })) === 'Image[10*20]',
  );

  check(
    'imageSizes[0] 缺失时按有效图片下标取（不拿第 2 项配第 1 张图）',
    (await titleAfterAppend(root, 's6', {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'url', url: 'x' } },
          IMAGE_BLOCK,
        ],
      },
      imageSizes: [null, { width: 800, height: 600 }],
    })) === 'Image',
  );

  // ===== 模型身份 =====
  // 注册一个普通引擎（promptPresetId 缺省 normal）：`updateMetadataForNewMessage`
  // 会按 `if (!metadata.context?.promptMode)` 从引擎补写 promptMode。
  sessionEngines.set('s7', { promptPresetId: 'normal' } as never);
  let plainMeta: Record<string, unknown>;
  try {
    plainMeta = await metaAfterAppend(root, 's7', {
      type: 'user',
      message: { role: 'user', content: '你好' },
    });
  } finally {
    sessionEngines.delete('s7');
  }
  check('会话没有模型身份时不写 model 键', !('model' in plainMeta));
  check('会话没有模型身份时不写 provider 键', !('provider' in plainMeta));
  // 对齐 `updateMetadataForNewMessage`：meta.json 的 context.promptMode 缺省补 normal
  check(
    '新 meta.json 的 context.promptMode 缺省补 normal',
    (plainMeta.context as { promptMode?: string } | undefined)?.promptMode === 'normal',
  );

  // 会话已有模型身份（engine.modelRefOverride）：meta.json 记录 model + provider
  sessionEngines.set('s8', {
    modelRefOverride: { provider: 'fake', model: 'other-model' },
  } as never);
  try {
    const chosenMeta = await metaAfterAppend(root, 's8', {
      type: 'user',
      message: { role: 'user', content: '你好' },
    });
    check('已选模型时写入 model', chosenMeta.model === 'other-model');
    check('已选模型时写入 provider', chosenMeta.provider === 'fake');
  } finally {
    sessionEngines.delete('s8');
  }

  resetGlobalEventBus();
  finish();
}

runTests('new-conversation-meta-parity', run);
