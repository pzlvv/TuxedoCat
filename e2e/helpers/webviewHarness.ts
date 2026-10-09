import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { FAKE_HOST_INIT, FakeHostDriver } from './fakeHost';
/**
 * webview UI 级测试的页面装配：静态伺服构建产物 `dist/webview/`，
 * 以假宿主初始化脚本打开真实 webview bundle。
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

export interface WebviewHandle {
  page: Page;
  host: FakeHostDriver;
  close(): Promise<void>;
}

/** 起一个只伺服 dist/webview 的静态服务器（监听回环随机端口） */
function startStaticServer(root: string): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    const rel = urlPath === '/' || urlPath.endsWith('/') ? path.join(urlPath, 'index.html') : urlPath;
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(path.normalize(root))) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
      });
    });
  });
}

let cachedServer: { url: string; close: () => void; refcount: number } | null = null;

async function acquireServer(root: string): Promise<{ url: string; release: () => void }> {
  if (!cachedServer) {
    cachedServer = { ...(await startStaticServer(root)), refcount: 0 };
  }
  cachedServer.refcount += 1;
  return { url: cachedServer.url, release: () => {
    if (!cachedServer) return;
    cachedServer.refcount -= 1;
    if (cachedServer.refcount <= 0) {
      cachedServer.close();
      cachedServer = null;
    }
  } };
}

/**
 * 打开一个静态伺服页面并注入初始化脚本（通用装配；webview 假宿主装配是它的特例）。
 * 每个用例独立 BrowserContext（隔离 clipboard 权限与存储），静态服务器进程内共享。
 */
export async function openStaticPage(
  browser: Browser,
  root: string,
  initScript?: string,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const { url, release } = await acquireServer(root);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  // 排查辅助：页面运行期错误转发到测试输出。只转发 console 会漏掉未捕获异常
  // （pageerror 不进 console）——假 API 缺方法导致 init 抛 TypeError 时，
  // 页面看起来毫无动静，用例只会表现为超时
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.error('[page-console]', msg.text());
    }
  });
  page.on('pageerror', (error) => {
    console.error('[page-error]', error.message);
  });
  if (initScript) await page.addInitScript(initScript);
  await page.goto(`${url}/index.html`);
  return {
    page,
    close: async () => {
      await context.close();
      release();
    },
  };
}

/**
 * 打开一个装配好假宿主的 webview 页面。
 * 每个用例独立 BrowserContext（隔离 clipboard 权限与存储），静态服务器进程内共享。
 * `initScript` 缺省用 VS Code 单视图形态；Electron 浮窗等形态传 `FAKE_HOST_INIT_FLOATING`。
 */
export async function openWebviewView(
  browser: Browser,
  repoRoot: string,
  initScript: string = FAKE_HOST_INIT,
): Promise<WebviewHandle> {
  const { page, close } = await openStaticPage(browser, path.join(repoRoot, 'dist', 'webview'), initScript);
  const host = new FakeHostDriver(page);
  await host.waitReady();
  return {
    page,
    host,
    close,
  };
}
