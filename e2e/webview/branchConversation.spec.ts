import { test, expect } from '@playwright/test';
import { openWebviewView } from '../helpers/webviewHarness';

/**
 * 分支对话的纯 UI 形态（specs/037 US-74 / US-75 / US-76）。
 *
 * 只覆盖**不依赖 Core**的渲染与交互：split 下拉两项、非 git 置灰与双语文案、草稿页的
 * 脏工作区提示、标题前的分支名（桩事件注入 `branchState`）、消息区无分支横幅。
 * worktree 创建 / 复用 / 清理 / 分支指针 / 可见性边界一律不在 e2e 覆盖——e2e 车道没有
 * git 仓库夹具，证据在 `core-rs/src/branch/*_tests.rs` 与 `src/test/standaloneBranch.test.ts`。
 */

const REPO_ROOT = process.cwd().replace(/[\\/]e2e$/, '');

/** 注入一条分支状态（模拟 core 的 `branchStateChanged` 投影） */
async function injectBranchState(
  page: import('@playwright/test').Page,
  view: unknown,
  sessionId: string,
): Promise<void> {
  await page.evaluate(
    (payload) => window.postMessage(payload, '*'),
    { type: 'branchState', sessionId, view },
  );
}

test.describe('分支对话的入口与展示（FR-006 / US-74 / US-76）', () => {
  test('新对话是 split button：主「+」走普通方式，小三角展开两项且无选中态', async ({ browser }) => {
    const { page, host, close } = await openWebviewView(browser, REPO_ROOT);
    try {
      const main = page.getByTestId('new-chat-main');
      const caret = page.getByTestId('new-chat-caret');
      await expect(main).toBeVisible();
      await expect(caret).toBeVisible();

      // 主「+」恒为普通方式：点它不带形态标记（`mode` 缺省即 plain）
      await main.click();
      await host.waitForSent('startNewConversation');
      const started = await host.waitForSent('startNewConversation');
      expect(started.mode ?? 'plain').toBe('plain');

      // 小三角展开两项
      await caret.click();
      const menu = page.getByRole('menu');
      await expect(menu.getByText('普通对话')).toBeVisible();
      await expect(menu.getByText('分支对话')).toBeVisible();
      // 一次性创建动作、无选中态：菜单里没有 checked / selected 标记
      await expect(menu.locator('[aria-checked="true"]')).toHaveCount(0);
    } finally {
      await close();
    }
  });

  test('非 git 工作区：分支对话项置灰并说明原因（含英文文案）', async ({ browser }) => {
    const { page, host, close } = await openWebviewView(browser, REPO_ROOT);
    try {
      // 让前置数据回 not-git（会话建立前没有 branchStateChanged，只有这一条来源）
      await page.evaluate(() => {
        (window as any).__fakeHost.state.branchPrecheck = {
          ok: false,
          reason: 'not-git',
          detail: 'not a git repository',
        };
      });
      await page.getByTestId('new-chat-caret').click();
      const menu = page.getByRole('menu');
      const branchItem = menu.getByRole('menuitem', { name: /分支对话|Branch conversation/ });
      await expect(branchItem).toBeVisible();
      // 置灰：aria-disabled（antd 的 disabled 项不可点）
      await expect(branchItem).toHaveAttribute('aria-disabled', 'true');
      // 点了也不产生任何上行（置灰项不可选中）
      const before = (await host.sentAll()).filter((m) => m.type === 'startNewConversation').length;
      await branchItem.click({ force: true }).catch(() => undefined);
      const after = (await host.sentAll()).filter((m) => m.type === 'startNewConversation').length;
      expect(after).toBe(before);
    } finally {
      await close();
    }
  });

  test('分支草稿页：只在主工作区脏时显示一行提示，且不显示分支名', async ({ browser }) => {
    const { page, close } = await openWebviewView(browser, REPO_ROOT);
    try {
      // 脏工作区
      await page.evaluate(() => {
        (window as any).__fakeHost.state.branchPrecheck = {
          ok: true,
          head: 'abc1234',
          dirty: true,
          baseBranch: 'main',
        };
      });
      // 打开分支形态的草稿页
      await page.getByTestId('new-chat-caret').click();
      await page.getByRole('menu').getByRole('menuitem', { name: /分支对话|Branch conversation/ }).click();

      const hint = page.getByTestId('branch-dirty-hint');
      await expect(hint).toBeVisible();
      await expect(hint).toContainText('abc1234');
      // 草稿页不显示分支名（名字在会话建立时才生成，草稿页不猜值）
      await expect(page.getByTestId('title-branch-name')).toHaveCount(0);
      // 也不出现「分支对话」字样的常驻标记
      await expect(page.locator('h1')).not.toContainText('分支对话');

      // 主工作区干净时不显示提示
      await page.evaluate(() => {
        (window as any).__fakeHost.state.branchPrecheck = {
          ok: true,
          head: 'abc1234',
          dirty: false,
          baseBranch: 'main',
        };
      });
      await page.getByTestId('new-chat-caret').click();
      await page.getByRole('menu').getByRole('menuitem', { name: /普通对话|Plain conversation/ }).click();
      await expect(page.getByTestId('branch-dirty-hint')).toHaveCount(0);
    } finally {
      await close();
    }
  });

  test('分支对话的顶栏：分支名在会话标题前，只有名字本身（无图标、无字样、消息区无横幅）', async ({ browser }) => {
    const { page, close } = await openWebviewView(browser, REPO_ROOT);
    try {
      const sessionId = await page.evaluate(() => (window as any).__fakeHost.state.lastSessionId ?? null);
      void sessionId;
      // 先建立会话（走一次普通创建，拿到 currentSessionId）
      await page.getByTestId('new-chat-main').click();
      const current = await page.evaluate(() => {
        const sent = (window as any).__fakeHost.sent;
        const last = [...sent].reverse().find((m: any) => m.type === 'startNewConversation');
        return last?.sessionId ?? null;
      });
      expect(current).toBeTruthy();

      await injectBranchState(page, {
        state: 'ready',
        branch: 'ellen-k3f',
        worktree: '/core/worktrees/ellen-k3f',
        baseCommit: 'c1d8a05aaaa',
        baseBranch: 'main',
      }, current!);

      const branchName = page.getByTestId('title-branch-name');
      await expect(branchName).toBeVisible();
      // 只有名字本身：不带 tuxedo/ 前缀、不带「分支对话」字样
      await expect(branchName).toHaveText('ellen-k3f');
      // 悬停显示完整分支名
      await expect(branchName).toHaveAttribute('title', /tuxedo\/ellen-k3f/);
      // 标题区里没有图标（标题前只有一个文本节点）
      expect(await branchName.locator('svg, .ti').count()).toBe(0);
      // 分支名在 h1 之前
      const order = await page.evaluate(() => {
        const name = document.querySelector('[data-testid="title-branch-name"]');
        const title = document.querySelector('h1');
        if (!name || !title) return null;
        return name.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING ? 'name-first' : 'title-first';
      });
      expect(order).toBe('name-first');
      // 消息区与状态条没有分支横幅 / 依赖策略 / 并行计数 / 发布按钮
      await expect(page.getByTestId('branch-banner')).toHaveCount(0);
      await expect(page.getByText(/发布分支|publish branch/i)).toHaveCount(0);
      await expect(page.getByText(/worktree 状态|依赖策略/)).toHaveCount(0);
    } finally {
      await close();
    }
  });

  test('unavailable 时分支名转警告色并给出原因，不出现常驻状态区', async ({ browser }) => {
    const { page, close } = await openWebviewView(browser, REPO_ROOT);
    try {
      await page.getByTestId('new-chat-main').click();
      const current = await page.evaluate(() => {
        const sent = (window as any).__fakeHost.sent;
        const last = [...sent].reverse().find((m: any) => m.type === 'startNewConversation');
        return last?.sessionId ?? null;
      });
      await injectBranchState(page, {
        state: 'unavailable',
        reason: 'worktree-missing',
        detail: 'worktree /core/worktrees/ellen-k3f no longer exists',
      }, current!);
      const marker = page.getByTestId('title-branch-name');
      await expect(marker).toBeVisible();
      await expect(marker).toHaveAttribute('title', /no longer exists/);
      // 它是异常提示而不是常驻状态区：只有这一处标记，没有额外的横幅区块
      await expect(page.getByTestId('title-branch-name')).toHaveCount(1);
      await expect(page.getByTestId('branch-banner')).toHaveCount(0);
    } finally {
      await close();
    }
  });
});

test.describe('对话列表的分支名（FR-006 AC-18 / US-75）', () => {
  test('分支对话的条目标题前显示分支名，悬停显示全名与来源', async ({ browser }) => {
    const { page, close } = await openWebviewView(browser, REPO_ROOT);
    try {
      await page.evaluate(() => {
        (window as any).__fakeHost.state.conversations = [
          {
            sessionId: 's-branch',
            title: '修复登录超时问题',
            createdAt: Date.now() - 60_000,
            updatedAt: Date.now(),
            messageCount: 3,
            branch: {
              name: 'ellen-k3f',
              worktree: '/core/worktrees/ellen-k3f',
              baseCommit: 'c1d8a05ffff',
              baseBranch: 'main',
            },
          },
          {
            sessionId: 's-plain',
            title: '整理 docs 里的架构图',
            createdAt: Date.now() - 120_000,
            updatedAt: Date.now() - 60_000,
            messageCount: 2,
            branch: null,
          },
        ];
      });
      await page.evaluate(() => (window as any).__fakeHost.send({ type: 'conversationsData', conversations: (window as any).__fakeHost.state.conversations }));

      // 打开对话历史下拉
      await page.locator('button[title*="对话历史"], button[title*="conversation history" i]').first().click();
      const branchName = page.getByTestId('list-branch-name').first();
      await expect(branchName).toHaveText('ellen-k3f');
      await expect(branchName).toHaveAttribute('title', /ellen-k3f/);
      // 普通会话的条目没有分支名（只有分支会话那一条）
      await expect(page.getByTestId('list-branch-name')).toHaveCount(1);
      // 无图标
      expect(await branchName.locator('svg').count()).toBe(0);
    } finally {
      await close();
    }
  });
});
