/**
 * 真实渲染耗时 + CPU profile 热点。
 *
 * harness 的 READY 是硬等 4s 后才设的，不能用来衡量渲染耗时。
 * 这里在页面内轮询：
 *   t_first  —— 容器出现第一个消息段的时刻
 *   t_all    —— 段数达到预期（全部消息已提交）的时刻
 *   t_stable —— scrollHeight 连续 3 帧不变（异步高亮等已稳定）的时刻
 * 并可选采集这段时间的 CPU profile，按 self-time 聚合出热点函数。
 *
 * 用法: node perf-render.mjs [--sessions=...] [--session=<name|last|0>] [--profile]
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
const WHICH = (process.argv.find((a) => a.startsWith('--session=')) || '--session=last').split('=')[1];
const DO_PROFILE = process.argv.includes('--profile');
const data = JSON.parse(fs.readFileSync(path.join(__dirname, DATA_FILE), 'utf8'));
const session = WHICH === 'last' ? data.sessions[data.sessions.length - 1] : WHICH === '0' ? data.sessions[0] : data.sessions.find((s) => s.name.includes(WHICH));

const browser = await chromium.launch({ headless: true, channel: 'msedge', args: ['--allow-file-access-from-files'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);

await page.addInitScript(() => {
  window.__marks = {};
  window.__longTasks = [];
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__longTasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
    }).observe({ entryTypes: ['longtask'] });
  } catch {}
  const started = performance.now();
  let lastH = -1;
  let stable = 0;
  const poll = () => {
    const cs = document.querySelectorAll('.messages-container');
    const ct = cs[cs.length - 1];
    if (ct) {
      const segs = [...ct.children].filter((e) => e.tagName === 'DIV' && e.classList.contains('mb-4')).length;
      if (!window.__marks.t_first && ct.children.length > 0) window.__marks.t_first = Math.round(performance.now() - started);
      if (segs > 0) {
        window.__marks.segs = segs;
        window.__marks.t_lastSeg = Math.round(performance.now() - started);
      }
      const h = ct.scrollHeight;
      if (h > 0 && h === lastH) {
        stable++;
        if (stable >= 3 && !window.__marks.t_stable) {
          window.__marks.t_stable = Math.round(performance.now() - started);
          window.__marks.finalH = h;
        }
      } else stable = 0;
      lastH = h;
    }
    requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
});

if (DO_PROFILE) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
}

const t0 = Date.now();
await page.goto(pageUrl('index.html', { data: DATA_FILE, session: session.name }), {
  waitUntil: 'domcontentloaded',
  timeout: 240000,
});
await page.waitForFunction(() => document.title === 'READY', null, { timeout: 280000 });
const wall = Date.now() - t0;

const marks = await page.evaluate(() => window.__marks);
const lt = await page.evaluate(() => window.__longTasks);
const nav = await page.evaluate(() => {
  const n = performance.getEntriesByType('navigation')[0] || {};
  const paints = Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)]));
  return { dcl: Math.round(n.domContentLoadedEventEnd || 0), load: Math.round(n.loadEventEnd || 0), ...paints };
});

console.log(`\n===== ${session.name.slice(-14)} / ${session.messages.length} 条 =====`);
console.log(`harness READY(wall): ${wall} ms   (含 harness 硬等 4s)`);
console.log(`真实渲染: 首段 ${marks.t_first ?? '-'} ms   全部 ${marks.segs ?? '-'} 段 @ ${marks.t_lastSeg ?? '-'} ms   稳定 ${marks.t_stable ?? '-'} ms`);
console.log(`  → 从 DOMContentLoaded(${nav.dcl}ms) 到全部消息渲染完成: ${marks.t_lastSeg != null ? marks.t_lastSeg - nav.dcl : '-'} ms`);
console.log(`  → 到布局稳定: ${marks.t_stable != null ? marks.t_stable - nav.dcl : '-'} ms`);
console.log(`FCP ${nav['first-contentful-paint'] ?? '-'} ms   load ${nav.load} ms`);
console.log(`长任务 ${lt.length} 个，合计 ${lt.reduce((a, b) => a + b.dur, 0)} ms，最长 ${Math.max(0, ...lt.map((t) => t.dur))} ms`);
console.log(`  分布: ${lt.sort((a, b) => a.start - b.start).map((t) => `${t.dur}ms@${t.start}`).join('  ')}`);

if (DO_PROFILE) {
  const { profile } = await cdp.send('Profiler.stop');
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  // 自时间聚合
  const self = new Map();
  const total = profile.timeDeltas.reduce((a, b) => a + b, 0);
  for (let i = 0; i < profile.samples.length; i++) {
    const n = byId.get(profile.samples[i]);
    if (!n) continue;
    const f = n.callFrame;
    const key = `${f.functionName || '(anonymous)'}  @${(f.url || '').split('/').pop()}:${f.lineNumber}`;
    self.set(key, (self.get(key) || 0) + (profile.timeDeltas[i] || 0));
  }
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  console.log(`\nCPU profile 总时长 ${(total / 1000).toFixed(2)}s，self-time Top 25:`);
  for (const [k, v] of top) console.log(`  ${(v / 1000).toFixed(0).padStart(5)} ms  ${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`);
}

await browser.close();
