/**
 * 验证代码预览行数限制：默认只渲染前 PREVIEW_LINES 行，点击预览框后渲染全部。
 * 用法: node verify-preview-limit.mjs [--sessions=big-sessions.json] [sessionIndex=0]
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 把 harness 目录下的页面转成 file:// URL，并附加查询参数。 */
const pageUrl = (html, params = {}) => {
  const u = pathToFileURL(path.join(__dirname, html));
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u.href;
};
const DATA_FILE = (process.argv.find((a) => a.startsWith('--sessions=')) || '--sessions=sessions.json').split('=')[1];
const sessionIndex = Number(process.argv.find((a) => /^\d+$/.test(a)) || 0);
const data = JSON.parse(fs.readFileSync(path.join(__dirname, DATA_FILE), 'utf8'));
const session = data.sessions[sessionIndex];

const browser = await chromium.launch({ headless: true, channel: 'msedge', args: ['--allow-file-access-from-files'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 2400 } });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('Performance.enable');

await page.goto(pageUrl('index.html', { data: DATA_FILE, session: session.name }), {
  waitUntil: 'domcontentloaded',
});
await page.waitForFunction(() => document.title === 'READY', null, { timeout: 180000 });
await page.waitForTimeout(1500);

const inspect = () =>
  page.evaluate(() => {
    const cs = document.querySelectorAll('.messages-container');
    const container = cs[cs.length - 1];
    const hints = Array.from(container.querySelectorAll('div[role="button"]'));
    const hintTexts = hints.map((h) => h.textContent.trim()).filter((t) => t.includes('行'));

    // 每个预览框：渲染行数 / 是否被截断（有提示条）
    const boxes = Array.from(container.querySelectorAll('.mt-2')).filter((d) => d.querySelector('.code-preview') || d.className.includes('code-preview'));
    const stats = boxes.map((box) => {
      const isDiff = box.className.includes('code-preview');
      const lines = isDiff ? box.querySelectorAll('pre').length : box.querySelectorAll('span.line').length;
      const textLines = isDiff ? 0 : (box.textContent || '').split('\n').length;
      // 提示条是 box 的下一个兄弟（按文案识别）
      const next = box.nextElementSibling;
      const truncated = !!(next && /仅显示前/.test(next.textContent || ''));
      return { lines, textLines, truncated };
    });

    let nodes = 0;
    const w = document.createTreeWalker(container, NodeFilter.SHOW_ALL);
    while (w.nextNode()) nodes++;

    return {
      nodes,
      boxCount: stats.length,
      truncatedBoxes: stats.filter((s) => s.truncated).length,
      maxRenderedLines: Math.max(0, ...stats.map((s) => Math.max(s.lines, s.textLines))),
      renderedLineList: stats.map((s) => Math.max(s.lines, s.textLines)).sort((a, b) => b - a).slice(0, 12),
      hintCount: hintTexts.length,
      sampleHint: hintTexts[0] || '',
    };
  });

const before = await inspect();
console.log(`\n=== 默认状态（${session.name.split('/').pop()}，${data.sessions[sessionIndex].messages.length} 条消息）===`);
console.log(`  容器内节点      : ${before.nodes}`);
console.log(`  预览框数量      : ${before.boxCount}（其中被截断 ${before.truncatedBoxes}）`);
console.log(`  单框最大渲染行数: ${before.maxRenderedLines}`);
console.log(`  Top 渲染行数    : ${before.renderedLineList.join(', ')}`);
console.log(`  提示条数量      : ${before.hintCount}`);
console.log(`  提示文案示例    : ${before.sampleHint}`);

// ── 点击第一个被截断的预览框，验证展开为全部行 ──
const expandInfo = await page.evaluate(() => {
  const cs = document.querySelectorAll('.messages-container');
  const container = cs[cs.length - 1];
  const boxes = Array.from(container.querySelectorAll('.mt-2')).filter((d) => d.querySelector('.code-preview') || d.className.includes('code-preview'));
  for (const box of boxes) {
    const next = box.nextElementSibling;
    if (next && /仅显示前/.test(next.textContent || '')) {
      const isDiff = box.className.includes('code-preview');
      const before = isDiff ? box.querySelectorAll('pre').length : box.querySelectorAll('span.line').length;
      box.click();
      return { found: true, before, isDiff, hint: next.textContent.trim() };
    }
  }
  return { found: false };
});
await page.waitForTimeout(2500);

const after = await inspect();
console.log(`\n=== 点击后 ===`);
console.log(`  点击的提示条    : ${expandInfo.hint}`);
console.log(`  点击前渲染行数  : ${expandInfo.before}`);
console.log(`  容器内节点      : ${after.nodes}  (${after.nodes - before.nodes >= 0 ? '+' : ''}${after.nodes - before.nodes})`);
console.log(`  剩余截断框      : ${after.truncatedBoxes}`);
console.log(`  单框最大渲染行数: ${after.maxRenderedLines}`);
console.log(`  Top 渲染行数    : ${after.renderedLineList.join(', ')}`);

console.log(`\n结论: ${expandInfo.found ? (after.maxRenderedLines > before.maxRenderedLines ? '点击后成功渲染全部行 ✔' : '点击后行数未增加 ✘') : '未找到可展开的预览框 ✘'}`);

await context.close();
await browser.close();
