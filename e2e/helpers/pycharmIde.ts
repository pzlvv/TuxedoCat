import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import AdmZip from 'adm-zip';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { CONFIG_DIR_NAME, EXTENSION_NAME } from '../../src/config/project';

/**
 * PyCharm 插件 e2e 的 IDE 启动器（specs/035 FR-009）。
 *
 * 沙箱化启动（沙箱化启动的实测结论见 docs/hosts/pycharm-plugin.md 第 5 节，缺一不可）：
 * - `PYCHARM_VM_OPTIONS` 指向生成的 .vmoptions：`idea.config/system/plugins/log.path`
 *   四路径重定向 + `-Didea.trust.all.projects=true`（信任对话框）+
 *   `-Djb.consents.confirmation.enabled=false`（数据共享对话框）；
 * - CDP 调试端口（Registry 键 `ide.browser.jcef.debug.port`）经沙箱 config 的
 *   `options/ide.general.xml` 持久化覆盖——`-D` 不进 Registry，实测无效；
 * - 插件 zip 解压进沙箱 plugins 目录；项目打开后面板自动 show（StartupActivity），
 *   JCEF 浏览器创建后 CDP 才监听。
 *
 * 环境登记：`e2e/environments.json` 的 `pycharm` 段（requirePycharmEnvironment 校验，
 * 缺失/非法收集期报错不 skip——本地车道口径同 electron-ssh）。
 */

/** 沙箱句柄与 CDP 连接（close() 杀进程树并清理沙箱目录） */
export interface PycharmIdeHandle {
  browser: Browser;
  context: BrowserContext;
  /** 面板页（内嵌 HttpServer 的 http://127.0.0.1:<port>/index.html） */
  panelPage: Page;
  /** 面板页 console / pageerror 收集（诊断转储用） */
  consoleMessages: string[];
  /** 页面 HTML + console 落盘到指定目录（用例失败路径调用） */
  debugDump: (dir: string) => Promise<void>;
  /** 沙箱根目录（idea.log / 工作区都在它下面） */
  sandboxDir: string;
  /** 会话工作目录（= 启动参数传入的 project 目录） */
  workspaceDir: string;
  /** idea.log 路径（IDE 侧行为断言面：diff/openFile 诊断行） */
  ideaLogPath: string;
  close: () => Promise<void>;
}

export interface LaunchOptions {
  /** settings.json 的 defaultAgentMode（manual=权限确认 / auto=自动放行） */
  agentMode: 'manual' | 'risk' | 'auto';
  /**
   * mock LLM baseURL（http://127.0.0.1:<port>/v1）。也可传工厂：在沙箱工作区路径确定后、
   * settings.json 写盘前调用——mock 的 Write 路由要按工作区拼文件路径，端口必须在
   * settings 落盘前定下来（先起 mock 再写配置，避免指向已重启换端口的死服务）。
   */
  mockLlmBaseURL: string | ((workspaceDir: string) => Promise<string>);
  /** 复用已存在的沙箱（同一用例内二次拉起；缺省每次新建） */
  reuseSandboxDir?: string;
  keepSandboxOnClose?: boolean;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('no port')));
      }
    });
    server.on('error', reject);
  });
}

function httpGetOk(port: number, pathname: string, timeoutMs = 2000): Promise<string | null> {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: pathname, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(res.statusCode === 200 ? body : null));
    });
    request.on('error', () => resolve(null));
    request.on('timeout', () => { request.destroy(); resolve(null); });
  });
}

function killProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => resolve());
    } else {
      execFile('kill', ['-9', String(pid)], () => resolve());
    }
  });
}

/** 找到 IDE 主进程 pid（按命令行里的沙箱路径过滤，避免误伤用户自己的 IDE） */
function findIdePids(sandboxDir: string, ideName: string): Promise<number[]> {
  const command = process.platform === 'win32'
    ? `Get-CimInstance Win32_Process -Filter "Name='${ideName}'" | Where-Object { $_.CommandLine -like '*${sandboxDir.replace(/'/g, "''")}*' } | Select-Object -ExpandProperty ProcessId`
    : `ps -eo pid,command | grep -F '${sandboxDir}' | grep -F '${ideName}' | grep -v grep | awk '{print $1}'`;
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'powershell' : 'sh', process.platform === 'win32' ? ['-NoProfile', '-Command', command] : ['-c', command], (err, stdout) => {
      const pids = String(stdout).split(/\s+/).map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n) && n > 0);
      resolve(pids);
    });
  });
}

/** 解压分发包到沙箱 plugins 目录（安装插件） */
function installPlugin(zipPath: string, pluginsDir: string): void {
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(pluginsDir, true);
}

/** 拉起本机 PyCharm（沙箱化 + 插件已装 + CDP 打开）并连上面板页 */
export async function launchPycharmIde(
  idePath: string,
  distributionZipPath: string,
  options: LaunchOptions,
  timeoutMs = 240_000,
): Promise<PycharmIdeHandle> {
  const sandboxDir = options.reuseSandboxDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'tuxedo-e2e-pycharm-'));
  const configDir = path.join(sandboxDir, 'config');
  const systemDir = path.join(sandboxDir, 'system');
  const pluginsDir = path.join(sandboxDir, 'plugins');
  const logDir = path.join(sandboxDir, 'log');
  const homeDir = path.join(sandboxDir, 'home');
  const workspaceDir = path.join(sandboxDir, 'project');
  for (const dir of [configDir, systemDir, pluginsDir, logDir, homeDir, workspaceDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 插件安装 + 工作区标识文件（让面板会话工作目录有内容可写）
  installPlugin(distributionZipPath, pluginsDir);
  fs.writeFileSync(path.join(workspaceDir, 'README.md'), '# tuxedo e2e workspace\n');

  // 面板配置（LLM 指向 mock 服务器；与 electron 车道的 writeSettings 同口径）
  const mockLlmBaseURL = typeof options.mockLlmBaseURL === 'function'
    ? await options.mockLlmBaseURL(workspaceDir)
    : options.mockLlmBaseURL;
  const configHome = path.join(homeDir, CONFIG_DIR_NAME);
  fs.mkdirSync(configHome, { recursive: true });
  fs.writeFileSync(path.join(configHome, 'settings.json'), JSON.stringify({
    llm: {
      activeProvider: 'mock',
      providers: {
        mock: {
          baseURL: mockLlmBaseURL,
          apiKey: 'sk-e2e-test',
          models: ['mock-model'],
          defaultModel: 'mock-model',
          modelConfigs: { 'mock-model': { apiType: 'OpenAI', context: 128000, output: 4096 } },
        },
      },
      thinking_effort: 'off',
      webSearch: false,
      enableUsageStats: false,
    },
    defaultAgentMode: options.agentMode,
    defaultPromptMode: 'normal',
    uiLanguage: 'zh',
  }, null, 2));

  // 沙箱 vmoptions + CDP 端口（Registry 持久化覆盖）
  const cdpPort = await findFreePort();
  const vmoptions = [
    `-Didea.config.path=${configDir.replace(/\\/g, '/')}`,
    `-Didea.system.path=${systemDir.replace(/\\/g, '/')}`,
    `-Didea.plugins.path=${pluginsDir.replace(/\\/g, '/')}`,
    `-Didea.log.path=${logDir.replace(/\\/g, '/')}`,
    `-Didea.trust.all.projects=true`,
    `-Djb.consents.confirmation.enabled=false`,
  ].join('\r\n');
  const vmoptionsPath = path.join(sandboxDir, 'e2e.vmoptions');
  fs.writeFileSync(vmoptionsPath, vmoptions, 'utf8');
  const optionsDir = path.join(configDir, 'options');
  fs.mkdirSync(optionsDir, { recursive: true });
  fs.writeFileSync(path.join(optionsDir, 'ide.general.xml'), [
    '<application>',
    '  <component name="Registry">',
    `    <entry key="ide.browser.jcef.debug.port" value="${cdpPort}" />`,
    '  </component>',
    '</application>',
  ].join('\n'));

  // 拉起 IDE（env 全量注入：vmoptions + 沙箱 home，面板读 <home>/<configDir>/settings.json）
  const ideName = path.basename(idePath);
  const child = new Promise<number>((resolve, reject) => {
    const { spawn } = require('node:child_process') as typeof import('node:child_process');
    const proc = spawn(idePath, [workspaceDir], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        PYCHARM_VM_OPTIONS: vmoptionsPath,
        USERPROFILE: homeDir,
        HOME: homeDir,
      },
      windowsHide: true,
    });
    proc.on('error', reject);
    // launcher 进程会立即退出，真正的 IDE 进程按命令行过滤
    setTimeout(() => resolve(proc.pid ?? 0), 3000);
  });

  // 轮询 CDP（首次启动含索引，预算放宽到 timeoutMs）
  const deadline = Date.now() + timeoutMs;
  let cdpUp = false;
  while (Date.now() < deadline) {
    if (await httpGetOk(cdpPort, '/json/version')) { cdpUp = true; break; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!cdpUp) {
    const logPath = path.join(logDir, 'idea.log');
    const tail = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').slice(-2000) : '(no idea.log)';
    await closeSandbox(sandboxDir, ideName, options.keepSandboxOnClose === true);
    throw new Error(`PyCharm CDP（127.0.0.1:${cdpPort}）超时未就绪；idea.log 尾部：\n${tail}`);
  }

  const ideNameForCleanup = ideName;
  const failFast = async (error: Error): Promise<never> => {
    const pids = await findIdePids(sandboxDir, ideNameForCleanup);
    for (const pid of pids) await killProcessTree(pid);
    await fs.promises.rm(sandboxDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  };
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 60_000 });
  } catch (error) {
    return failFast(error as Error);
  }
  const context = browser.contexts()[0];
  if (!context) throw new Error('CDP 已连接但没有 context');

  // 面板页：内嵌 HttpServer 伺服的 http://127.0.0.1:<port>/index.html（端口随面板随机，
  // 以 URL 结尾匹配；PyCharm 自身的 JCEF 页面不会叫 index.html）
  const logTail = (): string => {
    const logPath = path.join(logDir, 'idea.log');
    return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').slice(-1500) : '(no idea.log)';
  };
  const findPanel = async (): Promise<Page> => {
    const deadlineInner = Date.now() + 60_000;
    while (Date.now() < deadlineInner) {
      for (const page of context.pages()) {
        if (page.url().endsWith('/index.html')) return page;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    // 失败取证：targets + idea.log 尾部；沙箱保留（keepSandboxOnClose）供人工排查
    options.keepSandboxOnClose = true;
    let rawTargets = '';
    await httpGetOk(cdpPort, '/json/list')?.then((body) => { rawTargets = body ?? ''; });
    return failFast(new Error(
      `未找到面板页（*/index.html）。targets=${context.pages().map((p) => p.url()).join(', ') || '(空)'}
`
      + `raw=/json/list: ${rawTargets || '(空)'}
idea.log 尾部：
${logTail()}`,
    ));
  };
  let panelPage: Page;
  try {
    panelPage = await findPanel();
  } catch (error) {
    await browser.close().catch(() => undefined);
    return failFast(error as Error);
  }
  const consoleMessages: string[] = [];
  // 提前挂监听（module 脚本的早期报错发生在 findPanel 命中之后也可能错过）
  context.on('page', (page) => {
    page.on('console', (msg) => consoleMessages.push(`[${msg.type()}] ${msg.text().slice(0, 500)}`));
    page.on('pageerror', (err) => consoleMessages.push(`[pageerror] ${err.message.slice(0, 500)}`));
    page.on('requestfailed', (req) => consoleMessages.push(`[requestfailed] ${req.url()} ${req.failure()?.errorText}`));
  });
  const debugDump = async (dir: string): Promise<void> => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'panel.html'), await panelPage.content());
    fs.writeFileSync(path.join(dir, 'console.log.txt'), consoleMessages.join('\n'));
    fs.writeFileSync(path.join(dir, 'idea.log.txt'), logTail());
    try {
      const probe = await panelPage.evaluate(() => ({
        rootChildren: document.getElementById('root')?.childElementCount ?? -1,
        hostInfo: JSON.stringify((window as unknown as Record<string, unknown>).__hostInfo ?? null),
        javaQueryType: typeof (window as unknown as Record<string, unknown>).__javaQuery,
        vscodeType: typeof (window as unknown as Record<string, unknown>).vscode,
        bodyText: document.body.innerText.slice(0, 200),
      }));
      fs.writeFileSync(path.join(dir, 'probe.json'), JSON.stringify(probe, null, 2));
    } catch (error) {
      fs.writeFileSync(path.join(dir, 'probe.json'), `evaluate failed: ${String(error)}`);
    }
  };

  const ideaLogPath = path.join(logDir, 'idea.log');
  const close = async (): Promise<void> => {
    await browser.close().catch(() => undefined);
    // 等 CDP / 进程树完全退场再返回：紧跟着的下一个 IDE 实例会复用 Playwright 的
    // 连接池，旧连接未断干净时新实例会偶发 "browser has been closed"（实测竞态）
    await new Promise((r) => setTimeout(r, 1500));
    const pids = await findIdePids(sandboxDir, ideName);
    for (const pid of pids) await killProcessTree(pid);
    if (!options.keepSandboxOnClose) {
      await fs.promises.rm(sandboxDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  return { browser, context, panelPage, consoleMessages, debugDump, sandboxDir, workspaceDir, ideaLogPath, close };
}

async function closeSandbox(sandboxDir: string, ideName: string, keep: boolean): Promise<void> {
  const pids = await findIdePids(sandboxDir, ideName);
  for (const pid of pids) await killProcessTree(pid);
  if (!keep) await fs.promises.rm(sandboxDir, { recursive: true, force: true }).catch(() => undefined);
}

/** idea.log 里等待某条诊断行出现（IDE 侧行为断言面） */
export async function waitForIdeaLogLine(
  ideaLogPath: string,
  pattern: RegExp,
  timeoutMs = 60_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let content = '';
  while (Date.now() < deadline) {
    content = fs.existsSync(ideaLogPath) ? fs.readFileSync(ideaLogPath, 'utf8') : '';
    const match = content.split('\n').find((line) => pattern.test(line));
    if (match) return match;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`idea.log 未出现 ${pattern}（最后 500 字符：${content.slice(-500)}）`);
}
