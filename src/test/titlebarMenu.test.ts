/**
 * 自绘标题栏下拉菜单的 HTML 生成：守护「二级飞出面板条目多时被页面裁掉」这个回归。
 *
 * 症状：飞出面板是 body 的绝对定位子元素，而 body 只按主面板 .menu 的自然高度撑开，
 * 于是 body 上的 overflow: hidden 会把超出主面板的那截飞出面板整段裁掉。更糟的是
 * 飞出面板自身 scrollHeight == clientHeight（不会出现滚动条），后半截条目既看不到
 * 也滚不到——「添加最近的工作区」有十来条时就是这个表现。
 *
 * 修法：body 的 min-height 取菜单可用高度上限（maxHeight）。飞出面板底边由
 * positionFlyout 限制在 maxHeight 以内，所以 body 撑到 maxHeight 后一定装得下。
 *
 * 运行方式：npm run test:all -- titlebar-menu
 */

import * as assert from 'assert';
import { createChecker, runTests } from './helpers/harness';
import { getTitlebarMenuHtml, TITLEBAR_SUBMENU_WIDTH } from '../../electron/titlebarMenuHtml';

const MAX_HEIGHT = 700;

/** 造一份「最近工作目录」条目偏多的菜单：二级面板高度会超过主面板 */
function menuWithRecents(count: number, maxHeight?: number): string {
  return getTitlebarMenuHtml({
    items: [
      { type: 'item', id: 'main.addWorkspace', label: '打开本地工作区...' },
      {
        type: 'submenu',
        id: 'main.recent',
        label: '添加最近的工作区',
        items: Array.from({ length: count }, (_, i) => ({
          type: 'item',
          id: `main.recent.${i}`,
          label: `D:\\git\\project-${i}`,
        })),
      },
    ],
    isDark: false,
    maxHeight,
    availableRight: 1000,
    nonce: 'testnonce',
  });
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  const html = menuWithRecents(10, MAX_HEIGHT);
  const rendered = html.match(/data-id="main\.recent\.\d+"/g) ?? [];
  check('二级面板的条目全部渲染（10 条一条不少）', rendered.length === 10);
  check(
    'body 撑满菜单可用高度：超出主面板的飞出面板不会被 overflow 裁掉',
    html.includes(`min-height: ${MAX_HEIGHT}px`),
  );
  // 这条是上一条成立的前提：飞出面板底边被限制在 maxHeight 以内
  check('飞出面板高度上限取自 maxHeight', html.includes('maxHeight - top'));
  check('飞出面板宽度与常量一致', html.includes(`width: ${TITLEBAR_SUBMENU_WIDTH}px`));

  // 动态飞出宽度：主进程按「锚点到窗口右缘」下发，长路径完整显示；
  // 非法 / 过小值回退缺省宽度
  const wide = getTitlebarMenuHtml({
    items: [{ type: 'item', id: 'a', label: 'a' }],
    isDark: false,
    nonce: 'testnonce',
    flyoutWidth: 1280,
  });
  check('下发的飞出宽度生效（CSS 与页面变量同步）', wide.includes('width: 1280px') && wide.includes('var FLYOUT_W = 1280;'));
  const narrow = getTitlebarMenuHtml({
    items: [{ type: 'item', id: 'a', label: 'a' }],
    isDark: false,
    nonce: 'testnonce',
    flyoutWidth: 100,
  });
  check('过小的飞出宽度回退缺省值', narrow.includes(`width: ${TITLEBAR_SUBMENU_WIDTH}px`));

  // 未传 maxHeight（无高度上限）时不能拼出 `min-height: px` 这种非法声明
  const uncapped = menuWithRecents(3);
  check('未给 maxHeight 时不产生非法 min-height 声明', !/min-height:\s*px/.test(uncapped));
  assert.ok(!uncapped.includes('min-height'), '无 maxHeight 时不应声明 min-height');

  finish();
}

runTests('titlebarMenu', run);
