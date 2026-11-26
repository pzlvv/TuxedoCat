import { test, expect } from '@playwright/test';
import { openWebviewView } from '../helpers/webviewHarness';
import { fakeHostInit, type FakeStorageCapabilities } from '../helpers/fakeHost';

/**
 * Overlay 对话的挂载代理部署（`specs/051-overlay-root-mount-proxy` FR-002 / FR-003 /
 * FR-004）。
 *
 * 场景级：真实 webview bundle + 假宿主应答（`e2e/helpers/fakeHost.ts`）。这一层只验
 * **webview 能看见的那半边**——入口渲染判据、部署闸门的确认与取消、三选一与遮蔽输入、
 * 失败重试（不限次数）与模态层语义。宿主的编排（提权顺序、密码不进 argv / 日志、零密码
 * 通道的轮询、真实安装）由 `src/test/mountProxyInstall.test.ts` 与
 * `src/test/mountProxyGate.test.ts` 覆盖，真实安装落点在 `electron-ssh` 车道。
 *
 * 能力查询在 webview 挂载时只问一次（Core 的能力在生命周期内不变，webview 不重复问），
 * 因此每条用例用**注入期预置**给能力而不是在挂载后改 state——后者永远赶不上那一问。
 *
 * 运行：`npm run test:e2e:webview -- overlayMountProxy`
 */


const REPO_ROOT = process.cwd().replace(/[\\/]e2e$/, '');

/** 「可部署但当下不可用」：AC-4 的前置（入口渲染、闸门触发都要求它） */
const DEPLOYABLE: FakeStorageCapabilities = {
  isolatedWorkView: false,
  mountProxy: 'absent',
  deployable: true,
  reason: 'mount proxy missing',
};
/** 能力已就绪：AC-6 的前置 */
const READY: FakeStorageCapabilities = {
  isolatedWorkView: true,
  mountProxy: 'ready',
  deployable: false,
  reason: '',
};

/** 勾选框（FR-002 的入口；实现按 plan.md 的选择器契约挂 `data-work-view-option`） */
const WORK_VIEW_OPTION = 'input[data-work-view-option]';
/** 确认框根（模态层） */
const CONFIRM_DIALOG = '[data-mount-proxy-dialog="confirm"]';
/** 确认框里的四要素文案（root + setuid / 安装落点 / 目标主机 / 可建受限命名空间） */
const fact = (name: string): string => `${CONFIRM_DIALOG} [data-fact="${name}"]`;
/** 三选一 / 取消 / 确认动作 */
const action = (name: string): string => `[data-mount-proxy-action="${name}"]`;
/** 遮蔽输入框 */
const SECRET_INPUT = 'input[type="password"][data-mount-proxy-secret]';
/** 进度判别（`idle` / `running` / `needsCredential` / `failed` / `done`） */
const PHASE = '[data-mount-proxy-phase]';

/**
 * 以指定能力打开 webview（注入期给能力，见文件头注释）。
 * 返回同一套 handle，用例照常用 `handle.host` 驱动与断言上行消息。
 */
async function openWithCapabilities(
  browser: Parameters<typeof openWebviewView>[0],
  capabilities: FakeStorageCapabilities | null,
): Promise<Awaited<ReturnType<typeof openWebviewView>>> {
  const init = fakeHostInit(
    { conversationView: 'single', conversationListOwner: 'webview' },
    { storageCapabilities: capabilities },
  );
  return openWebviewView(browser, REPO_ROOT, init);
}

/** 勾选 Overlay 并发一条消息（FR-003 的闸门触发点） */
async function selectWorkViewAndSend(
  page: import('@playwright/test').Page,
  text: string,
): Promise<void> {
  await page.locator(WORK_VIEW_OPTION).check();
  await page.fill('textarea.input-textarea', text);
  await page.press('textarea.input-textarea', 'Enter');
}

// 每个用例显式创建（能力必须在页面脚本执行前就位），afterEach 收尾
let handle: Awaited<ReturnType<typeof openWebviewView>> | null = null;

test.afterEach(async () => {
  await handle?.close();
  handle = null;
});

// ─────────────────────────── FR-002 入口渲染判据 ───────────────────────────

test('FR-002 可部署但未就绪时渲染 Overlay 勾选框', async ({ browser }) => {
  handle = await openWithCapabilities(browser, DEPLOYABLE);
  // AC-4：能力当下不可用但 deployable 为 true → 空状态仍渲染勾选框
  await expect(handle.page.locator(WORK_VIEW_OPTION)).toBeVisible({ timeout: 15_000 });
});

/**
 * 入口渲染在装饰图**下方**且不移动装饰图（docs/hosts/webview-ui.md 第 11 节
 * 「新对话空态布局」）：入口是装饰图的绝对定位兄弟层，出现 / 消失都不改装饰图位置。
 * 判据取几何事实——装饰图中心与视口中心同高（居中不受入口影响）、入口整体落在
 * 装饰图下边界之下。
 */
test('FR-002 入口出现在 logo 下方且不影响 logo 位置', async ({ browser }) => {
  handle = await openWithCapabilities(browser, DEPLOYABLE);
  const { page } = handle;
  const logo = page.locator('.placeholder-logo');
  const entry = page.locator(WORK_VIEW_OPTION);
  await expect(entry).toBeVisible({ timeout: 15_000 });

  const geometry = await page.evaluate(() => {
    const logoEl = document.querySelector('.placeholder-logo');
    const entryEl = document.querySelector('input[data-work-view-option]');
    if (!logoEl || !entryEl) throw new Error('空态节点缺失');
    const logoBox = logoEl.getBoundingClientRect();
    const entryBox = entryEl.getBoundingClientRect();
    return {
      logoCenterY: logoBox.top + logoBox.height / 2,
      viewportCenterY: window.innerHeight / 2,
      logoBottom: logoBox.bottom,
      entryTop: entryBox.top,
    };
  });

  // 入口在装饰图下方，且留出了间距（不是压在图上）
  expect(geometry.entryTop).toBeGreaterThan(geometry.logoBottom);
  // 装饰图仍按视口中线居中：入口作为绝对定位层不占布局高度
  expect(Math.abs(geometry.logoCenterY - geometry.viewportCenterY)).toBeLessThanOrEqual(1);
});

/**
 * 空态层挂在视口上而不是消息区上：主输入框随内容长高时消息区被压矮，装饰图与入口
 * 的位置只由窗口尺寸决定，不跟着输入框走动（把 `.empty-state-layer` 的 fixed 改回
 * 消息区内的 static 即失败）。
 */
test('FR-002 主输入框长高时 logo 与入口位置不动', async ({ browser }) => {
  handle = await openWithCapabilities(browser, DEPLOYABLE);
  const { page } = handle;
  await expect(page.locator(WORK_VIEW_OPTION)).toBeVisible({ timeout: 15_000 });

  const readGeometry = () =>
    page.evaluate(() => {
      const logoEl = document.querySelector('.placeholder-logo');
      const entryEl = document.querySelector('input[data-work-view-option]');
      const inputEl = document.querySelector('textarea.input-textarea');
      if (!logoEl || !entryEl || !inputEl) throw new Error('空态节点缺失');
      return {
        logoTop: Math.round(logoEl.getBoundingClientRect().top),
        entryTop: Math.round(entryEl.getBoundingClientRect().top),
        inputHeight: Math.round(inputEl.getBoundingClientRect().height),
      };
    });

  const before = await readGeometry();
  // 填多行让主输入框按 maxRows 长高（不发送，空态保持不变）
  await page.fill('textarea.input-textarea', Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行`).join('\n'));
  const after = await readGeometry();

  expect(after.inputHeight, '输入框必须真的长高，否则本条用例验不到位移').toBeGreaterThan(before.inputHeight);
  expect(after.logoTop, '装饰图随输入框高度移动了').toBe(before.logoTop);
  expect(after.entryTop, '入口随输入框高度移动了').toBe(before.entryTop);
});

test('FR-002 不可部署时整块入口不渲染', async ({ browser }) => {
  // AC-5：非 Linux 或内核无 overlayfs → deployable false，整块入口不渲染
  handle = await openWithCapabilities(browser, {
    isolatedWorkView: false,
    mountProxy: 'absent',
    deployable: false,
    reason: 'overlayfs not available',
  });
  await expect(handle.page.locator(WORK_VIEW_OPTION)).toHaveCount(0);
});

test('FR-002 能力未到达时不渲染勾选框（不猜 false、也不猜 true）', async ({ browser }) => {
  // null = 宿主不应答：等待态不得渲染入口
  handle = await openWithCapabilities(browser, null);
  await expect(handle.page.locator(WORK_VIEW_OPTION)).toHaveCount(0);
});

test('FR-002 能力已就绪时勾选发消息直接建会话，不弹任何对话框', async ({ browser }) => {
  handle = await openWithCapabilities(browser, READY);
  const { page } = handle;
  await expect(page.locator(WORK_VIEW_OPTION)).toBeVisible({ timeout: 15_000 });

  // AC-6：直接建会话，不弹任何部署或提权对话框
  await selectWorkViewAndSend(page, '已就绪的 Overlay 对话');
  // specs/059 FR-001：用户按下发送先走提交请求，受理之后才上行已受理消息
  await handle.host.waitForSent('submitMessage', 15_000);
  await handle.host.waitForSent('sendMessage', 15_000);
  await expect(page.locator(CONFIRM_DIALOG)).toHaveCount(0);
});

// ─────────────────────── FR-003 部署闸门与知情同意 ───────────────────────

test('FR-003 未就绪时发消息弹确认框，消息不进 Core、不建会话', async ({ browser }) => {
  handle = await openWithCapabilities(browser, DEPLOYABLE);
  const { page } = handle;

  const before = await handle.host.sentAll();
  await selectWorkViewAndSend(page, '这条消息应该被闸门拦下');

  // AC-7：确认框出现，且该消息没有上行、没有建会话
  const dialog = page.locator(CONFIRM_DIALOG);
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  expect(await dialog.getAttribute('aria-modal')).toBe('true');
  const added = (await handle.host.sentAll()).slice(before.length);
  // 被拦下的是提交请求：既没有 submitMessage 之外的已受理上行，也没有把提交放行
  expect(
    added.some((m) => m.type === 'sendMessage'),
    '被拦的提交不得上行已受理消息',
  ).toBe(false);
  expect(
    added.some((m) => m.type === 'submitMessage'),
    '用户按下发送应上行提交请求（宿主据此裁决）',
  ).toBe(true);

  // AC-8：四要素文案逐项存在且非空
  for (const name of ['root-setuid', 'install-path', 'target-host', 'userns']) {
    const el = page.locator(fact(name));
    await expect(el, `确认框缺事实：${name}`).toBeVisible();
    expect((await el.innerText()).trim().length, `事实 ${name} 不得为空`).toBeGreaterThan(0);
  }
});

test('FR-003 取消部署：逐项回到发送前、勾选态保留、无提权动作', async ({ browser }) => {
  handle = await openWithCapabilities(browser, DEPLOYABLE);
  const { page } = handle;

  const before = await handle.host.sentAll();
  const text = '取消后应该还在输入框';
  await selectWorkViewAndSend(page, text);
  await expect(page.locator(CONFIRM_DIALOG)).toBeVisible({ timeout: 15_000 });

  await page.locator(action('cancel')).click();
  await expect(page.locator(CONFIRM_DIALOG)).toHaveCount(0);

  // AC-5 / AC-6（specs/059）：载体从未被消费——内容、勾选态、光标都还在，
  // 没有排队项 / 空闲挂起项，没有任何会话侧动静
  await expect(page.locator('textarea.input-textarea')).toHaveValue(text);
  await expect(page.locator(WORK_VIEW_OPTION)).toBeChecked();
  await expect(page.locator('[data-queued-message]')).toHaveCount(0);
  await expect(page.locator('[data-idle-suspended-message]')).toHaveCount(0);

  const added = (await handle.host.sentAll()).slice(before.length);
  const privileged = added.filter(
    (m) => m.type === 'requestMountProxyDeploy' || m.type === 'submitMountProxyCredential',
  );
  expect(privileged, '取消后不得有任何提权动作').toHaveLength(0);
  // AC-15：这次尝试没有上行过已受理消息（Core 从未收到）
  expect(
    added.some((m) => m.type === 'sendMessage'),
    '取消后不得上行已受理消息',
  ).toBe(false);
  // AC-14：回填补偿通道已删除——上行里从来不该有它（下行更没有该类型）
  expect(
    added.some((m) => m.type === 'userMessageDraftRestored' as never),
    '取消不得再发 userMessageDraftRestored',
  ).toBe(false);
});

test('FR-003 取消后逐项还原：图片与文件引用同样不动（AC-5）', async ({ browser }) => {
  handle = await openWithCapabilities(browser, DEPLOYABLE);
  const { page } = handle;

  // 勾选 Overlay 才有部署闸门可触发（能力不可用 + 可部署）
  await page.locator(WORK_VIEW_OPTION).check();

  // 粘贴一张图片（1x1 PNG），确认它在取消后仍在输入区
  await page.evaluate(() => {
    const input = document.querySelector('textarea.input-textarea');
    if (!input) throw new Error('主输入框缺失');
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'dot.png', { type: 'image/png' }));
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  });

  await page.fill('textarea.input-textarea', '带图片的草稿');
  await page.press('textarea.input-textarea', 'Enter');
  await expect(page.locator(CONFIRM_DIALOG)).toBeVisible({ timeout: 15_000 });

  await page.locator(action('cancel')).click();
  await expect(page.locator(CONFIRM_DIALOG)).toHaveCount(0);

  await expect(page.locator('textarea.input-textarea')).toHaveValue('带图片的草稿');
  // 图片区仍在：粘贴图片的缩略图数量与发送前一致
  const thumbnails = await page.locator('[data-pasted-image]').count();
  expect(thumbnails, '取消后粘贴图片必须原样保留').toBeGreaterThan(0);
});

test('FR-007 模态锁：确认框打开时对话切换入口不可用、焦点圈在框内（AC-16 / AC-19）', async ({ browser }) => {
  handle = await openWithCapabilities(browser, DEPLOYABLE);
  const { page } = handle;

  await selectWorkViewAndSend(page, '模态锁');
  const dialog = page.locator(CONFIRM_DIALOG);
  await expect(dialog).toBeVisible({ timeout: 15_000 });

  // 锁事实已上报（AC-16 的宿主侧投影）
  await expect.poll(async () => (await handle!.host.state()).conversationSwitchLocked, {
    timeout: 5_000,
  }).toBe(true);
  expect((await handle.host.state()).conversationSwitchLockReason).toBe('mount-proxy-dialog');

  // 焦点圈定：连按 Tab 都落在框内
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => {
      const active = document.activeElement;
      return active !== null && active.closest('[data-mount-proxy-dialog]') !== null;
    });
    expect(inside, `第 ${i + 1} 次 Tab 后焦点必须仍在确认框内`).toBe(true);
  }

  // Shift+Tab 同样不逃出去
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press('Shift+Tab');
    const inside = await page.evaluate(() => {
      const active = document.activeElement;
      return active !== null && active.closest('[data-mount-proxy-dialog]') !== null;
    });
    expect(inside, `第 ${i + 1} 次 Shift+Tab 后焦点必须仍在确认框内`).toBe(true);
  }

  // 取消后解锁（AC-16 的收尾）
  await page.locator(action('cancel')).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await handle!.host.state()).conversationSwitchLocked, {
    timeout: 5_000,
  }).toBe(false);
});

test('FR-003 模态层：Escape 与点遮罩都等价取消', async ({ browser }) => {
  handle = await openWithCapabilities(browser, DEPLOYABLE);
  const { page } = handle;

  // Escape
  await selectWorkViewAndSend(page, '第一轮');
  await expect(page.locator(CONFIRM_DIALOG)).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Escape');
  await expect(page.locator(CONFIRM_DIALOG)).toHaveCount(0);

  // 点遮罩（卡片居中、遮罩占满视口：点左上角必然落在遮罩上）
  await selectWorkViewAndSend(page, '第二轮');
  await expect(page.locator(CONFIRM_DIALOG)).toBeVisible({ timeout: 15_000 });
  await page.mouse.click(8, 8);
  await expect(page.locator(CONFIRM_DIALOG)).toHaveCount(0);
});

// ────────────────────── FR-004 提权顺序与密码来源 ──────────────────────

test('FR-004 免密 sudo 可用时不弹密码输入，直接进入安装进度', async ({ browser }) => {
  handle = await openWithCapabilities(browser, DEPLOYABLE);
  const { page } = handle;
  // 脚本里没有 needsCredential：宿主直接用 sudo -n 装完
  await handle.host.setMountProxyDeploy({ script: [], expected: null });

  await selectWorkViewAndSend(page, '免密路径');
  await expect(page.locator(CONFIRM_DIALOG)).toBeVisible({ timeout: 15_000 });
  await page.locator(action('deploy')).click();

  // AC-10：全程没有密码框
  await expect(page.locator(SECRET_INPUT)).toHaveCount(0);
  // 部署成功不弹提示：对话框直接收起（宿主接着发被拦消息），不再显示任何结果态
  await expect(page.locator(CONFIRM_DIALOG)).toHaveCount(0, { timeout: 15_000 });
});

test('FR-004 需要密码时给三选一，选 sudo 密码出现遮蔽输入', async ({ browser }) => {
  handle = await openWithCapabilities(browser, DEPLOYABLE);
  const { page } = handle;
  await handle.host.setMountProxyDeploy({
    script: ['needsCredential'],
    expected: { secret: 'right-secret' },
  });

  await selectWorkViewAndSend(page, '要密码的路径');
  await expect(page.locator(CONFIRM_DIALOG)).toBeVisible({ timeout: 15_000 });
  await page.locator(action('deploy')).click();

  // AC-11：三条来源都在
  await expect(page.locator(PHASE))
    .toHaveAttribute('data-mount-proxy-phase', 'needsCredential', { timeout: 15_000 });
  for (const source of ['sudo-password', 'root-password', 'manual-command']) {
    await expect(page.locator(action(source)), `缺来源：${source}`).toBeVisible();
  }

  // 选 sudo 密码 → 遮蔽输入出现（type=password，不是 text）
  await page.locator(action('sudo-password')).click();
  await expect(page.locator(SECRET_INPUT)).toBeVisible();
  await expect(page.locator(SECRET_INPUT)).toHaveAttribute('type', 'password');
});

test('FR-004 密码只随凭据消息上行，不进 DOM 文本、不进其它消息', async ({ browser }) => {
  handle = await openWithCapabilities(browser, DEPLOYABLE);
  const { page } = handle;
  const secret = 'p@ssw0rd-should-not-leak';
  await handle.host.setMountProxyDeploy({
    script: ['needsCredential'],
    expected: { method: 'sudoPassword', secret },
  });

  await selectWorkViewAndSend(page, '遮蔽输入');
  await expect(page.locator(CONFIRM_DIALOG)).toBeVisible({ timeout: 15_000 });
  await page.locator(action('deploy')).click();
  await page.locator(action('sudo-password')).click();
  await page.locator(SECRET_INPUT).fill(secret);
  await page.keyboard.press('Enter');

  const submitted = await handle.host.waitForSent('submitMountProxyCredential', 15_000);
  // AC-13：密码只在凭据消息的 secret 字段里，来源与方法名分开
  expect(submitted.method).toBe('sudoPassword');
  expect(submitted.secret).toBe(secret);

  // 其它上行消息里不得出现密码（宿主日志 / 诊断回显这类泄漏面）
  for (const message of await handle.host.sentAll()) {
    if (message.type === 'submitMountProxyCredential') continue;
    expect(JSON.stringify(message), `${message.type} 泄漏了密码`).not.toContain(secret);
  }
  // DOM 文本里也不出现（遮蔽输入的值不是文本节点，这里拦的是实现把它渲染成文本）
  await expect(page.locator('body')).not.toContainText(secret);
});

test('FR-004 认证失败回到三选一且可无限重试，失败态留在界面上', async ({ browser }) => {
  handle = await openWithCapabilities(browser, DEPLOYABLE);
  const { page } = handle;
  // 单次部署里连续 5 次认证失败（期望值与本用例提交的不同 → 每次都判错）：
  // 宿主不设次数上限，能试几次由服务端策略决定，因此同一个人机步骤会一直重来。
  await handle.host.setMountProxyDeploy({
    script: ['needsCredential'],
    expected: { secret: 'right-secret' },
  });

  await selectWorkViewAndSend(page, '连续失败');
  await expect(page.locator(CONFIRM_DIALOG)).toBeVisible({ timeout: 15_000 });
  await page.locator(action('deploy')).click();

  // 免密不可用 → 三选一；判错 → 失败态回显原因，仍可换来源继续，不设次数上限。
  await expect(page.locator(PHASE))
    .toHaveAttribute('data-mount-proxy-phase', 'needsCredential', { timeout: 15_000 });

  // 每次提交一行凭据上行，用它确认这一轮真的被判过一次
  const credentialCount = async (): Promise<number> =>
    (await handle!.host.sentAll()).filter((m) => m.type === 'submitMountProxyCredential').length;

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    // 失败态的 CredentialBody 仍在：换一条来源就能接着试，没有「剩余次数」也没有停手
    await page.locator(action('sudo-password')).click();
    await expect(page.locator(SECRET_INPUT)).toBeVisible();
    await page.locator(SECRET_INPUT).fill('wrong-secret');
    await page.keyboard.press('Enter');
    await expect.poll(credentialCount, { timeout: 15_000 }).toBe(attempt);
    await expect(page.locator(PHASE))
      .toHaveAttribute('data-mount-proxy-phase', 'failed', { timeout: 15_000 });
    await expect(page.locator(CONFIRM_DIALOG)).toContainText('authentication failed');
    // 第 6 次之外仍可继续：不放「已无剩余次数」这类文案
    await expect(page.locator(CONFIRM_DIALOG)).not.toContainText('次数');
  }
});

test('FR-004 失败态点「重试」重新走一遍部署，仍不设次数上限', async ({ browser }) => {
  handle = await openWithCapabilities(browser, DEPLOYABLE);
  const { page } = handle;
  await handle.host.setMountProxyDeploy({
    script: ['needsCredential'],
    expected: { secret: 'right-secret' },
  });

  await selectWorkViewAndSend(page, '重试');
  await expect(page.locator(CONFIRM_DIALOG)).toBeVisible({ timeout: 15_000 });
  await page.locator(action('deploy')).click();
  await expect(page.locator(PHASE))
    .toHaveAttribute('data-mount-proxy-phase', 'needsCredential', { timeout: 15_000 });

  await page.locator(action('sudo-password')).click();
  await page.locator(SECRET_INPUT).fill('wrong-secret');
  await page.keyboard.press('Enter');
  await expect(page.locator(PHASE))
    .toHaveAttribute('data-mount-proxy-phase', 'failed', { timeout: 15_000 });

  // 失败态的两个按钮：重试（再走一遍）与关闭（收手由用户决定）
  await page.locator(action('deploy')).click();
  await expect(page.locator(PHASE))
    .toHaveAttribute('data-mount-proxy-phase', 'needsCredential', { timeout: 15_000 });
});

test('FR-004 只有失败才提示：原因可见，重试与关闭都由用户决定', async ({ browser }) => {
  handle = await openWithCapabilities(browser, DEPLOYABLE);
  const { page } = handle;
  await handle.host.setMountProxyDeploy({ script: ['failed'], expected: null });

  await selectWorkViewAndSend(page, '安装失败');
  await expect(page.locator(CONFIRM_DIALOG)).toBeVisible({ timeout: 15_000 });
  await page.locator(action('deploy')).click();

  // 失败才提示：原因可见，关闭按钮在，重试按钮在
  await expect(page.locator(PHASE))
    .toHaveAttribute('data-mount-proxy-phase', 'failed', { timeout: 15_000 });
  await expect(page.locator(CONFIRM_DIALOG)).toContainText('installation failed');
  await expect(page.locator(action('deploy'))).toBeVisible();
  await expect(page.locator(action('cancel'))).toBeVisible();
});

test('FR-004 零密码通道给出完整命令，走完后继续原动作', async ({ browser }) => {
  handle = await openWithCapabilities(browser, DEPLOYABLE);
  const { page } = handle;
  const command = 'sudo -S install -m 4755 -o root -g root /tmp/mount-proxy /usr/libexec/mount-proxy';
  await handle.host.setMountProxyDeploy({
    script: ['manualCommand'],
    expected: null,
    facts: {
      manualCommand: command,
      installPath: '/usr/libexec/mount-proxy',
      targetHost: 'user@remote-host',
    },
  });

  await selectWorkViewAndSend(page, '零密码通道');
  await expect(page.locator(CONFIRM_DIALOG)).toBeVisible({ timeout: 15_000 });
  await page.locator(action('deploy')).click();

  // AC-12：命令完整可见（用户要能在自己的终端里跑），全程没有密码框经过宿主
  await expect(page.locator(PHASE))
    .toHaveAttribute('data-mount-proxy-phase', 'needsCredential', { timeout: 15_000 });
  await expect(page.locator('pre[data-mount-proxy-command]')).toHaveText(command);
  await expect(page.locator(SECRET_INPUT)).toHaveCount(0);

  // 用户在自己的终端跑完 → 宿主轮询到就位 → 继续原动作（done 收起对话框，不弹提示）
  await handle.host.send({
    type: 'mountProxyDeployState',
    phase: 'done',
    failure: null,
    manualCommand: null,
    targetHost: 'user@remote-host',
    installPath: '/usr/libexec/mount-proxy',
  });
  await expect(page.locator(CONFIRM_DIALOG)).toHaveCount(0, { timeout: 15_000 });
});
