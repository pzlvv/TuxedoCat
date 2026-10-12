/**
 * 回归测试：对话模型身份的落盘与恢复（specs/006 FR-006 / AC-13–AC-15）。
 *
 * 把两段已有实现拼成一条可回归的链：
 * - 落盘：`appendMessage` → `updateMetadataForNewMessage` 把会话运行时的模型身份
 *   （`engine.modelRefOverride`）写进 `meta.json` 顶层 `model` / `provider`；
 * - 恢复：`getConversationModelRef(meta)` 组装身份 → 宿主 `resolveModelRef(快照, 身份)`
 *   按当前配置校验，失效时回退默认模型。
 *
 * 覆盖四条口径：
 * 1. 身份合法 → 原样恢复；
 * 2. 记录的 model 不在该 provider 的模型列表 → 回退该 provider 的默认模型；
 * 3. 记录的 provider 已从配置移除 → 回退 active provider 的默认模型；
 * 4. `meta.json` 未记录身份 → 取 active provider 的默认模型（不回写）。
 *
 * 另外锁定「回退结果写回 `meta.json`」这一半：`updateConversationContext` 把解析后的
 * 身份写进顶层字段，再次加载时读到的就是回退后的身份。
 *
 * 运行方式：npm run test:all -- session-model-restore
 */

import * as fs from 'fs';
import * as path from 'path';
import { createEventBus } from '../host/EventBus';
import { setGlobalEventBus, resetGlobalEventBus } from '../core/AssistantEventBus';
import { createChecker, runTests } from './helpers/harness';
import { createRecordingCoreEventHandlers, makeTempDir } from './helpers/fixtures';
import { setSessionWorkspace, getProjectConversationDir } from '../core/history/Config';
import {
  appendMessage,
  getConversationModelRef,
  updateConversationContext,
} from '../core/history/Conversation';
import { sessionEngines } from '../core/QueryEngine';
import { resolveSettingsSnapshot } from '../core/settingsSnapshot';
import { resolveModelRef } from '../host/settingsRead';

/** 两份 provider 的配置：openrouter 有非默认模型 a/one，deepseek 是 active provider */
function rawSettings(): Record<string, unknown> {
  return {
    llm: {
      activeProvider: 'api.deepseek.com',
      providers: {
        'api.deepseek.com': {
          baseURL: 'https://api.deepseek.com',
          apiKey: 'sk-deepseek',
          models: ['deepseek-chat'],
        },
        'openrouter.ai': {
          baseURL: 'https://openrouter.ai/api/v1',
          apiKey: 'sk-or',
          models: ['a/one', 'b/two'],
          defaultModel: 'b/two',
        },
      },
    },
    defaultAgentMode: 'risk',
    defaultPromptMode: 'normal',
    mcp: { enabled: [] },
  };
}

function readMeta(projectRoot: string, sessionId: string): Record<string, unknown> {
  const metaPath = path.join(getProjectConversationDir(projectRoot), `${sessionId}.meta.json`);
  return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
}

/** 用真实 `appendMessage` 落一条用户消息（引擎桩提供会话模型身份），读回 meta.json */
async function appendWithModel(
  projectRoot: string,
  sessionId: string,
  modelRef: { provider: string; model: string } | null,
): Promise<Record<string, unknown>> {
  setSessionWorkspace(sessionId, projectRoot);
  sessionEngines.set(sessionId, {
    getMetaSnapshot: () => ({
      promptPresetId: 'normal',
      // 无模型身份时（null）不写 model / provider（对齐 updateMetadataForNewMessage）
      ...(modelRef ? { modelRefOverride: modelRef } : {}),
    }),
  } as never);
  try {
    await appendMessage({
      type: 'user',
      message: { role: 'user', content: '你好' },
    } as never, sessionId);
  } finally {
    sessionEngines.delete(sessionId);
  }
  return readMeta(projectRoot, sessionId);
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  const bus = createEventBus();
  bus.onCoreEvents(createRecordingCoreEventHandlers().handlers);
  setGlobalEventBus(bus);
  const root = makeTempDir('session-model-restore');
  const snapshot = resolveSettingsSnapshot(rawSettings());

  // ===== AC-13：身份合法 → 原样恢复 =====
  const validMeta = await appendWithModel(root, 'm-valid', { provider: 'openrouter.ai', model: 'a/one' });
  check('落盘：meta.json 顶层写入 model', validMeta.model === 'a/one');
  check('落盘：meta.json 顶层写入 provider', validMeta.provider === 'openrouter.ai');
  const validRef = getConversationModelRef(validMeta as never);
  check(
    '恢复：组装出的身份与落盘一致',
    validRef?.provider === 'openrouter.ai' && validRef.model === 'a/one',
  );
  const resolvedValid = resolveModelRef(snapshot, validRef);
  check(
    '恢复：身份仍有效时原样使用',
    resolvedValid?.provider === 'openrouter.ai' && resolvedValid.model === 'a/one',
  );

  // ===== AC-14（a）：model 不在 provider 列表 → 回退该 provider 的默认模型 =====
  const staleModelMeta = await appendWithModel(root, 'm-stale-model', {
    provider: 'openrouter.ai',
    model: 'gone/model',
  });
  const staleModelRef = getConversationModelRef(staleModelMeta as never);
  check(
    '失配：meta 记录的模型仍是失配值（回退发生在宿主侧）',
    staleModelRef?.model === 'gone/model',
  );
  const resolvedStaleModel = resolveModelRef(snapshot, staleModelRef);
  check(
    '失配：model 不在列表时回退到该 provider 的默认模型',
    resolvedStaleModel?.provider === 'openrouter.ai' && resolvedStaleModel.model === 'b/two',
  );
  // 回退结果写回 meta.json：再次加载读到的是回退后的身份
  await updateConversationContext('m-stale-model', {
    model: resolvedStaleModel!.model,
    provider: resolvedStaleModel!.provider,
  });
  const rewritten = readMeta(root, 'm-stale-model');
  check(
    '失配：回退结果写回 meta.json 顶层字段',
    rewritten.model === 'b/two' && rewritten.provider === 'openrouter.ai',
  );
  const reloaded = getConversationModelRef(rewritten as never);
  check(
    '失配：回写后再加载即得到回退身份',
    reloaded?.provider === 'openrouter.ai' && reloaded.model === 'b/two',
  );

  // ===== AC-14（b）：provider 已移除 → 回退 active provider 的默认模型 =====
  const removedProviderMeta = await appendWithModel(root, 'm-removed-provider', {
    provider: 'removed.example',
    model: 'x',
  });
  const removedProviderRef = getConversationModelRef(removedProviderMeta as never);
  check(
    '失配：provider 已移除时仍能从 meta 组装出原身份',
    removedProviderRef?.provider === 'removed.example',
  );
  const resolvedRemovedProvider = resolveModelRef(snapshot, removedProviderRef);
  check(
    '失配：provider 不存在时回退 active provider 的默认模型',
    resolvedRemovedProvider?.provider === 'api.deepseek.com'
      && resolvedRemovedProvider.model === 'deepseek-chat',
  );

  // ===== AC-15：未记录身份 → active provider 的默认模型，不回写 =====
  const noModelMeta = await appendWithModel(root, 'm-none', null);
  check('未记录：meta.json 不写 model 键', !('model' in noModelMeta));
  check('未记录：meta.json 不写 provider 键', !('provider' in noModelMeta));
  check('未记录：组装身份为 undefined', getConversationModelRef(noModelMeta as never) === undefined);
  const resolvedNone = resolveModelRef(snapshot, undefined);
  check(
    '未记录：取 active provider 的默认模型',
    resolvedNone?.provider === 'api.deepseek.com' && resolvedNone.model === 'deepseek-chat',
  );
  const stillNoModel = readMeta(root, 'm-none');
  check('未记录：不因解析而回写 meta.json', !('model' in stillNoModel));

  // ===== 边界：没有任何可用 provider 时不做猜测 =====
  const unconfigured = resolveSettingsSnapshot({});
  check(
    '未配置 provider：即使记录了身份也返回 undefined（保持未到达）',
    resolveModelRef(unconfigured, { provider: 'openrouter.ai', model: 'a/one' }) === undefined,
  );

  resetGlobalEventBus();
  finish();
}

runTests('session-model-restore', run);
