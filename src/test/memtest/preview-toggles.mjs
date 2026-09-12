/**
 * 验证 Edit/Write 预览的**两个独立开关**：
 *   ① 工具行右侧箭头（chevron）→ 整块预览显隐
 *   ② 点击预览框 → 行级截断展开（渲染全部行）
 * 用法: node preview-toggles.mjs [--data=sessions.json] [--session=<name|last|0>]
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split('=').slice(1).join('=');
const DATA_FILE = arg('data', 'sessions.json');
const WHICH = arg('session', 'last');
const data = JSON.parse(fs.readFileSync(path.join(__dirname, DATA_FILE), 'utf8'));
const session = WHICH === 'last' ? data.sessions[data.sessions.length - 1] : WHICH === '0' ? data.sessions[0] : data.sessions.find((s) => s.name.includes(WHICH));
if (!session) {
  console.error(`未找到会话 "${WHICH}"（数据文件 ${DATA_FILE}）`);
  process.exit(1);
}
/** 把 harness 目录下的页面转成 file:// URL，并附加查询参数。 */
const pageUrl = (html, params = {}) => {
  const u = pathToFileURL(path.join(__dirname, html));
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u.href;
};

const browser = await chromium.launch({ headless: true, channel: 'msedge', args: ['--allow-file-access-from-files'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 2400 } });
const page = await ctx.newPage();
await page.goto(pageUrl('index.html', { data: DATA_FILE, session: session.name }), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.title === 'READY', null, { timeout: 240000 });
await page.waitForTimeout(1500);

const probe = () => page.evaluate(() => {
  const root = [...document.querySelectorAll('.messages-container')].pop();
  const nameOf = (li) => {
    const first = li.firstElementChild;
    if (!first || first.tagName !== 'DIV') return null;
    const header = first.matches('div.flex.items-center') ? first : first.querySelector('div.flex.items-center');
    const sp = header ? [...header.querySelectorAll(':scope > span')].find((s) => !s.classList.contains('ti')) : null;
    return sp ? sp.textContent.trim() : null;
  };
  const out = [];
  const lis = [...root.querySelectorAll('li.msg-timeline-item')];
  lis.forEach((i, k) => { /* noop */ });
  lis.forEach((li, i) => {
    const n = nameOf(li);
    if (n !== 'Edit' && n !== 'Write') return;
    const card = li.firstElementChild;
    // 箭头按钮：ToolHeader 里带 chevron 图标的 button
    const arrow = card.querySelector('button .ti-chevron-down, button .ti-chevron-right');
    const box = card.querySelector('.code-preview') || card.querySelector('div[style*="overflow"]');
    const pre = card.querySelectorAll('pre').length;
    const lines = card.querySelectorAll('div[style*="min-height"], pre').length;
    out.push({ i, tool: n, preCount: pre, hasArrow: !!arrow, hasBox: !!box, boxClickable: box ? getComputedStyle(box).cursor : null });
  });
  return out;
});

const before = await probe();
// 挑一个行数最多的 Edit 卡
const target = before.filter((x) => x.tool === 'Edit' && x.preCount > 20).sort((a, b) => b.preCount - a.preCount)[0]
  || before.filter((x) => x.preCount > 5).sort((a, b) => b.preCount - a.preCount)[0];
console.log('样例卡:', JSON.stringify(target));
if (!target) { console.log('未找到可用样例'); await browser.close(); process.exit(0); }

const li = page.locator('li.msg-timeline-item').nth(target.i);

// ── ① 点击预览框 → 行数应变多 ──
const boxSel = target.tool === 'Edit' ? '.code-preview' : 'div[style*="max-height"]';
await li.locator(boxSel).first().click();
await page.waitForTimeout(600);
const afterClick = await li.locator('pre').count();
console.log(`\n② 点击预览框: pre 数 ${target.preCount} → ${afterClick}  ${afterClick > target.preCount ? '✓ 行级展开生效' : '✗ 没有变化'}`);

// ── ② 点击工具行箭头 → 整块预览应消失 ──
const arrowBtn = li.locator('button:has(.ti-chevron-down)').first();
await arrowBtn.click();
await page.waitForTimeout(600);
const afterArrow = await li.locator('pre').count();
const stillHasBox = await li.locator('.code-preview').count();
console.log(`① 点击工具行箭头: pre 数 ${afterClick} → ${afterArrow}，预览框 ${stillHasBox} 个  ${afterArrow === 0 && stillHasBox === 0 ? '✓ 整块收起生效' : '✗ 未收起'}`);

// ── 再点一次箭头应恢复 ──
await li.locator('button:has(.ti-chevron-right)').first().click();
await page.waitForTimeout(600);
const restored = await li.locator('pre').count();
console.log(`   再点箭头恢复: pre 数 ${afterArrow} → ${restored}  ${restored > 0 ? '✓ 恢复显示' : '✗ 未恢复'}`);

await browser.close();
