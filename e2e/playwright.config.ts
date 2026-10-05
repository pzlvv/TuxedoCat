import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 场景级 e2e 配置（`e2e/README.md`）。
 *
 * 两个 project 对应两层用例：
 * - `webview-ui`：Chromium 直接加载构建产物 `dist/webview/index.html`，宿主侧以
 *   假宿主（`helpers/fakeHost.ts`）按 `src/host/webviewMessages.ts` 协议应答，
 *   驱动「webview UI 在真实浏览器里的用户操作」。
 * - `electron-app`：`_electron.launch` 拉起完整桌面应用（embedded core + 假 LLM
 *   SSE 服务器），驱动「整应用的真实用户链路」。
 */
const repoRoot = path.resolve(__dirname, '..');

function assertArtifact(rel: string): void {
  const p = path.join(repoRoot, rel);
  if (!fs.existsSync(p)) {
    throw new Error(
      `缺少构建产物 ${rel}。e2e 用例针对构建后的应用运行，请先执行：` +
      `npm run build:webview && npm run copy-assets && npm run build:electron`,
    );
  }
}

assertArtifact(path.join('dist', 'webview', 'index.html'));
assertArtifact(path.join('dist-electron', 'main.cjs'));

export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
    locale: 'zh-CN',
  },
  projects: [
    { name: 'webview-ui', testMatch: /webview[\\/].+\.spec\.ts/ },
    { name: 'electron-app', testMatch: /electron[\\/].+\.spec\.ts/ },
    // TUI 安装程序（无浏览器：构建 → 自解压 → 载荷可执行 → TUI 启动守卫）
    { name: 'tui-installer', testMatch: /tui[\\/].+\.spec\.ts/ },
  ],
});
