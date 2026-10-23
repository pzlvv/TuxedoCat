import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockLlm, lastUserText } from '../helpers/mockLlmServer';
import { launchApp, makeWorkspace } from '../helpers/electronApp';
import type { AppHandle } from '../helpers/electronApp';
import type { MockLlm, ScriptDecision } from '../helpers/mockLlmServer';

/**
 * US-56 跨工作区代理（specs/023）
 *
 * Electron 整应用链路：两个本地工作区同时打开，父会话（工作区 A）一轮发出带
 * `target` 的 `Agent` 调用，断言子代理会话创建在工作区 B、B 的列表里出现
 * 「占位父对话 + 子代理」的树，A 的列表不出现该子代理。
 *
 * 身份口径与 `src/host/workspaceIdentity.ts` 一致：`机器名:path.resolve(目录)`。
 */

let mockLlm: MockLlm;
let app: AppHandle | null = null;
let workspaceA: string;
let workspaceB: string;

const SIDEBAR_ITEM = '#list .item[data-session-id]';

function machineName(): string {
  const fromEnv = process.platform === 'win32' ? process.env.COMPUTERNAME : process.env.HOSTNAME;
  return (fromEnv && fromEnv.trim()) || os.hostname();
}

function agentId(dir: string): string {
  return `${machineName()}:${path.resolve(dir)}`;
}

test.beforeEach(async () => {
  workspaceA = await makeWorkspace({ 'a.md': 'A' }, 'e2e-cross-a');
  workspaceB = await makeWorkspace({ 'b.md': 'B' }, 'e2e-cross-b');
  mockLlm = await startMockLlm({ workspaceDir: workspaceA });
});

test.afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  mockLlm.close();
  await fs.promises.rm(workspaceA, { recursive: true, force: true }).catch(() => undefined);
  await fs.promises.rm(workspaceB, { recursive: true, force: true }).catch(() => undefined);
});

test('US-56 跨工作区派发：子代理落在目标工作区，目标侧出现占位父对话', async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  app = await launchApp({
    repoRoot,
    mockLlm,
    workspaceDir: workspaceA,
    openWorkspaces: [workspaceA, workspaceB],
    activeWorkspace: workspaceA,
    agentMode: 'auto',
  });

  mockLlm.setHandler((req): ScriptDecision => {
    const text = lastUserText(req.body.messages);
    if (text === '在 B 里做点事') {
      // 目标工作区的子代理：首轮 Reply 回投发起方
      if (req.body.messages[req.body.messages.length - 1]?.role === 'tool') {
        return { kind: 'text', text: 'B 里做完了。' };
      }
      return { kind: 'tool', name: 'Reply', args: { message: 'B 里做完了。' } };
    }
    if (JSON.stringify(req.body.messages).includes('派给另一个工作区')) {
      if (JSON.stringify(req.body.messages).includes('Sub-agent created with ID')) {
        return { kind: 'text', text: '已经派给 B。' };
      }
      return {
        kind: 'tool',
        name: 'Agent',
        args: {
          prompt: '在 B 里做点事',
          agentRole: 'Master',
          description: '跨工作区任务',
          target: agentId(workspaceB),
        },
      };
    }
    return { kind: 'text', text: `收到：${text.slice(0, 40)}` };
  });

  const titlebar = await app.titlebarPage();
  const tabs = titlebar.locator('#workspaceTabs [role="tab"]');
  await expect(tabs).toHaveCount(2, { timeout: 20_000 });

  const chatA = await app.chatPage();
  await chatA.fill('textarea.input-textarea', '派给另一个工作区');
  await chatA.press('textarea.input-textarea', 'Enter');

  // 切到工作区 B：列表里出现占位父对话（标题带「跨工作区容器」标记）
  await tabs.nth(1).click();
  const sidebarB = await app.sidebarPage();
  const placeholder = sidebarB.locator(SIDEBAR_ITEM).filter({ hasText: '跨工作区容器' });
  await expect(placeholder).toHaveCount(1, { timeout: 30_000 });

  // 展开占位节点：子代理会话挂在它下面
  await placeholder.locator('[data-action="toggle-sub"]').click();
  await expect(
    sidebarB.locator(`${SIDEBAR_ITEM}.child`).filter({ hasText: '跨工作区任务' }),
  ).toHaveCount(1, { timeout: 15_000 });

  // 工作区 A 的列表里没有这个子代理（它归属目标工作区）
  await tabs.nth(0).click();
  const sidebarA = await app.sidebarPage();
  await expect(
    sidebarA.locator(SIDEBAR_ITEM).filter({ hasText: '跨工作区任务' }),
  ).toHaveCount(0);
});

test('US-56 占位页跳转：发起方工作区已打开时显示跳转链接（specs/023 FR-005 / AC-11）', async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  app = await launchApp({
    repoRoot,
    mockLlm,
    workspaceDir: workspaceA,
    openWorkspaces: [workspaceA, workspaceB],
    activeWorkspace: workspaceA,
    agentMode: 'auto',
  });

  mockLlm.setHandler((req): ScriptDecision => {
    const text = lastUserText(req.body.messages);
    if (text === '在 B 里做点事') {
      if (req.body.messages[req.body.messages.length - 1]?.role === 'tool') {
        return { kind: 'text', text: 'B 里做完了。' };
      }
      return { kind: 'tool', name: 'Reply', args: { message: 'B 里做完了。' } };
    }
    if (JSON.stringify(req.body.messages).includes('派给另一个工作区')) {
      if (JSON.stringify(req.body.messages).includes('Sub-agent created with ID')) {
        return { kind: 'text', text: '已经派给 B。' };
      }
      return {
        kind: 'tool',
        name: 'Agent',
        args: {
          prompt: '在 B 里做点事',
          agentRole: 'Master',
          description: '跨工作区任务',
          target: agentId(workspaceB),
        },
      };
    }
    return { kind: 'text', text: `收到：${text.slice(0, 40)}` };
  });

  const titlebar = await app.titlebarPage();
  const tabs = titlebar.locator('#workspaceTabs [role="tab"]');
  await expect(tabs).toHaveCount(2, { timeout: 20_000 });

  const chatA = await app.chatPage();
  await chatA.fill('textarea.input-textarea', '派给另一个工作区');
  await chatA.press('textarea.input-textarea', 'Enter');

  // 切到工作区 B：点击占位父对话（发起方工作区 A 仍打开，跳转链接必须可用）
  await tabs.nth(1).click();
  const sidebarB = await app.sidebarPage();
  const placeholder = sidebarB.locator(SIDEBAR_ITEM).filter({ hasText: '跨工作区容器' });
  await expect(placeholder).toHaveCount(1, { timeout: 30_000 });
  await placeholder.click();

  const jumpPage = await app.waitForPage('data:text/html');
  await expect(jumpPage.getByText('跨工作区子代理容器')).toBeVisible();
  await expect(jumpPage.locator('#jumpBtn')).toBeVisible();
  await expect(jumpPage.getByText('跳转链接不可用')).toHaveCount(0);
  // 路径行显示发起方工作区展示路径，而不是退化为 ph_ 占位会话 id
  await expect(jumpPage.getByText(path.basename(workspaceA))).toBeVisible();
});
