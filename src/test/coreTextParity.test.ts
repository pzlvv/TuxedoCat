/**
 * Core 文案键对等测试（`docs/core-ui-separation.md` 第 4.8 / 4.9 节）。
 *
 * 两侧共用 `src/test/fixtures/coreTextKeys.json`：
 * - 本文件断言「TS core 登记的键集合 == 对照表」且「对照表 ⊆ webview 翻译表（zh / en）」；
 * - `core-rs/src/core_text_tests.rs` 断言「Rust core 登记的键集合 == 对照表」。
 *
 * Core 只产出键与参数（`CoreEvent.notice` / 内置命令描述），翻译在 UI；键缺失时
 * webview 显示键本身并记日志。这里锁定的是「对等约束」：Core 用到的每个键都必须
 * 在 UI 的翻译表里存在。
 *
 * 只 import 两个纯字典模块（不 import `webview/i18n/index.ts`：那个模块在加载期读
 * `window`，Node 下不可用）。
 *
 * 运行方式：npm run test:all -- core-text-parity
 */

import * as fs from 'fs';
import * as path from 'path';
import { CORE_TEXT_KEYS } from '../core/coreText';
import { zhDict } from '../webview/i18n/zh';
import { enDict } from '../webview/i18n/en';
import { createChecker, runTests } from './helpers/harness';

const FIXTURE = path.resolve(__dirname, '../../../src/test/fixtures/coreTextKeys.json');

function run(): void {
  const { check, finish } = createChecker();
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as string[];

  check('对照表非空', fixture.length > 0);
  check(
    'TS core 的键集合与对照表一致',
    JSON.stringify([...CORE_TEXT_KEYS]) === JSON.stringify(fixture),
  );

  for (const key of fixture) {
    check(`zh 词典存在 ${key}`, typeof zhDict[key] === 'string' && zhDict[key].length > 0);
    check(`en 词典存在 ${key}`, typeof enDict[key] === 'string' && enDict[key].length > 0);
  }

  // 占位符对等：键里出现的 `{name}` 必须在两个词典里都保留（否则翻译时静默丢失参数）
  for (const key of fixture) {
    const placeholders = [...(zhDict[key] ?? '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const enPlaceholders = [...(enDict[key] ?? '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    check(`${key} 的占位符两侧一致`, JSON.stringify(placeholders) === JSON.stringify(enPlaceholders));
  }

  finish();
}

runTests('coreTextParity', run);
