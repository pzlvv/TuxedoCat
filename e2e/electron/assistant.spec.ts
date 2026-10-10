import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm, lastUserText } from '../helpers/mockLlmServer';
import { launchApp, makeWorkspace } from '../helpers/electronApp';
import type { AppHandle } from '../helpers/electronApp';
import type { MockLlm } from '../helpers/mockLlmServer';
import { CONFIG_DIR_NAME } from '../../src/config/project';

/**
 * US-1 流式对话 / US-2 中止 / US-14 工具卡片 / US-15 回滚 / US-18 权限确认 / US-28 工具轮次
 *
 * Electron 整应用链路：真实 standalone core（Rust 独立进程）+ 本地 mock LLM SSE
 * 服务器，manual 询问模式（settings.json defaultAgentMode）让写操作弹权限确认。
 */

let mockLlm: MockLlm;
let app: AppHandle;
let workspaceDir: string;

test.beforeEach(async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  workspaceDir = await makeWorkspace({ 'README.md': '# 工作区\n' });
  mockLlm = await startMockLlm({ workspaceDir });
  app = await launchApp({ repoRoot, mockLlm, workspaceDir });
});

test.afterEach(async () => {
  await app.close();
  mockLlm.close();
  await fs.promises.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
});

test('US-1 整应用对话：发送消息经真实 core 请求 mock LLM 并流式渲染', async () => {
  const chatPage = await app.chatPage();
  await chatPage.fill('textarea.input-textarea', '你好，介绍一下你自己');
  await chatPage.press('textarea.input-textarea', 'Enter');

  // 用户消息上屏
  await expect(chatPage.getByText('你好，介绍一下你自己').first()).toBeVisible();

  // 助手回复（mock 终轮文本）流式渲染完成
  await expect(chatPage.getByText(/收到：你好/).first()).toBeVisible({ timeout: 30_000 });

  // LLM 收到的请求走真实链路：settings.json 的 provider / apiKey / model 全部生效
  await expect.poll(() => mockLlm.requests.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  const req = mockLlm.requests[0];
  expect(req.authorization).toBe('Bearer sk-e2e-test');
  expect(req.body.model).toBe('mock-model');
  // system prompt 与工具定义随请求下发
  expect(req.body.messages[0].role).toBe('system');
  expect(req.body.tools?.map((t) => t.function?.name)).toContain('Write');
});

test('US-28+US-18 写文件完整轮次：权限确认 → 工具执行 → 落盘 → 终轮答复', async () => {
  const chatPage = await app.chatPage();
  await chatPage.fill('textarea.input-textarea', '写入文件 notes.md');
  await chatPage.press('textarea.input-textarea', 'Enter');

  // 工具卡片上架（US-14）：Write 卡片带文件名
  await expect(chatPage.getByText('notes.md').first()).toBeVisible({ timeout: 30_000 });

  // manual 模式：权限确认替换输入框（US-18）
  const overlay = chatPage.locator('.user-choice-overlay');
  await expect(overlay).toBeVisible({ timeout: 30_000 });
  await overlay.getByRole('button', { name: /允许/ }).first().click();

  // 文件真实写入工作区（US-28 验收：工具执行结果落盘）
  const written = path.join(workspaceDir, 'notes.md');
  await expect.poll(() => fs.existsSync(written), { timeout: 15_000 }).toBe(true);
  expect(fs.readFileSync(written, 'utf8')).toContain('# 由 e2e 场景写入');

  // 工具结果回传 LLM 后的最终答复
  await expect(chatPage.getByText('这是最终答复').first()).toBeVisible({ timeout: 30_000 });
  // 两轮 LLM 请求：工具轮 + 终轮，终轮上下文里包含 tool 结果
  await expect.poll(() => mockLlm.requests.length, { timeout: 15_000 }).toBe(2);
  expect(mockLlm.requests[1].body.messages.some((m) => m.role === 'tool')).toBe(true);

  // 会话落盘：jsonl 存在于隔离的会话目录
  const conversationsRoot = path.join(app.homeDir, CONFIG_DIR_NAME, 'conversations');
  const projectDirs = fs.readdirSync(conversationsRoot);
  expect(projectDirs.length).toBeGreaterThanOrEqual(1);
  const jsonlFiles = fs.readdirSync(path.join(conversationsRoot, projectDirs[0]))
    .filter((f) => f.endsWith('.jsonl'));
  expect(jsonlFiles.length).toBe(1);
});

test('US-18 拒绝权限：工具不执行，会话直接收尾', async () => {
  const chatPage = await app.chatPage();
  await chatPage.fill('textarea.input-textarea', '写入文件 denied.md');
  await chatPage.press('textarea.input-textarea', 'Enter');

  const overlay = chatPage.locator('.user-choice-overlay');
  await expect(overlay).toBeVisible({ timeout: 30_000 });
  await overlay.getByRole('button', { name: /拒绝/ }).first().click();

  // 拒绝即终止本轮：确认框关闭、查询结束（终止按钮回到禁用态）
  await expect(overlay).toBeHidden({ timeout: 15_000 });
  await expect(chatPage.locator('button[title="终止"]')).toBeDisabled({ timeout: 15_000 });
  await expect(chatPage.locator('textarea.input-textarea')).toBeVisible();
  // 文件未被创建
  await new Promise((r) => setTimeout(r, 1000));
  expect(fs.existsSync(path.join(workspaceDir, 'denied.md'))).toBe(false);
});

test('US-2 中止慢速流式回复回到空闲态', async () => {
  const chatPage = await app.chatPage();
  await chatPage.fill('textarea.input-textarea', '慢速回答一段长内容');
  await chatPage.press('textarea.input-textarea', 'Enter');

  const abortButton = chatPage.locator('button[title="终止"]');
  await expect(abortButton).toBeVisible({ timeout: 30_000 });
  // 等第一段内容到达再中止
  await expect(chatPage.getByText(/慢速流式输出/).first()).toBeVisible();
  await abortButton.click();

  // 中止后按钮回到禁用态（空闲），输入框可用。
  // 30 秒：standalone 下中止要穿过 core 进程（abort → 状态回推），全量负载下比
  // 单跑慢，15 秒的默认裕量实测会偶发超时
  await expect(abortButton).toBeDisabled({ timeout: 30_000 });
  await expect(chatPage.locator('textarea.input-textarea')).toBeEnabled();
});

test('US-2 首包到达前中止后，下一条消息仍进入本轮上下文并拿到回答', async () => {
  // 首包前中止会留下一条「已进上下文、但没有回复」的用户消息：中止标记
  // `*User Interrupted*` 是 system 消息（不进 API 载荷），下一条用户消息因此与它
  // 相邻，按 `mergeConsecutiveSameRole` 归一化成同一个 user turn（Anthropic 要求严格
  // user / assistant 交替，Embedded 同一口径）。所以断言写成「两条文本都在这一轮里
  // 被回答」，而不是断言两条独立消息——前者才是「消息不丢」这条不变量。
  mockLlm.setHandler((req) => {
    const text = lastUserText(req.body.messages);
    if (text.includes('再来一条')) return { kind: 'text', text: '好的，收到第二条。' };
    return { kind: 'slow', text: '这是一段慢速流式输出，逐字到达，适合验证中止操作。', chunkDelayMs: 700 };
  });

  const chatPage = await app.chatPage();
  await chatPage.fill('textarea.input-textarea', '慢速回答一段长内容');
  await chatPage.press('textarea.input-textarea', 'Enter');

  // 按钮一可用就中止：请求通常还没发出，中止落在消费循环的轮次边界上（首包前）
  const abortButton = chatPage.locator('button[title="终止"]');
  await expect(abortButton).toBeEnabled({ timeout: 30_000 });
  await abortButton.click();
  await expect(abortButton).toBeDisabled({ timeout: 30_000 });

  // 重发：消息必须真的进上下文并被回答（回归：曾把它误判成「消息被吞」）
  await chatPage.fill('textarea.input-textarea', '再来一条');
  await chatPage.press('textarea.input-textarea', 'Enter');
  await expect(chatPage.getByText('好的，收到第二条。').first()).toBeVisible({ timeout: 30_000 });
  await expect(abortButton).toBeDisabled({ timeout: 30_000 });

  const sent = lastUserText(mockLlm.requests[mockLlm.requests.length - 1].body.messages);
  expect(sent).toContain('再来一条');
  // 首包前中止时两条文本合并在同一个 user turn 里（这条同时锁住「合并是归一化，
  // 不是丢消息」）；若中止落在请求发出之后，第一条会作为独立 turn 存在，不再合并。
  if (mockLlm.requests.length === 1) {
    expect(sent).toContain('慢速回答一段长内容');
  }
});

test('US-2 网关不回响应头时中止仍立即回到空闲态', async () => {
  // 回归：请求发出后网关接受连接、读完请求却完全不回响应头（静默挂住）。
  // 旧实现 standalone core 阻塞在 reqwest 的 send() 上，只认 600s 整体超时，
  // 点「终止」没有任何反应；修复后 send 阶段按切片查 cancel，应立即以
  // 「用户中断」收尾。mock 的 `无响应` 脚本就是这个形态（默认路由，见 mockLlmServer）。
  const chatPage = await app.chatPage();
  await chatPage.fill('textarea.input-textarea', '无响应');
  await chatPage.press('textarea.input-textarea', 'Enter');

  const abortButton = chatPage.locator('button[title="终止"]');
  await expect(abortButton).toBeEnabled({ timeout: 30_000 });
  // 等假网关收到完整请求：此刻 core 已进入「等响应头」阶段，中止才落在本次回归点上
  await expect.poll(() => mockLlm.requests.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  await abortButton.click();

  // 中止后回到空闲（灰）并回显中断消息。30 秒的裕量仍远低于 600s 整体超时，
  // 旧实现下这条断言不可能通过（全量负载下比单跑慢，沿用同文件其它中止用例的口径）。
  await expect(abortButton).toBeDisabled({ timeout: 30_000 });
  await expect(chatPage.getByText('*User Interrupted*').first()).toBeVisible({ timeout: 30_000 });
  await expect(chatPage.locator('textarea.input-textarea')).toBeEnabled();
});

test('US-2 两阶段中止：前台结束后按钮转黄，再次点击才停后台任务', async () => {
  const chatPage = await app.chatPage();
  // 第一轮：Bash 后台任务（sleep 30）；工具结果回传后给终轮答复；
  // 之后 core 会补一条「仍有后台任务在跑」的 reminder，按普通文本收尾。
  mockLlm.setHandler((req) => {
    const last = req.body.messages[req.body.messages.length - 1];
    if (last?.role === 'tool') return { kind: 'text', text: '后台任务已启动。' };
    const text = lastUserText(req.body.messages);
    if (text.includes('启动一个后台任务')) {
      return {
        kind: 'tool',
        name: 'Bash',
        args: { command: 'sleep 30', run_in_background: true, description: 'Sleep' },
      };
    }
    return { kind: 'text', text: '好的，等待后台任务完成。' };
  });

  await chatPage.fill('textarea.input-textarea', '启动一个后台任务');
  await chatPage.press('textarea.input-textarea', 'Enter');

  // manual 模式：Bash 需要权限确认
  const overlay = chatPage.locator('.user-choice-overlay');
  await expect(overlay).toBeVisible({ timeout: 30_000 });
  await overlay.getByRole('button', { name: /允许/ }).first().click();

  // 工具结果与 reminder 追问都跑完：前台查询停下，但后台任务仍在
  await expect(chatPage.getByText(/后台任务已启动/).first()).toBeVisible({ timeout: 30_000 });
  const abortButton = chatPage.locator('button[data-abort-state]');
  await expect(abortButton).toHaveAttribute('data-abort-state', 'background', { timeout: 30_000 });
  await expect(abortButton).toBeEnabled();

  // 第二次点击才命中后台阶段：中止后台任务后回到空闲（灰）
  await abortButton.click();
  await expect(abortButton).toHaveAttribute('data-abort-state', 'none', { timeout: 30_000 });
  await expect(abortButton).toBeDisabled();
});

test('US-14+US-15 Edit 卡片的回滚确认框', async () => {
  const chatPage = await app.chatPage();
  // 先写一个文件（允许权限），再走 Edit 场景
  mockLlm.setHandler((req) => {
    const userText = lastUserText(req.body.messages);
    // 只有「最后一条消息是 tool 结果」才代表本轮工具已回传（历史里的 tool 结果不算）
    const lastMsg = req.body.messages[req.body.messages.length - 1];
    const hasToolResult = lastMsg?.role === 'tool';
    if (hasToolResult) return { kind: 'text', text: '完成。' };
    if (userText.startsWith('写入文件')) {
      return {
        kind: 'tool', name: 'Write',
        args: { file_path: path.join(workspaceDir, 'rollback-target.md'), content: '第一行\n第二行\n' },
      };
    }
    if (userText.startsWith('编辑文件')) {
      return {
        kind: 'tool', name: 'Edit',
        args: {
          file_path: path.join(workspaceDir, 'rollback-target.md'),
          old_string: '第二行', new_string: '第二行（已修改）',
        },
      };
    }
    return { kind: 'text', text: '好的。' };
  });

  async function allowPermission(): Promise<void> {
    const overlay = chatPage.locator('.user-choice-overlay');
    await expect(overlay).toBeVisible({ timeout: 30_000 });
    await overlay.getByRole('button', { name: /允许/ }).first().click();
  }

  await chatPage.fill('textarea.input-textarea', '写入文件 rollback-target.md');
  await chatPage.press('textarea.input-textarea', 'Enter');
  await allowPermission();
  await expect(chatPage.getByText('完成。').first()).toBeVisible({ timeout: 30_000 });

  await chatPage.fill('textarea.input-textarea', '编辑文件 rollback-target.md');
  await chatPage.press('textarea.input-textarea', 'Enter');
  await allowPermission();
  await expect.poll(
    () => fs.readFileSync(path.join(workspaceDir, 'rollback-target.md'), 'utf8'),
    { timeout: 15_000 },
  ).toContain('第二行（已修改）');

  // Edit 卡片上的回滚按钮 → 弹出二选一确认框（US-15）
  const rollbackButton = chatPage.locator('button[title="回滚修改到此"]').last();
  await expect(rollbackButton).toBeVisible({ timeout: 15_000 });
  await rollbackButton.click();
  await expect(chatPage.getByText('请选择回滚方式：')).toBeVisible();

  // 选「修改前」并确认 → 文件回到编辑前内容
  await chatPage.getByText('修改前', { exact: true }).click();
  await chatPage.getByRole('button', { name: /确认回滚/ }).click();
  await expect.poll(
    () => fs.readFileSync(path.join(workspaceDir, 'rollback-target.md'), 'utf8'),
    { timeout: 15_000 },
  ).toBe('第一行\n第二行\n');
});
