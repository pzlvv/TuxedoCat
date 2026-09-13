/**
 * browserShim - 浏览器版「preload」
 *
 * Electron 原生 webview 通过 preload 暴露 window.electronAPI（contextBridge + ipcRenderer），
 * 浏览器页面没有 preload，因此由 HTTP 服务器在 index.html 中注入这段脚本，
 * 用 WebSocket 复刻同样的 API 表面：
 *
 *   window.electronAPI.postMessage(msg)  -> ws.send(JSON.stringify(msg))          （前端 -> 后端）
 *   ws.onmessage -> window.postMessage(msg, '*')                                  （后端 -> 前端）
 *
 * webview 现有代码全部通过 window.addEventListener('message') 收消息、
 * 通过 window.electronAPI.postMessage 发消息，因此无需任何改动即可在浏览器中运行。
 *
 * 同时注入与 preload.ts 一致的全局变量（__hostInfo / __hasWorkspace / logoUri 等）。
 */

/**
 * 返回注入到 index.html 的浏览器启动脚本源码。
 * 宿主相关信息通过 window.__HOST_BOOTSTRAP__ 传入（由 webServer 在注入前写入）。
 */
export function getBrowserShimSource(): string {
  return `(function () {
  var cfg = window.__HOST_BOOTSTRAP__ || {};
  var listeners = [];
  var queue = [];
  var socket = null;
  var reconnectDelay = 500;
  var closing = false;
  // 最近一次「会话绑定」消息（setActiveSessionId / startNewConversation / loadConversation）。
  // 断线重连后后端会丢失该连接与会话的关联，重放一次即可恢复消息路由。
  var lastSessionMsg = null;
  var connectedOnce = false;

  function isOpen() {
    return socket && socket.readyState === 1;
  }

  function send(msg) {
    if (msg && (msg.type === 'setActiveSessionId' || msg.type === 'startNewConversation' || msg.type === 'loadConversation')) {
      lastSessionMsg = msg;
    }
    if (isOpen()) {
      socket.send(JSON.stringify(msg));
      return;
    }
    // 连接尚未就绪：先入队，连接建立后统一补发
    queue.push(msg);
    connect();
  }

  function connect() {
    if (closing) return;
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;
    var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      socket = new WebSocket(protocol + '//' + window.location.host + '/ws');
    } catch (e) {
      socket = null;
      return;
    }

    socket.onopen = function () {
      reconnectDelay = 500;
      var pending = queue;
      queue = [];
      for (var i = 0; i < pending.length; i++) {
        socket.send(JSON.stringify(pending[i]));
      }
      // 重连（非首次连接）：重放最近一次会话绑定消息，恢复会话级消息路由
      if (connectedOnce && lastSessionMsg) {
        try {
          socket.send(JSON.stringify(lastSessionMsg));
        } catch (e) {
          // 忽略
        }
      }
      connectedOnce = true;
    };

    socket.onmessage = function (event) {
      var msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      // 宿主请求页面重载（例如工作目录切换后，浏览器会话需要重新初始化）
      if (msg && msg.type === 'serverReload') {
        closing = true;
        window.location.reload();
        return;
      }
      // 服务端构建版本号：与页面内嵌版本号不一致，说明当前页面来自浏览器缓存
      // （微信 X5 / XWeb 内核对文档缓存很激进，?v= 这类查询参数也绕不过）。
      // 跳到带版本号的入口路径 —— 新路径必然 cache miss，从而拿到最新前端。
      if (msg && msg.type === 'serverBuildId') {
        if (cfg.buildId && msg.buildId && cfg.buildId !== msg.buildId) {
          closing = true;
          window.location.replace('/index-' + msg.buildId + '.html' + window.location.search);
        }
        return;
      }
      for (var i = 0; i < listeners.length; i++) {
        try {
          listeners[i](msg);
        } catch (e) {
          // 单个监听器异常不影响其它监听器
        }
      }
      // 与 preload.ts 行为一致：转发为 window message，webview 通过 addEventListener('message') 接收
      window.postMessage(msg, '*');
    };

    socket.onclose = function () {
      socket = null;
      if (closing) return;
      // 指数退避重连（上限 5s）
      var delay = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
      window.setTimeout(connect, delay);
    };

    socket.onerror = function () {
      // 出错后浏览器会触发 onclose，重连逻辑统一在 onclose 处理
    };
  }

  window.electronAPI = {
    postMessage: function (msg) { send(msg); },
    onMessage: function (callback) { listeners.push(callback); },
    getWorkspacePath: function () { return cfg.workspacePath || ''; },
    getSessionId: function () { return ''; },
  };

  window.__hasWorkspace = !!cfg.hasWorkspace;
  window.__vscodeLocale = cfg.vscodeLocale || 'en';
  window.__systemLocale = cfg.systemLocale || 'en';
  window.__uiLocale = cfg.uiLanguage || 'auto';
  window.__highlightLanguages = cfg.highlightLanguages || [];
  window.logoUri = './logo.png';
  window.__sessionId = '';
  window.__hostInfo = cfg.hostInfo;
  window.__serverMode = true;
  // 每个浏览器页面一个唯一标识：宿主回推的消息会带上它，
  // 使「查看文件 / 打开设置面板」这类操作只回到发起端，不广播到其它端。
  window.__clientId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

  // ── 全屏显示 ──
  // 浏览器要求 requestFullscreen() 必须由用户手势触发：页面加载时直接调用通常会被拒绝。
  // 因此先直接尝试一次；若未进入全屏，则退化为「首次用户交互（点击/按键/触摸）时再请求」。
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function requestFullscreen() {
    if (isFullscreen()) return true;
    var el = document.documentElement;
    var fn = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
    if (!fn) return false;
    try {
      var result = fn.call(el);
      if (result && typeof result.then === 'function') {
        // 被浏览器拒绝（无用户手势）时静默忽略，交给手势兜底
        result['catch'](function () {});
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function armFullscreenOnGesture() {
    var events = ['pointerdown', 'mousedown', 'keydown', 'touchstart'];
    function cleanup() {
      for (var i = 0; i < events.length; i++) {
        document.removeEventListener(events[i], handler, true);
      }
    }
    function handler() {
      cleanup();
      requestFullscreen();
    }
    for (var i = 0; i < events.length; i++) {
      document.addEventListener(events[i], handler, true);
    }
  }

  // cfg.fullscreen 显式设为 false 时不启用（默认启用）
  if (cfg.fullscreen !== false && document.fullscreenEnabled !== false) {
    requestFullscreen();
    // 同步调用后 fullscreenElement 可能尚未更新（异步进入全屏），
    // 这里统一挂一次手势兜底：已是全屏时 handler 内部会直接返回，无副作用。
    armFullscreenOnGesture();
  }

  connect();
})();
`;
}
