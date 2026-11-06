/**
 * `Transfer` 工具卡片的派生逻辑（specs/042）。
 *
 * 卡片的信息全部来自工具入参（两端身份）与工具结果文本（统计行 + 路径明细行）：
 * 解析口径、20 条上限、失败态与重放一致性都在这里锁定。夹具
 * `core-rs/fixtures/transferResult.txt` 是生成侧的同一份格式样本（Rust 侧
 * `tools_tests.rs` 断言 `run_transfer` 产出的文本与它逐字同形），两侧共用一份口径。
 *
 * 运行方式：npm run test:unit -- transfer-card
 */

import * as fs from 'fs';
import * as path from 'path';
import { parsePersistedOutput } from '../webview/persistedOutputParse';
import {
  buildTransferCardModel,
  TRANSFER_PATH_LIMIT,
  truncateMiddle,
} from '../webview/transferCard';
import { createChecker, runTests } from './helpers/harness';

const REPO_ROOT = path.resolve(__dirname, '../../..');

/** 生成侧夹具：`run_transfer` 的成功结果文本 */
function fixtureText(): string {
  return fs.readFileSync(path.join(REPO_ROOT, 'core-rs', 'fixtures', 'transferResult.txt'), 'utf8');
}

/** 稳定模型形态（对象字段顺序无关的逐字比较） */
function modelKey(model: ReturnType<typeof buildTransferCardModel>): string {
  return JSON.stringify({
    files: model.stats?.files ?? null,
    sizeText: model.stats?.sizeText ?? null,
    skipped: model.stats?.skipped ?? null,
    source: model.source,
    dest: model.dest,
    paths: model.paths,
    moreCount: model.moreCount,
    failed: model.failed,
  });
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // ── AC-1：身份、统计与清单（夹具与生成侧同源）──
  {
    const model = buildTransferCardModel(
      { sourceTarget: 'm1:/ws1', destTarget: 'm2:/ws2' },
      fixtureText(),
      'success',
    );
    check('统计行：文件数与字节数原样解析', model.stats?.files === 3 && model.stats?.sizeText === '4.0 KB');
    check('统计行：两端身份取入参', model.source === 'm1:/ws1' && model.dest === 'm2:/ws2');
    check(
      '清单：逐条列出相对路径',
      JSON.stringify(model.paths) === JSON.stringify(['src/a.txt', 'src/sub/b.txt', 'src/sub/deep/c.txt']),
    );
    check('清单：没有折叠行时 moreCount 为 0', model.moreCount === 0);
    check('成功态：failed 为 false', model.failed === false);
  }

  // ── AC-2：跳过项为 0 时不显示（模型里是 0，组件整段不渲染）──
  {
    const output = '✓ Transferred 1 files (12 B) from `m1:/ws1` to `m2:/ws2`\n  - a.txt';
    const model = buildTransferCardModel({ sourceTarget: '', destTarget: 'm2:/ws2' }, output, 'success');
    check('跳过项：结果不带 skipped 段时 skipped 为 0', model.stats?.skipped === 0);
    check('跳过项：结果带 skipped 段时按数字解析',
      buildTransferCardModel({}, fixtureText(), 'success').stats?.skipped === 2);
    check('缺省端：空串入参按缺省端处理（null）', model.source === null);
  }

  // ── AC-3：超过上限时截断（工具侧折叠行 + 卡片侧上限叠加）──
  {
    const total = TRANSFER_PATH_LIMIT + 5;
    const lines = [`✓ Transferred ${total} files (2.0 KB) from \`m1:/ws1\` to \`m2:/ws2\``];
    for (let i = 0; i < TRANSFER_PATH_LIMIT; i += 1) lines.push(`  - dir/file-${i}.txt`);
    lines.push('  ... and 5 more files');
    const model = buildTransferCardModel({}, lines.join('\n'), 'success');
    check(
      `上限：最多展示 ${TRANSFER_PATH_LIMIT} 条`,
      model.paths.length === TRANSFER_PATH_LIMIT && model.paths[TRANSFER_PATH_LIMIT - 1] === 'dir/file-19.txt',
    );
    check('上限：折叠行的计数原样带出', model.moreCount === 5);
  }

  // ── AC-3 边界：工具侧未折叠但超过卡片上限（旧版本结果 / 手工构造）──
  {
    const total = TRANSFER_PATH_LIMIT + 3;
    const lines = [`✓ Transferred ${total} files (2.0 KB) from \`a\` to \`b\``];
    for (let i = 0; i < total; i += 1) lines.push(`  - f${i}.txt`);
    const model = buildTransferCardModel({}, lines.join('\n'), 'success');
    check(
      '上限：卡片自己也截到 20 条，多出的部分进 moreCount',
      model.paths.length === TRANSFER_PATH_LIMIT && model.moreCount === 3,
    );
  }

  // ── AC-4：失败态显示错误原文，不解析统计 ──
  {
    const model = buildTransferCardModel(
      { sourcePath: '/a', targetPath: '/b' },
      'at least one end of a transfer must be the current conversation workspace',
      'fail',
    );
    check('失败态：failed 为 true', model.failed === true);
    check('失败态：不猜统计与清单', model.stats === null && model.paths.length === 0 && model.moreCount === 0);
    check('失败态：两端都缺省（入参没有 target）', model.source === null && model.dest === null);
  }

  // ── 旧版本结果（解析不出统计行）：只渲染身份行 + 原文，不猜数字 ──
  {
    const model = buildTransferCardModel(
      { sourceTarget: 'm1:/ws1', destTarget: 'm2:/ws2' },
      'Transferred some files',
      'success',
    );
    check('解析失败：stats 为 null', model.stats === null);
    check('解析失败：身份仍按入参给', model.source === 'm1:/ws1' && model.dest === 'm2:/ws2');
  }

  // ── 边界第 1 条：4K 裁剪成 <persisted-output> 信封时解析预览 ──
  {
    const body = fixtureText().trimEnd();
    const envelope = [
      '<persisted-output>',
      'Output too large (12KB). Full output saved to: /tmp/full.txt',
      '',
      'Preview (first 2K + last 2K):',
      body,
      '</persisted-output>',
    ].join('\n');
    const model = buildTransferCardModel(
      { sourceTarget: 'm1:/ws1', destTarget: 'm2:/ws2' },
      envelope,
      'success',
      (text) => parsePersistedOutput(text)?.preview ?? null,
    );
    check('信封：统计行从预览里解析', model.stats?.files === 3 && model.stats?.sizeText === '4.0 KB');
    check('信封：清单从预览里解析', model.paths.length === 3 && model.paths[0] === 'src/a.txt');
  }

  // ── FR-005：同一入参 + 输出两次构建结果相同（重放一致，不依赖会话内状态）──
  {
    const args = { sourceTarget: 'm1:/ws1', destTarget: 'm2:/ws2' };
    const first = buildTransferCardModel(args, fixtureText(), 'success');
    const second = buildTransferCardModel(args, fixtureText(), 'success');
    check('重放一致：两次构造成员模型逐字相同', modelKey(first) === modelKey(second));
  }

  // ── 结果文本兜底：入参缺 target（重放裁剪）时用结果里的身份 ──
  {
    const model = buildTransferCardModel({}, fixtureText(), 'success');
    check('兜底：入参缺 target 时用结果文本里的两端', model.source === 'm1:/ws1' && model.dest === 'm2:/ws2');
  }

  // ── 长路径截断（FR-001 第 3 段）：保留首尾，完整值给 title ──
  {
    const short = 'a/b.txt';
    check('截断：不超长时原样返回', truncateMiddle(short) === short);
    const long = `${'a'.repeat(60)}/tail.txt`;
    const cut = truncateMiddle(long, 56);
    check('截断：超长时长度受限且保留首尾', cut.length <= 56 && cut.startsWith('a') && cut.endsWith('tail.txt'));
  }

  finish();
}

runTests('transferCard', run);
