import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm, lastUserText } from '../helpers/mockLlmServer';
import { launchApp, makeWorkspace } from '../helpers/electronApp';
import { CONFIG_DIR_NAME } from '../../src/config/project';
import type { AppHandle } from '../helpers/electronApp';
import type { MockLlm, RecordedRequest, ScriptDecision } from '../helpers/mockLlmServer';

/**
 * US-51 子代理继承主对话的会话级配置
 * （specs/defects/subagent-thinking-effort-not-inherited）
 *
 * 整应用链路：父会话把思考强度切到「低」，同轮 `Agent` 派一个 Master 子代理，
 * 随后打开子会话视图检查三件事：
 * 1. 子会话 meta.json 的 context 落齐继承值（thinkingMode / webSearch / promptMode /
 *    agentMode）——修复前只落了 agentMode，其余键缺失；
 * 2. 打开子会话视图后输入区菜单里的思考强度高亮仍是「低」，而不是 settings.json
 *    的默认值（openai 分支的 settings 默认 off）——修复前宿主读不到 context 的继承值，
 *    按配置默认补齐并回写 Core，子代理的思考强度被静默改掉；
 * 3. 子代理发出的 LLM 请求体带继承来的 `reasoning_effort`（settings 默认 off 时该
 *    字段不出现，因此「请求里有 reasoning_effort=low」本身就是继承生效的证据）。
 */

let mockLlm: MockLlm;
let app: AppHandle;
let workspaceDir: string;

const SIDEBAR_ITEM = '#list .item[data-session-id]';
const PARENT_PROMPT = '派个 Master 干活';
const TASK_PROMPT = '干活任务';

/** 子代理的首轮请求（任务提示词 + 消息里没有 tool 结果） */
function subFirstRequests(): RecordedRequest[] {
  return mockLlm.requests.filter((req) => {
    if (req.body.messages.some((m) => m.role === 'tool')) return false;
    return lastUserText(req.body.messages) === TASK_PROMPT;
  });
}

/** 菜单分段控件里处于选中态的分段文案（选中项背景为 harness 色、文字白色） */
async function selectedSegment(menu: import('@playwright/test').Locator, label: string): Promise<boolean> {
  return menu.getByRole('button', { name: label, exact: true }).evaluate(
    (el) => getComputedStyle(el).color === 'rgb(255, 255, 255)',
  );
}

/** 沙箱 home 里该会话的 meta.json 路径 */
function metaPathOf(homeDir: string, sessionId: string): string {
  const conversationsDir = path.join(homeDir, CONFIG_DIR_NAME, 'conversations');
  for (const project of fs.readdirSync(conversationsDir)) {
    const candidate = path.join(conversationsDir, project, `${sessionId}.meta.json`);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`沙箱里没有找到会话 meta.json（sessionId=${sessionId}，${conversationsDir}）`);
}

test.beforeEach(async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  workspaceDir = await makeWorkspace({ 'README.md': '# 工作区\n' });
  mockLlm = await startMockLlm({ workspaceDir });
  // agentMode auto：Agent 工具免确认，父会话一轮内就能把子代理派出去。
  // settings 的 llm.thinking_effort 由启动器固定为 off——与父会话要切的 low 不同，
  // 继承失效时子会话会明确回落到 off。
  app = await launchApp({ repoRoot, mockLlm, workspaceDir, agentMode: 'auto' });
});

test.afterEach(async () => {
  await app.close();
  mockLlm.close();
  await fs.promises.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
});

test('子代理继承主对话的思考强度：落盘 / 重开显示 / 请求体（specs/defects/subagent-thinking-effort-not-inherited）', async () => {
  mockLlm.setHandler((req): ScriptDecision => {
    const text = lastUserText(req.body.messages);
    if (text === TASK_PROMPT) {
      // 子代理首轮直接 Reply 收尾（继承的思考强度体现在请求体的 reasoning_effort 上）
      return { kind: 'tool', name: 'Reply', args: { message: '子代理完成' } };
    }
    if (text === PARENT_PROMPT) {
      if (JSON.stringify(req.body.messages).includes('Sub-agent created with ID')) {
        return { kind: 'text', text: '子代理已经派出去了。' };
      }
      return {
        kind: 'tool',
        name: 'Agent',
        args: { prompt: TASK_PROMPT, agentRole: 'Master', description: '继承思考强度' },
      };
    }
    return { kind: 'text', text: `收到：${text.slice(0, 40)}` };
  });

  const chatPage = await app.chatPage();
  const sb = await app.sidebarPage();

  // 父会话把思考强度切到「低」——会话级配置经 setThinkingMode 落进 core 与 meta.json
  await expect(chatPage.locator('button[title="功能开关"]')).toBeVisible({ timeout: 30_000 });
  await chatPage.locator('button[title="功能开关"]').click();
  const parentMenu = chatPage.locator('ul.agent-mode-menu');
  await expect(parentMenu).toBeVisible();
  // 分段控件是受控组件：点击后高亮要等 React 重渲染，用轮询而不是立即断言
  await parentMenu.getByRole('button', { name: '低', exact: true }).click({ force: true });
  await expect.poll(() => selectedSegment(parentMenu, '低')).toBe(true);
  await chatPage.keyboard.press('Escape');

  // 同轮派子代理：父会话一轮 → Agent 工具 → 子代理后台跑 → Reply 回投
  await chatPage.fill('textarea.input-textarea', PARENT_PROMPT);
  await chatPage.press('textarea.input-textarea', 'Enter');
  await expect
    .poll(() => sb.locator(SIDEBAR_ITEM).count(), { timeout: 90_000 })
    .toBe(2);

  // RT-1：子会话 meta.json 落齐继承值（修复前 thinkingMode / webSearch / promptMode 缺失）
  const subSessionId = await sb.locator(SIDEBAR_ITEM).last().getAttribute('data-session-id');
  expect(subSessionId).toBeTruthy();
  const meta = JSON.parse(fs.readFileSync(metaPathOf(app.homeDir, subSessionId!), 'utf8'));
  expect(meta.context.thinkingMode).toBe('low');
  // settings 的默认 thinking_effort 是 off：继承失效时这里会是 off
  expect(meta.context.thinkingMode).not.toBe('off');
  expect(meta.context.agentMode).toBe('auto');
  expect(meta.context.promptMode).toBe('normal');
  expect(meta.context.webSearch).toBe(false);
  expect(meta.parentSessionId).toBeTruthy();

  // RT-2：打开子会话视图，输入区菜单的思考强度仍是继承来的「低」。
  // 修复前宿主读不到 context.thinkingMode → 按 settings 默认（off）补齐 → 高亮「关」。
  await sb.locator(SIDEBAR_ITEM).last().click();
  const subPage = await app.sessionPage(subSessionId!);
  const subMenuButton = subPage.locator('button[title="功能开关"]');
  await expect(subMenuButton).toBeVisible({ timeout: 30_000 });
  await subMenuButton.click();
  const subMenu = subPage.locator('ul.agent-mode-menu');
  await expect(subMenu).toBeVisible();
  // 会话加载与 setThinkingMode 回写可能晚于菜单打开：等视图自己稳定到「低」
  await expect.poll(() => selectedSegment(subMenu, '低'), { timeout: 30_000 }).toBe(true);
  expect(await selectedSegment(subMenu, '关')).toBe(false);
  await subPage.keyboard.press('Escape');

  // 打开子会话后 webview 的 setThinkingMode effect 会把当前值写回 core：落盘值不得被
  // 改成 settings 默认（打开会话不得静默改配置）
  await expect
    .poll(() => JSON.parse(fs.readFileSync(metaPathOf(app.homeDir, subSessionId!), 'utf8')).context.thinkingMode)
    .toBe('low');

  // RT-3：子代理请求体按继承来的思考强度组装。openai 分支只在
  // `thinking_enabled` 为真时写 `reasoning_effort`——settings 默认 off 时该字段不出现，
  // 因此「子代理请求里有 reasoning_effort=low」同时证明继承生效与请求侧未回落默认。
  expect(subFirstRequests().length).toBeGreaterThan(0);
  expect(subFirstRequests()[0].body.reasoning_effort).toBe('low');
});
