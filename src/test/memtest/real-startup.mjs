/**
 * 用「真实构建产物」测量 webview 启动性能（对比 shiki 静态/动态导入）。
 *
 * harness 用 esbuild 把所有代码打成单个 web.js，测不出 chunk 拆分带来的差异；
 * 这里直接起 HTTP 服务托管 dist/webview，按线上方式加载 index.html（ESM + modulepreload），
 * 只注入最小宿主桩，测量：
 *   - 各资源的加载时序与体积
 *   - DOMContentLoaded / FCP
 *   - 模块图（含所有静态依赖）全部就绪的时刻
 *
 * 用法: node real-startup.mjs <label>
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const label = process.argv[2] || 'current';
const ROOT = path.resolve(__dirname, '..', '..', '..', 'dist', 'webview');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

const srv = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const f = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  fs.readFile(f, (e, d) => {
    if (e) {
      res.writeHead(404);
      res.end('404');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(d);
  });
});
await new Promise((r) => srv.listen(0, r));
const port = srv.address().port;

const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();

// 最小宿主桩
await page.addInitScript(() => {
  const post = () => {};
  window.vscode = { postMessage: post, getState: () => null, setState: post };
  window.acquireVsCodeApi = () => window.vscode;
  window.__hostInfo = {
    kind: 'vscode',
    conversationList: 'webview',
    newConversation: 'webview',
    closeConversation: false,
    openConversationMode: 'loadConversation',
  };
  window.__highlightLanguages = [];
  // 记录「模块图就绪」时刻：等 #root 出现 React 渲染的节点
  window.__marks = {};
  const t0 = performance.now();
  const poll = () => {
    const root = document.getElementById('root');
    if (root && root.children.length > 0 && !window.__marks.firstRender) {
      window.__marks.firstRender = Math.round(performance.now());
    }
    if (!window.__marks.graphReady && performance.getEntriesByType('resource').some((e) => e.name.endsWith('index.js'))) {
      window.__marks.indexFetched = Math.round(performance.now());
    }
    requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
});

const t0 = Date.now();
await page.goto(`http://localhost:${port}/index.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4000);
const wall = Date.now() - t0;

const data = await page.evaluate(() => {
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const paints = Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)]));
  const res = performance.getEntriesByType('resource')
    .filter((e) => /\.(js|css)$/.test(e.name))
    .map((e) => ({
      f: e.name.split('/').pop(),
      start: Math.round(e.startTime),
      dur: Math.round(e.duration),
      size: Math.round((e.encodedBodySize || e.transferSize || 0) / 1024),
      type: e.initiatorType,
    }))
    .sort((a, b) => a.start - b.start);
  return {
    dcl: Math.round(nav.domContentLoadedEventEnd || 0),
    load: Math.round(nav.loadEventEnd || 0),
    paints,
    res,
    marks: window.__marks,
    rootChildren: document.getElementById('root')?.children.length ?? 0,
  };
});

console.log(`\n===== ${label} =====`);
console.log(`DCL ${data.dcl} ms   FCP ${data.paints['first-contentful-paint'] ?? '-'} ms   load ${data.load} ms   首屏渲染 ${data.marks.firstRender ?? '-'} ms   #root 子节点 ${data.rootChildren}`);
console.log('资源加载时序:');
for (const r of data.res) console.log(`  +${String(r.start).padStart(5)}ms  用时 ${String(r.dur).padStart(5)}ms  ${String(r.size).padStart(6)} kB  ${r.f}`);
const js = data.res.filter((r) => r.f.endsWith('.js'));
console.log(`  JS 合计 ${js.reduce((a, b) => a + b.size, 0)} kB（${js.length} 个文件）`);

await browser.close();
srv.close();
