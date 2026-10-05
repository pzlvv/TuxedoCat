/**
 * TuiUIHost - UIHost 契约的终端实现（docs/tui.md 第 5 节映射表）。
 *
 * 宿主实现层：允许使用 Node API（child_process / fs），不 import vscode / electron。
 * 三个渲染出口都收敛到注入的 dispatch（store 是唯一渲染事实，DEVELOPMENT.md 第 12 章
 * 规则 4）：sendToWebview 系列投递 wire 消息，预览 / 通知经 `tui:` 本地动作进同一 store。
 *
 * stdout 纪律（docs/tui.md 第 11.1 节风险 5）：日志一律走注入的 log 出口
 * （stderr / 文件），本模块不写 stdout——stdout 是 Ink 的渲染面。
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { diffLines } from 'diff';
import type {
  LineSelection,
  SaveFileOptions,
  SaveFileResult,
  ShowDiffOptions,
  UIHost,
  WebviewViewHandle,
  WorkspaceChange,
} from '../host/UIHost.js';
import type { HostToWebviewMessage } from '../host/webviewMessages.js';
import type { WorkspaceRef } from '../host/workspaceRef.js';
import { localWorkspaceRef } from '../host/workspaceRef.js';
import { tt, getHostLocale } from '../host/i18n.js';
import { writeSettingsJson } from '../host/settingsFile.js';
import type { TuiAction, TuiOverlay } from './store.js';

export interface TuiUIHostOptions {
  /** 唯一本地工作区（启动工作目录；docs/tui.md 第 1 节「单工作区」） */
  workspacePath: string;
  /** 日志出口（stderr / 文件；绝不能写 stdout） */
  log: (...args: unknown[]) => void;
  /** 渲染动作出口（store.dispatch） */
  dispatch: (action: TuiAction) => void;
}

export class TuiUIHost implements UIHost {
  private readonly options: TuiUIHostOptions;
  private readonly workspaceRefValue: WorkspaceRef;

  constructor(options: TuiUIHostOptions) {
    this.options = options;
    this.workspaceRefValue = localWorkspaceRef(options.workspacePath);
  }

  // ===================== 传输（5.1） =====================

  sendToWebview(message: HostToWebviewMessage): void {
    this.options.dispatch(message);
  }

  /** 单视图：广播与定向都退化为 sendToWebview（句柄不参与路由） */
  broadcastToWebviews(message: HostToWebviewMessage): void {
    this.sendToWebview(message);
  }

  /** 单视图：句柄是名义类型，透传不解读 */
  sendToWebviewView(_view: WebviewViewHandle, message: HostToWebviewMessage): void {
    this.sendToWebview(message);
  }

  /** 终端配色在渲染期读主题常量；isDarkTheme 恒 true 是唯一判定源 */
  onThemeChanged(_view: WebviewViewHandle | null): void {
    /* 设计允许的 no-op：TUI 不消费主题事件（docs/tui.md 第 5.1 节） */
  }

  // ===================== 环境（5.2） =====================

  log(...args: unknown[]): void {
    this.options.log(...args);
  }

  isDarkTheme(): boolean {
    return true;
  }

  getLocale(): string {
    // primeHostLocale（bootstrapCore 启动期调用）收敛后的宿主语言
    return getHostLocale();
  }

  // ===================== 面板 / 窗口（5.3） =====================

  /** 系统默认程序打开（start / open / xdg-open 按平台）；失败经 notice 提示 */
  async openFile(filePath: string, _target: LineSelection | null): Promise<void> {
    await openWithSystemApp(
      filePath,
      (line) => this.options.log(line),
      (text) => this.options.dispatch({ type: 'tui:notice', text, level: 'error' }),
    );
  }

  /** 全屏只读覆盖层（q / Esc 关闭） */
  async showVirtualDocument(content: string, title: string): Promise<void> {
    this.showOverlay({
      kind: 'document',
      title,
      lines: content.split('\n').map((text) => ({ text, color: 'white' as const })),
    });
  }

  /**
   * 终端 diff 覆盖层：before / after 渲染为带色统一 diff（新增绿 / 删除红 / 等值灰），
   * 在权限确认覆盖层弹出之前展示（语义与 VS Code 的 diff 标签一致）。
   */
  async showDiff(options: ShowDiffOptions): Promise<void> {
    const parts = diffLines(options.beforeContent, options.afterContent);
    const lines: TuiOverlay['lines'][number][] = [];
    for (const part of parts) {
      const color = part.added ? 'green' : part.removed ? 'red' : 'gray';
      const sign = part.added ? '+' : part.removed ? '-' : ' ';
      for (const line of part.value.replace(/\n$/, '').split('\n')) {
        lines.push({ text: `${sign} ${line}`, color });
      }
    }
    // 等值上下文只保留变更附近（各 3 行），长 diff 不淹没终端
    this.showOverlay({ kind: 'diff', title: options.title, lines: trimUnchanged(lines, 3) });
  }

  /** Mermaid 预览终端不支持：显式提示（设计允许的能力差异，不静默降级） */
  async openMermaidPreview(_code: string): Promise<void> {
    this.options.dispatch({
      type: 'tui:notice',
      text: tt('当前环境不支持 Mermaid 预览', 'Mermaid preview is not supported in the terminal'),
      level: 'warn',
    });
  }

  /** 关闭当前覆盖层（diff / 虚拟文档） */
  closePreview(): void {
    this.options.dispatch({ type: 'tui:closeOverlay' });
  }

  private showOverlay(overlay: TuiOverlay): void {
    this.options.dispatch({ type: 'tui:showOverlay', overlay });
  }

  /** 系统默认浏览器打开 */
  async openExternalUrl(url: string): Promise<void> {
    await openWithSystemApp(
      url,
      (line) => this.options.log(line),
      (text) => this.options.dispatch({ type: 'tui:notice', text, level: 'error' }),
    );
  }

  /**
   * 无对话框：写入工作目录下 defaultFileName，重名追加序号；
   * 成功后以 notice 告知落盘路径。
   */
  async saveTextFile(content: string, options: SaveFileOptions): Promise<SaveFileResult> {
    try {
      const target = numberedTarget(this.options.workspacePath, options.defaultFileName);
      await fs.promises.writeFile(target, content, 'utf8');
      this.options.dispatch({
        type: 'tui:notice',
        text: tt(`已保存：${target}`, `Saved: ${target}`),
        level: 'info',
      });
      return { success: true, filePath: target };
    } catch (err) {
      return { success: false, canceled: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ===================== 会话 / 列表 / 状态（5.4） =====================

  /** 正在查看该会话则切出（回到「选择 / 新建会话」空态）；磁盘与运行时内存不动 */
  async closeConversationView(sessionId: string): Promise<void> {
    // 宿主不持有「当前会话」事实（store 才是渲染事实）：经本地动作请求切出，
    // reducer 只在 activeSessionId 匹配时生效（docs/tui.md 第 5.4 节语义）
    this.options.dispatch({ type: 'tui:closeConversationView', sessionId });
  }

  // ===================== 工作区（WorkspaceProvider） =====================

  getWorkspacePath(): string | undefined {
    return this.options.workspacePath;
  }

  getWorkspaceRef(): WorkspaceRef | undefined {
    return this.workspaceRefValue;
  }

  getOpenWorkspaceRefs(): readonly WorkspaceRef[] {
    return [this.workspaceRefValue];
  }

  /** TUI 不产生工作区变化；bootstrapCore 装配时同步读 getOpenWorkspaceRefs，无需补发 */
  onWorkspaceChanged(_listener: (change: WorkspaceChange) => void): () => void {
    return () => {
      /* 设计允许的 no-op：单工作区宿主没有工作区变化（docs/tui.md 第 5.4 节） */
    };
  }

  // ===================== 配置文件 =====================

  /** 复用宿主层共用实现（串行队列 + 写后清 core 读缓存）；终端不改写路径 */
  async updateSettingsJson(mutator: (cfg: Record<string, unknown>) => void | Record<string, unknown>): Promise<void> {
    await writeSettingsJson(mutator as (cfg: Record<string, any>) => void | Record<string, any>);
  }
}

// ── 工具函数 ──

/** 统一的系统打开器（文件 / URL 同一出口；spawn 失败回错误文案） */
async function openWithSystemApp(
  target: string,
  log: (line: string) => void,
  notifyError: (text: string) => void,
): Promise<void> {
  const commands: Record<string, { file: string; argsBefore: string[] }> = {
    win32: { file: 'cmd', argsBefore: ['/c', 'start', ''] },
    darwin: { file: 'open', argsBefore: [] },
  };
  const command = commands[process.platform] ?? { file: 'xdg-open', argsBefore: [] };
  await new Promise<void>((resolve) => {
    const child = spawn(command.file, [...command.argsBefore, target], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', (err) => {
      const text = tt(`打开失败：${err.message}`, `Failed to open: ${err.message}`);
      log(text);
      notifyError(text);
      resolve();
    });
    child.on('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/** 重名追加序号的目标路径：name.ext → name (1).ext、name (2).ext … */
export function numberedTarget(dir: string, defaultFileName: string): string {
  const base = path.join(dir, defaultFileName);
  if (!fs.existsSync(base)) return base;
  const ext = path.extname(defaultFileName);
  const stem = path.basename(defaultFileName, ext);
  for (let i = 1; ; i++) {
    const candidate = path.join(dir, `${stem} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

/** diff 里等值上下文行折叠：每个变更块前后只保留 context 行 */
export function trimUnchanged(
  lines: ReadonlyArray<{ text: string; color: 'green' | 'red' | 'cyan' | 'yellow' | 'gray' | 'white' }>,
  context: number,
): Array<{ text: string; color: 'green' | 'red' | 'cyan' | 'yellow' | 'gray' | 'white' }> {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, i) => {
    if (line.color !== 'gray') {
      for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) {
        keep[j] = true;
      }
    }
  });
  const out: typeof lines[number][] = [];
  let skipped = 0;
  lines.forEach((line, i) => {
    if (keep[i]) {
      out.push(line);
      skipped = 0;
    } else {
      skipped++;
      if (skipped === 1 && i < lines.length - 1) {
        out.push({ text: `  ⋯ (${tt('省略等值上下文', 'unchanged context omitted')})`, color: 'gray' });
      }
    }
  });
  return out;
}
