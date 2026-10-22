import { test, expect } from '@playwright/test';
import type { Locator } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm, lastUserText } from '../helpers/mockLlmServer';
import { launchApp, makeWorkspace } from '../helpers/electronApp';
import type { AppHandle } from '../helpers/electronApp';
import type { MockLlm, RecordedRequest, ScriptDecision } from '../helpers/mockLlmServer';

/**
 * US-51 子代理角色 explorer（specs/020）
 *
 * Electron 整应用链路：真实 standalone core（Rust）+ 本地 mock LLM。
 * 1. 父会话发起 `Agent(agentRole="explorer")`：子代理首请求的 tools 恰为
 *    Read / Glob / Grep / Reply（无 Bash / WebSearch，无 `mcp__*`）。
 * 2. 子代理首轮故意调用 Bash（白名单外）：tool_result 为错误文案（点名角色与
 *    可用工具），命令未执行，会话不中止、随后 Reply 正常收尾。
 * 3. 打开 explorer 子会话视图：选项菜单的提示词模式 / 联网搜索 / MCP 三项置灰，
 *    点击不产生任何变更。
 */

let mockLlm: MockLlm;
let app: AppHandle;
let workspaceDir: string;

const SIDEBAR_ITEM = '#list .item[data-session-id]';
const TASK_PROMPT = '浏览一下工作区';
const PARENT_PROMPT = '派个 explorer 看看';

/** explorer 子代理的首轮请求（无 tool 结果 + 任务提示词） */
function subFirstRequests(): RecordedRequest[] {
  return mockLlm.requests.filter((req) => {
    if (req.body.messages.some((m) => m.role === 'tool')) return false;
    return lastUserText(req.body.messages) === TASK_PROMPT;
  });
}

function toolNames(req: RecordedRequest): string[] {
  return (req.body.tools ?? []).map((tool) => tool.function?.name ?? '');
}

/**
 * 按会话 id 确定性等待聊天视图页面（App 在会话切换时写 `__currentSessionId`）。
 * 多视图宿主下 `app.chatPage()` 在新视图尚未完成启动时可能解析回旧视图，
 * 侧栏切换后要用本函数拿到子会话自己的视图。
 */
async function waitForSessionPage(sessionId: string): Promise<import('@playwright/test').Page> {
  let found: import('@playwright/test').Page | null = null;
  await expect
    .poll(async () => {
      for (const page of app.context.pages()) {
        if (!page.url().includes('dist/webview/index.html')) continue;
        try {
          const sid = await page.evaluate(() => (window as any).__currentSessionId ?? null);
          if (sid === sessionId) {
            found = page;
            return true;
          }
        } catch {
          /* 页面正在销毁 */
        }
      }
      return false;
    }, { timeout: 30_000 })
    .toBe(true);
  return found!;
}

/** 从子代理请求里找带指定文案的 tool_result（Bash 拒绝文案断言用） */
function findToolResultText(fragment: string): boolean {
  for (const req of mockLlm.requests) {
    if (lastUserText(req.body.messages) !== TASK_PROMPT) continue;
    for (const message of req.body.messages) {
      if (message.role !== 'tool') continue;
      if (JSON.stringify(message.content).includes(fragment)) return true;
    }
  }
  return false;
}

/** 菜单行的行内置灰透明度（span 沿祖先找第一个带 style.opacity 的 div） */
async function rowOpacity(menu: Locator, text: string): Promise<string | null> {
  return menu.getByText(text, { exact: true }).evaluate((el) => {
    let node: HTMLElement | null = el as HTMLElement;
    const li = el.closest('li');
    while (node && node !== li) {
      if (node.style && node.style.opacity) return node.style.opacity;
      node = node.parentElement;
    }
    return null;
  });
}

test.beforeEach(async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  workspaceDir = await makeWorkspace({ 'README.md': '# 工作区\n' });
  mockLlm = await startMockLlm({ workspaceDir });
  app = await launchApp({ repoRoot, mockLlm, workspaceDir, agentMode: 'auto' });
});

test.afterEach(async () => {
  await app.close();
  mockLlm.close();
  await fs.promises.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
});

test('US-51 explorer：只读四件套、白名单外被拒、选项菜单置灰', async () => {
  mockLlm.setHandler((req): ScriptDecision => {
    const last = req.body.messages[req.body.messages.length - 1];
    const text = lastUserText(req.body.messages);
    if (text === TASK_PROMPT) {
      // Explorer 子代理：首轮故意调 Bash（应被执行侧拒绝），被拒后的下一轮 Reply 收尾
      if (last?.role === 'tool') {
        return { kind: 'tool', name: 'Reply', args: { message: 'Explorer 完成浏览' } };
      }
      return {
        kind: 'tool',
        name: 'Bash',
        args: { command: 'touch marker-explorer.txt', description: '越权尝试' },
      };
    }
    if (text === PARENT_PROMPT) {
      // 父会话：第一轮派 explorer；拿到 Agent 工具结果后收尾
      if (JSON.stringify(req.body.messages).includes('Sub-agent created with ID')) {
        return { kind: 'text', text: 'Explorer 干完了。' };
      }
      return {
        kind: 'tool',
        name: 'Agent',
        args: { prompt: TASK_PROMPT, agentRole: 'Explorer', description: '浏览文件' },
      };
    }
    return { kind: 'text', text: `收到：${text.slice(0, 40)}` };
  });

  const chatPage = await app.chatPage();
  const sb = await app.sidebarPage();
  await chatPage.fill('textarea.input-textarea', PARENT_PROMPT);
  await chatPage.press('textarea.input-textarea', 'Enter');

  // 子代理首请求到达：工具清单恰为四件套（内置定义顺序的过滤投影；
  // 无 Bash / WebSearch / TodoWrite / Agent，无 mcp__*）
  await expect
    .poll(() => subFirstRequests().length, { timeout: 60_000 })
    .toBe(1);
  expect(toolNames(subFirstRequests()[0])).toEqual(['Read', 'Grep', 'Glob', 'Reply']);

  // 白名单外的 Bash 被执行侧拒绝：tool_result 点名角色与可用工具，且命令未执行
  await expect
    .poll(
      () => findToolResultText('Explorer 子代理只有 Read / Glob / Grep / Reply 工具，Bash 不可用'),
      { timeout: 30_000 },
    )
    .toBe(true);
  expect(fs.existsSync(path.join(workspaceDir, 'marker-explorer.txt'))).toBe(false);

  // 会话未中止：子代理 Reply 投递回父会话并收尾（侧栏父 1 + 子 1）
  await expect
    .poll(() => sb.locator(SIDEBAR_ITEM).count(), { timeout: 30_000 })
    .toBe(2);

  // 打开 explorer 子会话视图（标题 = description「浏览文件」）。
  // 多视图宿主下 chatPage() 的解析在子视图尚未写入 __currentSessionId 时会竞态回
  // 父视图，这里按侧栏条目的 data-session-id 确定性等待子视图页面。
  const subSessionId = await sb.locator(SIDEBAR_ITEM).last().getAttribute('data-session-id');
  await sb.locator(SIDEBAR_ITEM).last().click();
  const subPage = await waitForSessionPage(subSessionId!);
  const menuButton = subPage.locator('button[title="功能开关"]');
  await expect(menuButton).toBeVisible();
  await menuButton.click();
  const menu = subPage.locator('ul.agent-mode-menu');
  await expect(menu).toBeVisible();

  // 三项置灰（specs/020 FR-005）：标签行行内 opacity 0.45
  expect(await rowOpacity(menu, '联网搜索')).toBe('0.45');
  expect(await rowOpacity(menu, '提示词模式')).toBe('0.45');
  expect(await rowOpacity(menu, 'MCP')).toBe('0.45');

  // 点击不产生任何变更：提示词模式点「极简」后「普通」仍高亮（onChange 被锁定早退）
  const selected = (label: string) =>
    menu.getByRole('button', { name: label, exact: true }).evaluate(
      (el) => getComputedStyle(el).color === 'rgb(255, 255, 255)',
    );
  expect(await selected('普通')).toBe(true);
  await menu.getByRole('button', { name: '极简', exact: true }).click({ force: true });
  expect(await selected('普通')).toBe(true);
  expect(await selected('极简')).toBe(false);

  // 联网搜索行同样锁定：点击后不发送变更（行为上无副作用；置灰样式已断言）
  await menu.getByText('联网搜索', { exact: true }).click({ force: true }).catch(() => undefined);
  expect(await rowOpacity(menu, '联网搜索')).toBe('0.45');
});

test('US-51 Master 子代理与普通会话：选项菜单照常可操作（不回归）', async () => {
  mockLlm.setHandler((req): ScriptDecision => {
    const text = lastUserText(req.body.messages);
    if (text === TASK_PROMPT) {
      // Master 子代理：首轮直接 Reply 收尾
      return { kind: 'tool', name: 'Reply', args: { message: 'Master 子代理完成' } };
    }
    if (text === '派个 Master 看看') {
      if (JSON.stringify(req.body.messages).includes('Sub-agent created with ID')) {
        return { kind: 'text', text: 'Master 干完了。' };
      }
      return {
        kind: 'tool',
        name: 'Agent',
        args: { prompt: TASK_PROMPT, agentRole: 'Master', description: '干活文件' },
      };
    }
    return { kind: 'text', text: `收到：${text.slice(0, 40)}` };
  });

  const chatPage = await app.chatPage();
  const sb = await app.sidebarPage();
  await chatPage.fill('textarea.input-textarea', '派个 Master 看看');
  await chatPage.press('textarea.input-textarea', 'Enter');

  // Master 子代理照常创建并收尾（侧栏父 1 + 子 1）
  await expect
    .poll(() => sb.locator(SIDEBAR_ITEM).count(), { timeout: 60_000 })
    .toBe(2);

  // 普通会话（父会话视图）：三项不置灰（行内 opacity 为 1）
  const menuButton = chatPage.locator('button[title="功能开关"]');
  await menuButton.click();
  const menu = chatPage.locator('ul.agent-mode-menu');
  await expect(menu).toBeVisible();
  expect(await rowOpacity(menu, '联网搜索')).toBe('1');
  expect(await rowOpacity(menu, '提示词模式')).toBe('1');
  expect(await rowOpacity(menu, 'MCP')).toBe('1');
  await chatPage.keyboard.press('Escape');

  // Master 子代理视图：同样不置灰（specs/020 FR-005 只锁非 Master 角色）
  const masterSubSessionId = await sb.locator(SIDEBAR_ITEM).last().getAttribute('data-session-id');
  await sb.locator(SIDEBAR_ITEM).last().click();
  const subPage = await waitForSessionPage(masterSubSessionId!);
  const subMenuButton = subPage.locator('button[title="功能开关"]');
  await expect(subMenuButton).toBeVisible();
  await subMenuButton.click();
  const subMenu = subPage.locator('ul.agent-mode-menu');
  await expect(subMenu).toBeVisible();
  expect(await rowOpacity(subMenu, '联网搜索')).toBe('1');
  expect(await rowOpacity(subMenu, '提示词模式')).toBe('1');
  expect(await rowOpacity(subMenu, 'MCP')).toBe('1');
});
