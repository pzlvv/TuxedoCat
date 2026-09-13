/**
 * webServer - 内置 HTTP / WebSocket 服务器
 *
 * 由 File 菜单的「Start Server」启动，在 0.0.0.0 上监听：
 * 1. HTTP：把构建产物 dist/webview 作为静态资源对外提供（webview 前端），
 *    并在 index.html 中注入浏览器启动脚本（浏览器版 preload，见 browserShim.ts）。
 * 2. WebSocket（/ws）：浏览器前端 <-> Electron 主进程（后端）的双向消息通道，
 *    消息体与 Electron 原生 webview 的 IPC 协议完全一致（webview-message）。
 *
 * 这样 Electron 主进程（core / ElectronUI）无需感知请求来自原生视图还是浏览器，
 * 浏览器页面复用同一套 webview 前端代码。
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import WebSocket = require('ws');

/** 浏览器客户端：与 ChatViewManager 的 ExternalChatClient 结构保持一致 */
export interface WebServerClient {
  /** 客户端唯一标识 */
  readonly id: number;
  isDestroyed(): boolean;
  /** 向浏览器推送消息（channel 仅为对齐 webContents.send 签名，实际按原样下发 message） */
  send(channel: string, message: unknown): void;
  onDestroyed(callback: () => void): void;
}

export interface WebServerOptions {
  /** 静态资源根目录（dist/webview） */
  webRoot: string;
  /** 监听地址，默认 0.0.0.0（局域网可访问） */
  host?: string;
  /** 监听端口 */
  port: number;
  /** 注入 index.html 的浏览器启动脚本（browserShim 生成） */
  shimSource: string;
  /** 每次请求 index.html 时生成注入到 window.__HOST_BOOTSTRAP__ 的宿主信息 */
  getHostGlobals: () => Record<string, unknown>;
  onClientConnected?: (client: WebServerClient) => void;
  onClientMessage: (client: WebServerClient, message: unknown) => void;
  onClientDisconnected?: (client: WebServerClient) => void;
}

export interface WebServerHandle {
  readonly host: string;
  readonly port: number;
  /** 本地访问地址 */
  readonly url: string;
  readonly clientCount: number;
  /** 向所有已连接的浏览器客户端广播消息 */
  broadcast(message: unknown): void;
  /** 关闭服务器与所有连接 */
  close(): Promise<void>;
}

/** WebSocket 路径 */
const WS_PATH = '/ws';
/** 心跳间隔：定期 ping，及时清理掉线连接 */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** 常见静态资源 MIME 类型 */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

function contentTypeOf(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 转义内联脚本内容，避免其中出现 `</script>` 提前结束脚本块。
 */
function escapeInlineScript(source: string): string {
  return source.replace(/<\/script/gi, '<\\/script');
}

/**
 * 在 index.html 的 </head> 前注入宿主信息与浏览器启动脚本。
 * 必须在 module 脚本执行前完成（内联经典脚本会先于 defer 的 module 执行）。
 */
function injectBootstrap(html: string, shimSource: string, globals: Record<string, unknown>): string {
  const globalsJson = escapeInlineScript(JSON.stringify(globals));
  const shim = escapeInlineScript(shimSource);
  const injected = `<script>window.__HOST_BOOTSTRAP__=${globalsJson};</script>\n`
    + `<script>${shim}</script>\n`;
  if (html.includes('</head>')) {
    return html.replace('</head>', `${injected}</head>`);
  }
  // 兜底：没有 </head> 时插到最前面
  return injected + html;
}

/**
 * 启动 HTTP + WebSocket 服务器。
 * 端口被占用时以 error 事件 reject，由调用方决定是否重试其它端口。
 */
export function startWebServer(options: WebServerOptions): Promise<WebServerHandle> {
  const host = options.host ?? '0.0.0.0';
  const webRoot = path.resolve(options.webRoot);

  return new Promise<WebServerHandle>((resolve, reject) => {
    const clients = new Map<number, WebServerClient>();
    let nextClientId = 1;
    let listening = false;

    const server = http.createServer((req, res) => {
      handleHttpRequest(req, res, webRoot, options);
    });

    let wss: WebSocket.WebSocketServer;
    try {
      wss = new WebSocket.WebSocketServer({ server, path: WS_PATH });
    } catch (err) {
      reject(err);
      return;
    }

    wss.on('connection', (socket) => {
      const id = nextClientId++;
      let destroyed = false;
      const destroyCallbacks: Array<() => void> = [];
      const tracked = socket as WebSocket.WebSocket & { isAlive?: boolean };
      tracked.isAlive = true;
      socket.on('pong', () => {
        tracked.isAlive = true;
      });

      const client: WebServerClient = {
        id,
        isDestroyed: () => destroyed,
        send: (_channel, message) => {
          if (destroyed) return;
          if (socket.readyState !== WebSocket.WebSocket.OPEN) return;
          try {
            socket.send(JSON.stringify(message));
          } catch (err) {
            console.error(`[webServer] send to client ${id} failed:`, err);
          }
        },
        onDestroyed: (callback) => {
          destroyCallbacks.push(callback);
        },
      };

      clients.set(id, client);
      console.log(`[webServer] client connected: #${id} (total=${clients.size})`);
      try {
        options.onClientConnected?.(client);
      } catch (err) {
        console.error('[webServer] onClientConnected error:', err);
      }

      // 告知页面服务端当前的构建版本号：若页面来自缓存（微信 X5 缓存很激进），
      // shim 会据此跳到带版本号的入口路径，强制拿到最新前端。
      client.send('webview-message', { type: 'serverBuildId', buildId: computeBuildId(webRoot) });

      socket.on('message', (data: WebSocket.RawData) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.toString());
        } catch {
          // 忽略非法 JSON
          return;
        }
        try {
          options.onClientMessage(client, parsed);
        } catch (err) {
          console.error(`[webServer] onClientMessage error (#${id}):`, err);
        }
      });

      const cleanup = (): void => {
        if (destroyed) return;
        destroyed = true;
        clients.delete(id);
        console.log(`[webServer] client disconnected: #${id} (total=${clients.size})`);
        for (const cb of destroyCallbacks) {
          try {
            cb();
          } catch (err) {
            console.error('[webServer] client destroy callback error:', err);
          }
        }
        try {
          options.onClientDisconnected?.(client);
        } catch (err) {
          console.error('[webServer] onClientDisconnected error:', err);
        }
      };

      socket.on('close', cleanup);
      socket.on('error', (err: Error) => {
        console.error(`[webServer] client #${id} socket error:`, err.message);
        cleanup();
      });
    });

    // 心跳：标记未响应 ping 的连接为失活并断开
    const heartbeat = setInterval(() => {
      for (const socket of wss.clients) {
        const tracked = socket as WebSocket.WebSocket & { isAlive?: boolean };
        if (tracked.isAlive === false) {
          socket.terminate();
          continue;
        }
        tracked.isAlive = false;
        try {
          socket.ping();
        } catch {
          // 忽略 ping 失败
        }
      }
    }, HEARTBEAT_INTERVAL_MS);

    const closeAll = async (): Promise<void> => {
      clearInterval(heartbeat);
      for (const socket of wss.clients) {
        try {
          socket.close(1001, 'server closing');
        } catch {
          // 忽略
        }
      }
      // 等待 WebSocket 关闭；超时则强制断开，避免个别客户端拖住关闭流程
      await new Promise<void>((done) => {
        const timer = setTimeout(() => {
          for (const socket of wss.clients) {
            try {
              socket.terminate();
            } catch {
              // 忽略
            }
          }
          done();
        }, 1000);
        wss.close(() => {
          clearTimeout(timer);
          done();
        });
      });
      // 关闭 HTTP 连接（含 keep-alive），并等待 server 真正关闭
      (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((done) => {
        const timer = setTimeout(done, 1000);
        server.close(() => {
          clearTimeout(timer);
          done();
        });
      });
    };

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (!listening) {
        clearInterval(heartbeat);
        try {
          wss.close();
        } catch {
          // 忽略
        }
        reject(err);
        return;
      }
      console.error('[webServer] server error:', err);
    });

    server.listen(options.port, host, () => {
      listening = true;
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      console.log(`[webServer] listening on http://${host}:${port}`);
      resolve({
        host,
        port,
        url: `http://localhost:${port}/`,
        get clientCount() {
          return clients.size;
        },
        broadcast: (message) => {
          for (const client of clients.values()) {
            client.send('webview-message', message);
          }
        },
        close: closeAll,
      });
    });
  });
}

/**
 * 带构建版本号的入口路径，形如 `/index-<buildId>.html`。
 *
 * 用途：微信 X5 / XWeb 内核对页面文档的缓存非常激进，`?v=` 之类的查询参数
 * 也绕不过（它基本按路径命中缓存）。因此页面加载后会用 WebSocket 拿服务端当前
 * 构建版本号，与自身内嵌的版本号比对，不一致就跳到这个「新路径」上，
 * 新路径必然 cache miss，从而拿到最新前端。
 *
 * 放在根目录（而不是 /__v/<id>/ 这类子路径）是为了让 index.html 里
 * `./assets/...`、`./logo.png` 这些相对路径仍然解析到根目录，无需改写资源地址。
 */
const VERSIONED_INDEX_RE = /^\/index-([0-9a-z]+)\.html$/;

/**
 * 计算前端构建版本号：index.html 的修改时间 + 大小。
 * 每次 `vite build` 都会重写 index.html，因此该值随构建变化；
 * 打包后 mtime 固定，版本号也稳定。
 */
function computeBuildId(webRoot: string): string {
  try {
    const stat = fs.statSync(path.join(webRoot, 'index.html'));
    const raw = `${Math.floor(stat.mtimeMs)}:${stat.size}`;
    // 简易 djb2，输出短字符串，避免把长数字暴露在 URL 上
    let hash = 5381;
    for (let i = 0; i < raw.length; i++) {
      hash = ((hash << 5) + hash + raw.charCodeAt(i)) >>> 0;
    }
    return hash.toString(36);
  } catch {
    return '0';
  }
}

/**
 * 处理 HTTP 静态资源请求：
 * - `/`、`/index.html` 与 `/index-<buildId>.html` 返回注入了浏览器启动脚本的页面
 * - 其它路径按 webRoot 下的真实文件返回
 */
function handleHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  webRoot: string,
  options: WebServerOptions,
): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  const rawUrl = req.url ?? '/';
  const pathname = decodeURIComponent(rawUrl.split('?')[0]);
  const isIndexRequest = pathname === '/' || VERSIONED_INDEX_RE.test(pathname);
  const relative = isIndexRequest ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(webRoot, relative);

  // 防目录穿越：解析后的路径必须仍在 webRoot 内
  if (filePath !== webRoot && !filePath.startsWith(webRoot + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    // index.html：注入启动脚本，且不缓存（保证宿主信息/前端更新即时生效）
    if (path.basename(filePath).toLowerCase() === 'index.html') {
      fs.readFile(filePath, 'utf-8', (readErr, html) => {
        if (readErr) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Internal Server Error');
          return;
        }
        const body = injectBootstrap(html, options.shimSource, {
          ...options.getHostGlobals(),
          // 页面内嵌当前构建版本号，供浏览器 shim 与服务端比对（见 VERSIONED_INDEX_RE）
          buildId: computeBuildId(webRoot),
        });
        res.writeHead(200, {
          'Content-Type': MIME_TYPES['.html'],
          'Content-Length': Buffer.byteLength(body),
          // 微信 X5 / XWeb 内核对页面缓存的复用很激进，只写 no-store 仍可能拿到旧页面，
          // 这里用最强组合禁用缓存，避免手机端刷新后仍是旧版本（表现为改动不生效）。
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0',
        });
        res.end(req.method === 'HEAD' ? undefined : body);
      });
      return;
    }

    res.writeHead(200, {
      'Content-Type': contentTypeOf(filePath),
      'Content-Length': stat.size,
      // 构建产物带内容 hash，可长期缓存
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      res.destroy();
    });
    stream.pipe(res);
  });
}
