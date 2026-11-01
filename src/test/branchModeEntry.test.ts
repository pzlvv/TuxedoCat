/**
 * 分支对话的入口与形态链路（specs/037 FR-006）：
 *
 * - `startNewConversation` 的形态标记 → 宿主翻译成 `UiEvent.branchModeChanged`（形态到达
 *   Core 的唯一一跳），且**先于** `conversationStarted`（Core 要在建引擎时改向工具根）；
 * - `plain` 形态不发该事件（普通对话不建 worktree、行为逐项不变）；
 * - i18n 双语齐全：下拉两项、置灰原因、草稿页脏工作区提示、标题 tooltip；
 * - 等待态语义：`branchStateChanged` 未到达时 webview 不按猜测值渲染分支名。
 *
 * 运行方式：npm run test:all -- branch-mode-entry
 */

import * as fs from 'fs';
import * as path from 'path';
import { zhDict } from '../webview/i18n/zh';
import { enDict } from '../webview/i18n/en';
import { createChecker, runTests } from './helpers/harness';

/** 仓库根：编译产物在 `out/src/test/`，往上三层 */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** 分支对话用到的全部 i18n 键（specs/037 FR-006 的四点 UI 增量） */
const BRANCH_KEYS = [
  'branch.newChatMenu',
  'branch.menuTitle',
  'branch.plainChat',
  'branch.plainChatHint',
  'branch.branchChat',
  'branch.branchChatHint',
  'branch.notGit',
  'branch.dirtyHint',
  'branch.dirtyHintNoBase',
  'branch.precheckPending',
  'branch.titleTip',
  'branch.listTipSource',
  'branch.unavailableTip',
  'notice.branch.unavailable',
] as const;

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // ---- i18n：双语齐全且不是空串 ----
  const missingZh = BRANCH_KEYS.filter((key) => {
    const value = (zhDict as Record<string, string>)[key];
    return typeof value !== 'string' || value.length === 0;
  });
  const missingEn = BRANCH_KEYS.filter((key) => {
    const value = (enDict as Record<string, string>)[key];
    return typeof value !== 'string' || value.length === 0;
  });
  check(`分支文案的中文齐全（缺 ${missingZh.join(' / ') || '无'}）`, missingZh.length === 0);
  check(`分支文案的英文齐全（缺 ${missingEn.join(' / ') || '无'}）`, missingEn.length === 0);
  check(
    '脏工作区提示带 {base} 占位（草稿页显示 base 短 id）',
    String((zhDict as Record<string, string>)['branch.dirtyHint']).includes('{base}')
      && String((enDict as Record<string, string>)['branch.dirtyHint']).includes('{base}'),
  );
  check(
    '置灰原因文案双语都说明「不是 git 仓库」',
    String((zhDict as Record<string, string>)['branch.notGit']).includes('git')
      && String((enDict as Record<string, string>)['branch.notGit']).includes('git'),
  );

  // ---- 宿主翻译：startNewConversation 的形态标记 ----
  const handlerSource = fs.readFileSync(
    path.join(REPO_ROOT, 'src', 'host', 'ui', 'webviewMessageHandler.ts'),
    'utf8',
  );
  const branchEmitAt = handlerSource.indexOf("type: 'branchModeChanged'");
  const startedEmitAt = handlerSource.indexOf("type: 'conversationStarted'");
  check("宿主把 startNewConversation 的形态标记翻译成 branchModeChanged", branchEmitAt > 0);
  check(
    'branchModeChanged 先于 conversationStarted（Core 建引擎时要改向工具根）',
    branchEmitAt > 0 && startedEmitAt > branchEmitAt,
  );
  check(
    "只有 mode === 'branch' 才发该事件（plain 是空操作）",
    /message\.mode === 'branch'/.test(handlerSource),
  );

  // ---- 契约：branchStateChanged 在 WebViewUI 的映射表里（漏写会编译报错，这里再锁一次） ----
  const webViewSource = fs.readFileSync(path.join(REPO_ROOT, 'src', 'host', 'WebViewUI.ts'), 'utf8');
  check(
    'WebViewUI 的 onCoreEvents 映射表登记了 branchStateChanged',
    /branchStateChanged: \(e\) => this\.onBranchStateChanged\(/.test(webViewSource),
  );
  check(
    '宿主只翻译和路由：onBranchStateChanged 不写 meta、不改 view',
    /this\.postToWebview\(sessionId, \{ type: 'branchState', view \}\)/.test(webViewSource),
  );

  // ---- webview：等待态（未到达时不渲染分支名）、标题前分支名、无图标无字样 ----
  const appSource = fs.readFileSync(path.join(REPO_ROOT, 'src', 'webview', 'App.tsx'), 'utf8');
  check(
    'branchView 的初始值是 undefined（等待态，不猜「就绪」）',
    /const \[branchView, setBranchView\] = useState<BranchStateView>\(undefined\)/.test(appSource),
  );
  check(
    "只在 view.state === 'ready' 时渲染标题前分支名",
    /branchView\?\.state === 'ready' && \(/.test(appSource),
  );
  check(
    '标题前的分支名只渲染名字本身（不拼 tuxedo/ 前缀）',
    /\{branchView\.branch\}/.test(appSource),
  );
  check(
    "标题区没有「分支对话」字样：unavailable 态才用 branchChat 文案（异常提示）",
    appSource.indexOf("t('branch.branchChat')") > appSource.indexOf("branchView?.state === 'unavailable'"),
  );
  check(
    "分支名在 h1 之前（标题前）",
    appSource.indexOf('data-testid="title-branch-name"') < appSource.indexOf('<h1 className="ui-fs-13 font-semibold truncate"'),
  );

  // ---- split button：主「+」恒为普通方式 ----
  check(
    '主「+」点击是 handleNewConversation(\'plain\')（恒为普通方式）',
    appSource.includes("onClick={() => handleNewConversation('plain')}"),
  );
  check(
    '下拉两项分别是 plain / branch（一次性创建动作，无选中态）',
    appSource.includes("key: 'plain'") && appSource.includes("key: 'branch'"),
  );
  check(
    '分支项在非 git 时置灰（disabled: !branchAvailable）',
    /disabled: !branchAvailable/.test(appSource),
  );
  check(
    '下拉展开时拉一次前置数据（不缓存承诺）',
    /if \(open\) void refreshBranchPrecheck\(\);/.test(appSource),
  );

  // ---- 草稿页：只在分支形态且脏时显示一行提示 ----
  check(
    '草稿页脏工作区提示的判据是「分支形态 + 草稿页 + 脏」（不显示分支名）',
    /draftBranchMode === 'branch' && isDraftPage && branchPrecheckDirty/.test(appSource),
  );
  check(
    '草稿页判据用 newChatSessionRef（未发送的新对话），不是「没有会话」',
    /const isDraftPage = currentSessionId !== null && newChatSessionRef\.current === currentSessionId;/.test(appSource),
  );
  check(
    '列表 tooltip 带完整分支名（tuxedo/<name>）',
    /tuxedo\/\{name\}/.test(String((zhDict as Record<string, string>)['branch.listTipSource'])),
  );
  check(
    '草稿页提示里没有分支名插值（名字在会话建立时才生成）',
    !/data-testid="branch-dirty-hint"[\s\S]{0,400}branchView/.test(appSource),
  );

  // ---- 消息区与状态条不出现分支横幅 / 依赖策略 / 并行计数 / 发布按钮 ----
  check(
    '消息区没有分支横幅（不出现 branch 相关的常驻区块）',
    !/data-testid="branch-banner"/.test(appSource),
  );
  check(
    '没有发布 / 合并按钮（成果出口是 git merge）',
    !/发布分支|publishBranch|mergeBranch/.test(appSource),
  );

  // ---- 对话列表：条目标题前显示分支名（无图标、宽度上限 140px） ----
  const treeItemSource = fs.readFileSync(
    path.join(REPO_ROOT, 'src', 'webview', 'ConversationTreeItem.tsx'),
    'utf8',
  );
  check(
    '对话列表条目标题前渲染分支名',
    treeItemSource.includes('data-testid="list-branch-name"') && /branch\.name/.test(treeItemSource),
  );
  check(
    '列表分支名宽度上限 140px（AC-18）',
    /maxWidth: 140/.test(treeItemSource),
  );
  check(
    '列表分支名的悬停显示来源（baseBranch + base 短 id + 时间）',
    treeItemSource.includes("t('branch.listTipSource'")
      && treeItemSource.includes('branch.baseCommit.substring(0, 7)'),
  );
  check(
    '列表分支名没有图标（只有文本节点）',
    !/data-testid="list-branch-name"[\s\S]{0,200}<Icon/.test(treeItemSource),
  );

  finish();
}

runTests('branchModeEntry', run);
