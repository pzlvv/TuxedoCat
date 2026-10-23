/**
 * `@` 工作区补全纯函数用例（specs/022 FR-007）：
 * 区间判定（引号 / 非引号 / 首字符）、过滤优先级、插入与光标位置。
 *
 * 运行方式：npm run test:all -- mention-state
 */

import {
  filterWorkspaces,
  insertMention,
  mentionToken,
  resolveMentionRange,
  type WorkspaceMentionItem,
} from '../webview/mentionState';
import { createChecker, runTests } from './helpers/harness';

const items: WorkspaceMentionItem[] = [
  { id: 'DEV-PC:C:\\work\\alpha', path: 'C:\\work\\alpha', displayName: 'alpha' },
  { id: '192.168.1.10:/srv/beta', path: '/srv/beta', displayName: 'beta' },
  { id: 'DEV-PC:C:\\Program Files\\gamma', path: 'C:\\Program Files\\gamma', displayName: 'gamma' },
];

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // ===== 区间 =====
  check('首字符 @ 激活', resolveMentionRange('@', 1).active);
  check('非首字符 @ 不激活', !resolveMentionRange('看 @DEV-PC', 5).active);

  const unquotedValue = '@DEV-PC:C:\\work\\alpha 帮个忙';
  const unquoted = resolveMentionRange(unquotedValue, 12);
  check('非引号区间在第一个空白处结束', unquoted.active && unquotedValue[unquoted.tokenEnd] === ' ');
  check('查询词 = 光标前的区间文本', unquoted.query === 'DEV-PC:C:\\w');
  check('光标越过空白后不再激活', !resolveMentionRange(unquotedValue, 30).active);

  const quotedValue = '@"DEV-PC:C:\\Program Files\\gamma" 帮个忙';
  const quoted = resolveMentionRange(quotedValue, 5);
  check('引号形态跨空白', quoted.active && quotedValue[quoted.tokenEnd] === ' ');
  check('引号形态区间以闭合引号结尾', quotedValue[quoted.tokenEnd - 1] === '"');
  check('引号形态查询词不含 @ 与引号', quoted.query === 'DEV');
  check('引号闭合后光标越界不激活', !resolveMentionRange(quotedValue, quoted.tokenEnd + 1).active);

  // ===== 过滤 =====
  const byId = filterWorkspaces(items, 'beta');
  check('ID 命中', byId.length === 1 && byId[0]?.displayName === 'beta');
  const byName = filterWorkspaces(items, 'gamma');
  check('目录名命中', byName.length === 1 && byName[0]?.displayName === 'gamma');
  const ordering: WorkspaceMentionItem[] = [
    { id: 'HOST:/aaa', path: '/aaa', displayName: 'zzz' },
    { id: 'HOST:/bbb', path: '/bbb', displayName: 'aaa-dir' },
  ];
  const ordered = filterWorkspaces(ordering, 'aaa');
  check('ID 命中排在目录名命中之前', ordered.length === 2 && ordered[0]?.id === 'HOST:/aaa');
  check('空查询返回全部', filterWorkspaces(items, '').length === items.length);

  // ===== 插入 =====
  check('无空白身份用非引号形态', mentionToken(items[0]!.id) === '@DEV-PC:C:\\work\\alpha');
  check(
    '含空白身份用引号形态',
    mentionToken(items[2]!.id) === '@"DEV-PC:C:\\Program Files\\gamma"',
  );

  const inserted = insertMention('@DEV', 4, items[0]!, 4);
  check('插入后带尾随空格', inserted.next === '@DEV-PC:C:\\work\\alpha ');
  check('光标置于输入末尾', inserted.caret === inserted.next.length);

  const keepTail = insertMention('@DEV 帮个忙', 4, items[0]!, 4);
  check('光标之后的原文保留', keepTail.next === '@DEV-PC:C:\\work\\alpha  帮个忙');

  const quotedInsert = insertMention('@"DEV-PC:C:\\Pro', 17, items[2]!, 17);
  check(
    '引号形态插入完整身份',
    quotedInsert.next === '@"DEV-PC:C:\\Program Files\\gamma" ',
  );

  const quotedClosedValue = '@"DEV-PC:C:\\Pro" 帮个忙';
  const quotedClosed = insertMention(quotedClosedValue, 17, items[2]!, quotedClosedValue.indexOf('"', 2) + 1);
  check(
    '引号形态替换到闭合引号、保留其后原文',
    quotedClosed.next === '@"DEV-PC:C:\\Program Files\\gamma"  帮个忙',
  );

  finish();
}

runTests('mention-state', run);
