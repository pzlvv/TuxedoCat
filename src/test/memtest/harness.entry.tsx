/**
 * MessagesView 内存测试 harness 入口（仅用于本地测试，不参与正式构建）。
 *
 * 打开方式：playwright 驱动 Chromium 加载 web bundle。
 * 页面 URL 带 ?session=<name> 查询参数时自动挂载该会话。
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import MessagesView from '../../webview/MessagesView';
import { getColors } from '../../webview/colors';
import type { Message } from '../../webview/types';
import { buildEditDiffHunks } from '../../core/utils/editDiff';

// 测试会话数据由 preprocess.js 生成，构建时被注入为全局 DATA
declare const __MEMTEST_DATA__: any;

interface SessionData {
  name: string;
  rawBytes: number;
  rawMessages: number;
  messages: Message[];
  editDiffNeeded?: Record<string, { beforeContent: string; afterContent: string }>;
}

// ── Edit diffHunks 运行时计算（等价扩展端 postConversationLoaded 的预处理）──
function applyEditDiff(session: SessionData): Message[] {
  const needed = session.editDiffNeeded || {};
  const messages = session.messages.map((m) => {
    if (m.role !== 'toolcall' || !m.toolCallId || !needed[m.toolCallId]) return m;
    const args = m.toolArgs || {};
    if (m.toolName === 'Edit' && (!args.diffHunks || args.diffHunks.length === 0)) {
      const src = needed[m.toolCallId];
      try {
        const hunks = buildEditDiffHunks({
          beforeContent: src.beforeContent,
          afterContent: src.afterContent,
          startLine: args.startLine as number | undefined,
          endLine: args.endLine as number | undefined,
          replaceAll: Boolean(args.replace_all),
        });
        return { ...m, toolArgs: { ...args, diffHunks: hunks } };
      } catch (e) {
        console.error('diff failed', e);
        return m;
      }
    }
    return m;
  });
  return messages as Message[];
}

// ── DOM 统计 ────────────────────────────────────────────────────────
interface DomStats {
  totalNodes: number;
  byTag: Record<string, number>;
  toolNodes: Record<string, number>;
  heaviest: Array<{ tag: string; count: number; textKB: number; nodeKB: number; htmlKB: number }>;
}

function collectDomStats(root: HTMLElement): DomStats {
  const byTag: Record<string, number> = {};
  const toolNodes: Record<string, number> = {};
  let totalNodes = 0;
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let n: Node | null;
  while ((n = walk.nextNode())) {
    totalNodes++;
    const el = n as Element;
    byTag[el.tagName] = (byTag[el.tagName] || 0) + 1;
  }
  const heaviest: DomStats['heaviest'] = [];
  for (const [tag, count] of Object.entries(byTag)) {
    if (count < 20 && tag !== 'PRE' && tag !== 'SPAN' && tag !== 'DIV') continue;
    const els = Array.from(root.querySelectorAll(tag));
    let textKB = 0;
    let htmlKB = 0;
    for (const el of els) {
      textKB += (el.textContent || '').length / 1024;
      htmlKB += (el as HTMLElement).innerHTML.length / 1024;
    }
    heaviest.push({ tag, count, textKB, nodeKB: 0, htmlKB });
  }
  heaviest.sort((a, b) => b.htmlKB - a.htmlKB);
  return { totalNodes, byTag, toolNodes, heaviest: heaviest.slice(0, 12) };
}

// ── App ──────────────────────────────────────────────────────────────
// 数据来源：优先使用构建期内联的 __MEMTEST_DATA__（小样本集，构建快）；
// 若以 --data=runtime 构建（内联为 undefined），则从同目录 sessions.json 运行时加载，
// 用于超大样本集（内联会让 bundle 膨胀到几十 MB 且拖慢 esbuild）。
const dataPromise: Promise<{ sessions: SessionData[] }> = (async () => {
  if (typeof __MEMTEST_DATA__ !== 'undefined' && __MEMTEST_DATA__?.sessions?.length) {
    return __MEMTEST_DATA__ as { sessions: SessionData[] };
  }
  // 可通过 ?data=<file> 指定运行时加载的样本集文件（默认 sessions.json）
  const dataFile = new URLSearchParams(location.search).get('data') || 'sessions.json';
  const res = await fetch('./' + dataFile);
  return (await res.json()) as { sessions: SessionData[] };
})();

function App() {
  const [messages, setMessages] = React.useState<Message[]>([]);
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const params = new URLSearchParams(location.search);
    const name = params.get('session');
    if (!name) return;
    let cancelled = false;
    dataPromise.then((data) => {
      if (cancelled) return;
      const session = data.sessions.find((s) => s.name === name);
      if (!session) {
        document.title = 'SESSION_NOT_FOUND';
        return;
      }
      const t0 = performance.now();
      let msgs = applyEditDiff(session);
      // ?forcePending=1：把所有 Edit/Write 工具卡片标记为"等待用户授权"（status: 'normal'），
      // 用于验证手动模式下预览必须完整展开、确认后才恢复缩略。
      if (params.get('forcePending') === '1') {
        msgs = msgs.map((m) =>
          m.role === 'toolcall' && (m.toolName === 'Edit' || m.toolName === 'Write')
            ? { ...m, status: 'normal' as const }
            : m,
        );
      }
      setMessages(msgs);
      (window as any).__messages = msgs;
      document.title = 'PENDING';
      (window as any).__memtestInfo = {
        name: session.name,
        rawBytes: session.rawBytes,
        rawMessages: session.rawMessages,
        uiMessages: msgs.length,
        contentChars: msgs.reduce((a, m) => a + (m.content?.length || 0), 0),
        argsChars: msgs.reduce((a, m) => a + JSON.stringify(m.toolArgs || {}).length, 0),
        parseMs: performance.now() - t0,
      };
    });
    return () => { cancelled = true; };
  }, []);

  // 挂载完成后上报 DOM 统计
  React.useEffect(() => {
    if (!messages.length) return;
    const container = containerRef.current;
    if (!container) return;
    // 等所有异步渲染（Shiki 等）稳定：用双重 rAF + 延时
    let attempts = 0;
    const check = () => {
      attempts++;
      const settled = attempts * 500;
      if (settled >= 4000) {
        const stats = collectDomStats(container);
        (window as any).__domStats = stats;
        document.title = 'READY';
        return;
      }
      setTimeout(check, 500);
    };
    setTimeout(check, 1000);
  }, [messages.length]);

  return (
    <div className="relative flex-1 min-h-0 flex flex-col overflow-hidden" style={{ height: '100vh' }}>
      <div
        ref={containerRef}
        className="flex-1 min-h-0 px-4 py-4 overflow-y-scroll messages-container"
        style={{ display: 'flex', flexDirection: 'column' }}
      >
        <MessagesView
          messages={messages}
          containerRef={containerRef}
          showThinkingAnimation={false}
          animationMode="thinking"
          isDark={true}
          colors={getColors(true)}
        />
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
