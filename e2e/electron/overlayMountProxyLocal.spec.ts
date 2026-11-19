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
 * FR-001 / FR-008 / FR-010 / FR-011）。
 *
 * 这一层跑**本地整应用**（真实 Core，宿主平台二进制），验三件 webview 层看不见的事：
 *
 * 1. 非 Linux 宿主 Core 的能力应答是 `deployable: false`，整块入口不渲染（AC-3 / AC-5）；
 * 2. 能力不可用时 Core 拒绝把 `storage: isolated` 写进 `meta.json`（AC-32）——否则该会话
 *    永久 isolated、每次工具调用都失败；
 * 3. 存量 `isolated` 会话在能力不可用时打开，界面给「转为真实工作区」的显式动作，
 *    转换后落盘为 `workspace` 且工具读写真实磁盘（AC-33 / FR-011）。
 *
 * 第 2 / 3 条只能在本层验：`meta.json` 是 Core 独占写入的落盘事实，webview 层是假的。
 *
 * 运行：`<envPrefix>_E2E_MOUNT_PROXY=1 npm run test:e2e:electron -- overlayMountProxyLocal`
 */


const WORK_VIEW_OPTION = 'input[data-work-view-option]';
const CONVERT_ACTION = '[data-conversation-storage-convert]';

let mockLlm: MockLlm | null = null;
let app: AppHandle | null = null;

test.afterEach(async () => {
  await app?.close();
  app = null;
  mockLlm?.close();
  mockLlm = null;
});

/**
 * 沙箱 home 里全部会话的 meta.json（工作区清单 `workspace.meta.json` 不是会话）。
 * 宿主侧只读：写入永远是 Core 的事（AGENTS.md 第 1 节第 9 条）。
 */
function conversationMetas(homeDir: string): Array<{ file: string; meta: Record<string, unknown> }> {
  const conversationsDir = path.join(homeDir, CONFIG_DIR_NAME, 'conversations');
  if (!fs.existsSync(conversationsDir)) return [];
  const out: Array<{ file: string; meta: Record<string, unknown> }> = [];
  for (const project of fs.readdirSync(conversationsDir)) {
    const projectDir = path.join(conversationsDir, project);
    if (!fs.statSync(projectDir).isDirectory()) continue;
    for (const file of fs.readdirSync(projectDir)) {
      if (!file.endsWith('.meta.json') || file === 'workspace.meta.json') continue;
      const full = path.join(projectDir, file);
      out.push({ file: full, meta: JSON.parse(fs.readFileSync(full, 'utf8')) as Record<string, unknown> });
    }
  }
  return out;
}

/** 本机 Core 的存储能力（经宿主转发，与 webview 拿到的是同一份事实） */
async function storageCapabilities(page: import('@playwright/test').Page): Promise<{
  isolatedWorkView: boolean;
  mountProxy: 'ready' | 'absent';
  deployable: boolean;
  reason: string;
}> {
  return page.evaluate(async () => {
    const wire = (window as unknown as {
      vscode?: { postMessage: (m: unknown) => void };
    }).vscode;
    if (!wire) throw new Error('webview 无 postMessage 通道');
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

test('FR-001 非 Linux 宿主 Core：能力不可部署、整块入口不渲染', async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  const workspaceDir = await makeWorkspace({}, 'e2e-ws-mount-proxy-capabilities');
  mockLlm = await startMockLlm({ workspaceDir });
  app = await launchApp({ repoRoot, mockLlm, workspaceDir });

  const page = await app.chatPage({ workspaceIncludes: 'e2e-ws-mount-proxy-capabilities', emptyState: true });
  await page.waitForSelector('textarea.input-textarea', { timeout: 30_000 });

  // Core 是宿主平台二进制：Windows / macOS 上没有代理形态，能力必须回不可部署
  const capabilities = await storageCapabilities(page);
  expect(capabilities.isolatedWorkView, '宿主平台无挂载代理时能力必须不可用').toBe(false);
  expect(capabilities.deployable, '非 Linux 平台装代理也解决不了，deployable 必须为 false').toBe(false);
  expect(capabilities.reason.trim().length, '不可用时必须点名原因').toBeGreaterThan(0);

  // 整块入口不渲染（AC-5）
  await expect(page.locator(WORK_VIEW_OPTION)).toHaveCount(0);
});

test('FR-010 能力不可用时拒绝 isolated 归属，meta.json 不留永久 isolated', async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  const workspaceDir = await makeWorkspace({}, 'e2e-ws-mount-proxy-reject');
  mockLlm = await startMockLlm({ workspaceDir });
  mockLlm.setHandler(() => ({ kind: 'text', text: '归属拒绝探针回复' }));
  app = await launchApp({ repoRoot, mockLlm, workspaceDir });

  const page = await app.chatPage({ workspaceIncludes: 'e2e-ws-mount-proxy-reject', emptyState: true });
  await page.waitForSelector('textarea.input-textarea', { timeout: 30_000 });

  // 归属随第一条消息生效（specs/045 FR-001，specs/051 FR-003）：勾选只是本地意图，
  // 因此这里直接发一条带 `isolated` 归属的消息，Core 必须拒绝该归属（能力不可用，AC-32）。
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
  await expect(page.getByText('归属拒绝探针回复').first()).toBeVisible({ timeout: 90_000 });

  const metas = conversationMetas(app.homeDir);
  expect(metas.length, '会话应已建档').toBeGreaterThan(0);
  for (const { file, meta } of metas) {
    expect(meta.storage, `${file} 不得留下永久的 isolated`).not.toBe('isolated');
  }
});

test('FR-011 存量 isolated 会话在能力不可用时给出显式转换，转换后落盘 workspace', async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  const workspaceDir = await makeWorkspace({ 'note.md': '# 真实工作区基线\n' }, 'e2e-ws-mount-proxy-convert');
  mockLlm = await startMockLlm({ workspaceDir });
  mockLlm.setHandler(() => ({ kind: 'text', text: '转换会话回复' }));

  // 第一段：造一个已落盘的普通会话，关闭应用
  app = await launchApp({ repoRoot, mockLlm, workspaceDir, agentMode: 'auto', keepHomeOnClose: true });
  let page = await app.chatPage({ workspaceIncludes: 'e2e-ws-mount-proxy-convert', emptyState: true });
  await page.waitForSelector('textarea.input-textarea', { timeout: 30_000 });
  await page.fill('textarea.input-textarea', '转换会话基线');
  await page.press('textarea.input-textarea', 'Enter');
  await expect(page.getByText('转换会话回复').first()).toBeVisible({ timeout: 90_000 });
  const homeDir = app.homeDir;
  await app.close();
  app = null;

  // 手工把归属改成 isolated（模拟「上一版本留下的存量会话」；此刻应用已关，无并发写）
  const metas = conversationMetas(homeDir);
  expect(metas.length, '会话应已建档').toBeGreaterThan(0);
  const target = metas[0]!;
  const seeded = { ...target.meta, storage: 'isolated' };
  fs.writeFileSync(target.file, JSON.stringify(seeded, null, 2));

  // 第二段：重开（本机 Core 能力不可用 → 该会话的工具调用会失败，界面给显式出路）
  app = await launchApp({ repoRoot, mockLlm, workspaceDir, agentMode: 'auto', reuseHomeDir: homeDir });
  page = await app.chatPage({ workspaceIncludes: 'e2e-ws-mount-proxy-convert' });
  await page.waitForSelector('textarea.input-textarea', { timeout: 30_000 });

  // AC-33：界面给「转为真实工作区」的显式动作（不是自动降级）
  const convert = page.locator(CONVERT_ACTION);
  await expect(convert, '存量 isolated 会话在能力不可用时必须给出显式转换动作').toBeVisible({ timeout: 60_000 });
  await convert.click();

  // 转换后落盘为 workspace（Core 是唯一写入点，用例只读）
  await expect
    .poll(() => {
      const refreshed = conversationMetas(homeDir).find((m) => m.file === target.file);
      return refreshed?.meta.storage;
    }, { timeout: 30_000 })
    .toBe('workspace');
  // 界面不再标注 Overlay
  await expect(convert).toHaveCount(0);
});
