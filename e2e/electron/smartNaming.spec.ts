import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm, lastUserText } from '../helpers/mockLlmServer';
import { launchApp, makeWorkspace } from '../helpers/electronApp';
import type { AppHandle } from '../helpers/electronApp';
import type { MockLlm } from '../helpers/mockLlmServer';

/**
 * US-21 智能命名（真实 LLM 链路）
 *
 * 两条真实装配都覆盖（mock LLM 按命名 prompt 识别并返回 JSON 标题）：
 * - 完整模式原生侧栏：`sidebar:smart-name-conversation` IPC → 主进程生成标题 →
 *   `conversationRenamed` 落盘 → conversationListChanged 刷回侧栏；
 * - 悬浮窗 webview 顶栏：`requestSmartNaming` → 宿主 → 总线 `smartNamingRequested`
 *   → standalone Core（Rust daemon）调 LLM → 落盘 → conversationsData 刷回 webview。
 *
 * 命名 prompt 的识别特征：用户消息含「对话标题生成器」（SMART_NAMING_SYSTEM_PROMPT 开头），
 * 且请求不带 tools——两条断言锁住「命名请求的形状」。
 */

const MOCK_TITLE = 'Python排序函数';

let mockLlm: MockLlm | null = null;
let app: AppHandle | null = null;
let workspaceDir: string | null = null;

interface LaunchOptions {
  /** 悬浮窗模式：对话列表移到 webview 顶栏（standalone daemon 侧链路的入口） */
  floating?: boolean;
}

/** 每个用例独立整套环境（工作区 + mock LLM + 整应用），afterEach 统一回收 */
async function launchEnv({ floating }: LaunchOptions = {}): Promise<AppHandle> {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  workspaceDir = await makeWorkspace({});
  mockLlm = await startMockLlm({ workspaceDir });
  app = await launchApp({
    repoRoot,
    mockLlm,
    workspaceDir,
    stateOverrides: floating ? { windowMode: 'floating' } : undefined,
  });
  return app;
}

test.afterEach(async () => {
  if (app) await app.close();
  mockLlm?.close();
  if (workspaceDir) {
    await fs.promises.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

/** 切到「识别命名 prompt 返回 JSON 标题、其余照旧」的脚本化路由 */
function routeNamingRequests(): void {
  mockLlm!.setHandler((req) => {
    const text = lastUserText(req.body.messages);
    if (text.includes('对话标题生成器')) {
      return { kind: 'text', text: JSON.stringify({ title: MOCK_TITLE }) };
    }
    return { kind: 'text', text: `收到：${text.slice(0, 40)}` };
  });
}

function namingRequests(): MockLlm['requests'] {
  return mockLlm!.requests.filter((r) => lastUserText(r.body.messages).includes('对话标题生成器'));
}

/** 读取沙箱 home 下唯一的会话 meta.json（单会话场景） */
function readMeta(): Record<string, unknown> {
  const conversationsRoot = path.join(app!.homeDir, '.tuxedo-cat', 'conversations');
  const projectDir = fs.readdirSync(conversationsRoot)[0];
  const metaFile = fs.readdirSync(path.join(conversationsRoot, projectDir))
    .find((f) => f.startsWith('session_') && f.endsWith('.meta.json'))!;
  return JSON.parse(fs.readFileSync(path.join(conversationsRoot, projectDir, metaFile), 'utf8')) as Record<string, unknown>;
}

/** 建一个已落盘的会话：发一条消息并等首轮回复完成，返回侧栏（模式 A） */
async function seedConversationViaChat(): Promise<void> {
  const chat = await app!.chatPage({ emptyState: true });
  await chat.fill('textarea.input-textarea', '帮我写一个Python排序函数');
  await chat.press('textarea.input-textarea', 'Enter');
  await expect(chat.getByText('收到：帮我写一个Python排序函数')).toBeVisible({ timeout: 30_000 });
  routeNamingRequests();
}

test('US-21 侧栏智能命名：LLM 标题写入侧栏并落盘 meta.json', async () => {
  await launchEnv();
  const sb = await app!.sidebarPage();
  await seedConversationViaChat();

  // 首轮完成：侧栏出现会话条目（标题=首条消息）
  const item = sb.locator('#list .item[data-session-id]').first();
  await expect(item).toBeVisible({ timeout: 30_000 });

  await item.hover();
  await item.locator('[data-action="smart-name"]').click();

  // 侧栏标题被 LLM 结果替换（.title 精确匹配，防止与首条消息的子串混淆）；
  // 「智能命名中…」提示随命名结束清掉
  await expect(item.locator('.title')).toHaveText(MOCK_TITLE, { timeout: 30_000 });
  await expect(item.locator('.naming-hint')).toHaveCount(0);

  // 命名请求形状：不带 tools，上下文带最近一轮用户/助手消息
  const requests = namingRequests();
  expect(requests).toHaveLength(1);
  expect(requests[0].body.tools ?? []).toHaveLength(0);
  const prompt = lastUserText(requests[0].body.messages);
  expect(prompt).toContain('[用户]: 帮我写一个Python排序函数');
  expect(prompt).toContain('[助手]:');

  // 落盘：meta.json 是 LLM 标题（只改标题，不动 updatedAt 语义）
  await expect.poll(() => readMeta().title, { timeout: 15_000 }).toBe(MOCK_TITLE);
});

test('US-21 悬浮窗 webview 智能命名：经总线到 standalone Core 生成标题', async () => {
  await launchEnv({ floating: true });
  const chat = await app!.chatPage({ emptyState: true });
  await seedConversationViaChat();

  // 打开对话历史，hover 出操作按钮，点「智能命名」
  await chat.locator('button[title="对话历史"]').click();
  const dropdown = chat.locator('.conversation-dropdown');
  const row = dropdown.locator('.group', { hasText: '帮我写一个Python排序函数' }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.hover();
  await row.locator('button[title="智能命名"]').click();

  // 标题刷新走磁盘事实：daemon 落盘后 conversationsData 推回 webview
  await expect(dropdown.getByText(MOCK_TITLE)).toBeVisible({ timeout: 30_000 });

  // 命名请求由 Rust daemon 发出（同一 mock LLM），形状与 Embedded 一致
  const requests = namingRequests();
  expect(requests).toHaveLength(1);
  expect(requests[0].body.tools ?? []).toHaveLength(0);

  await expect.poll(() => readMeta().title, { timeout: 15_000 }).toBe(MOCK_TITLE);
});
