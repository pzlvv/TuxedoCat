/**
 * `<persisted-output>` 预览解析（`docs/hosts/webview-ui.md` 的工具卡片段）。
 *
 * 守护的是「大输出落盘后，卡片里的预览与写入方写进去的内容逐字一致」：
 * 路径与正文都来自工具输出，完全可能含有 `Preview` 这个词或两个标签的字面量
 * （`cat` 本仓库的 `toolResultStorage.ts` 就是实例）。解析器若按「第一个命中的
 * 子串」定位，预览会从错误位置切开——框里少一截正文、多一行表头，
 * 而没有任何错误提示（specs/defects/persisted-output-preview-anchored-on-first-marker.md）。
 *
 * 运行方式：npm run test:unit -- persisted-output
 */

import * as assert from 'assert';
import { isPersistedOutput, parsePersistedOutput } from '../webview/persistedOutputParse';
import { createChecker, runTests } from './helpers/harness';

/**
 * 按生成侧（`buildLargeToolResultMessage`）的格式拼一条持久化输出消息。
 *
 * 逐字对齐 `src/shared/tools/toolResultStorage.ts` 的写入形态与
 * `core-rs/src/tools.rs` 的 `build_large_tool_result_message`。
 */
function buildPersistedOutput(
  filePath: string,
  preview: string,
  sizeKb = 12,
  headK = 2,
  tailK = 2,
): string {
  return '<persisted-output>\n'
    + `Output too large (${sizeKb}KB). Full output saved to: ${filePath}\n\n`
    + `Preview (first ${headK}K + last ${tailK}K):\n`
    + `${preview}\n`
    + '</persisted-output>';
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // ---------------- RT-1：路径含 Preview 段 ----------------

  // 修复前：`body.indexOf('Preview')` 先命中的是路径里的目录名，预览起点被算到表头行，
  // preview 变成 "\nPreview (first 2K + last 2K):\none"。
  const pathWithPreview = parsePersistedOutput(buildPersistedOutput('/home/u/Preview/a.txt', 'one\ntwo'));
  assert.strictEqual(
    pathWithPreview?.preview,
    'one\ntwo',
    'RT-1：路径里的 Preview 目录不该被当成预览表头',
  );
  assert.strictEqual(pathWithPreview?.filePath, '/home/u/Preview/a.txt', 'RT-1：路径原样保留');
  check('RT-1 路径含 Preview 段时预览不被表头污染', true);

  // ---------------- RT-2：正文里出现两个标签字面量 ----------------

  const sourceCode = "export const PERSISTED_OUTPUT_CLOSING_TAG = '</persisted-output>';\n"
    + "export const PERSISTED_OUTPUT_TAG = '<persisted-output>';";
  const withTags = parsePersistedOutput(
    buildPersistedOutput('/home/u/conversations/x/tool-results/a.txt', sourceCode),
  );
  assert.strictEqual(
    withTags?.preview,
    sourceCode,
    'RT-2：正文里的 </persisted-output> 字面量不能提前结束消息',
  );
  check('RT-2 正文含收尾标签字面量时预览完整保留', true);

  // ---------------- RT-3：正文以 Preview 开头 ----------------

  const previewText = 'Preview of changes:\n+ added line';
  const withPreviewText = parsePersistedOutput(buildPersistedOutput('/tmp/out.txt', previewText));
  assert.strictEqual(withPreviewText?.preview, previewText, 'RT-3：正文里的 Preview 不影响定位');
  check('RT-3 正文含 Preview 字样时预览从正文首行开始', true);

  // ---------------- RT-4：正常输入与非法输入 ----------------

  const plainPreview = 'line1\nline2\n... (42 chars omitted) ...\nlineN';
  const plain = parsePersistedOutput(buildPersistedOutput('/home/u/out.txt', plainPreview));
  assert.strictEqual(plain?.preview, plainPreview, 'RT-4a：正常输入的预览逐字保留');
  assert.strictEqual(plain?.filePath, '/home/u/out.txt', 'RT-4a：正常输入的路径逐字保留');
  assert.strictEqual(plain?.originalSize, 12 * 1024, 'RT-4a：大小按 KB 折算成字节');
  assert.strictEqual(plain?.isPersisted, true, 'RT-4a：标记为持久化输出');
  check('RT-4a 正常输入逐字一致', true);

  assert.strictEqual(parsePersistedOutput('plain output'), null, 'RT-4b：无标签时为 null');
  assert.strictEqual(
    parsePersistedOutput('<persisted-output>only opening tag'),
    null,
    'RT-4c：只有起始标签时为 null（缺完整标签对）',
  );
  assert.strictEqual(
    parsePersistedOutput('only closing tag</persisted-output>'),
    null,
    'RT-4d：只有收尾标签时为 null',
  );
  check('RT-4b/c/d 缺完整标签对时为 null', true);

  // ---------------- 大小 / 表头变体 ----------------

  // 表头两侧的大小由工具层按上限写入（4K 上限 = 前 2K + 后 2K，改上限后跟着变）
  const variant = parsePersistedOutput(buildPersistedOutput('/tmp/x.txt', 'body', 1024, 8, 8));
  assert.strictEqual(variant?.originalSize, 1024 * 1024, '大小按表头的 KB 数折算');
  assert.strictEqual(variant?.preview, 'body', '不同表头大小不影响正文定位');
  check('表头大小变体按写入方口径解析', true);

  // ---------------- isPersistedOutput ----------------

  assert.strictEqual(isPersistedOutput(buildPersistedOutput('/tmp/x.txt', 'p')), true, '完整标签对算持久化');
  assert.strictEqual(isPersistedOutput('echo <persisted-output>'), false, '单个同名标签不算持久化');
  assert.strictEqual(isPersistedOutput('echo </persisted-output>'), false, '单个收尾标签不算持久化');
  assert.strictEqual(
    isPersistedOutput('a</persisted-output>b<persisted-output>'),
    false,
    '顺序颠倒的标签对不算持久化',
  );
  check('isPersistedOutput 只认顺序正确的完整标签对', true);

  finish();
}

runTests('persisted-output', run);
