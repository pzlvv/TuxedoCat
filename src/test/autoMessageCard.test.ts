/**
 * 系统自动消息折叠行的摘要派生（`docs/hosts/webview-ui.md` 第 11 节「自动消息折叠行」）。
 *
 * 派生逻辑只有一份纯函数（`src/webview/autoMessageCard.ts`），组件只渲染结果：
 * - 后台 Bash 完成通知的正文由 core 生成（`core-rs/src/bash_task.rs` 的
 *   `build_completion_notification`），折叠行必须从正文解析结论与描述，
 *   不能在 webview 侧另拼一份文案；
 * - 解析不出来（老会话 / 文案改版）时退回整行描述，不猜状态。
 *
 * 运行方式：npm run test:unit -- auto-message-card
 */

import { firstLineSummary, parseBackgroundCompletion } from '../webview/autoMessageCard';
import { createChecker, runTests } from './helpers/harness';

/** core 产出的完成通知原文（与 `core-rs/src/bash_task_tests.rs` 的对照文案同形） */
function notification(descriptionLine: string, extra: string[] = []): string {
  return [
    'Background task completed',
    'Task: bg-1700000000000-abc',
    `Description: ${descriptionLine}`,
    'Duration: 1.5s',
    ...extra,
  ].join('\n');
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // ---------------- 完成通知：结论 + 描述 + 时长 ----------------

  const completed = parseBackgroundCompletion(
    notification('Background command "List files in current directory" completed (exit code 0)'),
  );
  check('completed：结论解析为 completed', completed.state === 'completed');
  check(
    'completed：描述取 Description 引号内的原文',
    completed.description === 'List files in current directory',
  );
  check('completed：时长原样保留', completed.duration === '1.5s');

  const failed = parseBackgroundCompletion(
    notification('Background command "Build the standalone core" failed with exit code 101'),
  );
  check('failed：结论解析为 failed', failed.state === 'failed');
  check('failed：描述取命令描述', failed.description === 'Build the standalone core');
  check('failed：退出码不出现在描述里', !failed.description.includes('101'));

  const stopped = parseBackgroundCompletion(
    notification('Background command "Serve docs" was stopped'),
  );
  check('stopped：结论解析为 stopped', stopped.state === 'stopped');
  check('stopped：描述取命令描述', stopped.description === 'Serve docs');

  // 描述里带引号：贪心匹配保留完整描述，不截断在第一个引号
  const quoted = parseBackgroundCompletion(
    notification('Background command "echo \\"hi there\\" && ls" completed (exit code 0)'),
  );
  check(
    '描述含引号：整段描述不腰斩',
    quoted.description === 'echo \\"hi there\\" && ls',
  );

  // 负退出码（被信号杀掉后 core 取到 -1 一类）
  check(
    '负退出码：仍判定为 completed',
    parseBackgroundCompletion(notification('Background command "x" completed (exit code -1)')).state
      === 'completed',
  );

  // 带输出预览：正文多行不影响首行解析
  const withOutput = parseBackgroundCompletion(
    notification('Background command "Run tests" completed (exit code 0)', [
      'Output (first 500 chars):',
      'PASS src/test/a.test.ts',
    ]),
  );
  check('带输出预览：描述与结论不受影响', withOutput.description === 'Run tests');
  check('带输出预览：时长仍在', withOutput.duration === '1.5s');

  // 缺 Duration（老格式 / 手工注入）：duration 为 null，不编造
  const noDuration = parseBackgroundCompletion(
    ['Background task completed', 'Description: Background command "x" was stopped'].join('\n'),
  );
  check('缺 Duration：返回 null', noDuration.duration === null);

  // 文案不认识：结论 unknown，描述退回 Description 整行（含关键字也照原样）
  const unknown = parseBackgroundCompletion(
    notification('Background command "x" finished somehow'),
  );
  check('未知文案：结论为 unknown', unknown.state === 'unknown');
  check(
    '未知文案：描述退回 Description 整行',
    unknown.description === 'Background command "x" finished somehow',
  );

  // 连 Description 都没有：退回正文首个非空行，仍能显示一行
  const bare = parseBackgroundCompletion('\n\nBackground task completed\nTask: bg-1');
  check('无 Description：结论为 unknown', bare.state === 'unknown');
  check('无 Description：描述取首个非空行', bare.description === 'Background task completed');
  check('空正文：描述为空串而不是崩溃', parseBackgroundCompletion('').description === '');
  check('空正文：结论为 unknown', parseBackgroundCompletion('').state === 'unknown');

  // ---------------- 子代理 From 消息：首行摘要 ----------------

  check(
    '首行摘要：取第一段正文',
    firstLineSummary('测试全部通过；超时配置已提到 120s。\n\n要点：\n1. xxx') === '测试全部通过；超时配置已提到 120s。',
  );
  check('首行摘要：跳过前导空行', firstLineSummary('\n\n\n正文第一行\n第二行') === '正文第一行');
  check('首行摘要：去标题标记', firstLineSummary('## 结论\n细节') === '结论');
  check('首行摘要：去列表标记', firstLineSummary('- 第一条\n- 第二条') === '第一条');
  check('首行摘要：去引用标记', firstLineSummary('> 引用一句') === '引用一句');
  check('首行摘要：去强调与行内代码标记', firstLineSummary('**加粗** 与 `代码`') === '加粗 与 代码');
  check('首行摘要：折叠空白', firstLineSummary('多个   空格') === '多个 空格');
  check('首行摘要：空正文返回空串', firstLineSummary('\n\n  \n') === '');
  check(
    '首行摘要：超长截断并加省略号',
    firstLineSummary('长'.repeat(30), 10) === '长'.repeat(10) + '…',
  );

  finish();
}

runTests('autoMessageCard', run);
