/**
 * 自绘标题栏下拉菜单的 HTML
 *
 * 与偏好设置窗口（`electron/preferenceDialogHtml.ts`）同构：主进程把 HTML 作为 data URL
 * 载入一个 WebContentsView（见 main.ts 的 ensureTitlebarMenuView），页面只负责显示。
 *
 * 二级菜单（如「最近打开的工作目录」）用飞出面板实现，默认收起、悬停父项才展开：
 * - 父项右侧显示箭头；飞出面板绝对定位在主面板右侧（右侧放不下时改为左侧）
 * - 页面底色透明，视图尺寸按「主面板 ∪ 飞出面板」上报，因此视图比主面板大时
 *   也不会挡住下面的内容（实测 WebContentsView 透明区域能与下方兄弟视图正常混叠）
 *
 * 页面通过 preload 暴露的 window.titlebarMenuAPI 与主进程通信：
 *   select(id)   选中菜单项
 *   close()      关闭菜单（Esc）
 *   resize(size) 上报需要的视图尺寸与左偏移（主进程据此定位窗口）
 */

/** 主面板宽度（与 CSS .menu 宽度一致） */
export const TITLEBAR_MENU_WIDTH = 260;
/** 二级飞出面板宽度（与 CSS .flyout 宽度一致） */
export const TITLEBAR_SUBMENU_WIDTH = 220;

/** 下拉菜单中的一行 */
export type TitlebarMenuNode =
  | { type: 'separator' }
  | { type: 'header'; label: string }
  | {
      type: 'item';
      id: string;
      label: string;
      accelerator?: string;
      enabled?: boolean;
      danger?: boolean;
      /**
       * 可勾选项（radio / checkbox）的选中态。
       * 显式给值（true/false）表示这一行预留勾选位——同组未选中项也要占位对齐；
       * undefined 表示普通项，不预留。
       */
      checked?: boolean;
      /**
       * 可勾选项的语义类型（与 checked 同时给出）：radio → menuitemradio，
       * checkbox → menuitemcheckbox。缺省按 radio 处理。
       */
      checkType?: 'radio' | 'checkbox';
    }
  | {
      type: 'submenu';
      id: string;
      label: string;
      enabled?: boolean;
      items: TitlebarMenuNode[];
    };

export interface TitlebarMenuHtmlOptions {
  items: TitlebarMenuNode[];
  isDark: boolean;
  /**
   * 菜单最大高度（px）：由主进程按窗口内容区高度算出。
   * 超出时菜单内部滚动，避免「最近打开」很多时菜单超出窗口被裁掉。
   */
  maxHeight?: number;
  /** 锚点（主面板左边）右侧还能用多少宽度：不够放飞出面板时改为向左展开 */
  availableRight?: number;
  /**
   * 二级飞出面板宽度上限（px）：主进程按「锚点到窗口右缘」下发。飞出面板按内容
   * 自适应（width: max-content）——条目短就收缩，不撑满可用宽度；「最近的工作区」
   * 这类长路径条目最多铺满到这个上限、完整显示。小于 TITLEBAR_SUBMENU_WIDTH
   * 时按缺省值处理。
   */
  flyoutMaxWidth?: number;
  /**
   * CSP nonce（由主进程随机生成）。页面是 data: URL + 内联 style/script，
   * 用 nonce 而不是 'unsafe-inline'：将来若有字段忘了转义，注入的脚本也执行不了。
   */
  nonce: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderNode(node: TitlebarMenuNode): string {
  if (node.type === 'separator') {
    return '<div class="sep" role="separator"></div>';
  }
  if (node.type === 'header') {
    return `<div class="group">${escapeHtml(node.label)}</div>`;
  }
  if (node.type === 'submenu') {
    const disabled = node.enabled === false;
    return `<div class="item submenu${disabled ? ' disabled' : ''}" role="menuitem" aria-haspopup="true"`
      + ` data-submenu="${escapeHtml(node.id)}"${disabled ? ' aria-disabled="true"' : ''}>`
      + `<span class="label">${escapeHtml(node.label)}</span>`
      + '<svg class="chevron" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 1.5L7 5l-3.5 3.5" /></svg>'
      + '</div>';
  }
  const disabled = node.enabled === false;
  const classes = ['item'];
  if (disabled) classes.push('disabled');
  if (node.danger) classes.push('danger');
  // 可勾选项：预留固定宽度的勾选列（同组未选中项也占位，标题左边缘才对齐）
  const checkable = node.checked !== undefined;
  if (checkable) classes.push('has-check');
  const check = checkable
    ? `<span class="check">${
      node.checked
        ? '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.6 5.4l2.2 2.2L8.4 2.4" /></svg>'
        : ''
    }</span>`
    : '';
  const accelerator = node.accelerator
    ? `<span class="accel">${escapeHtml(node.accelerator)}</span>`
    : '';
  const role = checkable
    ? (node.checkType === 'checkbox' ? 'menuitemcheckbox' : 'menuitemradio')
    : 'menuitem';
  const ariaChecked = checkable ? ` aria-checked="${node.checked ? 'true' : 'false'}"` : '';
  return `<div class="${classes.join(' ')}" role="${role}" data-id="${escapeHtml(node.id)}"${
    disabled ? ' aria-disabled="true"' : ''
  }${ariaChecked}>${check}<span class="label">${escapeHtml(node.label)}</span>${accelerator}</div>`;
}

/** 二级面板里不再嵌套子菜单：更深的层级平铺成 分组标题 + 条目 */
function renderFlyoutNode(node: TitlebarMenuNode): string {
  if (node.type === 'submenu') {
    return `<div class="group">${escapeHtml(node.label)}</div>`
      + node.items.map(renderFlyoutNode).join('\n        ');
  }
  return renderNode(node);
}

function collectSubmenus(nodes: TitlebarMenuNode[]): Array<{ id: string; items: TitlebarMenuNode[] }> {
  const out: Array<{ id: string; items: TitlebarMenuNode[] }> = [];
  for (const node of nodes) {
    if (node.type === 'submenu') out.push({ id: node.id, items: node.items });
  }
  return out;
}

export function getTitlebarMenuHtml(options: TitlebarMenuHtmlOptions): string {
  const bg = options.isDark ? '#1f1f26' : '#ffffff';
  const fg = options.isDark ? '#e4e4e7' : '#1f1f24';
  const muted = options.isDark ? '#8b8b96' : '#8a8a92';
  const border = options.isDark ? '#35353f' : '#dcdce2';
  const hover = options.isDark ? '#2c2c35' : '#f0f0f4';
  const groupColor = options.isDark ? '#7a7a85' : '#9a9aa2';
  const sepColor = options.isDark ? '#2e2e37' : '#ececf1';
  const danger = '#f87171';
  // 滚动条配色 / 尺寸与 electron/ui/scrollbar.css 保持一致（本页是 data URL，引不了那个文件）
  const scrollThumb = options.isDark ? '#3a3a44' : '#c9c9d1';
  const scrollThumbHover = options.isDark ? '#4a4a55' : '#aeaeb9';
  const maxHeight = options.maxHeight && options.maxHeight > 0 ? Math.round(options.maxHeight) : 0;
  const availableRight = Number.isFinite(options.availableRight) ? Math.round(options.availableRight as number) : -1;
  // 飞出面板宽度上限：主进程按「锚点到窗口右缘」下发；非法 / 过小的值按缺省宽度处理
  const flyoutMaxWidth = Number.isFinite(options.flyoutMaxWidth) && (options.flyoutMaxWidth as number) > TITLEBAR_SUBMENU_WIDTH
    ? Math.round(options.flyoutMaxWidth as number)
    : TITLEBAR_SUBMENU_WIDTH;
  // nonce 由主进程用 base64 生成（不含引号），但仍过滤一次避免拼进属性时破坏 HTML
  const nonce = String(options.nonce ?? '').replace(/[^A-Za-z0-9+/=_-]/g, '');

  const body = options.items.map(renderNode).join('\n      ');
  const flyouts = collectSubmenus(options.items)
    .map(
      (sub) =>
        `<div class="flyout" data-flyout="${escapeHtml(sub.id)}" role="menu">\n        ${
          sub.items.map(renderFlyoutNode).join('\n        ')
        }\n      </div>`,
    )
    .join('\n      ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:" />
<style nonce="${nonce}">
  * { box-sizing: border-box; margin: 0; padding: 0; }
  /* 页面底色透明：视图按「主面板 ∪ 飞出面板」取尺寸，多出来的区域不能挡住下方内容 */
  html, body { background: transparent; overflow: hidden; }
  body {
    position: relative;
    /* 撑满菜单可用高度：飞出面板是 body 的绝对定位子元素，body 若只按 .menu 的自然高度
       撑开，overflow: hidden 会把超出主面板的那截飞出面板整段裁掉——此时飞出面板自身
       scrollHeight == clientHeight（滚动条不出现），后半截条目既看不到也滚不到。
       「打开最近的工作区」条目多时就是这个症状。取菜单可用高度上限即可：飞出面板底边
       由 positionFlyout 限制在 maxHeight 以内，永远不会超过这个值。 */
    ${maxHeight ? `min-height: ${maxHeight}px;` : ''}
    font-family: system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif;
    font-size: 12.5px;
    color: ${fg};
    user-select: none;
  }
  .menu, .flyout {
    background: ${bg};
    border: 1px solid ${border};
    padding: 5px;
  }
  .menu {
    width: ${TITLEBAR_MENU_WIDTH}px;
    ${maxHeight ? `max-height: ${maxHeight}px; overflow-y: auto; overflow-x: hidden;` : 'overflow: hidden;'}
  }
  .flyout {
    position: absolute;
    display: none;
    /* 宽度按内容自适应：条目短就收缩到缺省宽度，不撑满可用空间；长条目最多
       铺到主进程下发的上限（锚点 → 窗口右缘），完整显示不截断 */
    width: max-content;
    min-width: ${TITLEBAR_SUBMENU_WIDTH}px;
    max-width: ${flyoutMaxWidth}px;
    overflow-y: auto;
    overflow-x: hidden;
    z-index: 2;
  }
  .flyout.open { display: block; }
  .menu::-webkit-scrollbar, .flyout::-webkit-scrollbar { width: 6px; }
  .menu::-webkit-scrollbar-track, .flyout::-webkit-scrollbar-track { background: transparent; }
  .menu::-webkit-scrollbar-thumb, .flyout::-webkit-scrollbar-thumb { background: ${scrollThumb}; border-radius: 3px; }
  .menu::-webkit-scrollbar-thumb:hover, .flyout::-webkit-scrollbar-thumb:hover { background: ${scrollThumbHover}; }
  .item {
    display: flex;
    align-items: center;
    gap: 16px;
    height: 28px;
    padding: 0 10px;
    border-radius: 5px;
    cursor: default;
    white-space: nowrap;
  }
  .item .label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .item .accel {
    flex: 0 0 auto;
    color: ${muted};
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
  }
  .item .chevron {
    flex: 0 0 auto;
    width: 10px;
    height: 10px;
    fill: none;
    stroke: ${muted};
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  /* 可勾选项：固定宽度的勾选列（未选中项也占位），整组标题左边缘对齐 */
  .item.has-check { gap: 8px; }
  .item .check {
    flex: 0 0 14px;
    width: 14px;
    height: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .item .check svg {
    width: 11px;
    height: 11px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .item:hover:not(.disabled),
  .item.active:not(.disabled),
  .item.submenu.open:not(.disabled) {
    background: ${hover};
  }
  .item.disabled {
    color: ${muted};
    opacity: 0.65;
  }
  .item.danger .label { color: ${danger}; }
  .group {
    padding: 7px 10px 3px;
    font-size: 10.5px;
    letter-spacing: 0.4px;
    text-transform: uppercase;
    color: ${groupColor};
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sep {
    height: 1px;
    background: ${sepColor};
    margin: 5px 6px;
  }
</style>
</head>
<body>
  <div class="menu" id="menu" role="menu">
      ${body}
  </div>
      ${flyouts}
<script nonce="${nonce}">
  (function () {
    var api = window.titlebarMenuAPI;
    // preload 未注入时明确提示：否则后面每次 api.* 都会抛错，菜单静默不显示、无从排查
    if (!api) {
      document.body.textContent = 'titlebar menu unavailable';
      return;
    }
    var menu = document.getElementById('menu');
    var PANEL_W = ${TITLEBAR_MENU_WIDTH};
    var maxHeight = ${maxHeight || 0};
    var availableRight = ${availableRight};
    // 当前展开的飞出面板方向。面板宽度按内容自适应（CSS width: max-content），
    // 每个面板的实测宽度不同，向左 / 向右展开在 openSubmenu 时按实测宽度决定
    var openSide = 'right';
    var openFlyout = null;
    // 键盘焦点所在面板与序号：二级面板打开后方向键要能在面板内部移动
    var activeRoot = menu;
    var activeIndex = -1;
    // 分区 id → 飞出面板元素。按 data 属性建表而不是把 id 拼进选择器，
    // 避免 id 含引号/方括号时选择器语法错误。
    var flyouts = {};
    Array.prototype.forEach.call(document.querySelectorAll('.flyout'), function (el) {
      flyouts[el.getAttribute('data-flyout')] = el;
    });

    function itemsIn(root) {
      return Array.prototype.slice.call(root.querySelectorAll('.item:not(.disabled)'));
    }

    function reportSize() {
      var panel = menu.getBoundingClientRect();
      var right = panel.right;
      var bottom = panel.bottom;
      var offsetX = 0;
      if (openFlyout) {
        var fr = openFlyout.getBoundingClientRect();
        right = Math.max(right, fr.right);
        bottom = Math.max(bottom, fr.bottom);
        // 向左展开时视图整体左移飞出面板实测宽度，主面板才能对齐菜单按钮
        if (openSide === 'left') offsetX = -Math.ceil(fr.width);
      }
      api.resize({
        width: Math.ceil(right),
        height: Math.ceil(bottom),
        offsetX: offsetX,
      });
    }

    /** 清掉当前高亮（键盘与鼠标共用一套 active 状态） */
    function clearActive() {
      if (activeIndex < 0) return;
      var list = itemsIn(activeRoot);
      if (list[activeIndex]) list[activeIndex].classList.remove('active');
      activeIndex = -1;
    }

    /** 把高亮移到 root 内的 el；el 为空时只清除并回到主面板 */
    function setActive(root, el) {
      clearActive();
      if (!el) {
        activeRoot = menu;
        return;
      }
      activeRoot = root;
      var list = itemsIn(root);
      activeIndex = list.indexOf(el);
      if (activeIndex >= 0) list[activeIndex].classList.add('active');
    }

    /** 当前展开的二级面板对应的主面板触发项 */
    function openTrigger() {
      return menu.querySelector('.submenu.open');
    }

    /** 把飞出面板对齐到触发项（打开时与主面板滚动后都要重算，否则面板会脱开条目） */
    function positionFlyout(trigger) {
      if (!openFlyout || !trigger) return;
      var top = Math.round(trigger.getBoundingClientRect().top);
      openFlyout.style.top = top + 'px';
      openFlyout.style.maxHeight = (maxHeight > 0 ? Math.max(80, maxHeight - top) : 400) + 'px';
    }

    function closeFlyout() {
      if (!openFlyout) return;
      openFlyout.classList.remove('open');
      var trigger = openTrigger();
      if (trigger) trigger.classList.remove('open');
      openFlyout = null;
      openSide = 'right';
      document.body.style.paddingLeft = '';
      // 焦点回主面板：键盘继续在主面板里移动
      clearActive();
      activeRoot = menu;
      reportSize();
    }

    function openSubmenu(id, trigger) {
      var el = flyouts[id];
      if (!el) return;
      if (openFlyout === el) {
        positionFlyout(trigger);
        return;
      }
      closeFlyout();
      openFlyout = el;
      trigger.classList.add('open');
      el.classList.add('open');
      // display:none 时量不出尺寸：先挂 open 再实测自适应后的宽度。
      // 从挂 open 到定位完成都在同一个同步块里，不会画出「停在旧位置」的中间帧。
      var w = Math.ceil(el.getBoundingClientRect().width);
      // 右侧放不下实测宽度的整个面板时改为向左展开（此时页面整体左移面板宽度）
      openSide = availableRight >= 0 && availableRight < PANEL_W + w ? 'left' : 'right';
      if (openSide === 'right') {
        el.style.left = PANEL_W + 'px';
        document.body.style.paddingLeft = '';
      } else {
        el.style.left = '0px';
        document.body.style.paddingLeft = w + 'px';
      }
      positionFlyout(trigger);
      reportSize();
    }

    function selectItem(el) {
      if (!el || el.classList.contains('disabled')) return;
      api.select(el.getAttribute('data-id'));
    }

    /** 宿主重新打开菜单时复位：收起二级面板并清掉上次残留的高亮 */
    function resetState() {
      closeFlyout();
      clearActive();
      activeRoot = menu;
    }

    function bindItems(root) {
      itemsIn(root).forEach(function (el) {
        var submenuId = el.getAttribute('data-submenu');
        el.addEventListener('mouseenter', function () {
          if (submenuId) {
            openSubmenu(submenuId, el);
            setActive(menu, el);
          } else if (root === menu) {
            // 只在主面板收起二级面板：飞出面板内部的条目必须保持面板展开，
            // 否则鼠标刚移进去面板就被自己关掉（条目点不到）。
            closeFlyout();
            setActive(menu, el);
          } else {
            setActive(root, el);
          }
        });
        el.addEventListener('click', function () {
          if (submenuId) {
            if (openFlyout === flyouts[submenuId]) closeFlyout();
            else openSubmenu(submenuId, el);
            return;
          }
          selectItem(el);
        });
      });
    }

    // 悬停到主面板的「分组标题 / 分隔线」处收起二级面板。
    //
    // 不能用 event.target === menu 判断空白处：.menu 有 5px 内边距 + 1px 边框，
    // 条目只铺满内容盒，鼠标从触发项移向右侧飞出面板时会经过这条内边距，
    // 此刻 target 恰好是 .menu，会把刚展开的面板立刻关掉——表现为二级菜单
    // 「一移上去就消失、点不到」。只认分组标题/分隔线即可覆盖真正的空白区域。
    menu.addEventListener('mouseover', function (event) {
      var el = event.target;
      if (el && el.classList && (el.classList.contains('group') || el.classList.contains('sep'))) {
        closeFlyout();
      }
    });
    // 主面板滚动后触发项位置变了，飞出面板要跟着走
    menu.addEventListener('scroll', function () {
      positionFlyout(openTrigger());
    });
    // 视图 bounds = 主面板 ∪ 飞出面板，透明区域同样会吃掉点击（Electron 不做像素级穿透），
    // 所以面板之外的点击要在页面内主动关掉菜单，否则用户点了聊天区却毫无反应。
    document.addEventListener('mousedown', function (event) {
      var el = event.target;
      if (el && el.closest && el.closest('.menu, .flyout')) return;
      api.close();
    });

    bindItems(menu);
    Array.prototype.forEach.call(document.querySelectorAll('.flyout'), bindItems);

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        // 二级面板打开时先收二级，再按一次才关整个菜单
        if (openFlyout) closeFlyout();
        else api.close();
        return;
      }
      if (event.key === 'ArrowRight') {
        // 只在主面板里、且当前项带子菜单时进入二级面板
        if (activeRoot !== menu) return;
        var cur = itemsIn(menu)[activeIndex];
        var submenuId = cur && cur.getAttribute('data-submenu');
        if (!submenuId) return;
        event.preventDefault();
        openSubmenu(submenuId, cur);
        setActive(menu, cur);
        var first = itemsIn(flyouts[submenuId])[0];
        if (first) setActive(flyouts[submenuId], first);
        return;
      }
      if (event.key === 'ArrowLeft') {
        if (!openFlyout) return;
        event.preventDefault();
        var trigger = openTrigger();
        closeFlyout();
        if (trigger) setActive(menu, trigger);
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        // 二级面板打开后方向键在面板内部移动（activeRoot 由 ArrowRight/ArrowLeft 切换）
        var list = itemsIn(activeRoot);
        if (!list.length) return;
        event.preventDefault();
        var next;
        if (activeIndex < 0) {
          next = event.key === 'ArrowDown' ? 0 : list.length - 1;
        } else {
          next = event.key === 'ArrowDown'
            ? (activeIndex + 1) % list.length
            : (activeIndex - 1 + list.length) % list.length;
        }
        setActive(activeRoot, list[next]);
        return;
      }
      if (event.key === 'Enter') {
        var item = itemsIn(activeRoot)[activeIndex];
        if (!item) return;
        event.preventDefault();
        item.click();
      }
    });

    // 宿主重新打开菜单时复位（页面会被复用、不重新加载，见主进程的尺寸缓存）：
    // 必须同时收起二级面板并清掉高亮，否则重开后按 Enter 会触发上次的高亮项。
    if (api.onReset) api.onReset(resetState);

    reportSize();
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(reportSize).catch(function () {});
    }
  })();
</script>
</body>
</html>`;
}
