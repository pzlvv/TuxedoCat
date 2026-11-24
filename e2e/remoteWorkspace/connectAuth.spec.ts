import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { openStaticPage } from '../helpers/webviewHarness';

/**
 * 「打开远程工作区」接入面板：认证链与口令浮层（`electron/remoteWorkspace/`，
 * 规格 specs/053 / `docs/core/core-remote.md` 第 2.8 节）。
 *
 * 这一步要连真实 SSH 才走得到，整应用 e2e（`e2e/electron/remoteWorkspace.spec.ts`）
 * 覆盖不到；这里按 webview-ui 同一手法直接伺服构建产物 `dist/remoteWorkspace/`，
 * 以假 `window.remoteWorkspaceAPI` 驱动真实页面逻辑，锁住：
 * - 首屏没有任何口令输入（`input[type=password]` 计数为 0）；
 * - 表单「连接」提交的请求 `password` 为 `null`（走认证链）；
 * - `needPassword` 结果弹出模态浮层、表单字段被禁用、焦点在口令输入框；
 * - 浮层提交只带那一次口令，失败保持浮层并回显原因，成功进入选目录；
 * - Esc / 取消关闭浮层且保留表单内容，不建链。
 */

const REPO_ROOT = process.cwd().replace(/[\\/]e2e$/, '');

/** 假宿主的可编程行为：每个用例通过 `window.__script` 决定下一次 connect 的结果 */
const FAKE_API_INIT = `
(() => {
  const listing = { path: '/', parent: null, entries: [] };
  window.__script = {
    // connect 的依次结果：needPassword → needPassword（口令错） → ok
    results: [],
    // 记录每次 connect 请求（用于断言 password 字段）
    requests: [],
    // 挂起的 connect 的放行开关（用例需要观察「连接中」状态时用）
    release: null,
  };
  window.remoteWorkspaceAPI = {
    connect: async (request) => {
      window.__script.requests.push(request);
      const next = window.__script.results.shift() ?? { ok: false, reason: 'error', error: 'unexpected call' };
      // pending：这次调用挂起，直到用例调用 release()——用来观察连接进行中的按钮 / 文案
      if (next.pending) {
        await new Promise((resolve) => { window.__script.release = resolve; });
        window.__script.release = null;
        return next.result.ok
          ? { ok: true, listing, endpoint: { host: request.host, port: Number(request.port), user: request.user } }
          : next.result;
      }
      return next.ok
        ? { ok: true, listing, endpoint: { host: request.host, port: Number(request.port), user: request.user } }
        : next;
    },
    sshHistory: async () => [],
    removeSshHistoryEntry: async () => [],
    list: async () => ({ ok: true, listing }),
    create: async () => ({ ok: true, path: '/' }),
    rename: async () => ({ ok: true, path: '/' }),
    remove: async () => ({ ok: true, path: '/' }),
    open: async () => ({ ok: true }),
    cancel: () => {},
  };
})();
`;

let handle: { page: Page; close: () => Promise<void> };

test.beforeEach(async ({ browser }) => {
  handle = await openStaticPage(browser, path.join(REPO_ROOT, 'dist', 'remoteWorkspace'), FAKE_API_INIT);
});

test.afterEach(async () => {
  await handle.close();
});

/** 填好表单三项（首屏没有口令输入） */
async function fillTarget(page: Page): Promise<void> {
  await page.fill('#sshHost', '10.0.0.1');
  await page.fill('#sshPort', '22');
  await page.fill('#sshUser', 'root');
}

/** 页面里假宿主的可编程脚本（与 `FAKE_API_INIT` 注入的形状一致） */
interface FakeScript {
  results: Array<Record<string, unknown>>;
  requests: Array<{ password: string | null }>;
  release: (() => void) | null;
}

/** 设定接下来 connect 的依次结果 */
async function script(page: Page, results: Array<Record<string, unknown>>): Promise<void> {
  await page.evaluate((value) => {
    (window as unknown as { __script: FakeScript }).__script.results = value;
  }, results);
}

/** 放行挂起的那次 connect（用例用 `{ pending: true, result }` 观察连接中状态） */
async function releasePending(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __script: FakeScript }).__script.release?.();
  });
}

/** 读出 connect 收到的全部请求 */
function requests(page: Page): Promise<Array<{ password: string | null }>> {
  return page.evaluate(() => (window as unknown as { __script: FakeScript }).__script.requests);
}

test('FR-001 首屏没有任何口令输入，表单只有主机 / 端口 / 用户三项', async () => {
  const { page } = handle;
  await expect(page.locator('#connectView input[type="password"]')).toHaveCount(0);
  await expect(page.locator('#passwordOverlay')).toBeHidden();
  await expect(page.locator('#sshHost')).toBeVisible();
  await expect(page.locator('#sshPort')).toBeVisible();
  await expect(page.locator('#sshUser')).toBeVisible();
});

test('FR-002 表单「连接」提交的请求不带口令（交给认证链）', async () => {
  const { page } = handle;
  await script(page, [{ ok: false, reason: 'needPassword', error: 'no private key' }]);
  await fillTarget(page);
  await page.click('#connect');
  await expect.poll(async () => (await requests(page)).length).toBe(1);
  const [first] = await requests(page);
  expect(first?.password).toBeNull();
});

test('FR-004 需要口令时弹出浮层：表单禁用、焦点在口令框、原因可见', async () => {
  const { page } = handle;
  await script(page, [{ ok: false, reason: 'needPassword', error: 'no private key, no ssh-agent identity' }]);
  await fillTarget(page);
  await page.click('#connect');

  await expect(page.locator('#passwordOverlay')).toBeVisible();
  await expect(page.locator('#passwordReason')).toContainText('no private key');
  // 浮层是模态的：下面的接入表单不可编辑（AC-7）
  await expect(page.locator('#sshHost')).toBeDisabled();
  await expect(page.locator('#sshPort')).toBeDisabled();
  await expect(page.locator('#sshUser')).toBeDisabled();
  await expect(page.locator('#connect')).toBeDisabled();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.id ?? ''))
    .toBe('sshPassword');
});

test('FR-004 口令错误：浮层保持打开并回显原因，可继续重输', async () => {
  const { page } = handle;
  await script(page, [
    { ok: false, reason: 'needPassword', error: 'no saved password' },
    { ok: false, reason: 'needPassword', error: 'All configured authentication methods failed' },
    { ok: true },
  ]);
  await fillTarget(page);
  await page.click('#connect');
  await expect(page.locator('#passwordOverlay')).toBeVisible();

  await page.fill('#sshPassword', 'wrong');
  await page.click('#submitPassword');

  await expect(page.locator('#passwordOverlay')).toBeVisible();
  await expect(page.locator('#passwordError')).toContainText('authentication methods failed');
  // 只试那一次口令：请求里带的是用户输入，不是表单残留
  const log = await requests(page);
  expect(log).toHaveLength(2);
  expect(log[1]?.password).toBe('wrong');

  // 重输正确口令后进入选目录
  await page.fill('#sshPassword', 'right');
  await page.click('#submitPassword');
  await expect(page.locator('#pickerView')).toBeVisible({ timeout: 5000 });
  const final = await requests(page);
  expect(final).toHaveLength(3);
  expect(final[2]?.password).toBe('right');
});

test('FR-004 回车与点「连接」是同一条提交路径', async () => {
  const { page } = handle;
  await script(page, [
    { ok: false, reason: 'needPassword', error: 'no saved password' },
    { ok: true },
  ]);
  await fillTarget(page);
  await page.click('#connect');
  await expect(page.locator('#passwordOverlay')).toBeVisible();

  await page.fill('#sshPassword', 'pw');
  await page.press('#sshPassword', 'Enter');
  await expect(page.locator('#pickerView')).toBeVisible({ timeout: 5000 });
});

test('FR-004 Esc / 取消关闭浮层：保留表单内容且不再发请求', async () => {
  const { page } = handle;
  await script(page, [{ ok: false, reason: 'needPassword', error: 'no saved password' }]);
  await fillTarget(page);
  await page.click('#connect');
  await expect(page.locator('#passwordOverlay')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('#passwordOverlay')).toBeHidden();
  await expect(page.locator('#sshHost')).toHaveValue('10.0.0.1');
  await expect(page.locator('#sshPort')).toHaveValue('22');
  await expect(page.locator('#sshUser')).toHaveValue('root');
  // 表单恢复可编辑（AC-11：回到表单）
  await expect(page.locator('#sshHost')).toBeEnabled();
  // 取消不建链：请求数仍是那一次
  expect((await requests(page)).length).toBe(1);
});

test('FR-009 终止性失败直接在表单上报错，不弹口令浮层', async () => {
  const { page } = handle;
  await script(page, [{ ok: false, reason: 'error', error: 'connect ECONNREFUSED 10.0.0.1:22' }]);
  await fillTarget(page);
  await page.click('#connect');

  await expect(page.locator('#passwordOverlay')).toBeHidden();
  await expect(page.locator('#connectError')).toContainText('ECONNREFUSED');
});

test('AC-10 口令被拒：原因在浮层里，输入保留且选中（specs/defects/remote-password-failure-hidden-behind-overlay）', async () => {
  const { page } = handle;
  await script(page, [
    { ok: false, reason: 'needPassword', error: 'no private key, no saved password' },
    { ok: false, reason: 'needPassword', error: 'All configured authentication methods failed' },
  ]);
  await fillTarget(page);
  await page.click('#connect');
  await expect(page.locator('#passwordOverlay')).toBeVisible();

  await page.fill('#sshPassword', 'wrong');
  await page.click('#submitPassword');

  // 原因必须在浮层里：浮层背后的 #connectError 被遮罩盖住，写在那里等于什么都没显示
  await expect(page.locator('#passwordOverlay')).toBeVisible();
  await expect(page.locator('#passwordError')).toContainText('authentication methods failed');
  await expect(page.locator('#connectError')).toHaveText('');
  // 输入保留并全选，直接敲字即覆盖重输（AC-10）
  await expect(page.locator('#sshPassword')).toHaveValue('wrong');
  await expect
    .poll(() => page.evaluate(() => {
      const input = document.getElementById('sshPassword') as HTMLInputElement | null;
      return input === null ? null : [input.selectionStart, input.selectionEnd];
    }))
    .toEqual([0, 5]);
});

test('浮层提交后的终止性失败收起浮层、报在表单上（FR-009）', async () => {
  const { page } = handle;
  // 第二次是部署阶段的失败：口令已被接受，问题不在口令上，不该再问一次
  await script(page, [
    { ok: false, reason: 'needPassword', error: 'no private key, no saved password' },
    { ok: false, reason: 'error', error: 'remote daemon started but state file is missing' },
  ]);
  await fillTarget(page);
  await page.click('#connect');
  await expect(page.locator('#passwordOverlay')).toBeVisible();

  await page.fill('#sshPassword', 'right');
  await page.click('#submitPassword');

  // 浮层收起才看得见原因：留在浮层上只会得到一个「什么都没说明」的浮层
  await expect(page.locator('#passwordOverlay')).toBeHidden();
  await expect(page.locator('#connectError')).toContainText('state file is missing');
  await expect(page.locator('#connect')).toBeEnabled();
});

test('浮层提交后进入连接中：浮层收起、按钮为连接中状态', async () => {
  const { page } = handle;
  await script(page, [
    { ok: false, reason: 'needPassword', error: 'no private key, no saved password' },
    { pending: true, result: { ok: true } },
  ]);
  await fillTarget(page);
  await page.click('#connect');
  await expect(page.locator('#passwordOverlay')).toBeVisible();

  await page.fill('#sshPassword', 'right');
  await page.click('#submitPassword');

  // 口令已被接受、正在部署 Core：浮层必须让开，进度与按钮状态才看得见
  await expect(page.locator('#passwordOverlay')).toBeHidden();
  await expect(page.locator('#connectStatus')).toContainText('Core');
  await expect(page.locator('#connect')).toBeDisabled();
  await expect(page.locator('#connect')).toHaveText(/连接中|Connecting/);

  await releasePending(page);
  await expect(page.locator('#pickerView')).toBeVisible({ timeout: 5000 });
});
