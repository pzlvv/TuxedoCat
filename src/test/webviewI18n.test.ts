/**
 * webview 与宿主两套 i18n 字典的键集对照（`docs/hosts/webview-ui.md`，`AGENTS.md` 第 2 节）。
 *
 * 用户可见文本一律走 i18n（`src/webview/i18n/` 的 `zh` / `en`）：两边键集漂移会让
 * 某种语言下出现裸键名（`tool.transfer.more` 直接显示给用户）。本用例把「两份字典
 * 键集完全一致」做成可执行断言，并逐条检查 `t()` 的占位符在两侧同名同数。
 *
 * 运行方式：npm run test:unit -- webview-i18n
 */

import { enDict } from '../webview/i18n/en';
import { zhDict } from '../webview/i18n/zh';
import { createChecker, runTests } from './helpers/harness';

/** 提取 `{name}` 占位符（顺序无关，按集合比较） */
function placeholders(template: string): string[] {
  return [...template.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1] ?? '').sort();
}

/**
 * 英文复数后缀 `{s}` 是既有词典里的**可选**占位（`result{s}`：单数时空串），
 * 中文没有形态变化、不需要它——两侧占位符比对时剔除，其余一律必须一致。
 */
const OPTIONAL_PLURAL = 's';

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  const zhKeys = new Set(Object.keys(zhDict));
  const enKeys = new Set(Object.keys(enDict));

  const missingInEn = [...zhKeys].filter((key) => !enKeys.has(key));
  const missingInZh = [...enKeys].filter((key) => !zhKeys.has(key));
  check(
    `键集两侧一致（zh ${zhKeys.size} / en ${enKeys.size}；en 缺 ${missingInEn.length}，zh 缺 ${missingInZh.length}）`,
    missingInEn.length === 0 && missingInZh.length === 0,
  );
  for (const key of missingInEn.slice(0, 20)) console.log(`     en 缺: ${key}`);
  for (const key of missingInZh.slice(0, 20)) console.log(`     zh 缺: ${key}`);

  const placeholderDrift: string[] = [];
  for (const key of zhKeys) {
    if (!enKeys.has(key)) continue;
    // 英文的 `{s}` 复数后缀在中文里不存在（形态变化差异），不参与对照
    const zh = placeholders(zhDict[key] ?? '').filter((name) => name !== OPTIONAL_PLURAL);
    const en = placeholders(enDict[key] ?? '').filter((name) => name !== OPTIONAL_PLURAL);
    if (JSON.stringify(zh) !== JSON.stringify(en)) {
      placeholderDrift.push(`${key}（zh {${zh.join(',')}} / en {${en.join(',')}}）`);
    }
  }
  check(`占位符两侧一致（漂移 ${placeholderDrift.length} 处）`, placeholderDrift.length === 0);
  for (const drift of placeholderDrift.slice(0, 20)) console.log(`     ${drift}`);

  // Transfer 卡片（specs/042 FR-001 / FR-002 / FR-004）的五个键两侧都有
  const transferKeys = [
    'tool.transfer.files',
    'tool.transfer.skipped',
    'tool.transfer.more',
    'tool.transfer.currentWorkspace',
    'tool.transfer.failed',
  ];
  const missingTransfer = transferKeys.filter((key) => !zhKeys.has(key) || !enKeys.has(key));
  check('Transfer 卡片的五个键两侧齐全', missingTransfer.length === 0);
  for (const key of missingTransfer) console.log(`     缺: ${key}`);

  finish();
}

runTests('webviewI18n', run);
