/**
 * VSCodeSpinDesign - Spin 设计器的 VS Code 实现（WebviewPanel）
 *
 * 构造注入 UIHost：只用 isDarkTheme / getLocale / saveTextFile / log 四个成员，
 * 不反向要求 UIHost 知道 Spin 的存在。
 *
 * `spin.json` 与技能清单经 Core 的 `UiRequest.spinDesignRequested` 取回：宿主不读
 * 本地磁盘（远程工作区的设计在 Core 所在机器，见 docs/core/standalone-core-boundaries.md 第 2 节）。
 */

import * as vscode from 'vscode';
import type { UIHost } from './host/UIHost.js';
import type { SpinDesign } from './host/SpinDesign.js';
import type { SpinDesignReadResult } from './shared/AssistantEventBus.js';
import { requestSpinDesign, saveSpinDesign } from './host/coreFacts.js';
import { planSpinDesignSessionSwitch } from './host/spinDesignSession.js';
import { tt, getSystemLocale } from './host/i18n.js';
import { getSettingsStore } from './host/SettingsStore.js';
import { SPIN_DESIGN_PANEL_ID } from './config/project.js';

export class VSCodeSpinDesign implements SpinDesign {
  /** 设计器当前绑定的会话；null = 无会话（空态、保存不可用） */
  private sessionId: string | null = null;

  constructor(private readonly host: UIHost) {}

  /** 创建或复用 Spin 设计面板（已打开则 reveal 复用；会话不同则切到新会话的数据） */
  async open(sessionId: string | null): Promise<void> {
    const panelId = SPIN_DESIGN_PANEL_ID;
    const existingPanel = this.findSpinDesignPanel();

    if (existingPanel) {
      const plan = await planSpinDesignSessionSwitch(
        this.sessionId,
        sessionId,
        requestSpinDesign,
      );
      if (plan.kind === 'error') {
        this.postError(existingPanel, plan.message);
      } else if (plan.kind === 'switch') {
        this.sessionId = plan.sessionId;
        this.postData(existingPanel, plan.read);
      }
      existingPanel.reveal();
      return;
    }

    // 新窗口：首次读取失败不创建窗口（避免空画布覆盖真实 spin.json）
    let read: SpinDesignReadResult;
    if (sessionId === null) {
      read = { status: 'ok', data: null, skills: [] };
    } else {
      read = await requestSpinDesign(sessionId);
      if (read.status === 'error') {
        throw new Error(read.message);
      }
    }
    this.sessionId = sessionId;

    const panel = vscode.window.createWebviewPanel(
      panelId,
      tt('Spin 设计', 'Spin Design'),
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        // 面板切到后台/被遮挡时保持 webview 内容与状态，避免重新加载丢失未保存编辑
        retainContextWhenHidden: true,
      },
    );

    const { getSpinDesignHtml } = await import('./host/ui/spinDesignHtml.js');
    panel.webview.html = getSpinDesignHtml(
      read.data,
      this.host.isDarkTheme(),
      this.host.getLocale(),
      getSystemLocale(),
      getSettingsStore().readUiLanguage(),
      read.skills,
      sessionId !== null,
    );

    // 监听来自 spin design webview 的消息
    panel.webview.onDidReceiveMessage(async (msg: any) => {
      if (msg.type === 'saveSpinDesign' && msg.data) {
        await this.handleSave(msg.data, panel);
      } else if (msg.type === 'exportSpinDesign' && msg.data) {
        await this.handleExport(msg.data, panel);
      } else if (msg.type === 'refreshSpinDesign') {
        await this.sendSpinDesignDataToPanel(panel);
      }
    });
  }

  /**
   * 从 Core 重读 spin.json + Skill 列表推给已打开的设计器；未打开时 no-op。
   */
  async refresh(): Promise<void> {
    const panel = this.findSpinDesignPanel();
    if (!panel) {
      return;
    }
    await this.sendSpinDesignDataToPanel(panel);
  }

  private async handleSave(data: any, panel: vscode.WebviewPanel): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) {
      panel?.webview.postMessage({
        type: 'spinSaveResult',
        success: false,
        error: tt('没有打开的工作目录', 'No workspace folder is open'),
      });
      return;
    }
    const saveData = { ...data, meta: data.meta || {} };
    try {
      const result = await saveSpinDesign(sessionId, saveData);
      if (result.status === 'ok') {
        panel?.webview.postMessage({ type: 'spinSaveResult', success: true });
      } else {
        panel?.webview.postMessage({ type: 'spinSaveResult', success: false, error: result.message });
      }
    } catch (err) {
      this.host.log(`[VSCodeSpinDesign] spin.json save failed: ${err}`);
      panel?.webview.postMessage({ type: 'spinSaveResult', success: false, error: String(err) });
    }
  }

  private async handleExport(data: any, panel: vscode.WebviewPanel): Promise<void> {
    try {
      const { exportSpinDesignJson } = await import('./host/spinDesignExport.js');
      const result = await exportSpinDesignJson(
        this.host,
        data,
        tt('导出 Spin 设计', 'Export Spin Design'),
      );
      panel?.webview.postMessage({ type: 'spinExportResult', ...result } as any);
    } catch (err) {
      this.host.log(`[VSCodeSpinDesign] spin.json export failed: ${err}`);
      panel?.webview.postMessage({ type: 'spinExportResult', success: false, error: String(err) } as any);
    }
  }

  /** 查找当前已打开的 Spin 设计面板 */
  private findSpinDesignPanel(): vscode.WebviewPanel | undefined {
    const existingPanel = vscode.window.tabGroups.all
      .flatMap(tg => tg.tabs)
      .find(tab => (tab.input as any)?.viewType === SPIN_DESIGN_PANEL_ID);
    return existingPanel
      ? (existingPanel.input as any).webviewPanel as vscode.WebviewPanel
      : undefined;
  }

  /**
   * 从 Core 重读 spin.json 与 Skill 列表，并推送给 Spin 设计器面板。
   * 供设计器"刷新"按钮和 SpinLoop 执行完成后自动刷新共用；失败时保持画布。
   */
  private async sendSpinDesignDataToPanel(panel: vscode.WebviewPanel): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) {
      return;
    }
    try {
      const read = await requestSpinDesign(sessionId);
      if (read.status === 'error') {
        this.postError(panel, read.message);
        return;
      }
      this.postData(panel, read);
    } catch (err) {
      this.postError(panel, String(err));
    }
  }

  private postData(
    panel: vscode.WebviewPanel,
    read: Extract<SpinDesignReadResult, { status: 'ok' }>,
  ): void {
    panel.webview.postMessage({
      type: 'spinDesignData',
      data: read.data,
      skills: read.skills,
    } as any);
  }

  private postError(panel: vscode.WebviewPanel, message: string): void {
    this.host.log(`[VSCodeSpinDesign] ${message}`);
    panel.webview.postMessage({ type: 'spinDesignError', error: message } as any);
  }
}
