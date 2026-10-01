/**
 * ElectronSpinDesign - Spin 设计器的 Electron 实现（BrowserWindow）
 *
 * 从原 ElectronUI 的 Spin 设计窗口部分整体迁入（阶段 3.4）。
 * 构造注入 UIHost（主题 / 语言 / 工作区 / 保存 / 日志都走它）；
 * 注入 acquireVsCodeApi shim 使 spinDesignHtml 原样复用。
 */

import type { BrowserWindow } from 'electron';
import { BrowserWindow as BrowserWindowCtor } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import type { UIHost } from '../src/host/UIHost.js';
import type { SpinDesign } from '../src/host/SpinDesign.js';
import { tt, getSystemLocale } from '../src/host/i18n.js';

/** 项目根目录（dist-electron 的上一级，与 main.ts 的 APP_ROOT 一致） */
const APP_ROOT = path.resolve(__dirname, '..');

export class ElectronSpinDesign implements SpinDesign {
  /** 当前打开的 Spin 设计窗口（用于 SpinLoop 完成后刷新其数据） */
  private spinDesignWindow: BrowserWindowCtor | undefined;
  /** 设计器当前绑定的工作目录（spin.json / 技能归属它）；未绑定时回退活动目录 */
  private workspacePath: string | undefined;

  constructor(private readonly host: UIHost) {}

  /** 打开 Spin 设计窗口（注入 acquireVsCodeApi shim 使 spinDesignHtml 可复用） */
  async open(workspacePath?: string): Promise<void> {
    const target = workspacePath || this.host.getWorkspacePath();
    // 已打开则聚焦复用，不重复创建（与 VSCodeSpinDesign / SpinDesign.open() 契约一致）
    const opened = this.spinDesignWindow;
    if (opened && !opened.isDestroyed()) {
      // 目录变了（从别的标签页发起 /spin）：切到新目录的 spin.json + 技能，
      // 否则窗口里显示的还是上一个目录的内容，保存也会写到上一个目录
      if (target && target !== this.workspacePath) {
        this.workspacePath = target;
        await this.refresh();
      }
      if (opened.isMinimized()) {
        opened.restore();
      }
      opened.focus();
      return;
    }
    this.workspacePath = target;

    // 读取已存在的 spin.json（按设计器绑定的目录）
    let existingData: any = null;
    const projectDir = this.getProjectConversationDir(this.workspacePath);
    if (projectDir) {
      const spinJsonPath = path.join(projectDir, 'spin.json');
      try {
        if (fs.existsSync(spinJsonPath)) {
          existingData = JSON.parse(fs.readFileSync(spinJsonPath, 'utf-8'));
        }
      } catch {
        // 忽略
      }
    }

    const { getSpinDesignHtml } = await import('../src/host/ui/spinDesignHtml.js');
    const { getAllSkills } = await import('../src/core/skills/loadSkillsDir.js');
    const { getSettingsStore } = await import('../src/host/SettingsStore.js');
    // 与 VSCodeSpinDesign 一致：主题 / 语言走 UIHost（不直连 electron API）；
    // 无工作区时不做技能扫描（路径为空，扫相对路径会落到宿主进程目录）
    const availableSkills = (this.workspacePath ? await getAllSkills(this.workspacePath) : [])
      .filter(s => !s.isHidden && s.userInvocable)
      .map(s => ({ name: s.name, description: s.description }));
    const html = getSpinDesignHtml(
      existingData,
      this.host.isDarkTheme(),
      this.host.getLocale(),
      getSystemLocale(),
      getSettingsStore().readUiLanguage(),
      availableSkills,
    );

    const win = new BrowserWindowCtor({
      width: 1100,
      height: 720,
      title: tt('Spin 设计', 'Spin Design'),
      icon: path.join(APP_ROOT, 'assets', 'logo.png'),
      autoHideMenuBar: true,
      // 与 getSpinDesignHtml 的页面底色一致（isDark ? '#1a1a1f' : '#f5f5f7'），
      // 主题仍以 host.isDarkTheme() 为唯一判定源（见 UIHost 契约）
      backgroundColor: this.host.isDarkTheme() ? '#1a1a1f' : '#f5f5f7',
      webPreferences: {
        sandbox: false,
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'spinPreload.cjs'),
      },
    });
    this.spinDesignWindow = win;
    win.on('closed', () => {
      if (this.spinDesignWindow === win) {
        this.spinDesignWindow = undefined;
      }
    });

    // 保存 spin.json
    const saveSpin = (data: any): void => {
      // 按设计器**绑定**的目录保存，不回查活动目录：否则从别的标签页打开过设计器后，
      // 保存会把当前目录的内容写进另一个目录的 spin.json
      const workspacePath = this.workspacePath || this.host.getWorkspacePath();
      const projectDir = this.getProjectConversationDir(workspacePath);
      if (!workspacePath || !projectDir) {
        win.webContents.send('spin-design-message', { type: 'spinSaveResult', success: false, error: tt('没有打开的工作目录', 'No workspace folder is open') });
        return;
      }
      const fullData = { ...data, meta: data.meta || {} };
      if (!fs.existsSync(projectDir)) {
        fs.mkdirSync(projectDir, { recursive: true });
      }
      // 串行写入 spin.json，避免与 SpinLoop 的 updateNodeMeta 并发
      // "读-改-写"导致清除结果被回写（保存不生效）
      import('../src/core/spin/Engine.js').then(({ writeSpinJsonQueued }) =>
        writeSpinJsonQueued(workspacePath, fullData)
      ).then(() => {
        win.webContents.send('spin-design-message', { type: 'spinSaveResult', success: true });
      }).catch((err) => {
        win.webContents.send('spin-design-message', { type: 'spinSaveResult', success: false, error: String(err) });
      });
    };

    // 监听 spin 窗口发来的保存消息
    const { ipcMain } = await import('electron');
    const listener = (_e: any, msg: any) => {
      if (msg?.type === 'saveSpinDesign' && msg.data) {
        saveSpin(msg.data);
      } else if (msg?.type === 'exportSpinDesign' && msg.data) {
        import('../src/host/spinDesignExport.js').then(({ exportSpinDesignJson }) =>
          exportSpinDesignJson(this.host, msg.data, tt('导出 Spin 设计', 'Export Spin Design'))
        ).then((result) => {
          if (!win.isDestroyed()) {
            win.webContents.send('spin-design-message', { type: 'spinExportResult', ...result });
          }
        }).catch((err) => {
          this.host.log(`[ElectronSpinDesign] spin.json export failed: ${err}`);
          if (!win.isDestroyed()) {
            win.webContents.send('spin-design-message', { type: 'spinExportResult', success: false, error: String(err) });
          }
        });
      }
    };
    ipcMain.on('spin-design-message', listener);
    win.on('closed', () => {
      ipcMain.removeListener('spin-design-message', listener);
    });

    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  }

  /**
   * SpinLoop 执行完成后刷新已打开的 Spin 设计窗口，
   * 避免窗口内旧缓存数据在用户再次保存时覆盖执行结果。
   */
  async refresh(): Promise<void> {
    const win = this.spinDesignWindow;
    if (!win || win.isDestroyed()) {
      return;
    }
    // 刷新设计器**绑定**的目录，不回查活动目录（SpinLoop 完成的刷新同理）
    const workspacePath = this.workspacePath || this.host.getWorkspacePath();
    const projectDir = this.getProjectConversationDir(workspacePath);
    if (!projectDir || !workspacePath) {
      return;
    }

    const spinJsonPath = path.join(projectDir, 'spin.json');
    let data: any = null;
    try {
      if (fs.existsSync(spinJsonPath)) {
        data = JSON.parse(fs.readFileSync(spinJsonPath, 'utf-8'));
      }
    } catch (err) {
      this.host.log(`[ElectronSpinDesign] Failed to read spin.json for refresh: ${err}`);
      return;
    }

    const { getAllSkills } = await import('../src/core/skills/loadSkillsDir.js');
    const availableSkills = (await getAllSkills(workspacePath))
      .filter(s => !s.isHidden && s.userInvocable)
      .map(s => ({ name: s.name, description: s.description }));

    win.webContents.send('spin-design-message', {
      type: 'spinDesignData',
      data,
      skills: availableSkills,
    });
  }

  private getProjectConversationDir(workspacePath?: string): string | undefined {
    if (!workspacePath) return undefined;
    try {
      const { getProjectConversationDir } = require('../src/core/history/Config.js');
      return getProjectConversationDir(workspacePath);
    } catch {
      return undefined;
    }
  }
}
