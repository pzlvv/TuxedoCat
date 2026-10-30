import { test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { requirePycharmEnvironment } from '../helpers/testEnvironment';
import { startMockLlm, type MockLlm } from '../helpers/mockLlmServer';
import { launchPycharmIde, type PycharmIdeHandle } from '../helpers/pycharmIde';

/**
 * JCEF 滚动帧率探针（手动诊断工具，默认 skip）：
 *   PYCHARM_PERF=1 npx playwright test -c e2e/playwright.config.ts --project=pycharm-plugin --grep "PERF"
 *
 * 输出（test-results/pycharm-perf/probe.json）：
 * - glRenderer：Chromium 实际使用的 GL 渲染器（含 SwiftShader / llvmpipe 即软件渲染）
 * - devicePixelRatio：缩放（DPI 额外缩放成本）
 * - idleFrames / scrollFrames：rAF 帧间隔分布（均值 / p95 / 最大值）——空闲与强制滚动
 *   各采样 90 帧；程序化滚动会触发 scroll 事件与锚点逻辑，帧间隔反映真实渲染吞吐。
 */
const PYCHARM = requirePycharmEnvironment();
const ZIP_PATH = path.join(__dirname, '..', '..', 'release', 'pycharm', `${require('../../src/config/project').EXTENSION_NAME}-pycharm-0.0.1.zip`);

let mockLlm: MockLlm;
let ide: PycharmIdeHandle | undefined;

test('PERF JCEF 滚动帧率与渲染器探测', async () => {
  test.skip(!process.env.PYCHARM_PERF, '手动诊断：设 PYCHARM_PERF=1 运行');
  mockLlm = await startMockLlm({ workspaceDir: '' });
  ide = await launchPycharmIde(PYCHARM.idePath, ZIP_PATH, {
    agentMode: 'manual',
    mockLlmBaseURL: async (workspaceDir) => {
      mockLlm = await startMockLlm({ workspaceDir });
      return mockLlm.baseURL;
    },
    keepSandboxOnClose: true,
  });
  const page = ide.panelPage;
  await page.waitForSelector('textarea.input-textarea', { timeout: 120_000 }).catch(async (error) => {
    await ide!.debugDump('test-results/pycharm-perf');
    throw error;
  });
  const { findIdePids } = await import('../helpers/pycharmIde');
  const idePids = await findIdePids(ide.sandboxDir, path.basename(PYCHARM.idePath));
  const idePid = idePids[0] ?? 0;

  // 造点内容：几条带代码块的回复让 DOM 有真实体量
  for (const text of ['你好', '执行命令 echo perf-probe', '写入文件 perf-notes.md']) {
    await page.fill('textarea.input-textarea', text);
    await page.press('textarea.input-textarea', 'Enter');
    await page.waitForTimeout(4000);
  }

  // 把 IDE 窗口置前：被遮挡的 Chromium 窗口会被 Windows occlusion tracking 限到
  // 30fps（实测后台 rAF 稳定 33.3ms），必须在前台测才是用户真实看到的帧率
  const { execFile } = await import('node:child_process');
  await new Promise<void>((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command',
      `(New-Object -ComObject WScript.Shell).AppActivate(${idePid}) ; Start-Sleep -Milliseconds 500`],
      () => resolve());
  });
  await page.waitForTimeout(800);

  const probe = await page.evaluate(async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const sample = async (frames: number, drive?: () => void): Promise<number[]> => {
      const deltas: number[] = [];
      let last = performance.now();
      let count = 0;
      return new Promise<number[]>((resolve) => {
        const tick = (t: number) => {
          deltas.push(t - last);
          last = t;
          count += 1;
          if (count >= frames) { resolve(deltas); return; }
          drive?.();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    };
    const summarize = (deltas: number[]) => {
      const sorted = [...deltas].sort((a, b) => a - b);
      const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
      return {
        mean: Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length * 10) / 10,
        p50: Math.round(p(0.5) * 10) / 10,
        p95: Math.round(p(0.95) * 10) / 10,
        max: Math.round(sorted[sorted.length - 1] * 10) / 10,
      };
    };
    // 找消息滚动容器：可滚动且子节点最多的元素
    const scroller = [...document.querySelectorAll<HTMLElement>('*')]
      .filter((el) => el.scrollHeight > el.clientHeight + 100 && /auto|scroll/.test(getComputedStyle(el).overflowY))
      .sort((a, b) => b.childElementCount - a.childElementCount)[0];
    const idle = summarize(await sample(90));
    let scroll: ReturnType<typeof summarize> | null = null;
    if (scroller) {
      const min = 0;
      const max = scroller.scrollHeight;
      scroll = summarize(await sample(90, () => {
        scroller.scrollTop = Math.floor(min + Math.random() * (max - min));
      }));
    }
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl');
    let glRenderer = 'no-webgl';
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      glRenderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    }
    return {
      glRenderer,
      devicePixelRatio: window.devicePixelRatio,
      scrollerFound: scroller ? `${scroller.tagName}.${scroller.className}`.slice(0, 80) : 'none',
      idleFrames: idle,
      scrollFrames: scroll,
    };
  });

  fs.mkdirSync('test-results/pycharm-perf', { recursive: true });
  fs.writeFileSync('test-results/pycharm-perf/probe.json', JSON.stringify(probe, null, 2));
});

test.afterAll(async () => {
  if (ide) await ide.close();
  await mockLlm?.close();
});
