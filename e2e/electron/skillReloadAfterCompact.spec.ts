import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm, lastUserText } from '../helpers/mockLlmServer';
import { launchApp, makeWorkspace } from '../helpers/electronApp';
import type { AppHandle } from '../helpers/electronApp';
import type { MockLlm, RecordedRequest } from '../helpers/mockLlmServer';
import { CONFIG_DIR_NAME } from '../../src/config/project';

/**
 * US-27 验收标准 5：压缩后本会话调用过的技能仍对模型可见
 * （`docs/features/compaction.md` FR-007 / `docs/features/skills.md` 3.4）。
 *
 * 这条用例跑的是**真实链路**：真实 standalone Core + 真实会话 JSONL + mock LLM。
 * 技能正文是一次性进上下文的（`Skill` 工具的 `isMeta` 消息），压缩会把较早的历史折进
 * 摘要——模型只剩「加载过某技能」。本用例断言重挂把正文放回去，且断言的对象是
 * **Core 真的发给 LLM 的请求体**，不是界面文字：正文没进上下文时界面一样好看。
 *
 * 三个容易写错、因此各自单列的观察点：
 * 1. 重挂来自磁盘：技能文件改写后，第二次压缩重挂的是新版（不是旧副本）；
 * 2. 重复压缩：第一代的重挂章节本身会被第二次压缩吃掉，但调用记录要跨代继承，
 *    所以第二代仍要重挂；且第一代章节不进摘要输入（否则旧规则被压成摘要正文）；
 * 3. 技能在压缩前被删：压缩照常完成，摘要点名缺席，不静默吞。
 */

let mockLlm: MockLlm;
let app: AppHandle;
let workspaceDir: string;

/** 技能正文的哨兵串：每一代各写一份，用来判断重挂的是哪一版 */
const SKILL_BODY_V1 = 'E2E-SKILL-BODY-V1 缺陷修复流程：先写红用例再改代码';
const SKILL_BODY_V2 = 'E2E-SKILL-BODY-V2 缺陷修复流程：第二轮改过的正文';

function writeSkill(name: string, body: string): void {
  const dir = path.join(workspaceDir, '.agents', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\ndescription: e2e 技能 ${name}\n---\n\n${body}\n`,
    'utf8',
  );
}

/** 会话 JSONL 的绝对路径（Core 独占写入，用例只读） */
function conversationFile(): string {
  const root = path.join(app.homeDir, CONFIG_DIR_NAME, 'conversations');
  const projectDir = fs.readdirSync(root).find((dir) => decodeURIComponent(dir).includes('tuxedo-e2e-ws'));
  if (projectDir === undefined) throw new Error(`找不到工作区对话目录：${root}`);
  // 必须排掉 `.compact_archive.jsonl`：它也以 `.jsonl` 结尾、且按字母序排在会话流之前
  // （`<sid>.compact_archive.jsonl` < `<sid>.jsonl`）。选错文件时症状很迷惑——压缩明明
  // 发生了，边界条数却一直是 0（读到的是归档记录，里面没有边界标记）。
  const file = fs
    .readdirSync(path.join(root, projectDir))
    .find((name) => name.endsWith('.jsonl') && !name.endsWith('.compact_archive.jsonl'));
  if (file === undefined) throw new Error('找不到会话 jsonl');
  return path.join(root, projectDir, file);
}

/** 读会话 JSONL 里的消息体（每行一条记录，`message` 是消息本体） */
function readMessages(): Array<Record<string, unknown>> {
  return fs
    .readFileSync(conversationFile(), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => (JSON.parse(line) as { message: Record<string, unknown> }).message);
}

/** 摘要消息正文（压缩产物的第二条消息） */
function summaryContent(): string {
  const summary = readMessages().find((message) => message.isCompactSummary === true);
  if (summary === undefined) throw new Error('会话里没有压缩摘要消息');
  const body = (summary.message as { content: unknown }).content;
  if (typeof body !== 'string') throw new Error('摘要正文不是字符串');
  return body;
}

/** 摘要消息上的技能调用记录 */
function persistedLoadedSkills(): unknown {
  const summary = readMessages().find((message) => message.isCompactSummary === true);
  return summary?.compactLoadedSkills;
}

/** 最近一次请求里发给 LLM 的全部文本（system + messages） */
function lastRequestText(): string {
  const request: RecordedRequest | undefined = mockLlm.requests.at(-1);
  if (request === undefined) throw new Error('mock LLM 还没收到请求');
  return JSON.stringify(request.body.messages);
}

/** 等会话回到空闲（终止按钮禁用） */
async function waitIdle(page: Awaited<ReturnType<AppHandle['chatPage']>>): Promise<void> {
  await expect(page.locator('button[title="终止"]')).toBeDisabled({ timeout: 30_000 });
}

/**
 * 已完成的压缩代次数。
 *
 * 不能数会话里的 `compact_boundary` 条数：压缩**整体替换**消息数组，边界标记永远只有
 * 1 条（`[边界标记, 摘要, ...保留区]`），第二次压缩不会变成 2 条。能累积的是归档文件的
 * 代次（`compactGeneration`，1 起、每次压缩 +1），它才是「压过几次」的事实。
 */
function compactGenerationCount(): number {
  const archive = conversationFile().replace(/\.jsonl$/, '.compact_archive.jsonl');
  if (!fs.existsSync(archive)) return 0;
  const generations = fs
    .readFileSync(archive, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => Number((JSON.parse(line) as { compactGeneration?: number }).compactGeneration ?? 1));
  return generations.length === 0 ? 0 : Math.max(...generations);
}

/** 点用量条触发手动压缩，等这一次压缩真的完成（归档代次到达期望值） */
async function compactNow(
  page: Awaited<ReturnType<AppHandle['chatPage']>>,
  expectedGeneration: number,
): Promise<void> {
  const usage = page.locator('[title="点击压缩"]');
  await expect(usage).toBeVisible({ timeout: 20_000 });
  await usage.locator('button').click();
  // 判据用「归档代次」而不是「有没有摘要」：第二次压缩时摘要消息早就存在，后者会让
  // 等待立刻返回，后面的断言读到的是上一代产物。
  await expect.poll(() => compactGenerationCount(), { timeout: 40_000 }).toBe(expectedGeneration);
  await waitIdle(page);
}

/** 发一条消息并等终轮答复 */
async function sendAndAwait(
  page: Awaited<ReturnType<AppHandle['chatPage']>>,
  text: string,
  expected: RegExp | string,
): Promise<void> {
  await page.fill('textarea.input-textarea', text);
  await page.press('textarea.input-textarea', 'Enter');
  await expect(page.getByText(expected).first()).toBeVisible({ timeout: 30_000 });
  await waitIdle(page);
}

test.beforeEach(async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  workspaceDir = await makeWorkspace({ 'README.md': '# 工作区\n' });
  writeSkill('fix', SKILL_BODY_V1);
  mockLlm = await startMockLlm({ workspaceDir });
  // auto 模式：Skill 工具本就免确认，auto 也让后续可能出现的写操作不打断这条用例
  app = await launchApp({ repoRoot, mockLlm, workspaceDir, agentMode: 'auto' });
});

test.afterEach(async () => {
  await app.close();
  mockLlm.close();
  await fs.promises.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
});

test('US-27 技能正文被压缩吃掉后，下一轮请求里又有了（重挂来自磁盘）', async () => {
  test.setTimeout(120_000);
  const page = await app.chatPage();

  // 1. 用户 `/fix` 触发技能：Skill 工具把正文注入成 isMeta 消息（三条消息落盘）
  await sendAndAwait(page, '/fix E2E-ARGS', /收到：/);
  const afterSkill = readMessages();
  const injected = afterSkill.find(
    (message) => message.isMeta === true && message.skillName === 'fix',
  );
  expect(injected, '技能正文应以 isMeta 消息注入并带 skillName 标记').toBeDefined();
  expect(String((injected?.message as { content: unknown }).content)).toContain(SKILL_BODY_V1);
  // 首次调用：正文在上下文里，请求体里就带着它
  expect(lastRequestText()).toContain(SKILL_BODY_V1);

  // 2. 攒够 31 条以上消息，让压缩真的有可摘要内容（保留区固定 30 条）
  for (let i = 0; i < 16; i += 1) {
    await sendAndAwait(page, `铺垫消息 ${i}`, new RegExp(`收到：铺垫消息 ${i}`));
  }

  // 3. 手动压缩
  await compactNow(page, 1);

  // 摘要正文里有重挂章节，且是磁盘上的正文
  const summary = summaryContent();
  expect(summary).toContain('### 已加载技能');
  expect(summary).toContain(SKILL_BODY_V1);
  expect(summary).toContain('不是当前轮次的要求');
  // 调用记录落盘（只记名字与参数，不存正文）
  expect(persistedLoadedSkills()).toEqual([{ name: 'fix', args: 'E2E-ARGS' }]);

  // 4. 下一轮请求：真正发给 LLM 的上下文里有技能正文
  await sendAndAwait(page, '压缩后继续干活', /收到：压缩后继续干活/);
  const request = lastRequestText();
  expect(request).toContain(SKILL_BODY_V1);
  expect(request).toContain('不是当前轮次的要求');
});

test('US-27 重复压缩：第一代的重挂章节被吃掉，第二代仍重挂且取磁盘新版', async () => {
  test.setTimeout(180_000);
  const page = await app.chatPage();

  await sendAndAwait(page, '/fix 第一轮', /收到：/);
  for (let i = 0; i < 16; i += 1) {
    await sendAndAwait(page, `第一代铺垫 ${i}`, new RegExp(`收到：第一代铺垫 ${i}`));
  }
  await compactNow(page, 1);
  expect(summaryContent()).toContain(SKILL_BODY_V1);
  expect(persistedLoadedSkills()).toEqual([{ name: 'fix', args: '第一轮' }]);

  // 磁盘改写：第二代重挂必须取新版（不是调用时的旧副本）
  writeSkill('fix', SKILL_BODY_V2);

  // 第二次压缩前再攒 31 条以上，让第一代的摘要与注入正文都进归档区
  for (let i = 0; i < 16; i += 1) {
    await sendAndAwait(page, `第二代铺垫 ${i}`, new RegExp(`收到：第二代铺垫 ${i}`));
  }

  // 关键观察点：第二次压缩的摘要输入里不能出现第一代的重挂章节。
  // 它在归档区里（`isCompactSummary` 消息），必须被剥掉——否则旧版技能正文会被
  // 摘要模型压成一段似是而非的规则，与新算的章节自相矛盾。
  const beforeSecond = mockLlm.requests.length;
  await compactNow(page, 2);

  // 第二次压缩自身也调用了一次 LLM 生成摘要：那次请求体里不能有第一代章节
  const compactRequests = mockLlm.requests.slice(beforeSecond);
  const compactPrompt = compactRequests
    .map((req) => JSON.stringify(req.body.messages))
    .find((text) => text.includes('请总结以下对话的要点'));
  expect(compactPrompt, '第二次压缩应有摘要请求').toBeDefined();
  expect(compactPrompt).not.toContain('### 已加载技能');
  expect(compactPrompt).not.toContain(SKILL_BODY_V1);

  // 第二代摘要：仍重挂，且是磁盘新版
  const secondSummary = summaryContent();
  expect(secondSummary).toContain('### 已加载技能');
  expect(secondSummary).toContain(SKILL_BODY_V2);
  expect(secondSummary).not.toContain(SKILL_BODY_V1);
  // 记录跨代继承（第一代早已不在消息里）
  expect(persistedLoadedSkills()).toEqual([{ name: 'fix', args: '第一轮' }]);

  // 下一轮请求里是第二代正文
  await sendAndAwait(page, '二次压缩后继续', /收到：二次压缩后继续/);
  const request = lastRequestText();
  expect(request).toContain(SKILL_BODY_V2);
  expect(request).not.toContain(SKILL_BODY_V1);
});

test('US-27 技能在压缩前被删除：压缩照常完成并在摘要里点名', async () => {
  test.setTimeout(120_000);
  const page = await app.chatPage();

  await sendAndAwait(page, '/fix 会被删', /收到：/);
  for (let i = 0; i < 16; i += 1) {
    await sendAndAwait(page, `铺垫 ${i}`, new RegExp(`收到：铺垫 ${i}`));
  }

  // 删除技能目录：压缩时重渲染解析不到
  fs.rmSync(path.join(workspaceDir, '.agents', 'skills', 'fix'), { recursive: true, force: true });

  await compactNow(page, 1);
  const summary = summaryContent();
  expect(summary).toContain('无法重新读取');
  expect(summary).toContain('fix');
  expect(summary).not.toContain(SKILL_BODY_V1);
  // 记录留着：下次压缩还会再试
  expect(persistedLoadedSkills()).toEqual([{ name: 'fix', args: '会被删' }]);

  // 压缩没有被技能缺席拖垮：下一轮照常工作
  await sendAndAwait(page, '删除后继续', /收到：删除后继续/);
});

test('US-27 没有调用过技能时，压缩产物不带重挂章节', async () => {
  test.setTimeout(120_000);
  const page = await app.chatPage();

  for (let i = 0; i < 17; i += 1) {
    await sendAndAwait(page, `普通消息 ${i}`, new RegExp(`收到：普通消息 ${i}`));
  }
  await compactNow(page, 1);

  expect(summaryContent()).not.toContain('### 已加载技能');
  expect(persistedLoadedSkills()).toBeUndefined();
});

// 让 `lastUserText` 的导入不被 tree-shake 掉（其它车道上的脚本化路由复用同一份判定）
void lastUserText;
