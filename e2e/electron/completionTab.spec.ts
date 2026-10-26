import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { startMockLlm } from '../helpers/mockLlmServer';
import { launchApp, makeWorkspace, type AppHandle } from '../helpers/electronApp';
import type { MockLlm } from '../helpers/mockLlmServer';

/**
 * 「任务完成」绿色呼吸灯（`electron/completionAttention.ts`）的标签页链路：
 * 非活动标签页里的任务完成 → 该标签页亮 `activity-completed`（呼吸一次后常亮）。
 * 差分（running → idle）→ 武装（完成时该标签页未激活）→ 推送（主窗口聚焦）
 * → 标题栏挂 class，四环断一环绿灯都不亮。
 */
let mockLlm: MockLlm;
let app: AppHandle;

test.beforeEach(async () => {
  const workspaceDir = await makeWorkspace({});
  mockLlm = await startMockLlm({ workspaceDir });
  void workspaceDir;
});

test.afterEach(async () => {
  await app.close();
  mockLlm.close();
});

test('非活动标签页任务完成 → 标签页亮绿色未读完成灯', async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  const aDir = await makeWorkspace({}, 'e2e-ws-done-a');
  const bDir = await makeWorkspace({}, 'e2e-ws-done-b');
  app = await launchApp({
    repoRoot, mockLlm, workspaceDir: bDir,
    openWorkspaces: [aDir, bDir],
    activeWorkspace: bDir,
  });

  // B（当前活动）里发起一条慢速查询：约 8s 的分片流，留足切标签页的时间
  mockLlm.setHandler(() => ({
    kind: 'slow', text: '慢速流式输出'.repeat(6), chunkDelayMs: 350,
  }));
  const tabs = (await app.titlebarPage()).locator('#workspaceTabs [role="tab"]');
  await expect(tabs).toHaveCount(2, { timeout: 20_000 });
  // 显式激活 B 并定位它自己的空态视图（多视图宿主里预热备用视图也是空态，
  // 直接拿「活动视图」可能输入到未激活的预热视图里）
  await tabs.nth(1).click();
  const chatPage = await app.chatPage({ workspaceIncludes: 'e2e-ws-done-b', emptyState: true });
  await chatPage.fill('textarea.input-textarea', '慢速回答');
  await chatPage.press('textarea.input-textarea', 'Enter');
  // 查询确实在跑（abort 按钮可用）：排除「消息没发出」的脚手架噪音
  await expect(chatPage.locator('button[title="终止"]')).toBeEnabled({ timeout: 30_000 });

  // B 是第二个标签页（打开集合顺序），先确认它进入运行态（蓝灯亮）：
  // 这一步同时验证状态流对非当前视图的会话可见
  await expect(tabs.nth(1)).toHaveClass(/activity-running/, { timeout: 30_000 });

  // 切到 A：B 变为非活动标签页，查询继续在后台跑
  await tabs.nth(0).click();
  await expect(tabs.nth(0)).toHaveClass(/active/, { timeout: 10_000 });

  // 等 B 的查询结束（蓝灯熄灭），随后应挂上绿色完成灯
  await expect(tabs.nth(1)).not.toHaveClass(/activity-running/, { timeout: 60_000 });
  await expect(tabs.nth(1)).toHaveClass(/activity-completed/, { timeout: 10_000 });

  // 激活该标签页即视为已读：绿灯摘除
  await tabs.nth(1).click();
  await expect(tabs.nth(1)).not.toHaveClass(/activity-completed/, { timeout: 10_000 });

  await fs.promises.rm(aDir, { recursive: true, force: true }).catch(() => undefined);
  await fs.promises.rm(bDir, { recursive: true, force: true }).catch(() => undefined);
});

test('窗口失焦期间任务完成 → 绿灯当场挂上，不等回窗聚焦', async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  const aDir = await makeWorkspace({}, 'e2e-ws-blur-a');
  const bDir = await makeWorkspace({}, 'e2e-ws-blur-b');
  app = await launchApp({
    repoRoot, mockLlm, workspaceDir: bDir,
    openWorkspaces: [aDir, bDir],
    activeWorkspace: bDir,
  });

  // B（活动）里发起慢速查询，切到 A 后把主窗口失焦（模拟用户在别的应用里等结果）：
  // 完成发生在失焦期间，可见但未聚焦的窗口此刻就要亮灯，不回窗不补亮
  mockLlm.setHandler(() => ({
    kind: 'slow', text: '失焦完成输出'.repeat(30), chunkDelayMs: 500,
  }));
  const tabs = (await app.titlebarPage()).locator('#workspaceTabs [role="tab"]');
  await expect(tabs).toHaveCount(2, { timeout: 20_000 });
  await tabs.nth(1).click();
  const chatPage = await app.chatPage({ workspaceIncludes: 'e2e-ws-blur-b', emptyState: true });
  await chatPage.fill('textarea.input-textarea', '失焦完成探针');
  await chatPage.press('textarea.input-textarea', 'Enter');
  // 查询确实在跑（abort 按钮可用）：排除「消息没发出」的脚手架噪音
  await expect(chatPage.locator('button[title="终止"]')).toBeEnabled({ timeout: 30_000 });
  await expect(tabs.nth(1)).toHaveClass(/activity-running/, { timeout: 30_000 });

  await tabs.nth(0).click();
  await app.evaluateInMain(`(function(){try{
    const e = process.mainModule ? process.mainModule.require('electron') : require('electron');
    const focused = e.BrowserWindow.getAllWindows().find(function(win){ return !win.isDestroyed() && win.isFocused(); });
    if (!focused) return 'none-focused';
    // blur() 对前台窗口直接调用在 Windows 下可能无效（前台锁）：
    // minimize → restore 打散焦点状态后 blur() 可靠生效，窗口保持可见（不最小化）
    focused.minimize();
    focused.restore();
    focused.blur();
    return 'ok';
  } catch (err) { return 'ERR ' + err.message; }})()`);
  // 失焦必须真实生效（否则完成落在聚焦窗口里，用例测不到失焦链路）：
  // 全部窗口都不持焦点才算失焦成立
  await expect.poll(async () => {
    const raw = await app.evaluateInMain(`(function(){try{
      const e = process.mainModule ? process.mainModule.require('electron') : require('electron');
      return String(e.BrowserWindow.getAllWindows().some(function(win){
        return !win.isDestroyed() && win.isFocused();
      }));
    } catch (err) { return 'ERR ' + err.message; }})()`);
    return (raw as { result?: { result?: { value?: string } } })?.result?.result?.value;
  }, { timeout: 30_000 }).toBe('false');

  // 不再聚焦窗口：查询结束时 B 的绿灯必须当场挂上（失焦即推送，不等回窗）
  await expect(tabs.nth(1)).toHaveClass(/activity-completed/, { timeout: 90_000 });

  await fs.promises.rm(aDir, { recursive: true, force: true }).catch(() => undefined);
  await fs.promises.rm(bDir, { recursive: true, force: true }).catch(() => undefined);
});
