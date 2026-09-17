/**
 * VSCodeSpinDesign - Spin 设计器的 VS Code 实现（WebviewPanel）
 *
 * 从原 VSCodeUI 的 Spin 设计面板部分整体迁入（阶段 3.4）。
 * 构造注入 UIHost：只用 getWorkspacePath / isDarkTheme / getLocale / saveTextFile / log
 * 五个成员，不反向要求 UIHost 知道 Spin 的存在。
 */

import * as vscode from 'vscode';
import type { UIHost } from './host/UIHost.js';
import type { SpinDesign } from './host/SpinDesign.js';
import { tt, getSystemLocale } from './core/i18n.js';
import { readUiLanguageSync } from './core/history/Config.js';
import { SPIN_DESIGN_PANEL_ID } from './config/project.js';

export class VSCodeSpinDesign implements SpinDesign {
  constructor(private readonly host: UIHost) {}

  /** 创建或复用 Spin 设计面板（已打开则 reveal 复用） */
  async open(): Promise<void> {
    const panelId = SPIN_DESIGN_PANEL_ID;
    const existingPanel = this.findSpinDesignPanel();

    let panel: vscode.WebviewPanel;
    if (existingPanel) {
      panel = existingPanel;
      panel.reveal();
      return;
    }

    // 读取已存在的 spin.json（从 ~/<CONFIG_DIR_NAME>/conversations/<encoded-workspace>/）
    const { existingData, spinJsonExists, spinJsonPath, workspacePath, hasWorkspace } =
      await this.readSpinDesignData();

    // 文件存在但连续重试仍无法解析时，不能打开空编辑器，
    // 否则后续保存可能用空数据覆盖真实 spin.json。
    if (spinJsonExists && !existingData) {
      vscode.window.showErrorMessage(`Failed to read spin.json: ${spinJsonPath}`);
      return;
    }

    panel = vscode.window.createWebviewPanel(
      panelId,
      tt('Spin 设计', 'Spin Design'),
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        // 面板切到后台/被遮挡时保持 webview 内容与状态，避免重新加载丢失未保存编辑
        retainContextWhenHidden: true,
      }
    );

    const { getSpinDesignHtml } = await import('./host/ui/spinDesignHtml.js');
    const { getAllSkills } = await import('./core/skills/loadSkillsDir.js');
    const isDark = this.host.isDarkTheme();
    // 无工作区时不做技能扫描（workspacePath 为空，扫相对路径会落到宿主进程目录）
    const availableSkills = (hasWorkspace ? await getAllSkills(workspacePath) : [])
      .filter(s => !s.isHidden && s.userInvocable)
      .map(s => ({ name: s.name, description: s.description }));
    panel.webview.html = getSpinDesignHtml(
      existingData,
      isDark,
      this.host.getLocale(),
      getSystemLocale(),
      readUiLanguageSync(),
      availableSkills,
    );

    // 监听来自 spin design webview 的消息
    panel.webview.onDidReceiveMessage(async (msg: any) => {
      if (msg.type === 'saveSpinDesign' && msg.data) {
        await this.handleSave(msg.data, workspacePath, hasWorkspace, panel);
      } else if (msg.type === 'exportSpinDesign' && msg.data) {
        await this.handleExport(msg.data, panel);
      } else if (msg.type === 'refreshSpinDesign') {
        await this.sendSpinDesignDataToPanel(panel);
      }
    });
  }

  /**
   * 从磁盘重读 spin.json + Skill 列表推给已打开的设计器；未打开时 no-op。
   */
  async refresh(): Promise<void> {
    const panel = this.findSpinDesignPanel();
    if (!panel) {
      return;
    }
    await this.sendSpinDesignDataToPanel(panel);
  }

  private async handleSave(data: any, workspacePath: string, hasWorkspace: boolean, panel: vscode.WebviewPanel): Promise<void> {
    if (!hasWorkspace) {
      panel?.webview.postMessage({ type: 'spinSaveResult', success: false, error: tt('没有打开的工作目录', 'No workspace folder is open') });
      return;
    }
    const { getProjectConversationDir } = await import('./core/history/Config.js');
    const projectDir = getProjectConversationDir(workspacePath);
    const saveData = { ...data, meta: data.meta || {} };
    // 确保目录存在
    const fs = require('fs') as typeof import('fs');
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }
    try {
      // 串行写入 spin.json，避免与 SpinLoop 的 updateNodeMeta 并发
      // "读-改-写"导致清除结果被回写（保存不生效）
      const { writeSpinJsonQueued } = await import('./core/spin/Engine.js');
      await writeSpinJsonQueued(workspacePath, saveData);
      panel?.webview.postMessage({ type: 'spinSaveResult', success: true });
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

  /** 读取 Spin 设计数据（spin.json + 工作区路径），带重试保护 */
  private async readSpinDesignData(): Promise<{
    existingData: any;
    spinJsonExists: boolean;
    spinJsonPath: string | null;
    workspacePath: string;
    hasWorkspace: boolean;
  }> {
    const workspacePath = this.host.getWorkspacePath();
    const hasWorkspace = !!workspacePath;

    if (!hasWorkspace || !workspacePath) {
      return {
        existingData: null,
        spinJsonExists: false,
        spinJsonPath: null,
        workspacePath: '',
        hasWorkspace: false,
      };
    }

    const { getProjectConversationDir } = await import('./core/history/Config.js');
    const path = require('path') as typeof import('path');
    const projectDir = getProjectConversationDir(workspacePath);
    const spinJsonPath = path.join(projectDir, 'spin.json');
    const fs = require('fs') as typeof import('fs');
    let existingData: any = null;
    let spinJsonExists = false;

    // 使用重试读取：即使写入方已改为原子写，仍可能在极端情况下遇到文件占用/瞬时不可读，
    // 避免因一次读取失败就回退到空画布，导致节点内容看起来被清空。
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (fs.existsSync(spinJsonPath)) {
          spinJsonExists = true;
          const content = fs.readFileSync(spinJsonPath, 'utf-8');
          existingData = JSON.parse(content);
        }
        break;
      } catch {
        existingData = null;
        if (attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
        }
      }
    }

    return { existingData, spinJsonExists, spinJsonPath, workspacePath, hasWorkspace };
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
   * 读取磁盘上最新的 spin.json 与 Skill 列表，并推送给 Spin 设计器面板。
   * 供设计器"刷新"按钮和 SpinLoop 执行完成后自动刷新共用。
   */
  private async sendSpinDesignDataToPanel(panel: vscode.WebviewPanel): Promise<void> {
    const refreshed = await this.readSpinDesignData();
    if (refreshed.spinJsonExists && !refreshed.existingData) {
      panel.webview.postMessage({
        type: 'spinSaveResult',
        success: false,
        error: `Failed to read spin.json: ${refreshed.spinJsonPath}`,
      } as any);
      return;
    }
    const { getAllSkills } = await import('./core/skills/loadSkillsDir.js');
    const availableSkills = (await getAllSkills(refreshed.workspacePath))
      .filter(s => !s.isHidden && s.userInvocable)
      .map(s => ({ name: s.name, description: s.description }));
    panel.webview.postMessage({
      type: 'spinDesignData',
      data: refreshed.existingData,
      skills: availableSkills,
    } as any);
  }
}
