import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { SerializedWorkspaceRef } from '../../src/host/workspaceState';
import { workspaceRefKey } from '../../src/host/workspaceRef';
import { CONFIG_DIR_NAME, EXTENSION_NAME } from '../../src/config/project';
import { TRAY_SOUND_DISABLE_ENV } from '../../electron/trayAttentionSound';
import type { MockLlm } from './mockLlmServer';

/**
 * Electron 整应用启动器。
 *
 * 驱动方式：`chromium.connectOverCDP` 直连 Electron 的 DevTools 端点。
 * 标题栏 / 侧栏 / 聊天视图都是 WebContentsView，在 CDP 目标列表里以 page target
 * 暴露，因此可以用完整的 Playwright Page API 驱动（无需 `_electron` 的主进程桥）。
 *
 * 两个环境要点（探针实证，见 e2e/README.md 的「已知坑」）：
 * 1. **主窗口渲染器必须拉起**：应用的主 BrowserWindow 从不 loadURL（视图全挂在
 *    contentView 上），其 webContents 没有渲染进程，CDP 命令对其永不响应，会让
 *    Playwright 的页面初始化无限挂起。这里经 Node inspector（`--inspect=0`）在
 *    主进程里执行 `loadURL('about:blank')` 把渲染器拉起来。
 * 2. `--remote-debugging-port=0` / `--inspect=0` / `--remote-allow-origins=*` 必须
 *    放在入口文件**之前**（Chromium/Node 开关解析位置）。
 *
 * 隔离策略：
 * - `USERPROFILE`/`HOME`/`APPDATA` 指向临时目录：`~/<configDir>/`（settings.json、
 *   会话落盘）与 Electron userData（workspace-state.json）全部进沙箱
 * - Core 为 standalone（产品真实形态，前置 `npm run build:core`）；
 *   LLM 指向本地 mock SSE 服务器
 * - `--multi-instance=<id>` + `--workspace=<dir>`：跳过单实例锁、启动即打开工作区
 */

export interface ChatPageOptions {
  /** 只匹配绑定工作区路径包含该子串的视图 */
  workspaceIncludes?: string;
  /** 只匹配空会话视图（消息区空态且会话已生成） */
  emptyState?: boolean;
}

export interface AppHandle {
  /** CDP 连接的 Browser（断开连接用 close，退出应用用 kill） */
  browser: Browser;
  /** 默认上下文：所有 webContents 页面都在其中 */
  context: BrowserContext;
  /**
   * 活动聊天视图。多视图宿主下同屏有多个聊天页（当前会话、预热备用、非活动
   * 工作区预载），按「绑定工作区 + 自身会话 + 侧栏列表」组合解析；切换会话 /
   * 工作区 / 新建对话后应重新获取。
   */
  chatPage(opts?: ChatPageOptions): Promise<Page>;
  /** 标题栏视图 */
  titlebarPage(): Promise<Page>;
  /** 侧栏视图（悬浮窗模式下被移除，可能等待超时） */
  sidebarPage(): Promise<Page>;
  /** 按子串等待页面出现（每次调用重新枚举 context.pages()） */
  waitForPage(urlIncludes: string, timeout?: number): Promise<Page>;
  /** 结束应用并断开连接 */
  close(): Promise<void>;
  /** 在主进程执行表达式（Node inspector 直连；注入测试钩子用） */
  evaluateInMain(expression: string): Promise<unknown>;
  /** 临时目录（USERPROFILE 沙箱），用例可直接检查会话落盘 */
  homeDir: string;
  workspaceDir: string;
  /** 隔离 userData 里的 workspace-state.json（预置 / 断言宿主落盘状态用） */
  stateFile: string;
}

function writeSettings(homeDir: string, mockLlm: MockLlm, agentMode: 'manual' | 'risk' | 'auto'): void {
  const configDir = path.join(homeDir, CONFIG_DIR_NAME);
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({
    llm: {
      activeProvider: 'mock',
      providers: {
        mock: {
          baseURL: mockLlm.baseURL,
          apiKey: 'sk-e2e-test',
          models: ['mock-model'],
          defaultModel: 'mock-model',
          modelConfigs: {
            'mock-model': { apiType: 'OpenAI', context: 128000, output: 4096 },
          },
        },
      },
      thinking_effort: 'off',
      webSearch: false,
      enableUsageStats: false,
    },
    // manual：Write/Edit/Bash 全部弹权限确认，覆盖 US-18 场景；
    // 子代理并发用例（specs/005）传 auto 让 Agent 调用免确认自动执行
    defaultAgentMode: agentMode,
    defaultPromptMode: 'normal',
    uiLanguage: 'zh',
  }, null, 2));
}

interface SpawnedApp {
  child: ReturnType<typeof spawn>;
  nodeWs: string;
  devtoolsWs: string;
  homeDir: string;
  /** 隔离 userData 里的 workspace-state.json（预置 / 断言宿主落盘状态用） */
  stateFile: string;
}

/** 等待子进程输出里出现某行（stderr + stdout 合并监听） */
function waitForOutput(
  child: { stderr: NodeJS.ReadableStream | null; stdout: NodeJS.ReadableStream | null },
  re: RegExp,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待输出超时: ${re}`)), timeoutMs);
    let buf = '';
    const onData = (d: Buffer): void => {
      buf += d.toString();
      const m = buf.match(re);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stderr?.on('data', onData);
    child.stdout?.on('data', onData);
  });
}

async function spawnApp(options: {
  repoRoot: string;
  mockLlm: MockLlm;
  workspaceDir: string;
  /** 本地项传路径字符串；远程项传 `SerializedWorkspaceRef`（含 endpoint 与凭证） */
  openWorkspaces?: Array<string | SerializedWorkspaceRef>;
  activeWorkspace?: string | SerializedWorkspaceRef;
  /**
   * 预置 workspace-state.json 的其余字段（如 recentSshConnections）。
   * 只预置字段不开工作区时照常走 `--workspace=` 启动，字段由主进程读盘带上。
   */
  stateOverrides?: Record<string, unknown>;
  /** 权限模式（缺省 manual：工具调用弹确认）；auto 让工具免确认自动执行 */
  agentMode?: 'manual' | 'risk' | 'auto';
}): Promise<SpawnedApp> {
  const homeDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tuxedo-e2e-home-'));
  writeSettings(homeDir, options.mockLlm, options.agentMode ?? 'manual');

  // 实例后缀必须与 main.ts 的过滤规则一致（[^A-Za-z0-9_-] 剔除 + 截断 32），
  // 预置 workspace-state.json 的目录名要和它完全相同
  const instanceId = randomUUID().replace(/-/g, '').slice(0, 12);
  const roamingDir = path.join(homeDir, 'AppData', 'Roaming');
  await fs.promises.mkdir(roamingDir, { recursive: true });
  const userDataDir = path.join(roamingDir, `${EXTENSION_NAME}-multi-` + instanceId);
  const stateFile = path.join(userDataDir, 'workspace-state.json');

  if ((options.openWorkspaces && options.openWorkspaces.length > 0) || options.stateOverrides) {
    // 预置打开集合 / 额外字段：写隔离 userData 的 workspace-state.json，启动时恢复标签页。
    // 活动项是引用对象时必须写 activeWorkspaceKey（主进程按去重键回查；旧字段
    // activeWorkspace 只认本地路径字符串，对象会被忽略）
    const active = options.activeWorkspace ?? options.openWorkspaces?.[options.openWorkspaces.length - 1];
    const activeIsRef = typeof active === 'object' && active !== null;
    await fs.promises.mkdir(userDataDir, { recursive: true });
    await fs.promises.writeFile(stateFile, JSON.stringify({
      windowMode: 'normal',
      theme: 'dark',
      ...options.stateOverrides,
      openWorkspaces: options.openWorkspaces ?? [],
      activeWorkspaceKey: activeIsRef
        ? workspaceRefKey(active as SerializedWorkspaceRef as Parameters<typeof workspaceRefKey>[0])
        : null,
      activeWorkspace: typeof active === 'string' ? active : null,
    }));
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    USERPROFILE: homeDir,
    HOME: homeDir,
    APPDATA: roamingDir,
    DISABLE_AUTO_COMPACT: '1',
    // 整应用用例在开发机上跑，会话结束会触发托盘提醒音——关掉它，
    // 免得与开发机上真实运行的应用（或用户正在听的其它声音）撞在一起
    [TRAY_SOUND_DISABLE_ENV]: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const args: string[] = [
    // Chromium/Node 开关必须在入口文件之前
    '--inspect=0',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    path.join(options.repoRoot, 'dist-electron', 'main.cjs'),
    '--no-sandbox',
    `--multi-instance=${instanceId}`,
  ];
  // 预置了打开集合时由状态文件恢复工作区，避免 --workspace 再追加
  if (!options.openWorkspaces || options.openWorkspaces.length === 0) {
    args.push(`--workspace=${options.workspaceDir}`);
  }

  const child = spawn(require('electron') as unknown as string, args, {
    env,
    cwd: options.repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // E2E_DEBUG=1 时把应用主进程日志透传到测试输出（排查 core / 权限链路）
  if (process.env.E2E_DEBUG) {
    child.stdout.on('data', (d: Buffer) => process.stderr.write(`[app] ${d}`));
    child.stderr.on('data', (d: Buffer) => process.stderr.write(`[app-err] ${d}`));
  }
  child.stderr.resume();
  child.stdout.resume();

  const nodeWs = await waitForOutput(child, /Debugger listening on (ws:\/\/\S+)/, 30_000);
  const devtoolsWs = await waitForOutput(child, /DevTools listening on (ws:\/\/\S+)/, 30_000);
  return { child, nodeWs, devtoolsWs, homeDir, stateFile };
}

/** 经 Node inspector 在主进程执行表达式（拉起主窗口渲染器） */
function evaluateInMain(nodeWs: string, expression: string, timeoutMs = 15_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(nodeWs);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('主进程 evaluate 超时'));
    }, timeoutMs);
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression } }));
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Node inspector websocket 连接失败'));
    };
    ws.onmessage = (ev) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(String(ev.data)));
      } catch {
        resolve(null);
      }
      ws.close();
    };
  });
}

export async function launchApp(options: {
  repoRoot: string;
  mockLlm: MockLlm;
  workspaceDir: string;
  openWorkspaces?: Array<string | SerializedWorkspaceRef>;
  activeWorkspace?: string | SerializedWorkspaceRef;
  stateOverrides?: Record<string, unknown>;
  /** 权限模式（缺省 manual：工具调用弹确认）；auto 让工具免确认自动执行 */
  agentMode?: 'manual' | 'risk' | 'auto';
}): Promise<AppHandle> {
  const spawned = await spawnApp(options);

  // 等主窗口创建完成再拉渲染器（窗口是 show:false 创建的，日志 showing window 后必然存在）
  await waitForOutput(spawned.child, /showing window/, 30_000).catch(() => undefined);
  await evaluateInMain(
    spawned.nodeWs,
    "(function(){try{const e=process.mainModule?process.mainModule.require('electron'):require('electron');"
      + "const wins=e.BrowserWindow.getAllWindows();let n=0;"
      + "for(const w of wins){if(!w.webContents.getURL()){w.webContents.loadURL('about:blank');n++;}}"
      + "return 'kicked '+n+'/'+wins.length;}catch(err){return 'ERR '+err.message;}})()",
  );
  // loadURL 异步提交，给渲染器一点拉起时间再连接
  await new Promise((r) => setTimeout(r, 800));

  const browser = await chromium.connectOverCDP(spawned.devtoolsWs, { timeout: 30_000 });
  const context = browser.contexts()[0];

  const waitForPage = (urlIncludes: string, timeout = 20_000): Promise<Page> =>
    new Promise<Page>((resolve, reject) => {
      const started = Date.now();
      const poll = (): void => {
        const found = context.pages().find((p) => p.url().includes(urlIncludes));
        if (found) {
          resolve(found);
          return;
        }
        if (Date.now() - started > timeout) {
          reject(new Error(`等待页面超时（URL 含 "${urlIncludes}"）。现有页面：${
            context.pages().map((p) => p.url()).join(', ')
          }`));
          return;
        }
        setTimeout(poll, 200);
      };
      poll();
    });

  /**
   * 解析「当前活动」的聊天视图（多视图宿主的固有难点，诊断脚本实证）：
   * 同屏存在多个聊天页（当前会话、预热备用视图、非活动工作区的预载视图），
   * 且 Electron 对未挂载的 WebContentsView 仍报告 `visibilityState=visible`、
   * `document.hasFocus()=true`，两者都不能作为判据。
   *
   * 确定性判据（组合使用）：
   * 1. 视图绑定的 `window.electronAPI.getWorkspacePath()`（创建时经 `--workspace=` 注入）
   * 2. 视图自己的 `window.__currentSessionId`（App.tsx 在会话切换时写入）
   * 3. 侧栏当前列出的会话集合与 `.item.active` 活动会话
   *
   * 解析优先级：工作区过滤 →（可选）空会话态过滤 → 会话不在侧栏列表（新建对话
   * 视图）→ 侧栏活动会话匹配 → 最后一个候选。
   */
  const waitForChatPage = (
    opts: { workspaceIncludes?: string; emptyState?: boolean } = {},
    timeout = 20_000,
  ): Promise<Page> =>
    new Promise<Page>((resolve, reject) => {
      const started = Date.now();
      const poll = async (): Promise<void> => {
        const pages = context.pages().filter((p) => p.url().includes('dist/webview/index.html'));
        const annotated = await Promise.all(pages.map(async (p) => {
          try {
            return {
              page: p,
              ws: await p.evaluate(() => {
                const api = (window as any).electronAPI;
                return api?.getWorkspacePath ? String(api.getWorkspacePath()) : '';
              }),
              sid: await p.evaluate(() => ((window as any).__currentSessionId as string | null) ?? null),
              empty: await p.evaluate(() => document.querySelector('.messages-container-empty') !== null),
            };
          } catch {
            return null; // 页面正在销毁
          }
        }));

        let candidates = annotated.filter((c): c is NonNullable<typeof c> => c !== null);
        if (opts.workspaceIncludes) {
          candidates = candidates.filter((c) => c.ws.includes(opts.workspaceIncludes!));
        }
        if (opts.emptyState) {
          // 要求 sid 已生成：预热备用视图也是空态，但尚未激活（无会话），
          // 过早往里输入会绕过宿主的会话登记（诊断脚本实证的竞态）
          candidates = candidates.filter((c) => c.empty && !!c.sid);
        }
        if (candidates.length > 0) {
          // 侧栏列表（当前工作区）与活动会话
          const sidebar = context.pages().find((p) => p.url().includes('dist/sidebar/index.html'));
          let listed = new Set<string>();
          let activeId: string | null = null;
          if (sidebar && !sidebar.isClosed()) {
            try {
              const info = await sidebar.evaluate(() => ({
                ids: Array.from(document.querySelectorAll('#list .item[data-session-id]'))
                  .map((el) => el.getAttribute('data-session-id') ?? ''),
                active: document.querySelector('#list .item.active')?.getAttribute('data-session-id') ?? null,
              }));
              listed = new Set(info.ids.filter(Boolean));
              activeId = info.active;
            } catch { /* 侧栏正被移除（悬浮窗切换） */ }
          }
          const pick =
            // 新建对话视图：会话不在当前列表里（尚未落盘）
            candidates.find((c) => c.sid && !listed.has(c.sid))
            // 已打开的会话视图：侧栏活动项匹配
            ?? candidates.find((c) => activeId && c.sid === activeId)
            ?? candidates[candidates.length - 1];
          resolve(pick.page);
          return;
        }
        if (Date.now() - started > timeout) {
          reject(new Error(`等待活动聊天视图超时（候选 ${pages.length} 个均不满足 ${JSON.stringify(opts)}）`));
          return;
        }
        setTimeout(() => { void poll(); }, 200);
      };
      void poll();
    });

  const chatPage = await waitForChatPage();
  await chatPage.waitForSelector('textarea.input-textarea', { timeout: 30_000 });

  const close = async (): Promise<void> => {
    try {
      await browser.close().catch(() => undefined);
    } finally {
      const pid = spawned.child.pid;
      if (pid) {
        // Windows 下杀进程树（GPU/渲染器随父进程退出不可靠时兜底）。
        // 必须等进程树真正退出再返回：串行用例下，下一个实例若与垂死的
        // Electron / core 进程争 CPU，时序敏感的断言会偶发超时（实测回归）
        if (process.platform === 'win32') {
          await new Promise<void>((resolve) => {
            execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => resolve());
          });
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline) {
            const alive = await new Promise<boolean>((resolve) => {
              execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], (err, stdout) => {
                resolve(!err && new RegExp(`^"[^"]*","${pid}"`).test(String(stdout)));
              });
            });
            if (!alive) break;
            await new Promise((r) => setTimeout(r, 200));
          }
        } else {
          spawned.child.kill('SIGKILL');
        }
      }
      await fs.promises.rm(spawned.homeDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  return {
    browser,
    context,
    /**
     * 活动聊天视图。可选过滤：`workspaceIncludes`（视图绑定的工作区路径）、
     * `emptyState`（空会话视图）。切换会话/工作区/新建对话后应重新获取。
     */
    chatPage: (opts?: { workspaceIncludes?: string; emptyState?: boolean }) => waitForChatPage(opts ?? {}),
    titlebarPage: () => waitForPage('dist/titlebar/index.html'),
    sidebarPage: () => waitForPage('dist/sidebar/index.html'),
    waitForPage,
    close,
    evaluateInMain: (expression: string) => evaluateInMain(spawned.nodeWs, expression),
    homeDir: spawned.homeDir,
    workspaceDir: options.workspaceDir,
    stateFile: spawned.stateFile,
  };
}

/** 主进程求值并取回返回值（`evaluateInMain` 回的是 CDP 原始消息） */
export async function mainEval<T>(app: AppHandle, expression: string): Promise<T> {
  const raw = await app.evaluateInMain(expression) as {
    result?: { result?: { value?: T }; exceptionDetails?: { text?: string } };
  };
  if (raw?.result?.exceptionDetails) {
    throw new Error(`主进程求值抛错：${expression}（${raw.result.exceptionDetails.text ?? ''}）`);
  }
  return raw?.result?.result?.value as T;
}

/** 自绘消息框窗口的页面标题（与 electron/styledMessageBox.ts 的 MESSAGE_BOX_PAGE_TITLE 同步） */
const MESSAGE_BOX_PAGE_TITLE = 'tc-message-box';

/**
 * 等待自绘消息框窗口出现（关闭确认 / 删除确认等已不再走原生 dialog，Playwright
 * 可以直接驱动它的页面），返回其 Page。按「data URL + 固定页面标题」识别——
 * 应用里只有消息框用 data URL 载入且标题固定。
 */
export async function waitForMessageBox(app: AppHandle, timeout = 10_000): Promise<Page> {
  const startedAt = Date.now();
  for (;;) {
    const candidates = app.context.pages().filter((p) => p.url().startsWith('data:text/html'));
    for (const page of candidates) {
      if ((await page.title()) === MESSAGE_BOX_PAGE_TITLE) return page;
    }
    if (Date.now() - startedAt > timeout) {
      throw new Error('等待自绘消息框超时。现有页面：'
        + app.context.pages().map((p) => p.url()).join(', '));
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** 读当前消息框渲染出的文案（message / detail / 按钮标签，顺序即下标顺序） */
export async function messageBoxText(page: Page): Promise<{ message: string; detail: string; buttons: string[] }> {
  return page.evaluate(() => ({
    message: (document.querySelector('.message') as HTMLElement | null)?.textContent ?? '',
    detail: (document.querySelector('.detail') as HTMLElement | null)?.textContent ?? '',
    buttons: Array.from(document.querySelectorAll<HTMLButtonElement>('.actions button')).map((b) => b.textContent ?? ''),
  }));
}

/** 点击消息框按钮（0 = 第一个按钮；点击后窗口关闭） */
export async function clickMessageBoxButton(page: Page, index: number): Promise<void> {
  await page.locator(`.actions button[data-index="${index}"]`).click();
}

/** 造一个临时工作区；name 用于固定目录名（工作区标签页显示目录名） */
export async function makeWorkspace(files: Record<string, string> = {}, name?: string): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tuxedo-e2e-ws-'));
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, content, 'utf8');
  }
  if (name) {
    const named = path.join(path.dirname(dir), name);
    await fs.promises.rm(named, { recursive: true, force: true }).catch(() => undefined);
    await fs.promises.rename(dir, named);
    return named;
  }
  return dir;
}
