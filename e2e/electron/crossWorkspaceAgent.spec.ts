import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockLlm, lastUserText } from '../helpers/mockLlmServer';
import { launchApp, makeWorkspace } from '../helpers/electronApp';
import { CONFIG_DIR_NAME } from '../../src/config/project';
import type { AppHandle } from '../helpers/electronApp';
import type { MockLlm, ScriptDecision } from '../helpers/mockLlmServer';

/**
 * US-56 跨工作区代理（specs/023；specs/025 直建普通对话）
 *
 * Electron 整应用链路：两个本地工作区同时打开，父会话（工作区 A）一轮发出带
 * `target` 的 `Agent` 调用，断言跨工作区对话创建在工作区 B 且是**顶层普通对话**
 * （specs/025 FR-001：无占位父对话、可打开、输入禁用），A 的列表不出现该对话。
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

test('US-56 跨工作区派发：对话落在目标工作区且为顶层普通对话（specs/025 FR-001）', async () => {
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
      // 目标工作区的跨工作区对话：首轮 Reply 回投发起方
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

  // 切到工作区 B：顶层出现普通对话行（标题 = description），无容器标记、无子树折叠按钮
  await tabs.nth(1).click();
  const sidebarB = await app.sidebarPage();
  const row = sidebarB.locator(SIDEBAR_ITEM).filter({ hasText: '跨工作区任务' });
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  await expect(row).not.toContainText('跨工作区容器');
  await expect(row.locator('[data-action="toggle-sub"]')).toHaveCount(0);

  // 点击打开：正常对话视图渲染消息，不出现占位页（按行 sid 选页，避开预加载备用视图）
  const rowSid1 = await row.getAttribute('data-session-id');
  await row.click();
  const chatB = await app.chatPage({ sessionIncludes: rowSid1 ?? '' });
  await expect(chatB.getByText('在 B 里做点事')).toBeVisible({ timeout: 20_000 });
  await expect(chatB.getByText('跨工作区子代理容器')).toHaveCount(0);

  // 工作区 A 的列表里没有这个对话（它归属目标工作区）
  await tabs.nth(0).click();
  const sidebarA = await app.sidebarPage();
  await expect(
    sidebarA.locator(SIDEBAR_ITEM).filter({ hasText: '跨工作区任务' }),
  ).toHaveCount(0);
});

test('US-56 跨工作区对话打开后输入禁用、返回发起方按 creator 跳转（specs/025 FR-004 / FR-005）', async () => {
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

  // 切到工作区 B：打开跨工作区对话
  await tabs.nth(1).click();
  const sidebarB = await app.sidebarPage();
  const row = sidebarB.locator(SIDEBAR_ITEM).filter({ hasText: '跨工作区任务' });
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  const rowSid2 = await row.getAttribute('data-session-id');
  await row.click();
  const chatB = await app.chatPage({ sessionIncludes: rowSid2 ?? '' });

  // 输入框禁用 + placeholder「非用户创建对话无法输入」（specs/025 FR-004）
  const textareaB = chatB.locator('textarea.input-textarea');
  await expect(textareaB).toBeDisabled({ timeout: 20_000 });
  await expect(textareaB).toHaveAttribute('placeholder', '非用户创建对话无法输入');

  // 「返回发起方」按钮按 creator 跳转（specs/025 FR-005）：切回工作区 A 并打开发起方对话
  const back = chatB.getByTitle(/返回父对话|Back to parent/);
  await expect(back).toBeVisible();
  await back.click();

  // 活动标签切回 A，聊天区显示发起方对话（标题 = 首条用户消息）
  await expect(chatA.getByText('派给另一个工作区').first()).toBeVisible({ timeout: 20_000 });
  // A 的输入框可输入（creator=user 的会话不受禁用影响）
  await expect(chatA.locator('textarea.input-textarea')).toBeEnabled({ timeout: 20_000 });
});

test('US-56 会话设置全量继承与 creator 落盘（specs/025 FR-002 / FR-005）', async () => {
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
      // 跨工作区对话的第二轮（Reply 的 tool 结果）：收尾文本
      if (req.body.messages[req.body.messages.length - 1]?.role === 'tool') {
        return { kind: 'text', text: 'B 里做完了。' };
      }
      // 第一轮延迟应答：对话停在「工具调用等待」窗口，运行流水灯稳定可见
      return { kind: 'tool', name: 'Reply', args: { message: 'B 里做完了。' }, delayMs: 8000 };
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

  // 对方 tab 流水灯不依赖手动切换：归属在派发时刻已登记（Client 路由表），
  // 目标工作区还没被激活（宿主索引未刷新）也必须亮运行灯（delayMs 撑住窗口）
  await expect(tabs.nth(1)).toHaveClass(/activity-running/, { timeout: 15_000 });

  // 切到工作区 B：顶层对话行在跑（delayMs 撑住窗口）→ 运行流水灯
  await tabs.nth(1).click();
  const sidebarB = await app.sidebarPage();
  const row = sidebarB.locator(SIDEBAR_ITEM).filter({ hasText: '跨工作区任务' });
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  await expect(row.locator('.running-bar')).toBeVisible({ timeout: 15_000 });

  // 收尾后行灯熄灭：等发起方收到回投结果，再等流水灯消失
  await tabs.nth(0).click();
  await expect(chatA.getByText('已经派给 B。')).toBeVisible({ timeout: 30_000 });
  await tabs.nth(1).click();
  await expect(row.locator('.running-bar')).toHaveCount(0, { timeout: 20_000 });

  // creator 落盘 + 全量继承（specs/025 FR-002 / FR-005）：读目标工作区对话 meta.json，
  // 断言归属与七项设置等于发起方会话的生效值（不按角色裁剪）
  const rowId = await row.getAttribute('data-session-id');
  const metaPath = path.join(
    app.homeDir,
    CONFIG_DIR_NAME,
    'conversations',
    encodeURIComponent(workspaceB),
    `${rowId}.meta.json`,
  );
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  expect(meta.creator).toEqual({
    kind: 'agent',
    workspaceId: agentId(workspaceA),
    sessionId: expect.any(String),
  });
  expect(typeof meta.creator.sessionId).toBe('string');
  expect(meta.creator.sessionId).not.toBe('');
  expect(meta.parentSessionId).toBeUndefined();
  expect(meta.crossWorkspaceOrigin).toBeUndefined();
  // 发起方 launchApp(agentMode: 'auto') + settings（thinking off / webSearch false /
  // model mock-model / provider mock / 无 mcp.json）→ 继承值全部可预期
  expect(meta.context.agentMode).toBe('auto');
  expect(meta.context.thinkingMode).toBe('off');
  expect(meta.context.promptMode).toBe('normal');
  expect(meta.context.webSearch).toBe(false);
  expect(meta.context.mcpEnabled).toEqual([]);
  expect(meta.model).toBe('mock-model');
  expect(meta.provider).toBe('mock');
});
