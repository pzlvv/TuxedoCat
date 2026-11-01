/**
 * 分支对话的两条 `UiRequest` 与宿主回落（specs/037 FR-003 / FR-007）：
 *
 * - `requestBranchTree` / `requestBranchPrecheck` 走同名 `requestCore`，载荷带路由键；
 * - `not-branch` 是唯一的失败形态：宿主据此**回落主工作区读盘**（不是分支会话 /
 *   worktree 已不在 / 相对路径越界，三种情形的表现相同，不细分 reason）；
 * - 目录树条目**没有** `change` 字段（侧栏差异标记是本次范围之外的预留设计）；
 * - `branchPrecheckRequested` 按工作区路由：多工作区宿主必须问到该目录自己的 Core。
 *
 * 运行方式：npm run test:all -- branch-tree-requested
 */

import * as assert from 'assert';
import { setGlobalEventBus, type UiRequest } from '../shared/AssistantEventBus';
import { requestBranchPrecheck, requestBranchTree } from '../host/coreFacts';
import { createTestBus } from './helpers/testBus';
import { createChecker, runTests } from './helpers/harness';

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  const sent: UiRequest[] = [];
  let treeResult: Awaited<ReturnType<typeof requestBranchTree>> = { ok: true, entries: [] };
  let precheckResult: Awaited<ReturnType<typeof requestBranchPrecheck>> = {
    ok: true,
    head: 'abc1234',
    dirty: false,
    baseBranch: 'main',
  };

  const bus = createTestBus();
  bus.onUiRequests({
    conversationListRequested: async () => [],
    smartNamingRequested: async () => ({ title: '' }),
    balanceRequested: async () => null,
    compactArchiveRequested: async () => null,
    mcpServersRequested: async () => [],
    conversationSpacesRequested: async () => [],
    flushSessionRequested: async () => null,
    conversationLoadRequested: async () => ({
      messages: [],
      metadata: null,
      pendingToolUseIds: [],
      hasCompactArchive: false,
      agentMode: null,
      workMode: 'normal',
    }),
    sessionTodosRequested: async () => [],
    skillsRequested: async () => ({ skills: [] }),
    spinDesignRequested: async () => ({ status: 'ok', data: null, skills: [] }),
    spinDesignSaveRequested: async () => ({ status: 'ok' }),
    watchWorkspaceFileRequested: async () => ({ ok: true }),
    unwatchWorkspaceFileRequested: async () => null,
    branchTreeRequested: async (request) => {
      sent.push(request);
      return treeResult;
    },
    branchPrecheckRequested: async (request) => {
      sent.push(request);
      return precheckResult;
    },
  });
  setGlobalEventBus(bus);

  // ---- 目录树：路径与载荷带路由键 ----
  const tree = await requestBranchTree({ sessionId: 's-branch', dir: 'src/host' });
  const treeRequest = sent.at(-1) as Extract<UiRequest, { type: 'branchTreeRequested' }>;
  check(
    '分支目录树走 branchTreeRequested',
    treeRequest.type === 'branchTreeRequested',
  );
  check('目录树请求带会话', treeRequest.sessionId === 's-branch');
  check('目录树请求带 worktree 根内相对路径', treeRequest.dir === 'src/host');
  check('目录树应答原样回传（条目 + ok）', tree.ok === true && Array.isArray(tree.entries));

  // ---- 根目录用空串（约定格式，不用 '.'） ----
  await requestBranchTree({ sessionId: 's-branch', dir: '' });
  const rootRequest = sent.at(-1) as Extract<UiRequest, { type: 'branchTreeRequested' }>;
  check('根目录的 dir 是空串（约定格式）', rootRequest.dir === '');

  // ---- not-branch：宿主回落主工作区读盘 ----
  treeResult = { ok: false, reason: 'not-branch' };
  const notBranch = await requestBranchTree({ sessionId: 's-plain', dir: '' });
  check(
    '不是分支会话时应答 { ok: false, reason: not-branch }（宿主据此回落主工作区）',
    notBranch.ok === false && notBranch.reason === 'not-branch',
  );

  // ---- 条目形态：只有 name / kind / mtimeMs，没有差异标记 ----
  treeResult = {
    ok: true,
    entries: [
      { name: 'src', kind: 'directory', mtimeMs: 1 },
      { name: 'README.md', kind: 'file', mtimeMs: null },
    ],
  };
  const withEntries = await requestBranchTree({ sessionId: 's-branch', dir: '' });
  assert.ok(withEntries.ok);
  const keys = Object.keys(withEntries.entries[0] ?? {}).sort();
  check(
    `目录树条目只带 name / kind / mtimeMs（实际 ${keys.join(' / ')}）`,
    keys.join(',') === 'kind,mtimeMs,name',
  );
  check(
    '目录树条目**没有** change 字段（差异标记是预留设计，specs/037 FR-007）',
    withEntries.entries.every((entry) => !('change' in entry)),
  );
  check(
    'mtimeMs 取不到时为 null（不猜值）',
    withEntries.entries[1]?.mtimeMs === null,
  );

  // ---- 创建前置：两态应答 ----
  const ok = await requestBranchPrecheck('/ws');
  const precheckRequest = sent.at(-1) as Extract<UiRequest, { type: 'branchPrecheckRequested' }>;
  check('创建前置走 branchPrecheckRequested', precheckRequest.type === 'branchPrecheckRequested');
  check('创建前置按工作区路由（带 workspacePath）', precheckRequest.workspacePath === '/ws');
  check(
    'git 仓库的应答是 { ok: true, head, dirty, baseBranch }',
    ok.ok === true && ok.head === 'abc1234' && ok.dirty === false && ok.baseBranch === 'main',
  );

  precheckResult = { ok: false, reason: 'not-git', detail: 'not a git repository' };
  const notGit = await requestBranchPrecheck('/plain');
  check(
    '非 git 目录的应答是 { ok: false, reason: not-git, detail }',
    notGit.ok === false && notGit.reason === 'not-git' && notGit.detail.length > 0,
  );
  check('非 git 应答没有 head / dirty（判别联合，不混字段）', !('head' in notGit) && !('dirty' in notGit));

  // ---- 活动工作区：workspacePath 为 null 时按活动工作区路由 ----
  await requestBranchPrecheck(null);
  const activeRequest = sent.at(-1) as Extract<UiRequest, { type: 'branchPrecheckRequested' }>;
  check('workspacePath 为 null 是合法载荷（按活动工作区路由）', activeRequest.workspacePath === null);

  finish();
}

runTests('branchTreeRequested', run);
