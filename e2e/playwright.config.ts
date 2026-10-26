import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { assertEnvironmentFileIfPresent } from './helpers/testEnvironment';

/**
 * 场景级 e2e 配置（`e2e/README.md`）。
 *
 * 六个 project 对应五层用例（`electron-app` 与 `electron-ssh` 同属整应用层：后者要外部
 * SSH 环境，拆开是为了让没有远端机器的开发机与 CI 车道都能各自独立跑）：
 * - `webview-ui`：Chromium 直接加载构建产物 `dist/webview/index.html`，宿主侧以
 *   假宿主（`helpers/fakeHost.ts`）按 `src/host/webviewMessages.ts` 协议应答，
 *   驱动「webview UI 在真实浏览器里的用户操作」。
 * - `electron-app`：拉起完整桌面应用（standalone core + 假 LLM SSE 服务器），
 *   驱动「整应用的真实用户链路」。
 * - `electron-ssh`：同一套整应用，连真实 SSH 远端（`e2e/environments.json`）。
 * - `remote-workspace-ui`：`electron/remoteWorkspace/` 的选择器页面（要连真实 SSH
 *   才走得到，整应用 e2e 覆盖不了）：Chromium 加载构建产物 + 假远端目录树。
 * - `terminal-ui`：`electron/terminal/` 的远程终端页面（同上的假通道手法）。
 * - `tui-installer`：TUI 安装程序（无浏览器：构建 → 自解压 → 载荷可执行 → 启动守卫）。
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
assertArtifact(path.join('dist', 'remoteWorkspace', 'index.html'));
assertArtifact(path.join('dist', 'terminal', 'index.html'));

// Core 二进制（electron-app 用例驱动真实 Core）：缺失时在配置加载期即报错，
// 不等用例跑到一半才在 spawn 处失败。目录 / 文件名口径同 src/host/standalone/coreBinary.ts
//（`<arch>-<platform>` / binaryName[.exe]），名字取自工程配置不写死。
const coreArch = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : null;
if (coreArch && (process.platform === 'win32' || process.platform === 'linux')) {
  const project = require('../project.config.cjs') as { core: { binaryName: string; resourceDir: string } };
  assertArtifact(path.join(
    'dist', 'resources', project.core.resourceDir,
    `${coreArch}-${process.platform}`,
    project.core.binaryName + (process.platform === 'win32' ? '.exe' : ''),
  ));
}

// 环境文件存在但形状非法（非 JSON / 顶层不是对象）：整个车道立即报错——配置坏了
// 不该等用到它的用例才发现。文件缺失放行：大多数用例不依赖外部环境（依赖方各自
// 在用例开头校验并向使用者报错）。见 e2e/README.md「测试环境配置」。
assertEnvironmentFileIfPresent();

export default defineConfig({
  testDir: '.',
  // 超时档位按「慢机器可用」取值（Windows ARM64 / 低配 runner 实测轮次可达数十秒）：
  // 单测 180s（整应用用例一轮真实 core + mock LLM 链路在负载下可超 2 分钟），
  // 单断言 30s（15s 档在这类机器上会随机把「慢」误判成「坏」）。只放宽失败路径的
  // 感知，不改变成功路径的行为；CI 快机器不受影响。
  timeout: 180_000,
  expect: { timeout: 30_000 },
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
    // 整应用：不需要外部 SSH 环境。真实 SSH 远端单独一个 project（`electron-ssh`）——
    // 它依赖 `e2e/environments.json`，缺文件时在收集期就报错，不该把整个车道拖下水。
    {
      name: 'electron-app',
      testMatch: /electron[\\/].+\.spec\.ts/,
      testIgnore: /remoteSshExecution\.spec\.ts/,
    },
    // 真实 SSH 远端（本地车道：要 e2e/environments.json，不进 CI——runner 内临时起的
    // sshd 替代不了真实远端，见 e2e/README.md 的 CI 车道表）
    { name: 'electron-ssh', testMatch: /electron[\\/]remoteSshExecution\.spec\.ts/ },
    { name: 'remote-workspace-ui', testMatch: /remoteWorkspace[\\/].+\.spec\.ts/ },
    // 远程终端页面（specs/022，同 remote-workspace-ui 的手法）：构建产物 + 假 SSH 通道
    { name: 'terminal-ui', testMatch: /terminal[\\/].+\.spec\.ts/ },
    // TUI 安装程序（无浏览器：构建 → 自解压 → 载荷可执行 → TUI 启动守卫）
    { name: 'tui-installer', testMatch: /tui[\\/].+\.spec\.ts/ },
  ],
});
