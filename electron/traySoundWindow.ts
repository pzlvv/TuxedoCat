/**
 * 托盘提醒音的播放载体：一个懒创建、播完自毁的隐藏窗口 + Web Audio。
 *
 * 为什么不用 `<audio src>`（见 `docs/hosts/host-matrix.md` 第 12 节的托盘提醒段落）：
 * `assets/meow.aac`
 * 是 MP4 容器（`ftyp mp42` + AAC-LC 44.1kHz 立体声），但容器时长元数据与数据不一致
 * （`mvhd` / `mdhd` 声明 ≈6ms，`stts` 每帧 delta = 5），Chromium 按声明时长判定结束，
 * `<audio>` 实测只播 6ms。`decodeAudioData` 解到文件尾则完整（实测 1.254s），因此这里
 * 解码一次、缓存 AudioBuffer，每次播放新建 `AudioBufferSourceNode`（停旧源 + `start(0)`，
 * 天然满足「重播不叠加」）。
 *
 * 音频以 base64 经 `executeJavaScript` 注入页面：`data:` 页面加载 `file://` 子资源会被
 * Chromium 拒绝（实测 ERR_FAILED），所以不能把音频当页面子资源引用。
 *
 * 窗口**不常驻**：播完音频时长 + 余量即销毁。常驻一个隐藏窗口会改坏两处既有判定——
 * `electron/main.ts` 的 `window-all-closed`（主窗口关闭后应用不再退出）与
 * `app.on('activate')` 里 `BrowserWindow.getAllWindows().length === 0`（主窗口重建不了）。
 */

import { BrowserWindow } from 'electron';
import { readFileSync } from 'node:fs';
import type { AttentionSoundPlayer } from './trayAttentionSound.js';

/** 页面标题标记（窗口不显示，仅便于调试时在窗口列表里辨认） */
const PAGE_TITLE = 'tc-tray-sound';

/** 播放结束后的销毁余量（毫秒）：给音频输出留一点排空时间，避免尾音被截 */
const DESTROY_MARGIN_MS = 400;

/** 最小壳页面：音频与解码逻辑都由下面的脚本注入（不落 dist 构建产物） */
const SHELL_HTML =
  `<!doctype html><html><head><meta charset="utf-8"><title>${PAGE_TITLE}</title></head><body></body></html>`;

/**
 * 初始化脚本：把 base64 音频解码成 AudioBuffer 并缓存到页面全局，返回音频时长（毫秒）。
 *
 * `AudioContext` 的自动播放策略由窗口的 `autoplayPolicy` 放开；仍显式 `resume()` 一次，
 * 免得策略或系统音频设备状态把上下文留在 suspended（播放脚本会再校验一次 state）。
 */
function initScript(base64: string): string {
  return `(async () => {
  const raw = atob(${JSON.stringify(base64)});
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const ctx = new AudioContext();
  if (ctx.state !== 'running') await ctx.resume().catch(() => {});
  const buffer = await ctx.decodeAudioData(bytes.buffer);
  window.__traySound = { ctx, buffer, source: null };
  return buffer.duration * 1000;
})()`;
}

/** 播放脚本：停掉上一路源、从头播一次，返回播放后的上下文状态（调用方据此判定是否真的在出声） */
const PLAY_SCRIPT = `(async () => {
  const state = window.__traySound;
  if (!state) throw new Error('sound not initialized');
  if (state.ctx.state !== 'running') await state.ctx.resume();
  if (state.source) { try { state.source.stop(); } catch (err) {} }
  const source = state.ctx.createBufferSource();
  source.buffer = state.buffer;
  source.connect(state.ctx.destination);
  source.start(0);
  state.source = source;
  return state.ctx.state;
})()`;

export interface TraySoundPlayer extends AttentionSoundPlayer {
  /**
   * 释放当前播放窗口与销毁定时器（幂等）。之后再次 `play()` 会重新懒建窗口——
   * 主窗口关掉后应用可能仍在跑（macOS 的 `activate` 会重建主窗口），
   * 这里只清窗口，不把载体永久停用。
   */
  dispose(): void;
}

export function createTraySoundPlayer(options: { audioPath: string }): TraySoundPlayer {
  let win: BrowserWindow | null = null;
  /** 解码完成的信号：resolve 音频时长（毫秒）；窗口销毁 / 解码失败时 reject */
  let ready: Promise<number> | null = null;
  let destroyTimer: ReturnType<typeof setTimeout> | null = null;

  function clearDestroyTimer(): void {
    if (destroyTimer) {
      clearTimeout(destroyTimer);
      destroyTimer = null;
    }
  }

  function destroyWindow(): void {
    clearDestroyTimer();
    const target = win;
    win = null;
    ready = null;
    if (target && !target.isDestroyed()) target.destroy();
  }

  /** 懒建窗口并解码一次音频；重复调用复用同一个窗口 */
  function ensureReady(): Promise<number> {
    if (ready) return ready;
    const base64 = readFileSync(options.audioPath).toString('base64');
    const created = new BrowserWindow({
      show: false,
      webPreferences: {
        // 没有用户手势也要出声：不赌 Electron 的默认策略，显式放开
        autoplayPolicy: 'no-user-gesture-required',
        // 隐藏窗口默认会被节流；音频解码与播放不该受窗口可见性影响
        backgroundThrottling: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win = created;
    created.on('closed', () => {
      if (win === created) {
        win = null;
        ready = null;
      }
    });
    ready = created
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SHELL_HTML)}`)
      .then(() => created.webContents.executeJavaScript(initScript(base64)) as Promise<unknown>)
      .then((durationMs) => {
        if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) {
          throw new Error(`decode returned ${String(durationMs)}`);
        }
        return durationMs;
      });
    return ready;
  }

  return {
    async play(): Promise<void> {
      clearDestroyTimer();
      let durationMs: number;
      try {
        durationMs = await ensureReady();
      } catch (err) {
        // 建窗 / 载页 / 解码失败：销毁半成品窗口，下次提醒重新来过
        destroyWindow();
        throw err;
      }
      const target = win;
      if (!target || target.isDestroyed()) throw new Error('sound window is gone');
      const state = (await target.webContents.executeJavaScript(PLAY_SCRIPT)) as unknown;
      if (state !== 'running') throw new Error(`audio context is ${String(state)}`);
      // 播完即销毁：窗口只在提醒后存活音频时长 + 余量
      destroyTimer = setTimeout(() => {
        destroyTimer = null;
        destroyWindow();
      }, durationMs + DESTROY_MARGIN_MS);
    },
    dispose(): void {
      destroyWindow();
    },
  };
}
