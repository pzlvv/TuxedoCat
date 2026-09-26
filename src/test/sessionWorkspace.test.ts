/**
 * 单测：会话工作目录表（工作目录是对话的属性）。
 *
 * 验证：
 * - `getProjectRoot(sessionId)` 优先按会话解析，未登记 / 未传时回退活动工作目录；
 * - `hasProjectRoot(sessionId)` 按同一规则判断；
 * - `expandPath(path, baseDir)` 以会话自己的工作目录解析相对路径；
 * - 对话列表缓存按工作目录分桶，互不清空；
 * - `createConversationMetadataSync` 写入会话自己的工作目录。
 *
 * 运行方式：npm run test:all -- sessionWorkspace
 */

import * as fs from 'fs';
import * as path from 'path';
import { createChecker, runTests } from './helpers/harness';
import { makeTempDir } from './helpers/fixtures';
import {
  setActiveWorkspace,
  setSessionWorkspace,
  clearSessionWorkspace,
  clearAllSessionWorkspaces,
  getProjectRoot,
  getSessionWorkspace,
  hasProjectRoot,
  getProjectConversationDir,
} from '../core/history/Config';
import {
  loadConversationList,
  resetConversationListCache,
  createConversationMetadataSync,
} from '../core/history/Conversation';
import { expandPath } from '../core/utils/path';

runTests('sessionWorkspace', async () => {
  const { check, finish } = createChecker();
  const wsA = makeTempDir('ws-a');
  const wsB = makeTempDir('ws-b');

  clearAllSessionWorkspaces();
  setActiveWorkspace(wsA);

  // 默认解析到活动工作目录
  check('getProjectRoot() 解析到活动工作目录', getProjectRoot() === wsA);
  check('hasProjectRoot() 为真', hasProjectRoot() === true);

  // 会话工作目录优先于活动工作目录
  setSessionWorkspace('session_b', wsB);
  check('getProjectRoot(sessionId) 解析到会话自己的工作目录', getProjectRoot('session_b') === wsB);
  check('getSessionWorkspace 读取会话工作目录', getSessionWorkspace('session_b') === wsB);
  check('hasProjectRoot(sessionId) 为真', hasProjectRoot('session_b') === true);
  check('未登记会话回退到活动工作目录', getProjectRoot('session_unknown') === wsA);
  check('未登记会话 hasProjectRoot 回退活动工作目录', hasProjectRoot('session_unknown') === true);

  // 相对路径以会话自己的工作目录为基准
  check(
    'expandPath 以 baseDir 解析相对路径',
    expandPath('src/a.ts', wsB) === path.resolve(wsB, 'src/a.ts'),
  );
  check(
    'expandPath 省略 baseDir 时用活动工作目录',
    expandPath('src/a.ts') === path.resolve(wsA, 'src/a.ts'),
  );
  check('expandPath 空路径返回 baseDir', expandPath('', wsB) === wsB);

  // 注销后回退
  clearSessionWorkspace('session_b');
  check('注销后回退到活动工作目录', getProjectRoot('session_b') === wsA);
  check('注销后 getSessionWorkspace 返回 undefined', getSessionWorkspace('session_b') === undefined);

  // 无活动工作目录时，已登记的会话仍可解析
  setActiveWorkspace(null);
  setSessionWorkspace('session_b', wsB);
  check('活动工作目录为空时会话仍可解析', getProjectRoot('session_b') === wsB);
  check('活动工作目录为空时 hasProjectRoot() 为假', hasProjectRoot() === false);
  check('活动工作目录为空时 hasProjectRoot(sessionId) 为真', hasProjectRoot('session_b') === true);
  setActiveWorkspace(wsA);

  // 对话列表缓存按工作目录分桶
  const dirA = getProjectConversationDir(wsA);
  const dirB = getProjectConversationDir(wsB);
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  const meta = (sessionId: string, project: string) =>
    JSON.stringify({ sessionId, project, title: sessionId, createdAt: 1, updatedAt: 1, messageCount: 1 });
  fs.writeFileSync(path.join(dirA, 'session_a.meta.json'), meta('session_a', wsA));
  fs.writeFileSync(path.join(dirB, 'session_b.meta.json'), meta('session_b', wsB));

  resetConversationListCache();
  const listA = await loadConversationList(wsA);
  const listB = await loadConversationList(wsB);
  check(
    'loadConversationList(wsA) 只含 A 的对话',
    listA.length === 1 && listA[0].sessionId === 'session_a',
  );
  check(
    'loadConversationList(wsB) 只含 B 的对话',
    listB.length === 1 && listB[0].sessionId === 'session_b',
  );
  const listA2 = await loadConversationList(wsA);
  check('缓存按工作目录分桶且命中', listA2 === listA && listA2[0].sessionId === 'session_a');

  // 无工作目录时返回空列表而不是抛错
  setActiveWorkspace(null);
  resetConversationListCache();
  const empty = await loadConversationList();
  check('无工作目录时 loadConversationList 返回空', empty.length === 0);
  setActiveWorkspace(wsA);

  // 新建对话元数据写入会话自己的工作目录
  setSessionWorkspace('session_c', wsB);
  createConversationMetadataSync('session_c', 'title');
  check(
    'createConversationMetadataSync 写入会话自己的工作目录',
    fs.existsSync(path.join(dirB, 'session_c.meta.json')),
  );
  check(
    'createConversationMetadataSync 不写入活动工作目录',
    !fs.existsSync(path.join(dirA, 'session_c.meta.json')),
  );
  const written = JSON.parse(fs.readFileSync(path.join(dirB, 'session_c.meta.json'), 'utf-8'));
  check('元数据 project 记录会话自己的工作目录', written.project === wsB);

  clearAllSessionWorkspaces();
  finish();
});
