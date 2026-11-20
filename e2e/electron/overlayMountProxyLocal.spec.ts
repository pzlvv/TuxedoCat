import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from '../helpers/mockLlmServer';
import { launchApp, makeWorkspace } from '../helpers/electronApp';
import type { AppHandle } from '../helpers/electronApp';
import type { MockLlm } from '../helpers/mockLlmServer';
import { CONFIG_DIR_NAME } from '../../src/config/project';

/**
 * Overlay 挂载代理：能力事实与 fail-closed（`specs/051-overlay-root-mount-proxy`
 * FR-001 / FR-010）。
 *
 * 这一层跑**本地整应用**（真实 Core，宿主平台二进制），验两件 webview 层看不见的事：
 *
 * 1. 宿主平台 Core 的能力应答与入口渲染判据是否同源（AC-3 / AC-5）；
 * 2. 能力不可用时 `isolated` 归属不被接受（AC-32）——否则该会话会永久 isolated、
 *    每次工具调用都失败。
 *
 * 第 2 条的「不接受」有两道关口，分层验：宿主侧的部署闸门在消息进 Core **之前**就拦下它
 * （本文件，端到端唯一稳定可观测的形态）；Core 侧的拒绝落盘走单测——宿主闸门存在时
 * 端到端构造不出「消息带着 isolated 到达 Core」的状态。分层理由见
 * `specs/defects/fr-010-e2e-does-not-reach-fail-closed.md`。
 *
 * 运行：`npm run test:e2e:electron -- overlayMountProxyLocal`
 */


const WORK_VIEW_OPTION = 'input[data-work-view-option]';

let mockLlm: MockLlm | null = null;
let app: AppHandle | null = null;

test.afterEach(async () => {
  await app?.close();
  app = null;
  mockLlm?.close();
  mockLlm = null;
});

/**
 * 本机 Core 的存储能力（经宿主转发，与 webview 拿到的是同一份事实）。
 *
 * 通道判据必须与 webview 同口径：Electron 宿主注入的是 `window.electronAPI`，VS Code /
 * 浏览器 shim 才是 `window.vscode`（`src/webview/webviewEnv.ts` 的 `getHostMessageApi`）。
 */
async function storageCapabilities(page: import('@playwright/test').Page): Promise<{
  isolatedWorkView: boolean;
  mountProxy: 'ready' | 'absent';
  deployable: boolean;
  reason: string;
}> {
  return page.evaluate(async () => {
    const host = (window as unknown as {
      electronAPI?: { postMessage: (m: unknown) => void };
      vscode?: { postMessage: (m: unknown) => void };
    });
    const wire = host.electronAPI ?? host.vscode;
    if (!wire) throw new Error('webview 无宿主消息通道（electronAPI / vscode 都不存在）');
    // 拿回复：webview 侧监听同一通道的 setStorageCapabilities
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('storageCapabilities 超时')), 30_000);
      const onMessage = (event: MessageEvent): void => {
        const msg = event.data as { type?: string };
        if (msg?.type !== 'setStorageCapabilities') return;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve(msg as never);
      };
      window.addEventListener('message', onMessage);
      wire.postMessage({ type: 'requestStorageCapabilities' });
    });
  });
}

test('FR-001 宿主平台 Core：能力应答与入口渲染判据同源', async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  const workspaceDir = await makeWorkspace({}, 'e2e-ws-mount-proxy-capabilities');
  mockLlm = await startMockLlm({ workspaceDir });
  app = await launchApp({ repoRoot, mockLlm, workspaceDir });

  const page = await app.chatPage({ workspaceIncludes: 'e2e-ws-mount-proxy-capabilities', emptyState: true });
  await page.waitForSelector('textarea.input-textarea', { timeout: 30_000 });

  const capabilities = await storageCapabilities(page);

  // 能力是 Core 的事实，断言按**跑这个 Core 的平台**分流——不假定 runner 一定是 Linux：
  // 无代理时本机永远不会「此刻可用」（Core 自己不建命名空间）。
  expect(capabilities.isolatedWorkView, '没有代理时能力必然不是「此刻可用」').toBe(false);
  expect(capabilities.reason.trim().length, '不可用时必须点名原因').toBeGreaterThan(0);

  if (process.platform === 'linux') {
    // Linux：装代理可能解决问题。这里**不断言** `deployable` 的具体值——runner 上是否真有
    // overlayfs 由内核决定，代理装没装由前面跑过哪些用例决定；只断言它与「是否可以部署」
    // 的派生关系自洽（`deployable: true` 时 `mountProxy` 必须还是 absent）。
    if (capabilities.deployable) {
      expect(capabilities.mountProxy, 'deployable 意味着代理尚未就位').toBe('absent');
    }
  } else {
    // Windows / macOS：挂载命名空间与 overlayfs 都不存在，装代理也解决不了
    expect(capabilities.deployable, '非 Linux 平台装代理也解决不了，deployable 必须为 false').toBe(false);
  }

  // 入口渲染判据是 `isolatedWorkView || deployable`（FR-002）：与能力事实同源。
  // 本机没有代理可用时，只有「可部署」才该渲染入口。
  const entryCount = await page.locator(WORK_VIEW_OPTION).count();
  expect(entryCount, '入口渲染判据必须等于 isolatedWorkView || deployable').toBe(
    capabilities.isolatedWorkView || capabilities.deployable ? 1 : 0,
  );
});

test('FR-010 能力不可用时宿主拦下 isolated 归属的消息，不建会话也不落盘', async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  const workspaceDir = await makeWorkspace({}, 'e2e-ws-mount-proxy-reject');
  mockLlm = await startMockLlm({ workspaceDir });
  mockLlm.setHandler(() => ({ kind: 'text', text: '不该出现的回复' }));
  app = await launchApp({ repoRoot, mockLlm, workspaceDir, agentMode: 'auto' });

  const page = await app.chatPage({ workspaceIncludes: 'e2e-ws-mount-proxy-reject', emptyState: true });
  await page.waitForSelector('textarea.input-textarea', { timeout: 30_000 });

  const capabilities = await storageCapabilities(page);
  // 前提：这条用例只在「能力不可用」时成立（可用时闸门不拦，断言无意义）
  test.skip(capabilities.isolatedWorkView, '本机代理已就位，无法构造「能力不可用」的前置');

  // 归属随第一条消息生效（specs/045 FR-001，specs/051 FR-003）：勾选只是本地意图，
  // 因此这里直接发一条带 `isolated` 归属的消息，看宿主闸门是否在它进 Core 之前拦下。
  const sessionId = await page.evaluate(() => String((window as unknown as { __currentSessionId?: string }).__currentSessionId ?? ''));
  expect(sessionId, '空状态应已有会话 id').toBeTruthy();
  await page.evaluate((sid) => {
    // Electron 宿主是 `electronAPI`，VS Code 才是 `vscode`（src/webview/webviewEnv.ts 同口径）
    const host = window as unknown as {
      electronAPI?: { postMessage: (m: unknown) => void };
      vscode?: { postMessage: (m: unknown) => void };
    };
    const wire = host.electronAPI ?? host.vscode;
    if (!wire) throw new Error('未找到宿主消息 API');
    wire.postMessage({ type: 'sendMessage', sessionId: sid, content: '归属拒绝探针', storage: 'isolated' });
  }, sessionId);

  if (capabilities.deployable) {
    // 可部署：宿主弹部署确认框，消息不进 Core（specs/051 FR-003 的闸门）。
    await expect(
      page.locator('[data-mount-proxy-dialog="confirm"]'),
      '可部署时宿主应弹部署确认框而不是把消息放行',
    ).toBeVisible({ timeout: 30_000 });
  }
  // 不可部署（非 Linux、或内核无 overlayfs）：宿主按接线错误拒绝，异常被
  // `handleWebviewMessage` 收进日志、不向调用方抛——界面表现为「不弹框、消息不生效」。
  // 两条分支的共同结论就是下面那组断言：消息没有进 Core。

  // 无论哪条分支，模型都不得收到这次请求：收到说明消息进了 Core。
  await expect
    .poll(() => mockLlm?.requests.length ?? 0, { timeout: 15_000 })
    .toBe(0);

  // 界面上不出现模型回复（消息被拦，本轮从未开始）
  await expect(page.getByText('不该出现的回复')).toHaveCount(0);

  // 归属也没有落盘：会话若被建出来也不得带 isolated（Core 只写 workspace）
  const metadataDir = path.join(app.homeDir, CONFIG_DIR_NAME, 'conversations');
  if (fs.existsSync(metadataDir)) {
    for (const project of fs.readdirSync(metadataDir)) {
      const projectDir = path.join(metadataDir, project);
      if (!fs.statSync(projectDir).isDirectory()) continue;
      for (const file of fs.readdirSync(projectDir)) {
        if (!file.endsWith('.meta.json') || file === 'workspace.meta.json') continue;
        const meta = JSON.parse(fs.readFileSync(path.join(projectDir, file), 'utf8')) as {
          storage?: string;
        };
        expect(meta.storage, `${file} 不得留下永久的 isolated`).not.toBe('isolated');
      }
    }
  }
});
