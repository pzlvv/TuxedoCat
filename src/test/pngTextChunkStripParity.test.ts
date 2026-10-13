/**
 * Read 读 PNG 的文本元数据块剥离对等测试（Embedded ↔ Standalone）。
 *
 * 两侧读同一份 `src/test/fixtures/pngTextChunkStrip.json`：
 * - 本文件断言 Embedded 的 `stripPngTextChunks` == 对照表，并用真实 `ReadTool.call`
 *   跑通「含文本块的 PNG → image block 的载荷已是剥离后字节」；
 * - `core-rs/src/tools_tests.rs` 的 `png_text_chunk_strip_parity_tests` 断言 Standalone
 *   的 `tools::strip_png_text_chunks` == 同一份对照表。
 *
 * 为什么需要它：PNG 的 `tEXt` / `zTXt` / `iTXt` 只承载文本注释（作者、生成软件、
 * 提示词等），对模型看图没有价值却可能让 base64 载荷膨胀；剥离必须两侧同源，
 * 否则同一张图在 Embedded 与 Standalone 下发出去的字节不同。
 *
 * 运行方式：npm run test:all -- png-text-chunk-strip
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReadTool } from '../core/tools/read/Read';
import { stripPngTextChunks, validateImageBytes } from '../core/tools/read/imageValidation';
import { createChecker, runTests } from './helpers/harness';

interface StripCase {
  name: string;
  why: string;
  hex: string;
  expectedHex: string;
}

const FIXTURE = path.resolve(__dirname, '../../../src/test/fixtures/pngTextChunkStrip.json');

/** 内容是 JPEG（签名 + EOI）：非 PNG 图片的载荷必须逐字节原样发出 */
const JPEG_HEX = 'ffd8ffe000104a46494600010100000100010000ffd9';

function contextFor(cwd: string) {
  return {
    cwd,
    sessionId: 's1',
    abortController: new AbortController(),
    getAppState: () => ({}),
    setAppState: () => undefined,
  };
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { cases: StripCase[] };
  check('对照表非空', fixture.cases.length > 0);

  for (const testCase of fixture.cases) {
    const input = Buffer.from(testCase.hex, 'hex');
    const actual = Buffer.from(stripPngTextChunks(input)).toString('hex');
    if (actual !== testCase.expectedHex) {
      console.log(`     actual:   ${actual}`);
      console.log(`     expected: ${testCase.expectedHex}`);
    }
    check(`${testCase.name}（${testCase.why}）`, actual === testCase.expectedHex);

    // 剥离结果仍是结构自洽的 PNG（FR-002）：再走一次既有结构校验
    check(
      `${testCase.name}：剥离结果仍通过结构校验`,
      validateImageBytes(Buffer.from(testCase.expectedHex, 'hex'), 'image/png') === null,
    );

    // 没有可剥离的块时不重建字节（载荷与文件逐字节相同）
    if (testCase.hex === testCase.expectedHex) {
      check(`${testCase.name}：无文本块时原样返回输入`, stripPngTextChunks(input) === input);
    }
  }

  // 工具端到端：Read 发出的 image block 载荷是剥离后的字节，磁盘文件不动
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'png-text-chunk-strip-'));
  try {
    const withText = fixture.cases.find((c) => c.name === 'png-text-chunk');
    check('对照表含 png-text-chunk 用例', withText !== undefined);
    if (withText) {
      const filePath = path.join(dir, 'shot.png');
      fs.writeFileSync(filePath, Buffer.from(withText.hex, 'hex'));
      const before = fs.statSync(filePath);

      const result = await (ReadTool as any).call({ file_path: 'shot.png' }, contextFor(dir));
      const mapped = (ReadTool as any).mapToolResultToToolResultBlockParam(result.data, 't1');
      check(
        '含文本块的 PNG：image block 载荷为剥离后字节',
        mapped.content[0]?.type === 'image'
          && mapped.content[0]?.source?.media_type === 'image/png'
          && mapped.content[0]?.source?.data ===
            Buffer.from(withText.expectedHex, 'hex').toString('base64'),
      );

      const after = fs.statSync(filePath);
      check(
        '读后磁盘文件内容与修改时间不变',
        fs.readFileSync(filePath).toString('hex') === withText.hex
          && after.mtimeMs === before.mtimeMs,
      );
    }

    // 非 PNG 图片：载荷逐字节原样（不触碰 JPEG 的元数据）
    fs.writeFileSync(path.join(dir, 'photo.jpg'), Buffer.from(JPEG_HEX, 'hex'));
    const jpegResult = await (ReadTool as any).call({ file_path: 'photo.jpg' }, contextFor(dir));
    const jpegMapped = (ReadTool as any).mapToolResultToToolResultBlockParam(jpegResult.data, 't2');
    check(
      '非 PNG 图片：载荷逐字节原样',
      jpegMapped.content[0]?.source?.media_type === 'image/jpeg'
        && jpegMapped.content[0]?.source?.data === Buffer.from(JPEG_HEX, 'hex').toString('base64'),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  finish();
}

runTests('png-text-chunk-strip-parity', run);
