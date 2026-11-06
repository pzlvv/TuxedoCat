import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockLlm, lastUserText } from '../helpers/mockLlmServer';
import { launchApp, makeWorkspace } from '../helpers/electronApp';
import type { AppHandle } from '../helpers/electronApp';
import type { MockLlm, ScriptDecision } from '../helpers/mockLlmServer';

/**
 * US-60 跨工作区文件传输（specs/028）
 *
 * Electron 整应用链路：两个本地工作区同时打开，会话（工作区 A）一轮发出 `Transfer`
 * 调用（缺省源 = 本对话工作区，`destTarget` = 工作区 B 身份），断言文件递归落到
 * B 的目标路径（含目标父目录自动创建）；守卫用例断言两端同为当前工作区时返回
 * 「用 Bash」的工具错误、两端零写入。
 *
 * 身份口径与 `src/host/workspaceIdentity.ts` 一致：`机器名:path.resolve(目录)`。
 */

let mockLlm: MockLlm;
let app: AppHandle | null = null;
let workspaceA: string;
let workspaceB: string;
/** 跨重启用例（FR-005 重放）留下的沙箱 home：afterEach 负责清理 */
let retainedHome: string | null = null;

function machineName(): string {
  const fromEnv = process.platform === 'win32' ? process.env.COMPUTERNAME : process.env.HOSTNAME;
  return (fromEnv && fromEnv.trim()) || os.hostname();
}

function agentId(dir: string): string {
  return `${machineName()}:${path.resolve(dir)}`;
}

test.beforeEach(async () => {
  workspaceA = await makeWorkspace(
    {
      'a.md': 'A 文件内容',
      'nested/deep/b.md': 'B 文件内容',
      'nested/.dotfile': '点文件',
    },
    'e2e-transfer-a',
  );
  workspaceB = await makeWorkspace({ 'b.md': 'B' }, 'e2e-transfer-b');
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
  if (retainedHome) {
    await fs.promises.rm(retainedHome, { recursive: true, force: true }).catch(() => undefined);
    retainedHome = null;
  }
});

test('US-60 本地↔本地：Transfer 把目录递归搬到目标工作区（specs/028 FR-003）', async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  app = await launchApp({
    repoRoot,
    mockLlm,
    workspaceDir: workspaceA,
    openWorkspaces: [workspaceA, workspaceB],
    activeWorkspace: workspaceA,
    agentMode: 'auto',
    // 卡片重放断言要重开同一沙箱（FR-005），home 归用例所有
    keepHomeOnClose: true,
  });

  mockLlm.setHandler((req): ScriptDecision => {
    const text = lastUserText(req.body.messages);
    if (text === '把 nested 搬到 B' && !JSON.stringify(req.body.messages).includes('Transferred')) {
      return {
        kind: 'tool',
        name: 'Transfer',
        args: {
          sourcePath: path.join(path.resolve(workspaceA), 'nested'),
          targetPath: path.join(path.resolve(workspaceB), 'incoming', 'nested'),
          destTarget: agentId(workspaceB),
        },
      };
    }
    return { kind: 'text', text: '传输完成。' };
  });

  const titlebar = await app.titlebarPage();
  const tabs = titlebar.locator('#workspaceTabs [role="tab"]');
  await expect(tabs).toHaveCount(2, { timeout: 20_000 });

  const chatA = await app.chatPage();
  await chatA.fill('textarea.input-textarea', '把 nested 搬到 B');
  await chatA.press('textarea.input-textarea', 'Enter');
  await expect(chatA.getByText('传输完成。')).toBeVisible({ timeout: 30_000 });

  // 硬证据：B 的目标路径出现整棵子树（递归 + 点文件 + 父目录自动创建）
  await expect
    .poll(
      async () => fs.existsSync(path.join(workspaceB, 'incoming', 'nested', 'deep', 'b.md')),
      { timeout: 10_000 },
    )
    .toBe(true);
  expect(
    await fs.promises.readFile(path.join(workspaceB, 'incoming', 'nested', 'deep', 'b.md'), 'utf8'),
  ).toBe('B 文件内容');
  await expect
    .poll(
      async () => fs.existsSync(path.join(workspaceB, 'incoming', 'nested', '.dotfile')),
      { timeout: 10_000 },
    )
    .toBe(true);
  // 目标端无暂存残留
  const leftovers: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (entry.name.includes('tuxedo-transfer-tmp')) leftovers.push(entry.name);
      if (entry.isDirectory()) await walk(path.join(dir, entry.name));
    }
  };
  await walk(path.join(workspaceB, 'incoming'));
  expect(leftovers).toEqual([]);

  // 工具卡片（specs/042 FR-008）：两端身份（完整值在 title，正文按中点截断）、
  // 统计与逐条文件清单（相对**被传输子树根**的路径）
  const card = chatA.locator('.msg-timeline-item').filter({ hasText: 'Transfer' }).first();
  await expect(card.getByTitle(agentId(workspaceA))).toBeVisible({ timeout: 10_000 });
  await expect(card.getByTitle(agentId(workspaceB))).toBeVisible();
  await expect(card.getByText(/2 个文件 · 23 B/)).toBeVisible();
  await expect(card.getByTitle('deep/b.md')).toBeVisible();
  await expect(card.getByTitle('.dotfile')).toBeVisible();

  // 重放一致（specs/042 FR-005）：重开同一沙箱后，卡片信息全部来自 toolArgs 与
  // 结果文本，两端身份与统计与传输当时相同
  const homeDir = app.homeDir;
  retainedHome = homeDir;
  await app.close();
  // 沙箱要留给第二段重开：home 归用例所有，由 afterEach 统一清理
  app = await launchApp({
    repoRoot,
    mockLlm,
    workspaceDir: workspaceA,
    openWorkspaces: [workspaceA, workspaceB],
    activeWorkspace: workspaceA,
    agentMode: 'auto',
    reuseHomeDir: homeDir,
  });
  const sidebar = await app.sidebarPage();
  const row = sidebar.locator('#list .item[data-session-id]').first();
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  const sid = await row.getAttribute('data-session-id');
  await row.click();
  const replayChat = await app.chatPage({ sessionIncludes: sid ?? '' });
  const replayCard = replayChat.locator('.msg-timeline-item').filter({ hasText: 'Transfer' }).first();
  await expect(replayCard.getByTitle(agentId(workspaceA))).toBeVisible({ timeout: 30_000 });
  await expect(replayCard.getByTitle(agentId(workspaceB))).toBeVisible();
  await expect(replayCard.getByText(/2 个文件 · 23 B/)).toBeVisible();
  await expect(replayCard.getByTitle('deep/b.md')).toBeVisible();
});

test('US-60 守卫：两端都是当前工作区 → 提示用 Bash、零写入（specs/028 FR-002）', async () => {
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
    if (text === '在本工作区里复制' && !JSON.stringify(req.body.messages).includes('use Bash')) {
      return {
        kind: 'tool',
        name: 'Transfer',
        args: {
          sourcePath: path.join(path.resolve(workspaceA), 'a.md'),
          targetPath: path.join(path.resolve(workspaceA), 'copy.md'),
        },
      };
    }
    return { kind: 'text', text: '被工具错误拒绝了。' };
  });

  const titlebar = await app.titlebarPage();
  const tabs = titlebar.locator('#workspaceTabs [role="tab"]');
  await expect(tabs).toHaveCount(2, { timeout: 20_000 });

  const chatA = await app.chatPage();
  await chatA.fill('textarea.input-textarea', '在本工作区里复制');
  await chatA.press('textarea.input-textarea', 'Enter');
  await expect(chatA.getByText('被工具错误拒绝了。')).toBeVisible({ timeout: 30_000 });

  // 守卫命中：同工作区复制被拒，目标端零写入
  expect(fs.existsSync(path.join(workspaceA, 'copy.md'))).toBe(false);
});
