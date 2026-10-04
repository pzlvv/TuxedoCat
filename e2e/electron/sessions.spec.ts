import { test, expect, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from '../helpers/mockLlmServer';
import { launchApp, makeWorkspace, stubMainMessageBox } from '../helpers/electronApp';
import type { AppHandle } from '../helpers/electronApp';
import type { MockLlm } from '../helpers/mockLlmServer';

/**
 * US-19 侧栏对话列表 / US-20 新建对话 / US-21 重命名 / US-22 删除（Electron 原生侧栏）
 *
 * 条目断言不带前缀过滤：会话目录里的 workspace.meta.json（工作区清单）不是会话，
 * 混进列表是幽灵条目（回归即此处 toHaveCount 失败）。
 */
const SIDEBAR_ITEM = '#list .item[data-session-id]';

let mockLlm: MockLlm;
let app: AppHandle;
let workspaceDir: string;

test.beforeEach(async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  workspaceDir = await makeWorkspace({});
  mockLlm = await startMockLlm({ workspaceDir });
  app = await launchApp({ repoRoot, mockLlm, workspaceDir });
});

test.afterEach(async () => {
  await app.close();
  mockLlm.close();
  await fs.promises.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
});

async function chat(): Promise<Page> {
  return app.chatPage();
}

async function sidebar(): Promise<Page> {
  return app.sidebarPage();
}

/** 发一条消息让当前「新对话」落盘成会话（标题自动取首条消息） */
async function sendMessage(text: string): Promise<void> {
  const chatPage = await chat();
  await chatPage.fill('textarea.input-textarea', text);
  await chatPage.press('textarea.input-textarea', 'Enter');
}

function items(page: Page): Locator {
  return page.locator(SIDEBAR_ITEM);
}

test('US-19 发送消息后侧栏出现会话条目并显示消息数', async () => {
  const sb = await sidebar();
  await sendMessage('创建第一个会话');
  await expect(items(sb).first()).toBeVisible({ timeout: 30_000 });
  await expect(items(sb).first()).toContainText('2 条');
  // 只有一个会话：清单混进列表（幽灵条目）会在这里多出一条
  await expect(items(sb)).toHaveCount(1);

  // 对话在磁盘上落盘（meta + jsonl）
  const conversationsRoot = path.join(app.homeDir, '.tuxedo-cat', 'conversations');
  const projectDir = fs.readdirSync(conversationsRoot)[0];
  const files = fs.readdirSync(path.join(conversationsRoot, projectDir));
  expect(files.some((f) => f.startsWith('session_') && f.endsWith('.meta.json'))).toBe(true);
  expect(files.some((f) => f.endsWith('.jsonl'))).toBe(true);
});

test('US-20 侧栏「+ 新对话」切到新的空会话', async () => {
  const sb = await sidebar();
  await sendMessage('第一个会话的内容');
  await expect(items(sb)).toHaveCount(1, { timeout: 30_000 });

  await sb.locator('#newChat').click();
  // 聊天区切到新会话：等到「已激活的空会话视图」（会话已生成、消息区空态）
  const newChat = await app.chatPage({ emptyState: true });
  await expect(newChat.locator('textarea.input-textarea')).toBeEnabled();
  await expect(newChat.getByText('第一个会话的内容')).toHaveCount(0, { timeout: 15_000 });
  // 给宿主一点处理会话登记的时间（真实用户的输入节奏）
  await new Promise((r) => setTimeout(r, 500));

  // 在新会话里发消息后列表出现第二个条目（最新会话排最前，标题自动取新消息）
  await sendMessage('第二个会话的内容');
  await expect(items(sb)).toHaveCount(2, { timeout: 30_000 });
  await expect(items(sb).first()).toContainText('第二个会话的内容');
});

test('US-21 侧栏重命名会话（行内输入，Enter 提交）', async () => {
  const sb = await sidebar();
  await sendMessage('即将被重命名的会话');
  const item = items(sb).first();
  await expect(item).toBeVisible({ timeout: 30_000 });

  await item.hover();
  await item.locator('[data-action="rename"]').click();
  const renameInput = sb.locator('.rename-input');
  await expect(renameInput).toBeVisible();
  await renameInput.fill('我的重命名会话');
  await renameInput.press('Enter');

  // 标题更新 + 落盘到 meta.json
  await expect(item).toContainText('我的重命名会话', { timeout: 15_000 });
  const conversationsRoot = path.join(app.homeDir, '.tuxedo-cat', 'conversations');
  const projectDir = fs.readdirSync(conversationsRoot)[0];
  const metaFile = fs.readdirSync(path.join(conversationsRoot, projectDir))
    .find((f) => f.startsWith('session_') && f.endsWith('.meta.json'))!;
  const meta = JSON.parse(fs.readFileSync(path.join(conversationsRoot, projectDir, metaFile), 'utf8'));
  expect(meta.title).toBe('我的重命名会话');
});

test('US-22 侧栏删除会话带二次确认，确认后数据删除', async () => {
  const sb = await sidebar();
  await sendMessage('将被删除的会话');
  const item = items(sb).first();
  await expect(item).toBeVisible({ timeout: 30_000 });

  await item.hover();
  await item.locator('[data-action="delete"]').click();
  // 行内二次确认条
  await expect(item.locator('[data-action="confirm-delete"]')).toBeVisible();
  await item.locator('[data-action="confirm-delete"]').click();

  // 删除当前打开的会话：聊天区切到新对话（输入框可用）
  await expect((await chat()).locator('textarea.input-textarea')).toBeEnabled({ timeout: 30_000 });

  // 磁盘数据被删除（meta + jsonl 均不在）
  const conversationsRoot = path.join(app.homeDir, '.tuxedo-cat', 'conversations');
  const projectDir = fs.readdirSync(conversationsRoot)[0];
  await expect.poll(
    () => fs.readdirSync(path.join(conversationsRoot, projectDir))
      .filter((f) => f.startsWith('session_')).length,
    { timeout: 15_000 },
  ).toBe(0);
  // 侧栏条目随 conversationListChanged 自动消失（列表刷新链路回归即此处失败）
  await expect(items(sb)).toHaveCount(0, { timeout: 15_000 });
});

test('US-19 关闭非 idle 对话需二次确认', async () => {
  const sb = await sidebar();
  await sendMessage('慢速回答一段长内容');
  const item = items(sb).first();
  await expect(item).toBeVisible({ timeout: 30_000 });
  // 慢速查询在跑：条目标记非 idle（流水灯），且该对话的视图已打开
  await expect(item.locator('.running-bar')).toBeVisible({ timeout: 30_000 });
  await expect(item.locator('.loaded-dot')).toBeVisible();

  const messageBox = await stubMainMessageBox(app);

  // 取消（默认返回下标 1）：视图与运行都保留
  await item.hover();
  await item.locator('[data-action="close"]').click();
  await expect.poll(() => messageBox.calls()).toHaveLength(1);
  expect((await messageBox.calls())[0].message).toBe('该对话正在运行');
  await expect(item.locator('.loaded-dot')).toBeVisible();
  await expect(item.locator('.running-bar')).toBeVisible();

  // 确认：视图销毁（已打开标记消失）、运行中止（流水灯消失）
  await messageBox.setResponse(0);
  await item.hover();
  await item.locator('[data-action="close"]').click();
  await expect.poll(() => messageBox.calls()).toHaveLength(2);
  await expect(item.locator('.loaded-dot')).toHaveCount(0, { timeout: 30_000 });
  await expect(item.locator('.running-bar')).toHaveCount(0, { timeout: 30_000 });
});

test('US-19 侧栏搜索框按标题过滤对话', async () => {
  const sb = await sidebar();
  await sendMessage('独特关键词会话');
  await expect(items(sb).first()).toBeVisible({ timeout: 30_000 });

  // 搜不到的内容：空态文案；搜首条消息（自动标题）：命中一条
  await sb.locator('#searchInput').fill('完全不存在的内容');
  await expect(sb.locator('#list')).toContainText('没有匹配的对话', { timeout: 10_000 });
  await sb.locator('#searchInput').fill('独特关键词');
  await expect(items(sb)).toHaveCount(1, { timeout: 10_000 });
});

test('US-19 列表等待超过 100ms 才显示加载中，快速切换不闪转圈', async () => {
  const sb = await sidebar();
  // 记录 #list 的内容变化序列（loading / item / empty 的去重序列）：
  // - 慢拉取（主进程钩子注入 800ms 延迟）：切换工作区等待超过 100ms，必须出现「加载中」；
  // - 快拉取（撤销注入，毫秒级回包）：切换工作区不得闪转圈——否则 tab 页间切换闪烁。
  // 延时阈值 100ms（sidebar 的 LOADING_SHOW_DELAY_MS）；拉取延迟钩子是主进程的
  // TUXEDO_CAT_E2E_SLOW_LIST_MS（隐藏开关；页面侧 window.sidebarAPI 不可写）。
  const dir2 = await makeWorkspace({}, 'e2e-ws-second');
  try {
    await sb.evaluate(() => {
      const w = window as unknown as { __listContentLog?: string[]; __resetListLog?: () => void };
      const list = document.getElementById('list')!;
      w.__listContentLog = [];
      let prev: string | null = null;
      new MutationObserver(() => {
        const cur = list.querySelector('.list-loading') ? 'loading'
          : list.querySelector('.item') ? 'item'
          : (list.textContent || '').includes('暂无对话') ? 'empty' : null;
        if (cur && cur !== prev) {
          prev = cur;
          w.__listContentLog!.push(cur);
        }
      }).observe(list, { childList: true });
      w.__resetListLog = () => { w.__listContentLog = []; prev = null; };
    });

    // 慢路径：加第二个工作区并切为活动项，拉取被延迟 800ms，等待超过 100ms 必出转圈
    await app.evaluateInMain("process.env.TUXEDO_CAT_E2E_SLOW_LIST_MS = '800'");
    await sb.evaluate((dir) =>
      (window as unknown as { sidebarAPI?: { addWorkspaces: (paths: string[]) => void } })
        .sidebarAPI!.addWorkspaces([dir as string]), dir2);
    await expect.poll(
      () => sb.evaluate(() => {
        const log = (window as unknown as { __listContentLog?: string[] }).__listContentLog ?? [];
        return log.includes('loading') && log[log.length - 1] === 'empty';
      }),
      { timeout: 30_000 },
    ).toBe(true);

    // 快路径：撤销注入，按 id 切回第一个工作区（activate-workspace 的字符串参数是
    // refKey 不是路径），列表毫秒级回包，不得出现转圈
    await app.evaluateInMain('delete process.env.TUXEDO_CAT_E2E_SLOW_LIST_MS');
    await sb.evaluate(async (wsPath) => {
      const w = window as unknown as {
        sidebarAPI?: {
          getWorkspaces: () => Promise<{ workspaces: Array<{ id: string; path: string }> }>;
          openWorkspace: (id: string) => void;
        };
        __resetListLog?: () => void;
      };
      w.__resetListLog!();
      const state = await w.sidebarAPI!.getWorkspaces();
      const target = state.workspaces.find((t) => t.path === (wsPath as string));
      if (target) w.sidebarAPI!.openWorkspace(target.id);
    }, app.workspaceDir);
    await expect.poll(
      () => sb.evaluate(() => {
        const log = (window as unknown as { __listContentLog?: string[] }).__listContentLog ?? [];
        return log.length > 0 && log[log.length - 1] === 'empty';
      }),
      { timeout: 30_000 },
    ).toBe(true);
    const fastSeq = await sb.evaluate(() =>
      (window as unknown as { __listContentLog?: string[] }).__listContentLog);
    expect(fastSeq).not.toContain('loading');
  } finally {
    await fs.promises.rm(dir2, { recursive: true, force: true }).catch(() => undefined);
  }
});
