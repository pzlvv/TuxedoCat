import { test, expect } from '@playwright/test';
import { openWebviewView } from '../helpers/webviewHarness';

/**
 * 空态背景 Logo 与加载动画 Logo 都是纯装饰，完全不可操作：不可框选、不可拖出
 * 系统拖影、不接收鼠标事件。
 *
 * 实现是 CSS 背景层而不是 `<img>`（`src/webview/DecorativeLogo.tsx`）：`<img>` 是
 * 浏览器天然的拖拽源，`draggable={false}` / `-webkit-user-drag` 只是逐层打补丁，
 * 任一失效就漏出「图片不动、半透明副本跟着光标」的拖影。这里锁住结构性事实
 * （DOM 里没有可拖的图片节点）与行为面（真实鼠标拖过时不触发 dragstart）。
 */
test('空态背景 Logo 不是图片节点，不可选中、不可拖拽', async ({ browser }) => {
  const { page, close } = await openWebviewView(browser, process.cwd().replace(/[\\/]e2e$/, ''));
  const logo = page.locator('.placeholder-logo');
  await expect(logo).toBeVisible();

  // 结构面：装饰图不是 <img>，DOM 里没有任何 alt=logo 的图片
  const structure = await logo.evaluate((el) => ({
    tag: el.tagName,
    role: el.getAttribute('role'),
    backgroundImage: getComputedStyle(el).backgroundImage,
    imageCount: document.querySelectorAll('img[alt="logo"]').length,
    width: Math.round(el.getBoundingClientRect().width),
    height: Math.round(el.getBoundingClientRect().height),
  }));
  expect(structure.tag).toBe('DIV');
  expect(structure.role).toBe('img');
  expect(structure.backgroundImage).toContain('url(');
  expect(structure.imageCount).toBe(0);
  expect(structure.width).toBe(360);
  expect(structure.height).toBe(360);

  // 样式面：不可框选、不接收鼠标事件
  const style = await logo.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { pointerEvents: cs.pointerEvents, userSelect: cs.userSelect };
  });
  expect(style.pointerEvents).toBe('none');
  expect(style.userSelect).toBe('none');

  // 行为面：按住拖过图片区域，整个文档都不得触发 dragstart
  await page.evaluate(() => {
    const w = window as unknown as { __dragEvents: string[] };
    w.__dragEvents = [];
    document.addEventListener(
      'dragstart',
      (e) => {
        const t = e.target as HTMLElement | null;
        w.__dragEvents.push(`${t?.tagName}.${t?.className ?? ''}`);
      },
      true,
    );
  });
  const box = await logo.boundingBox();
  if (!box) throw new Error('logo boundingBox missing');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 200, cy + 150, { steps: 8 });
  await page.mouse.up();
  const dragged = await page.evaluate(
    () => (window as unknown as { __dragEvents: string[] }).__dragEvents,
  );
  expect(dragged).toEqual([]);
  await close();
});

/**
 * 加载动画 Logo 只在切换对话的瞬时出现，场景用例很难稳定停在那一帧，
 * 因此直接探一条同 class 组合的 div 的样式契约。
 */
test('加载动画 Logo 与空态共用装饰层样式契约', async ({ browser }) => {
  const { page, close } = await openWebviewView(browser, process.cwd().replace(/[\\/]e2e$/, ''));
  const state = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.className = 'placeholder-logo placeholder-logo--loading';
    document.body.appendChild(probe);
    const cs = getComputedStyle(probe);
    const result = {
      pointerEvents: cs.pointerEvents,
      userSelect: cs.userSelect,
      backgroundSize: cs.backgroundSize,
      width: Math.round(probe.getBoundingClientRect().width),
      height: Math.round(probe.getBoundingClientRect().height),
    };
    probe.remove();
    return result;
  });
  expect(state.pointerEvents).toBe('none');
  expect(state.userSelect).toBe('none');
  expect(state.backgroundSize).toBe('contain');
  expect(state.width).toBe(56);
  expect(state.height).toBe(56);
  await close();
});
