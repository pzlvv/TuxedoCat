/**
 * hostInfoForConversationListOwner 单测（对话列表渲染方运行期切换的能力推导）
 *
 * 覆盖：
 * - 切换渲染方只改 `conversationListOwner`，`conversationView`（宿主静态能力）原样保留；
 * - 渲染方与 base 相同时返回同一对象引用（App 的 state 与 useMemo 依赖引用稳定性）；
 * - 派生行为：列表 / 新建入口跟渲染方走，打开方式 / 关闭按钮跟视图模式走
 *   —— 悬浮窗（Electron + webview 渲染列表）仍是多视图，切换会话不原地重载。
 *
 * 运行方式：npm run test:all -- host-info
 */

import {
  hostInfoForConversationListOwner,
  rendersConversationListInWebview,
  newConversationEntryOf,
  openConversationModeOf,
  canCloseConversation,
  ELECTRON_HOST_INFO,
  VSCODE_HOST_INFO,
  type HostInfo,
} from '../host/types';
import { createChecker, runTests } from './helpers/harness';

const { check, finish } = createChecker();

function run(): void {
  // ── base × owner 四种组合：只改 owner，视图模式不动 ──
  const cases: Array<{
    label: string;
    base: HostInfo;
    owner: HostInfo['conversationListOwner'];
    want: HostInfo;
  }> = [
    {
      label: 'Electron 多视图 + host（启动即完整模式）',
      base: ELECTRON_HOST_INFO,
      owner: 'host',
      want: { conversationView: 'multi', conversationListOwner: 'host' },
    },
    {
      label: 'Electron 多视图 + webview（切到悬浮窗）',
      base: ELECTRON_HOST_INFO,
      owner: 'webview',
      want: { conversationView: 'multi', conversationListOwner: 'webview' },
    },
    {
      label: 'VS Code 单视图 + webview',
      base: VSCODE_HOST_INFO,
      owner: 'webview',
      want: { conversationView: 'single', conversationListOwner: 'webview' },
    },
    {
      // 关键回归点：以悬浮窗启动的视图（preload 注入 owner=webview）切回完整模式
      label: '悬浮窗启动的视图 + host（切回完整模式）',
      base: { conversationView: 'multi', conversationListOwner: 'webview' },
      owner: 'host',
      want: { conversationView: 'multi', conversationListOwner: 'host' },
    },
  ];

  for (const c of cases) {
    const info = hostInfoForConversationListOwner(c.base, c.owner);
    check(
      `${c.label} → ${info.conversationView}/${info.conversationListOwner}`,
      info.conversationView === c.want.conversationView
        && info.conversationListOwner === c.want.conversationListOwner,
    );
  }

  // ── 引用稳定：渲染方与 base 相同时返回同一对象 ──
  check('Electron + host 返回同一引用', hostInfoForConversationListOwner(ELECTRON_HOST_INFO, 'host') === ELECTRON_HOST_INFO);
  check('VS Code + webview 返回同一引用', hostInfoForConversationListOwner(VSCODE_HOST_INFO, 'webview') === VSCODE_HOST_INFO);

  // ── 派生行为：列表渲染方 / 新建入口跟 owner 走 ──
  const floating = hostInfoForConversationListOwner(ELECTRON_HOST_INFO, 'webview');
  check('悬浮窗：对话列表由 webview 渲染', rendersConversationListInWebview(floating) === true);
  check('悬浮窗：新建对话入口在顶栏', newConversationEntryOf(floating) === 'webview');

  const backToHost = hostInfoForConversationListOwner(floating, 'host');
  check('切回完整模式：列表交还原生侧栏', rendersConversationListInWebview(backToHost) === false);
  check('切回完整模式：新建对话交还宿主侧栏', newConversationEntryOf(backToHost) === 'host');

  // ── 派生行为：打开方式 / 关闭按钮跟视图模式走，不随渲染方变化 ──
  check('悬浮窗仍是多视图：打开会话走 openConversation', openConversationModeOf(floating) === 'openConversation');
  check('悬浮窗仍是多视图：提供关闭会话按钮', canCloseConversation(floating) === true);

  const vscode = hostInfoForConversationListOwner(VSCODE_HOST_INFO, 'webview');
  check('VS Code 单视图：打开会话走 loadConversation', openConversationModeOf(vscode) === 'loadConversation');
  check('VS Code 单视图：不提供关闭会话按钮', canCloseConversation(vscode) === false);
  check('VS Code 单视图：列表由 webview 渲染', rendersConversationListInWebview(vscode) === true);

  finish();
}

runTests('hostInfo', run);
