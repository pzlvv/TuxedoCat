/**
 * MessagesView 运行时性能剖析。
 *
 * 采集：
 *   1. 挂载耗时（navigationStart → READY）与长任务
 *   2. 首屏渲染各阶段（scripting / style / layout / recalc）
 *   3. 滚动性能：帧数、掉帧、滚动期间的 style recalc 与 layout 次数
 *   4. 交互性能：hover 一个消息段、展开一个 thinking 的耗时
 *   5. 追加一条消息（模拟流式）的 React 提交耗时
 *
 * 用法: node perf.mjs <label> [--sessions=big-sessions.json] [--session=<name|last|0>]
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
const label = process.argv[2] || 'current';
const DATA_FILE = (process.argv.find((a) => a.startsWith('--sessions=')) || '--sessions=sessions.json').split('=')[1];
const WHICH = (process.argv.find((a) => a.startsWith('--session=')) || '--session=last').split('=')[1];
const METRIC_NAMES = ['ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'TaskDuration', 'LayoutCount', 'RecalcStyleCount', 'Nodes', 'JSEventListeners', 'JSHeapUsedSize'];
const data = JSON.parse(fs.readFileSync(path.join(__dirname, DATA_FILE), 'utf8'));
const session = WHICH === 'last' ? data.sessions[data.sessions.length - 1] : WHICH === '0' ? data.sessions[0] : data.sessions.find((s) => s.name.includes(WHICH));

const browser = await chromium.launch({ headless: true, channel: 'msedge', args: ['--allow-file-access-from-files'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);

// 长任务观察器必须在页面脚本前注入
await page.addInitScript(() => {
  window.__longTasks = [];
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__longTasks.push({ start: e.startTime, dur: e.duration });
    }).observe({ entryTypes: ['longtask'] });
  } catch {}
  window.__frames = [];
  window.__rafStart = 0;
  window.__rafOn = false;
  const tick = (t) => {
    if (window.__rafOn) window.__frames.push(t);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

const t0 = Date.now();
await page.goto(pageUrl('index.html', { data: DATA_FILE, session: session.name }), {
  waitUntil: 'domcontentloaded',
});
await page.waitForFunction(() => document.title === 'READY', null, { timeout: 280000 });
const mountMs = Date.now() - t0;
await page.waitForTimeout(2500);

await cdp.send('Performance.enable');
const pick = (ms) => Object.fromEntries(METRIC_NAMES.map((n) => [n, ms.find((m) => m.name === n)?.value ?? 0]));
const m1 = pick((await cdp.send('Performance.getMetrics')).metrics);

const longTasks = await page.evaluate(() => window.__longTasks);
const nav = await page.evaluate(() => {
  const n = performance.getEntriesByType('navigation')[0] || {};
  const paints = Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)]));
  return { domContentLoaded: Math.round(n.domContentLoadedEventEnd || 0), loadEnd: Math.round(n.loadEventEnd || 0), ...paints };
});

// ── 滚动性能 ──
const scroll = await page.evaluate(async () => {
  const cs = document.querySelectorAll('.messages-container');
  const ct = cs[cs.length - 1];
  window.__frames = [];
  window.__rafOn = true;
  const start = performance.now();
  const steps = 60;
  const maxTop = ct.scrollHeight - ct.clientHeight;
  for (let i = 0; i < steps; i++) {
    ct.scrollTop = (maxTop * i) / steps;
    // 强制 style/layout 并让出一帧
    void ct.offsetHeight;
    await new Promise((r) => requestAnimationFrame(r));
  }
  window.__rafOn = false;
  const end = performance.now();
  const f = window.__frames;
  const gaps = [];
  for (let i = 1; i < f.length; i++) gaps.push(f[i] - f[i - 1]);
  gaps.sort((a, b) => b - a);
  return {
    durationMs: Math.round(end - start),
    frames: f.length,
    avgGap: gaps.length ? +(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(2) : 0,
    p95Gap: gaps.length ? +gaps[Math.floor(gaps.length * 0.05)].toFixed(2) : 0,
    worstGap: gaps.length ? +gaps[0].toFixed(2) : 0,
    longFrames: gaps.filter((g) => g > 33).length,
  };
});
const m2 = pick((await cdp.send('Performance.getMetrics')).metrics);

// ── 交互：展开 thinking ──
const toggle = await page.evaluate(async () => {
  const cs = document.querySelectorAll('.messages-container');
  const ct = cs[cs.length - 1];
  const d = ct.querySelector('details');
  if (!d) return null;
  d.scrollIntoView({ block: 'center' });
  await new Promise((r) => requestAnimationFrame(r));
  const s = performance.now();
  d.querySelector('summary').click();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return +(performance.now() - s).toFixed(2);
});
const m3 = pick((await cdp.send('Performance.getMetrics')).metrics);

const d = (k) => +(m3[k] - m1[k]).toFixed(2);
const dScroll = (k) => +(m2[k] - m1[k]).toFixed(2);

console.log(`\n===== ${label}  (会话 ${session.name.slice(-14)} / ${session.messages.length} 条) =====`);
console.log(`挂载耗时(domcontentloaded→READY): ${mountMs} ms`);
console.log(`DOMContentLoaded: ${nav.domContentLoaded} ms   FCP: ${nav['first-contentful-paint'] ?? '-'} ms   load: ${nav.loadEnd} ms`);
console.log(`长任务: ${longTasks.length} 个，合计 ${Math.round(longTasks.reduce((a, b) => a + b.dur, 0))} ms，最长 ${Math.round(Math.max(0, ...longTasks.map((t) => t.dur)))} ms`);
console.log(`  → 最大的 3 个: ${longTasks.sort((a, b) => b.dur - a.dur).slice(0, 3).map((t) => Math.round(t.dur) + 'ms@' + Math.round(t.start)).join(', ') || '无'}`);
console.log(`\n滚动 ${scroll.durationMs}ms / ${scroll.frames} 帧  平均帧间隔 ${scroll.avgGap}ms  p95 ${scroll.p95Gap}ms  最差 ${scroll.worstGap}ms  掉帧(>33ms) ${scroll.longFrames}`);
console.log(`滚动期间: Layout ${dScroll('LayoutCount')} 次 / ${dScroll('LayoutDuration').toFixed(3)}s   RecalcStyle ${dScroll('RecalcStyleCount')} 次 / ${dScroll('RecalcStyleDuration').toFixed(3)}s`);
console.log(`\n展开 thinking 耗时: ${toggle ?? '-'} ms`);
console.log(`交互期间: Scripting ${d('ScriptDuration').toFixed(3)}s  Layout ${d('LayoutDuration').toFixed(3)}s  Recalc ${d('RecalcStyleDuration').toFixed(3)}s`);
console.log(`\n全程: Scripting ${m3.ScriptDuration.toFixed(2)}s  Layout ${m3.LayoutDuration.toFixed(2)}s  RecalcStyle ${m3.RecalcStyleDuration.toFixed(2)}s`);
console.log(`      TaskDuration ${m3.TaskDuration.toFixed(2)}s  Nodes ${m3.Nodes}  Listeners ${m3.JSEventListeners}`);

await browser.close();
