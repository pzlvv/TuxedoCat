/**
 * 单测：对话标题截断不得切开代理对（`src/shared/utils/contentBlocks.ts` 的
 * `buildConversationTitle`）。
 *
 * 背景（`src/shared/utils/stringUtils.ts` 的模块注释）：按长度截断一律要用代理对安全的
 * 工具，裸 `substring` / `slice` 会在 emoji 中间切开，留下孤立代理项。孤立代理项在
 * `JSON.stringify` 下是语法合法但语义非法的 `"\ud83d"`——落盘后 Core 侧读盘要按
 * `util::sanitize_json_surrogates` 修一遍，webview 经帧通道（`stringifyJsonSafe`）
 * 收到的标题会变成 U+FFFD，与写盘值不一致。
 *
 * 两侧口径必须一致：Core 的 `history::derive_title` 用 `util::utf16_take`（遇到放不下的
 * 字符就停），因此 50 个 UTF-16 code unit 的截断在「第 50 个单元是高代理」时得到 49 个
 * 单元。这里锁定 TS 侧同一口径。
 *
 * 运行方式：npm run test:unit -- conversationTitle
 */

import { buildConversationTitle } from '../shared/utils/contentBlocks';
import { hasLoneSurrogate } from '../shared/utils/stringUtils';
import { createChecker, runTests } from './helpers/harness';

/** 一个占 2 个 UTF-16 code unit 的字符（U+1F600） */
const EMOJI = '\u{1F600}';

function run(): void {
  const { check, finish } = createChecker();

  // ---------- 截断边界：第 50 个 code unit 落在代理对中间 ----------

  // 49 个 ASCII + emoji：`substring(0, 50)` 会切掉 emoji 的低半，留下孤立高代理
  const splitPair = 'a'.repeat(49) + EMOJI + ' tail';
  const splitTitle = buildConversationTitle(splitPair);
  check('截断边界不切出孤立代理项', !hasLoneSurrogate(splitTitle));
  check(
    '截断边界与 Core 的 utf16_take 同口径（49 个 code unit）',
    splitTitle === 'a'.repeat(49),
  );
  check(
    '截断边界的结果是合法 Unicode（JSON 往返不产生替换字符）',
    !JSON.stringify({ title: splitTitle }).includes('\\ud'),
  );

  // 48 个 ASCII + emoji：整对放得下，应完整保留
  const pairFits = 'a'.repeat(48) + EMOJI + ' tail';
  check('整对放得下时完整保留 emoji', buildConversationTitle(pairFits) === 'a'.repeat(48) + EMOJI);

  // 纯 emoji 开头：第 50 个单元落在第 25 个 emoji 的高半上
  const allEmoji = EMOJI.repeat(30);
  const emojiTitle = buildConversationTitle(allEmoji);
  check('纯 emoji 标题不切出孤立代理项', !hasLoneSurrogate(emojiTitle));
  check('纯 emoji 标题保留 25 个完整字符', emojiTitle === EMOJI.repeat(25));

  // ---------- 既有行为不变 ----------

  check('短文本原样（trim 后）', buildConversationTitle('  修复登录 bug  ') === '修复登录 bug');
  check('恰好 50 个 ASCII 不被截断', buildConversationTitle('a'.repeat(50)) === 'a'.repeat(50));
  check('51 个 ASCII 截到 50 个', buildConversationTitle('a'.repeat(51)) === 'a'.repeat(50));
  check('空文本无图片返回空串', buildConversationTitle('') === '');
  check('纯空白按空文本处理', buildConversationTitle('   ') === '');
  check(
    '仅图片：优先用宽高生成 Image[w*h]',
    buildConversationTitle('', [{ dataUrl: 'data:image/png;base64,AAA', width: 800, height: 600 }])
      === 'Image[800*600]',
  );
  check(
    '仅图片：宽高缺失退化为 Image',
    buildConversationTitle('', [{ dataUrl: 'data:image/png;base64,AAA' }]) === 'Image',
  );
  check(
    '文本优先于图片',
    buildConversationTitle('看这张图', [{ dataUrl: 'data:image/png;base64,AAA', width: 1, height: 1 }])
      === '看这张图',
  );

  finish();
}

runTests('conversationTitle', run);
