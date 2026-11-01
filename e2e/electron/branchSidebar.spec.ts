import { test, expect, type Locator, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from '../helpers/mockLlmServer';
import { launchApp, makeWorkspace } from '../helpers/electronApp';
import type { AppHandle } from '../helpers/electronApp';
import type { MockLlm } from '../helpers/mockLlmServer';
import { CONFIG_DIR_NAME } from '../../src/config/project';

/**
 * 分支对话的 Electron 原生侧栏入口（specs/037 FR-006）。
 *
 * 覆盖两件只有整应用链路才成立的事：
 * - 侧栏「新对话」也是 split button：小三角展开两项，非 git 仓库时分支项置灰；
 * - 在真实 git 仓库里经侧栏建一条分支对话：草稿页标题前出现分支图标，发送第一条消息后
 *   会话以分支形态落盘（`meta.json` 的 `branch`），侧栏条目显示分支名。
 *
 * worktree 的创建 / 复用 / 清理与分支指针推进不在本文件的覆盖范围（那部分由
 * `core-rs/src/branch/*_tests.rs` 与 `src/test/standaloneBranch.test.ts` 锁定）。
 */

const SIDEBAR_ITEM = '#list .item[data-session-id]';

let mockLlm: MockLlm;
let app: AppHandle;
let workspaceDir: string;

async function git(cwd: string, ...args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
  });
}

/** 把工作区初始化成真实 git 仓库并提交基线（分支创建的前置条件） */
async function initGitRepo(): Promise<void> {
  await git(workspaceDir, 'init', '-q');
  await git(workspaceDir, 'config', 'user.email', 'e2e@t');
  await git(workspaceDir, 'config', 'user.name', 'e2e');
  await fs.promises.writeFile(path.join(workspaceDir, 'readme.md'), 'base\n');
  await git(workspaceDir, 'add', '-A');
  await git(workspaceDir, 'commit', '-q', '-m', 'base');
}

async function sidebar(): Promise<Page> {
  return app.sidebarPage();
}

function items(page: Page): Locator {
  return page.locator(SIDEBAR_ITEM);
}

test.describe('Electron 侧栏的分支对话入口（FR-006 / US-76）', () => {
  test.beforeEach(async () => {
    const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
    workspaceDir = await makeWorkspace({});
    await initGitRepo();
    mockLlm = await startMockLlm({ workspaceDir });
    app = await launchApp({ repoRoot, mockLlm, workspaceDir });
  });

  test.afterEach(async () => {
    await app.close();
    mockLlm.close();
  });

  test('US-76 侧栏新对话是 split button：小三角展开普通 / 分支两项，分支项在 git 仓库里可选', async () => {
    const sb = await sidebar();
    // 主「+」恒为普通方式新建：点它切到普通草稿页（没有分支图标）
    await sb.locator('#newChat').click();
    const chatPage = await app.chatPage({ emptyState: true, draftMode: 'plain' });
    await expect(chatPage.locator('textarea.input-textarea')).toBeEnabled();
    await expect(chatPage.getByTestId('draft-branch-icon')).toHaveCount(0);

    // 小三角展开两项；分支项在真实 git 仓库里可选
    await sb.locator('#newChatCaret').click();
    const menu = sb.locator('.actions-menu.open');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /普通对话/ })).toBeVisible();
    const branchItem = menu.getByRole('menuitem', { name: /分支对话/ });
    await expect(branchItem).toBeVisible();
    await expect(branchItem).not.toHaveAttribute('disabled', '');
  });

  test('US-76 分支对话：草稿页标题前有分支图标，发送首条消息后侧栏条目显示分支名', async () => {
    const sb = await sidebar();
    await sb.locator('#newChatCaret').click();
    const menu = sb.locator('.actions-menu.open');
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: /分支对话/ }).click();

    // 分支形态的草稿页：标题前有分支图标，且不显示分支名（草稿页只留形态）
    const chatPage = await app.chatPage({ emptyState: true, draftMode: 'branch' });
    await expect(chatPage.getByTestId('draft-branch-icon')).toBeVisible({ timeout: 30_000 });
    await expect(chatPage.getByTestId('title-branch-name')).toHaveCount(0);

    // 发送第一条消息 → 会话以分支形态建立，侧栏条目出现分支名。
    // 必须往**这个**分支草稿页里发：同屏还可能有普通预热视图，默认解析会选到它。
    await chatPage.fill('textarea.input-textarea', '分支对话的第一条消息');
    await chatPage.press('textarea.input-textarea', 'Enter');
    const item = items(sb).first();
    await expect(item).toBeVisible({ timeout: 60_000 });
    const branchName = item.getByTestId('sidebar-branch-name');
    await expect(branchName).toBeVisible({ timeout: 60_000 });
    // 只有名字本身（不带 tuxedo/ 前缀）；悬停显示完整分支名与来源
    const sessionId = await item.getAttribute('data-session-id');
    if (!sessionId) throw new Error('侧栏条目缺少 data-session-id');
    const name = (await branchName.textContent())?.trim() ?? '';
    expect(name).toMatch(/^[a-z]+(-[a-z]+)*-[a-z0-9]{3}$/);
    await expect(branchName).toHaveAttribute('title', new RegExp(`tuxedo/${name}`));

    // 落盘事实：meta.json 的 branch 字段与侧栏一致（宿主不编造分支名）。
    // meta 由 Core 在首条消息落盘时写，晚于列表推送一瞬，因此轮询等一次。
    await expect.poll(async () => (await readOnlySessionMeta(sessionId))?.branch?.name, { timeout: 20_000 })
      .toBe(name);
    const meta = await readOnlySessionMeta(sessionId) as { branch?: { worktree?: string } };
    expect(String(meta.branch?.worktree ?? '')).toContain(name);
  });
});

/**
 * 读本次用例建立的**那一条**会话的 `meta.json`。
 *
 * 按会话 id 精确定位：会话目录里还会有工作区清单等非会话文件，取第一个
 * `session_*.meta.json` 在多会话 / 重启场景会读到别的会话。
 */
async function readOnlySessionMeta(sessionId: string): Promise<{
  title?: string;
  branch?: { name: string; worktree: string; baseCommit: string; baseBranch: string } | null;
}> {
  const conversationsRoot = path.join(app.homeDir, CONFIG_DIR_NAME, 'conversations');
  for (const projectDir of fs.readdirSync(conversationsRoot)) {
    const dir = path.join(conversationsRoot, projectDir);
    const target = path.join(dir, `${sessionId}.meta.json`);
    if (!fs.existsSync(target)) continue;
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  }
  return {};
}
