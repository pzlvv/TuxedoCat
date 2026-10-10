/**
 * Read 图片合法性校验对等测试（Embedded ↔ Standalone）。
 *
 * 两侧读同一份 `src/test/fixtures/imageValidation.json`：
 * - 本文件断言 Embedded 的 `validateImageBytes` == 对照表，并用真实 `ReadTool.call`
 *   跑通「合法图片出 image block / 非法图片报错」；
 * - `core-rs/src/tools_tests.rs` 的 `image_validation_parity_tests` 断言 Standalone 的
 *   `tools::image_validation_failure` == 对照表。
 *
 * 为什么需要它：Read 按扩展名给图片定 media_type，扩展名不是事实——`.png` 里塞
 * 任意二进制时若不校验，非法 image block 会被发给 provider 并整轮报错。
 *
 * 运行方式：npm run test:all -- image-validation-parity
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReadTool } from '../core/tools/read/Read';
import { validateImageBytes } from '../core/tools/read/imageValidation';
import { createChecker, runTests } from './helpers/harness';

interface ParityCase {
  name: string;
  why: string;
  mediaType: string;
  hex: string;
  expected: string | null;
}

const FIXTURE = path.resolve(__dirname, '../../../src/test/fixtures/imageValidation.json');

/** 合法 PNG（签名 + IHDR + IDAT + IEND），取自对照表的 `png-valid` */
const VALID_PNG_HEX =
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c48900000001494441540028387de80000000049454e44ae426082';
/** 内容是 JPEG 但扩展名是 .png：签名不符 */
const MISMATCHED_PNG_HEX = 'ffd8ffe000104a46494600010100000100010000ffd9';

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
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { cases: ParityCase[] };
  check('对照表非空', fixture.cases.length > 0);

  for (const testCase of fixture.cases) {
    const actual = validateImageBytes(Buffer.from(testCase.hex, 'hex'), testCase.mediaType);
    if (actual !== testCase.expected) {
      console.log(`     actual:   ${JSON.stringify(actual)}`);
      console.log(`     expected: ${JSON.stringify(testCase.expected)}`);
    }
    check(`${testCase.name}（${testCase.why}）`, actual === testCase.expected);
  }

  // 工具端到端：校验失败必须报错（而不是把非法内容当图片发出去）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-validation-'));
  try {
    fs.writeFileSync(path.join(dir, 'bad.png'), Buffer.from(MISMATCHED_PNG_HEX, 'hex'));
    let message = '';
    try {
      await (ReadTool as any).call({ file_path: 'bad.png' }, contextFor(dir));
    } catch (error) {
      message = (error as Error).message;
    }
    check(
      '非法图片：Read 报错且文案指向文件与格式',
      message ===
        'Invalid image file: bad.png. The content is not a valid image/png image (file signature does not match the format).',
    );

    // 合法图片仍走 image content block
    fs.writeFileSync(path.join(dir, 'ok.png'), Buffer.from(VALID_PNG_HEX, 'hex'));
    const result = await (ReadTool as any).call({ file_path: 'ok.png' }, contextFor(dir));
    const mapped = (ReadTool as any).mapToolResultToToolResultBlockParam(result.data, 't1');
    check(
      '合法图片：仍是 image content block',
      mapped.content[0]?.type === 'image'
        && mapped.content[0]?.source?.media_type === 'image/png'
        && mapped.content[0]?.source?.data === Buffer.from(VALID_PNG_HEX, 'hex').toString('base64'),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  finish();
}

runTests('image-validation-parity', run);
