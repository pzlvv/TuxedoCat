/**
 * 配置快照的数值字段必须是 Core 契约接受的形态
 * （`docs/architecture/core-ui-separation.md` 第 4.3 节：快照字段）。
 *
 * Core 用 `u64` 反序列化 `provider.modelLimits[].context` / `.output` 与
 * `llm.maxTokens`（`core-rs/src/settings.rs` 的 `ModelLimits` / `LlmSettings`）；
 * 而快照解析（`src/shared/settingsSnapshot.ts`）只校验「是有限数」，于是负数与小数被
 * 原样下发。serde 对 `u64` 的校验是整份快照级：一个字段不合法，
 * `apply_from_host_environment` 整个失败——Core 永远拿不到快照，`coreReady`
 * 一次都不发（宿主侧 `coreReadiness` 一直是未就绪），全部会话按「Core 未就绪」拒绝受理。
 *
 * 回归口径：解析出的快照里，凡是 Core 用 `u64` 接收的字段都必须是**非负整数**；
 * 非法输入按各自口径回落（模型限值回落注册表 / 兜底，`maxTokens` 回落默认值），
 * 合法值不受影响。
 *
 * 运行方式：npm run test:all -- settingsSnapshotContract
 */

import { createChecker, runTests } from './helpers/harness';
import { resolveSettingsSnapshot } from '../shared/settingsSnapshot';
import { FALLBACK_MODEL_PARAMS } from '../shared/utils/modelConfig';

/** Core 的 `ModelLimits` 里全部 `u64` 字段（`core-rs/src/settings.rs`） */
interface CoreNumericFields {
  context: number;
  output: number;
  thinkingTokenBudget: number;
}

const isU64 = (value: unknown): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** 快照里全部 `u64` 字段是否都合法（额外返回非法项，便于失败时定位） */
function invalidU64Fields(snapshot: ReturnType<typeof resolveSettingsSnapshot>): string[] {
  const bad: string[] = [];
  const checkLimits = (label: string, limits: CoreNumericFields): void => {
    for (const field of ['context', 'output', 'thinkingTokenBudget'] as const) {
      if (!isU64(limits[field])) bad.push(`${label}.${field}=${String(limits[field])}`);
    }
  };
  for (const [key, provider] of Object.entries(snapshot.llm.providers)) {
    for (const [model, limits] of Object.entries(provider.modelLimits)) {
      checkLimits(`${key}.${model}`, limits);
    }
  }
  checkLimits('modelLimitsFallback', snapshot.llm.modelLimitsFallback);
  if (!isU64(snapshot.llm.maxTokens)) bad.push(`maxTokens=${String(snapshot.llm.maxTokens)}`);
  return bad;
}

function run(): void {
  const { check, finish } = createChecker();

  // ---------------- RT-1：负数模型限值 ----------------

  const negative = resolveSettingsSnapshot({
    llm: {
      providers: {
        p: { baseURL: 'https://p', models: ['m'], modelConfigs: { m: { context: -1, output: -1024 } } },
      },
    },
  });
  check(
    'RT-1 负数 modelConfigs 不进入快照（负 context / output 回落注册表兜底）',
    negative.llm.providers.p.modelLimits.m.context === FALLBACK_MODEL_PARAMS.contextWindow
      && negative.llm.providers.p.modelLimits.m.output === FALLBACK_MODEL_PARAMS.maxOutputTokens,
  );
  check('RT-1 负数输入下快照的 u64 字段全部合法', invalidU64Fields(negative).length === 0);

  // ---------------- RT-2：小数模型限值 ----------------

  const fractional = resolveSettingsSnapshot({
    llm: {
      providers: {
        p: { baseURL: 'https://p', models: ['m'], modelConfigs: { m: { context: 1.5, output: 2048.75 } } },
      },
    },
  });
  check(
    'RT-2 小数 modelConfigs 不进入快照（回落注册表兜底）',
    fractional.llm.providers.p.modelLimits.m.context === FALLBACK_MODEL_PARAMS.contextWindow
      && fractional.llm.providers.p.modelLimits.m.output === FALLBACK_MODEL_PARAMS.maxOutputTokens,
  );
  check('RT-2 小数输入下快照的 u64 字段全部合法', invalidU64Fields(fractional).length === 0);

  // ---------------- RT-3：llm.maxTokens ----------------

  const fractionalMax = resolveSettingsSnapshot({ llm: { maxTokens: 1.5 } });
  const negativeMax = resolveSettingsSnapshot({ llm: { maxTokens: -5 } });
  check(
    'RT-3 小数 / 负数 maxTokens 回落默认值',
    fractionalMax.llm.maxTokens === FALLBACK_MODEL_PARAMS.maxOutputTokens
      && negativeMax.llm.maxTokens === FALLBACK_MODEL_PARAMS.maxOutputTokens,
  );
  check(
    'RT-3 非法 maxTokens 下快照的 u64 字段全部合法',
    invalidU64Fields(fractionalMax).length === 0 && invalidU64Fields(negativeMax).length === 0,
  );

  // ---------------- RT-4：合法值不受影响 ----------------

  const legal = resolveSettingsSnapshot({
    llm: {
      maxTokens: 8192,
      providers: {
        p: {
          baseURL: 'https://p',
          models: ['m'],
          modelConfigs: { m: { context: 12345, output: 678, apiType: 'Responses' } },
        },
      },
    },
  });
  check(
    'RT-4 合法整数限值与 maxTokens 原样保留',
    legal.llm.maxTokens === 8192
      && legal.llm.providers.p.modelLimits.m.context === 12345
      && legal.llm.providers.p.modelLimits.m.output === 678
      && legal.llm.providers.p.modelLimits.m.apiType === 'Responses',
  );
  check('RT-4 合法输入下快照的 u64 字段全部合法', invalidU64Fields(legal).length === 0);

  // ---------------- RT-5：默认快照自身合法 ----------------

  check('RT-5 空配置的快照 u64 字段全部合法', invalidU64Fields(resolveSettingsSnapshot(undefined)).length === 0);

  finish();
}

runTests('settingsSnapshotContract', run);
