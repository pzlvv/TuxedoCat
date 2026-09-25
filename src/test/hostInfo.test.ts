/**
 * hostInfoForViewMode 单测（视图模式运行期切换的能力推导）
 *
 * 覆盖：
 * - base × mode 四种组合的 conversationList / newConversation 推导；
 * - 模式与 base 相同时返回同一对象引用（App 的 state 与 useMemo 依赖引用稳定性）；
 * - 悬浮窗（single/webview）启动后切回 multi 时，newConversation 必须回到 'host'
 *   —— 回退 base 会让完整模式顶栏同时出现「新建对话」与「关闭会话」。
 *
 * 运行方式：npm run test:all -- host-info
 */

import {
  hostInfoForViewMode,
  rendersConversationListInWebview,
  openConversationModeOf,
  canCloseConversation,
  ELECTRON_HOST_INFO,
  VSCODE_HOST_INFO,
  type HostInfo,
} from '../host/types';
import { createChecker, runTests } from './helpers/harness';

const { check, finish } = createChecker();

function run(): void {
  // ── base × mode 四种组合 ──
  const cases: Array<{ label: string; base: HostInfo; mode: HostInfo['conversationList']; want: HostInfo }> = [
    {
      label: 'Electron 多视图 + multi（启动即完整模式）',
      base: ELECTRON_HOST_INFO,
      mode: 'multi',
      want: { conversationList: 'multi', newConversation: 'host' },
    },
    {
      label: 'Electron 多视图 + single（切到悬浮窗）',
      base: ELECTRON_HOST_INFO,
      mode: 'single',
      want: { conversationList: 'single', newConversation: 'webview' },
    },
    {
      label: 'VS Code 单视图 + single',
      base: VSCODE_HOST_INFO,
      mode: 'single',
      want: { conversationList: 'single', newConversation: 'webview' },
    },
    {
      // 关键回归点：以悬浮窗启动的视图（preload 注入 base=single/webview）切回完整模式
      label: '悬浮窗启动的视图 + multi（切回完整模式）',
      base: { conversationList: 'single', newConversation: 'webview' },
      mode: 'multi',
      want: { conversationList: 'multi', newConversation: 'host' },
    },
  ];

  for (const c of cases) {
    const info = hostInfoForViewMode(c.base, c.mode);
    check(
      `${c.label} → ${info.conversationList}/${info.newConversation}`,
      info.conversationList === c.want.conversationList && info.newConversation === c.want.newConversation,
    );
  }

  // ── 引用稳定：模式与 base 相同时返回同一对象 ──
  check('multi 宿主 + multi 模式返回同一引用', hostInfoForViewMode(ELECTRON_HOST_INFO, 'multi') === ELECTRON_HOST_INFO);
  check('single 宿主 + single 模式返回同一引用', hostInfoForViewMode(VSCODE_HOST_INFO, 'single') === VSCODE_HOST_INFO);

  // ── 派生行为（UI 与「打开会话」都读它们）──
  const floating = hostInfoForViewMode(ELECTRON_HOST_INFO, 'single');
  check('single：对话列表由 webview 渲染', rendersConversationListInWebview(floating) === true);
  check('single：打开会话走 loadConversation', openConversationModeOf(floating) === 'loadConversation');
  check('single：不提供关闭会话按钮', canCloseConversation(floating) === false);

  const backToMulti = hostInfoForViewMode(floating, 'multi');
  check('切回 multi：列表交还原生侧栏', rendersConversationListInWebview(backToMulti) === false);
  check('切回 multi：打开会话走 openConversation', openConversationModeOf(backToMulti) === 'openConversation');
  check('切回 multi：提供关闭会话按钮', canCloseConversation(backToMulti) === true);
  check('切回 multi：新建对话交还宿主侧栏', backToMulti.newConversation === 'host');

  finish();
}

runTests('hostInfo', run);
