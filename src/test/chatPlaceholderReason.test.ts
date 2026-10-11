/**
 * 聊天区占位页「不可用原因」渲染单测（`docs/host-matrix.md`「不可用工作区」）。
 *
 * 原因是判别联合：指纹变更有专属引导（新旧指纹 + 确认指引），其余展示原始错误；
 * 这里的断言锁死「指纹必须出现、用户文本必须转义」这两条，占位页改版时不回退。
 *
 * 运行方式：npm run test:all -- chat-placeholder-reason
 */

import * as assert from 'assert';
import { getChatPlaceholderHtml } from '../../electron/chatPlaceholderHtml';
import { createChecker, runTests } from './helpers/harness';

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // 无原因（原因未知）：只有标题 / 路径 / 重连按钮，不渲染原因区
  const plain = getChatPlaceholderHtml({
    kind: 'remoteUnreachable',
    path: 'ssh://pz@192.168.31.91/home/pz/workspace',
    reason: null,
  });
  assert.ok(plain.includes('reconnectBtn'), '无原因也要有重连按钮');
  assert.ok(!plain.includes('class="reason"'), '无原因不渲染指纹引导区');
  check('reason=null → 无原因区', true);

  // 指纹变更：新旧指纹与确认指引都出现在页面上
  const hostKey = getChatPlaceholderHtml({
    kind: 'remoteUnreachable',
    path: 'ssh://pz@192.168.31.91/home/pz/workspace',
    reason: {
      kind: 'hostKeyChanged',
      expectedFingerprint: 'aaa61116',
      observedFingerprint: 'bbb72227',
    },
  });
  assert.ok(hostKey.includes('aaa61116') && hostKey.includes('bbb72227'), '两份指纹都要展示');
  assert.ok(hostKey.includes('reconnectBtn'), '指纹变更仍保留重连按钮');
  check('hostKeyChanged → 展示新旧指纹', true);

  // 一般错误：原始错误详情进页面
  const generic = getChatPlaceholderHtml({
    kind: 'remoteUnreachable',
    path: 'ssh://pz@172.20.56.28/home/pz/git/demo',
    reason: { kind: 'generic', detail: 'SSH connection timed out after 20000ms' },
  });
  assert.ok(generic.includes('SSH connection timed out after 20000ms'), '一般原因展示原始错误');
  check('generic → 展示原始错误', true);

  // 用户可见文本一律转义：错误详情里的 HTML 不能变成页面结构
  const escaped = getChatPlaceholderHtml({
    kind: 'remoteUnreachable',
    path: 'ssh://x',
    reason: { kind: 'generic', detail: '<script>alert(1)</script>' },
  });
  assert.ok(!escaped.includes('<script>alert(1)</script>'), '原始 script 标签不得出现在页面');
  assert.ok(escaped.includes('&lt;script&gt;'), '错误详情被转义');
  check('错误详情 HTML 转义', true);

  finish();
}

runTests('chatPlaceholderReason', run);
