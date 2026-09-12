/**
 * Playwright 内存测试驱动脚本。
 *
 * 用法:
 *   node run.mjs --variant=full [--sessions=all|big]
 *
 * 对每个样本会话：
 *   1. 启动新 Edge 页面（1280x2400 视口，模拟高视口 webview）
 *   2. 加载 harness 页面（?session=xxx）
 *   3. 等 READY（异步渲染稳定）
 *   4. GC 后采集：JS 堆、DOM 节点、按 tag 的 DOM 统计
 *   5. 输出 JSON 到 results-<variant>.json
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

const variantArg = process.argv.find((a) => a.startsWith('--variant='));
const variant = variantArg ? variantArg.split('=')[1] : 'full';
const sessionsArg = process.argv.find((a) => a.startsWith('--sessions='));
const sessionFilter = sessionsArg ? sessionsArg.split('=')[1] : 'all';
// 模拟 settings.json 中已记录的 highlightLanguages（注入 window.__highlightLanguages）
const langsArg = process.argv.find((a) => a.startsWith('--langs='));
const injectedLangs = langsArg ? langsArg.split('=')[1] : '';
// 数据源（默认 sessions.json，可切到 sessions-synthetic.json）
const dataArg = process.argv.find((a) => a.startsWith('--data='));
const dataFile = dataArg ? dataArg.split('=')[1] : 'sessions.json';

const data = JSON.parse(fs.readFileSync(path.join(__dirname, dataFile), 'utf8'));

const htmlName = variant === 'full' ? 'index.html' : `index-${variant}.html`;
const outName = `results-${variant}.json`;

let sessions = data.sessions;
if (sessionFilter === 'big') {
  // 只测空会话基线 + 最大两个会话
  sessions = [data.sessions[0], data.sessions[1], data.sessions[data.sessions.length - 1]];
}

const results = [];
const browser = await chromium.launch({ headless: true, channel: 'msedge' });

for (const session of sessions) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 2400 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  const url = pageUrl(htmlName, { session: session.name, langs: injectedLangs });
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForFunction(() => document.title === 'READY', null, { timeout: 60000 });
  } catch {
    console.error(`TIMEOUT: ${session.name} (title=${await page.title()})`);
  }
  const loadMs = Date.now() - t0;

  await page.waitForTimeout(800);
  await cdp.send('HeapProfiler.collectGarbage');
  await page.waitForTimeout(400);
  await cdp.send('HeapProfiler.collectGarbage');

  const jsHeap = await cdp.send('Runtime.getHeapUsage');
  const domStats = await page.evaluate(() => window.__domStats);
  const info = await page.evaluate(() => window.__memtestInfo);
  const docStats = await page.evaluate(() => {
    const root = document.querySelector('.messages-container') || document.body;
    let textLen = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) textLen += n.textContent.length;
    return { textChars: textLen, htmlChars: root.innerHTML.length };
  });

  // 检查 shiki highlighter 是否真的初始化了（用于确认变体生效）
  const highlighterState = await page.evaluate(() => {
    const pre = document.querySelectorAll('.code-preview pre').length;
    const spans = document.querySelectorAll('.code-preview span').length;
    return { diffPreLines: pre, diffSpans: spans };
  });

  // 按需加载/预热验证：注入的语言、上报的语言、每个文件路径是否真的高亮
  const lazyState = await page.evaluate(() => {
    const injected = window.__injectedLangs || [];
    const reported = window.__reportedLangs || [];
    // 每个 EditFile 卡片：文件名 + 是否有高亮 span
    const cards = [];
    document.querySelectorAll('.code-preview').forEach((el, i) => {
      const root = el.closest('li') || el.parentElement;
      const label = (root && root.textContent || '').slice(0, 60);
      cards.push({
        index: i,
        label,
        spans: el.querySelectorAll('span').length,
        preLines: el.querySelectorAll('pre').length,
      });
    });
    return { injected, reported, cards };
  });

  results.push({
    variant,
    name: session.name,
    rawBytes: session.rawBytes,
    uiMessages: info?.uiMessages,
    contentChars: info?.contentChars,
    argsChars: info?.argsChars,
    loadMs,
    jsHeapUsed: jsHeap.usedSize,
    jsHeapTotal: jsHeap.totalSize,
    domNodes: domStats?.totalNodes,
    domByTag: domStats?.byTag,
    textChars: docStats.textChars,
    htmlChars: docStats.htmlChars,
    highlighterState,
    lazyState,
  });

  console.log(
    `[${variant}] ${session.name.split('/').pop()} | raw=${(session.rawBytes / 1024).toFixed(0)}KB msgs=${info?.uiMessages} | ` +
    `heap=${(jsHeap.usedSize / 1048576).toFixed(1)}MB | nodes=${domStats?.totalNodes} | diffSpans=${highlighterState.diffSpans} | load=${loadMs}ms`
  );
  if (lazyState) {
    console.log(`   注入(预热)=[${lazyState.injected.join(',')}]  上报(新加载)=[${lazyState.reported.join(',')}]`);
    for (const c of lazyState.cards) {
      console.log(`     卡片#${c.index} spans=${String(c.spans).padStart(4)} pre=${c.preLines} | ${c.label.replace(/\s+/g, ' ').slice(0, 70)}`);
    }
  }

  await context.close();
}

await browser.close();
fs.writeFileSync(path.join(__dirname, outName), JSON.stringify(results, null, 2));
console.log(`\nWrote ${outName}`);
