/**
 * 分支对话契约面的形态锁定（specs/037 FR-001 / FR-008）：
 *
 * - `CoreEvent.branchStateChanged` / `UiEvent.branchModeChanged` /
 *   `UiRequest.branchTreeRequested` / `UiRequest.branchPrecheckRequested` 在
 *   `src/shared/AssistantEventBus.ts` 的联合里存在，判别字段与载荷必选（无 `?`）；
 * - `view` 是**判别联合**（`plain` / `ready` / `unavailable`），`ready` 只带四个最小事实；
 * - `meta.json` 的 `branch` 字段两侧同名同形：Rust `BranchFacts::to_meta` 的键 =
 *   TS `ConversationBranch` 的键（Rust 写 → TS 读的字段名对照）；
 * - 旧会话没有 `branch` 键时读取侧归一为 `null`（`normalizeBranch`），
 *   `ConversationMetadata.branch` 成员必选、不用可选字段。
 *
 * 本文件不依赖 Core 二进制；运行方式：npm run test:all -- branch-contract
 */

import * as fs from 'fs';
import * as path from 'path';
import { normalizeBranch, type ConversationBranch, type ConversationMetadata } from '../shared/history/Conversation';
import { createChecker, runTests } from './helpers/harness';

/** 仓库根：编译产物在 `out/src/test/`，往上三层 */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const BUS_SOURCE = path.join(REPO_ROOT, 'src', 'shared', 'AssistantEventBus.ts');
const STATE_SOURCE = path.join(REPO_ROOT, 'core-rs', 'src', 'branch', 'state.rs');
const HISTORY_SOURCE = path.join(REPO_ROOT, 'core-rs', 'src', 'history.rs');

/** 去掉块注释与行注释（成员名扫描不该被注释里的示例骗到） */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** 取某个 `export type X = …` 成员的源码片段（到下一个顶层 `export` 为止） */
function unionBlock(source: string, name: string): string {
  const start = source.indexOf(`export type ${name} =`);
  if (start < 0) throw new Error(`AssistantEventBus.ts 缺 export type ${name}`);
  const rest = source.slice(start + 1);
  const stops = ['\nexport type ', '\nexport interface ', '\n// ===================='].map((marker) => {
    const at = rest.indexOf(marker);
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  });
  return rest.slice(0, Math.min(...stops));
}

/**
 * 取联合里某个成员（以 `type: '<name>'` 定位）。
 *
 * 成员有两种书写形态：多行（`| {\n type: 'x';\n … }`）与单行
 * （`| { type: 'x'; … }`），因此起点取「该 type 之前最近的花括号」，再按花括号配平取到
 * 成员结束。
 */
function memberBlock(block: string, type: string): string {
  const at = block.indexOf(`type: '${type}'`);
  if (at < 0) throw new Error(`联合里缺成员 ${type}`);
  const start = block.lastIndexOf('{', at);
  let index = start;
  let depth = 0;
  while (index < block.length) {
    const ch = block[index];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        index += 1;
        break;
      }
    }
    index += 1;
  }
  return block.slice(Math.max(start, 0), index);
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  const busSource = stripComments(fs.readFileSync(BUS_SOURCE, 'utf8'));
  const coreEvents = unionBlock(busSource, 'CoreEvent');
  const uiEvents = unionBlock(busSource, 'UiEvent');
  const uiRequests = unionBlock(busSource, 'UiRequest');

  // ---- CoreEvent.branchStateChanged ----
  const branchEvent = memberBlock(coreEvents, 'branchStateChanged');
  check(
    'CoreEvent.branchStateChanged 载荷是 { sessionId, view }，全必选',
    /sessionId:\s*string/.test(branchEvent) && /\bview:/.test(branchEvent),
  );
  check(
    'branchStateChanged.view 是判别联合（plain / ready / unavailable 三态）',
    branchEvent.includes("state: 'plain'")
      && branchEvent.includes("state: 'ready'")
      && branchEvent.includes("state: 'unavailable'"),
  );
  check(
    'ready 态只带 branch / worktree / baseCommit / baseBranch 四个最小事实',
    ['branch', 'worktree', 'baseCommit', 'baseBranch'].every((field) =>
      new RegExp(`\\b${field}:\\s*string`).test(branchEvent),
    ),
  );
  // 窄口径断言：view 不带 commits / dirty / peers / deps（specs/037 FR-008）
  const forbidden = ['commits', 'dirty', 'peers', 'deps'].filter((field) =>
    new RegExp(`\\b${field}\\s*:`).test(branchEvent),
  );
  check(
    `branchStateChanged.view 不带 commits / dirty / peers / deps（命中 ${forbidden.join(' / ') || '无'}）`,
    forbidden.length === 0,
  );
  check(
    'unavailable 态的 reason 只有 not-git / worktree-missing / git-failed 三个取值',
    /reason:\s*'not-git'\s*\|\s*'worktree-missing'\s*\|\s*'git-failed'/.test(branchEvent),
  );
  check('branchStateChanged.view 没有可选字段（不出现 `?`）', !/\w\?:/.test(branchEvent));

  // ---- UiEvent.branchModeChanged ----
  // 断言不区分成员的书写形态（单行成员不带行尾 `;`）：只比字段与类型
  const modeEvent = memberBlock(uiEvents, 'branchModeChanged');
  check(
    'UiEvent.branchModeChanged 载荷是 { sessionId, mode: plain|branch }',
    /sessionId:\s*string/.test(modeEvent) && /mode:\s*'plain'\s*\|\s*'branch'/.test(modeEvent),
  );

  // ---- UiRequest 两条 ----
  const treeRequest = memberBlock(uiRequests, 'branchTreeRequested');
  check(
    'UiRequest.branchTreeRequested 载荷是 { sessionId, dir }',
    /sessionId:\s*string/.test(treeRequest) && /dir:\s*string/.test(treeRequest),
  );
  const precheckRequest = memberBlock(uiRequests, 'branchPrecheckRequested');
  check(
    'UiRequest.branchPrecheckRequested 按工作区路由（workspacePath: string | null）',
    /workspacePath:\s*string\s*\|\s*null/.test(precheckRequest),
  );

  // ---- `sessionConfigChanged` 的 change 联合带 branchMode ----
  check(
    "sessionConfigChanged 的 change 联合包含 { key: 'branchMode' }",
    coreEvents.includes("key: 'branchMode'; value: 'plain' | 'branch'"),
  );

  // ---- meta.json 的 branch 字段两侧同名同形 ----
  const stateSource = fs.readFileSync(STATE_SOURCE, 'utf8');
  const metaKeys = [...stateSource.matchAll(/"(\w+)":\s*(?:self\.|facts\.)?(\w+)/g)]
    .filter((match) => match[1] !== undefined)
    .map((match) => match[1] as string);
  const expected = ['name', 'worktree', 'baseCommit', 'baseBranch'];
  const metaBlockStart = stateSource.indexOf('pub fn to_meta');
  const metaBlock = stateSource.slice(metaBlockStart, stateSource.indexOf('pub fn from_meta'));
  const rustKeys = expected.filter((key) => metaBlock.includes(`"${key}"`));
  check(
    `Rust BranchFacts::to_meta 写全四个键（${expected.join(' / ')}；命中 ${rustKeys.length}）`,
    rustKeys.length === expected.length,
  );

  const tsBranch: ConversationBranch = {
    name: 'ellen-k3f',
    worktree: '/core/worktrees/ellen-k3f',
    baseCommit: 'abc123',
    baseBranch: 'main',
  };
  check(
    'TS ConversationBranch 的键与 Rust 侧一致（同名同形）',
    Object.keys(tsBranch).join(',') === expected.join(','),
  );
  const normalized = normalizeBranch(tsBranch);
  check('normalizeBranch 对合法形态原样返回', normalized !== null && normalized.name === tsBranch.name);

  // ---- 旧会话兼容：缺失 / 形态不对一律 null ----
  check('旧会话没有 branch 键 → null', normalizeBranch(undefined) === null);
  check('branch 为 null → null', normalizeBranch(null) === null);
  check('branch 形态不对（非对象）→ null', normalizeBranch('ellen-k3f') === null);
  check(
    'branch 缺字段 → null（不猜值）',
    normalizeBranch({ name: 'ellen-k3f', worktree: '/w' }) === null,
  );

  // ---- ConversationMetadata.branch 必选、用 null 表示「没有」 ----
  const conversationSource = stripComments(
    fs.readFileSync(path.join(REPO_ROOT, 'src', 'shared', 'history', 'Conversation.ts'), 'utf8'),
  );
  check(
    'ConversationMetadata.branch 是必选成员、用 `| null` 表示没有（不用 `?`）',
    /branch: ConversationBranch \| null;/.test(conversationSource),
  );
  // 只看 `ConversationMetadata` 接口体本身：`normalizeBranch((parsed as { branch?: unknown }).branch)`
  // 是读取侧的窄化断言，不是契约成员
  const metadataInterfaceStart = conversationSource.indexOf('export interface ConversationMetadata {');
  const metadataInterface = conversationSource.slice(
    metadataInterfaceStart,
    conversationSource.indexOf('\n}', metadataInterfaceStart),
  );
  check(
    'ConversationMetadata 里 branch 没有写成可选成员',
    metadataInterfaceStart >= 0 && !/\bbranch\?:/.test(metadataInterface),
  );
  // 类型层断言：缺 branch 的形态不满足 ConversationMetadata（编译期即红）
  type MissingBranch = Omit<ConversationMetadata, 'branch'>;
  const withoutBranch: MissingBranch = {
    sessionId: 's',
    project: '/w',
    title: 't',
    createdAt: 1,
    updatedAt: 1,
    messageCount: 1,
    creator: { kind: 'user' },
  };
  check(
    '缺 branch 的对象类型上不是 ConversationMetadata（成员必选）',
    ('branch' in withoutBranch) === false,
  );

  // ---- 落盘写入点收在 history.rs 的唯一函数 ----
  const historySource = fs.readFileSync(HISTORY_SOURCE, 'utf8');
  check(
    'branch 字段的唯一落盘点在 history.rs 的 touch_metadata_with_branch',
    historySource.includes('pub fn touch_metadata_with_branch') && historySource.includes('metadata["branch"] = branch.clone();'),
  );
  check('state.rs 的 metaKeys 扫描没有意外空结果（夹具自检）', Array.isArray(metaKeys));

  finish();
}

runTests('branchContract', run);
