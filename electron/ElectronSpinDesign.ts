/**
 * ElectronSpinDesign - Spin 设计器的 Electron 实现（BrowserWindow）
 *
 * 构造注入 UIHost（主题 / 语言 / 保存 / 日志都走它）；注入 acquireVsCodeApi shim
 * 使 spinDesignHtml 原样复用。
 *
 * `spin.json` 与技能清单经 Core 的 `UiRequest.spinDesignRequested` 取回：宿主不读
 * 本地磁盘（远程工作区的设计在 Core 所在机器，见 docs/core/standalone-core-boundaries.md 第 2 节）。
 */

import type { BrowserWindow } from 'electron';
import { BrowserWindow as BrowserWindowCtor } from 'electron';
import * as path from 'path';
import type { UIHost } from '../src/host/UIHost.js';
import type { SpinDesign } from '../src/host/SpinDesign.js';
import type { SpinDesignReadResult } from '../src/shared/AssistantEventBus.js';
import { requestSpinDesign, saveSpinDesign } from '../src/host/coreFacts.js';
import { planSpinDesignSessionSwitch } from '../src/host/spinDesignSession.js';
import { tt, getSystemLocale } from '../src/host/i18n.js';
import { guardViewNavigation } from './viewNavigation.js';

/** 项目根目录（dist-electron 的上一级，与 main.ts 的 APP_ROOT 一致） */
const APP_ROOT = path.resolve(__dirname, '..');

export class ElectronSpinDesign implements SpinDesign {
  /** 当前打开的 Spin 设计窗口（用于 SpinLoop 完成后刷新其数据） */
  private spinDesignWindow: BrowserWindowCtor | undefined;
  /** 设计器当前绑定的会话；null = 无会话（空态、保存不可用） */
  private sessionId: string | null = null;

  constructor(private readonly host: UIHost) {}

  /** 打开 Spin 设计窗口（注入 acquireVsCodeApi shim 使 spinDesignHtml 可复用） */
  async open(sessionId: string | null): Promise<void> {
    const opened = this.spinDesignWindow;
    if (opened && !opened.isDestroyed()) {
      const plan = await planSpinDesignSessionSwitch(
        this.sessionId,
        sessionId,
        requestSpinDesign,
      );
      if (plan.kind === 'error') {
        this.postError(plan.message);
      } else if (plan.kind === 'switch') {
        this.sessionId = plan.sessionId;
        this.postData(plan.read);
      }
      if (opened.isMinimized()) {
        opened.restore();
      }
      opened.focus();
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

    const { getSpinDesignHtml } = await import('../src/host/ui/spinDesignHtml.js');
    const { getSettingsStore } = await import('../src/host/SettingsStore.js');
    // 与 VSCodeSpinDesign 一致：主题 / 语言走 UIHost（不直连 electron API）
    const html = getSpinDesignHtml(
      read.data,
      this.host.isDarkTheme(),
      this.host.getLocale(),
      getSystemLocale(),
      getSettingsStore().readUiLanguage(),
      read.skills,
      sessionId !== null,
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
    // 页面注入 spinPreload（保存 spin.json / 导出）：同其他应用自有页面一样拒绝窗口内导航
    guardViewNavigation(win.webContents, 'spin-design');
    win.on('closed', () => {
      if (this.spinDesignWindow === win) {
        this.spinDesignWindow = undefined;
      }
    });

    // 保存 spin.json：按设计器**绑定**的会话写回，不回查活动目录
    const saveSpin = (data: any): void => {
      const boundSessionId = this.sessionId;
      if (!boundSessionId) {
        win.webContents.send('spin-design-message', {
          type: 'spinSaveResult',
          success: false,
          error: tt('没有打开的工作区', 'No workspace is open'),
        });
        return;
      }
      const fullData = { ...data, meta: data.meta || {} };
      saveSpinDesign(boundSessionId, fullData).then((result) => {
        if (result.status === 'ok') {
          win.webContents.send('spin-design-message', { type: 'spinSaveResult', success: true });
        } else {
          win.webContents.send('spin-design-message', {
            type: 'spinSaveResult',
            success: false,
            error: result.message,
          });
        }
      }).catch((err) => {
        win.webContents.send('spin-design-message', {
          type: 'spinSaveResult',
          success: false,
          error: String(err),
        });
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
      } else if (msg?.type === 'refreshSpinDesign') {
        // 设计器工具栏"刷新"：从 Core 重读最新 spin.json 与技能列表回传
        // 复用 refresh() 的装配路径（SpinLoop 完成后的自动刷新同路），只读不落盘
        this.refresh().catch((err) => {
          this.host.log(`[ElectronSpinDesign] spin.json refresh failed: ${err}`);
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
    const sessionId = this.sessionId;
    if (!sessionId) {
      return;
    }
    try {
      const read = await requestSpinDesign(sessionId);
      if (read.status === 'error') {
        this.postError(read.message);
        return;
      }
      this.postData(read);
    } catch (err) {
      this.postError(String(err));
    }
  }

  private postData(read: Extract<SpinDesignReadResult, { status: 'ok' }>): void {
    const win = this.spinDesignWindow;
    if (!win || win.isDestroyed()) {
      return;
    }
    win.webContents.send('spin-design-message', {
      type: 'spinDesignData',
      data: read.data,
      skills: read.skills,
    });
  }

  private postError(message: string): void {
    this.host.log(`[ElectronSpinDesign] ${message}`);
    const win = this.spinDesignWindow;
    if (!win || win.isDestroyed()) {
      return;
    }
    win.webContents.send('spin-design-message', { type: 'spinDesignError', error: message });
  }
}
