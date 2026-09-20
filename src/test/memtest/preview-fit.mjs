/**
 * 计算「预览框不出现滚动条」所需的渲染行数。
 *
 * 预览框 maxHeight = 300px 且 box-sizing: border-box（Tailwind preflight），
 * 上下各 1px 边框 → 可用内容高度 298px。
 * 真实行高 18px（12px 字号 × Tailwind preflight 的 html{line-height:1.5}）。
 *
 * Edit diff 使用 pre-wrap，长行会折行，所以「逻辑行数」≠「视觉高度」，
 * 这里直接累加前 N 个 <pre> 的真实高度来判断是否放得下。
 *
 * 用法: node preview-fit.mjs [sessionIndex=0] [--sessions=big-sessions.json]
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

await page.goto(pageUrl('index.html', { data: DATA_FILE, session: session.name }), {
  waitUntil: 'domcontentloaded',
});
await page.waitForFunction(() => document.title === 'READY', null, { timeout: 180000 });
await page.waitForTimeout(1200);

const raw = await page.evaluate(() => {
  const cs = document.querySelectorAll('.messages-container');
  const container = cs[cs.length - 1];
  const boxes = Array.from(container.querySelectorAll('.mt-2'))
    .filter((d) => d.querySelector('.code-preview') || d.className.includes('code-preview'));

  const out = [];
  for (const box of boxes) {
    const next = box.nextElementSibling;
    if (!(next && /仅显示前/.test(next.textContent || ''))) continue; // 只看被截断的
    const isDiff = box.className.includes('code-preview');
    if (isDiff) {
      // 每个 diff 行是一个 wrapper div > pre，pre 高度即该行真实占用高度
      const pres = Array.from(box.querySelectorAll('pre'));
      out.push({
        kind: 'Edit',
        logicalLines: pres.length,
        preHeights: pres.map((el) => el.getBoundingClientRect().height),
        contentH: box.scrollHeight,
        boxH: box.clientHeight,
        lineHeight: getComputedStyle(pres[0]).lineHeight,
      });
    } else {
      const spans = box.querySelectorAll('span.line');
      const inner = box.querySelector('.code-preview');
      out.push({
        kind: 'Write',
        logicalLines: spans.length,
        preHeights: [],
        contentH: inner ? inner.getBoundingClientRect().height : box.scrollHeight,
        boxH: box.clientHeight,
        lineHeight: getComputedStyle(inner || box).lineHeight,
      });
    }
  }
  return { boxes: out, boxSizing: getComputedStyle(container).boxSizing };
});

console.log(`会话 ${session.name.split('/').pop()}  截断预览框 ${raw.boxes.length} 个`);
const edit = raw.boxes.filter((b) => b.kind === 'Edit');
const write = raw.boxes.filter((b) => b.kind === 'Write');
console.log(`  Edit ${edit.length} 个 / Write ${write.length} 个`);
if (edit[0]) console.log(`  Edit 行高 = ${edit[0].lineHeight}   单框内容高 p50 = ${edit.map((b) => Math.round(b.contentH)).sort((a, b) => a - b)[Math.floor(edit.length / 2)]}px`);
if (write[0]) console.log(`  Write 行高 = ${write[0].lineHeight}  单框内容高 p50 = ${write.map((b) => Math.round(b.contentH)).sort((a, b) => a - b)[Math.floor(write.length / 2)]}px`);

const AVAIL = 298; // 300px - 上下各 1px 边框

console.log(`\n── 可用内容高度 ${AVAIL}px，各候选行数的「放得下」比例 ──`);
console.log('渲染行数'.padStart(9) + 'Edit 放得下'.padStart(14) + 'Edit 最大高'.padStart(12) + 'Write 放得下'.padStart(15) + 'Write 最大高'.padStart(13));

for (const n of [10, 12, 14, 15, 16, 17, 18, 20, 22, 24]) {
  // Edit：累加前 n 个 pre 的高度
  const editOk = edit.filter((b) => {
    let h = 0;
    for (let i = 0; i < Math.min(n, b.preHeights.length); i++) h += b.preHeights[i];
    return h <= AVAIL;
  }).length;
  const editMax = Math.max(...edit.map((b) => {
    let h = 0;
    for (let i = 0; i < Math.min(n, b.preHeights.length); i++) h += b.preHeights[i];
    return h;
  }));
  // Write：内容高度按行等比缩放
  const writeOk = write.filter((b) => (b.contentH / b.logicalLines) * n <= AVAIL).length;
  const writeMax = Math.max(...write.map((b) => Math.round((b.contentH / b.logicalLines) * n)));
  console.log(
    String(n).padStart(9) +
    `${editOk}/${edit.length} (${((editOk / Math.max(1, edit.length)) * 100).toFixed(0)}%)`.padStart(14) +
    `${Math.round(editMax)}px`.padStart(12) +
    `${writeOk}/${write.length} (${((writeOk / Math.max(1, write.length)) * 100).toFixed(0)}%)`.padStart(15) +
    `${writeMax}px`.padStart(13),
  );
}

await context.close();
await browser.close();
