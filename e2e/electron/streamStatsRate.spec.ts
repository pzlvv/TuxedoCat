import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from '../helpers/mockLlmServer';
import { launchApp, makeWorkspace } from '../helpers/electronApp';
import type { AppHandle } from '../helpers/electronApp';
import type { MockLlm } from '../helpers/mockLlmServer';

/**
 * US-4 流式性能统计（`docs/features/user-stories/dialog-core.md`「流式性能统计
 * （首字耗时、解码速率）」）。
 *
 * 用**已知速率**的 mock LLM 驱动整条链路（Electron + 真实 standalone core），
 * 断言 UI 上的 Decode 速率落在「思考段真实速率」的区间内。
 *
 * 缺陷背景（`specs/defects/stream-stats-decode-window-diluted.md`）：
 * Core 对同一个 thinking 块发两条 `streamEnd`（BlockStop + MessageDelta），
 * 后者用整轮结束时刻覆盖了思考块的结束时刻，把正文输出与空档算进分母。
 *
 * mock 脚本（`固定速率`）的节奏：
 *   thinking 20 帧 × 5 token / 100ms  → 思考段 50 tok/s，时长约 2.0s
 *   空档 1000ms
 *   正文 10 帧 × 5 token / 50ms       → 正文段 100 tok/s，时长约 0.5s
 *   reasoning_tokens 上报 100（20×5），completion_tokens 上报 150
 *
 * 分母口径正确 → 100 tok / ≈2.0s ≈ 50 tok/s
 * 分母被稀释（整轮 ≈3.5s）→ ≈ 28 tok/s
 * 用区间断言把两者分开，且留足调度抖动余量。
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

test('US-4 思考段速率不被正文与空档稀释：已知 50 tok/s 的服务显示在正常区间', async () => {
  const chatPage = await app.chatPage();
  await chatPage.fill('textarea.input-textarea', '固定速率回答一下');
  await chatPage.press('textarea.input-textarea', 'Enter');

  // 流式结束后统计标签会冻结为 token 口径，出现 tok/s
  const statsLabel = chatPage.getByText(/Decode:.*tok\/s/).first();
  await expect(statsLabel).toBeVisible({ timeout: 60_000 });

  const text = (await statsLabel.textContent()) ?? '';
  const match = text.match(/\((\d+(?:\.\d+)?)\s*tok\/s\)/);
  expect(match, `统计标签应含 tok/s 数值，实际：${text}`).toBeTruthy();
  const rate = Number(match![1]);

  // mock 的思考段真实速率 = 5 token / 100ms = 50 tok/s。
  // 分母若错用整轮时长（≈3.5s）会得到 ≈28 tok/s，低于下界。
  expect(rate, `decode 速率应在思考段真实速率附近，实际 ${rate} tok/s（标签：${text}）`)
    .toBeGreaterThan(40);
  // 上界防「分母被压得比思考段还短」这类反向错误
  expect(rate).toBeLessThan(65);

  // 同一轮的 token 计数应取 reasoning_tokens（100），而不是 completion_tokens（150）
  expect(text).toMatch(/100\s*tok/);
});
