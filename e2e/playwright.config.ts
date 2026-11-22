import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { assertEnvironmentFileIfPresent } from './helpers/testEnvironment';

/**
 * 场景级 e2e 配置（`e2e/README.md`）。
 *
 * 七个 project 对应六层用例（`electron-app` 与 `electron-ssh` 同属整应用层：后者要外部
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

/**
 * 需要真实 SSH 远端的用例文件（`electron-ssh` 车道）。
 *
 * `electron-app` 用同一条正则做 `testIgnore`、`electron-ssh` 用做 `testMatch`：两份名单
 * 若各写一遍，新增一条真实 SSH 用例时必然只改一处——漏了 `testIgnore` 这条车道会在
 * 没有远端机器的开发机与 CI 上收集它的用例，漏了 `testMatch` 则是新用例永远不跑。
 */
const REMOTE_SSH_SPECS =
  /electron[\\/](remoteSshExecution|remoteTaskSurvival|remoteChangeList|overlayMountProxyRemote)\.spec\.ts/;

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
  // 失败早停：默认会跑完全部用例并对每条失败用例重试，一条环境级故障能把车道拖到
  // 一个多小时（实测 electron-ssh 20 条用例全红 × 2.2 分钟 × 重试 = 95 分钟，而根因
  // 只是同一处启动失败）。CI 上 5 条失败即停：足够确认「不是偶发」，又能在几分钟内
  // 拿到结论。
  //
  // 为什么是 5 而不是 3：`electron-ssh` 的 14 条用例共用同一条远端链路，环境级故障
  // 会让前几条连续失败——3 条时整轮只跑到第 6 条就被切断，真实失败面（后面 8 条是否
  // 也红）看不出来。5 条能把「连续失败」与「零星失败」区分开，代价只是多跑几分钟。
  maxFailures: process.env.CI ? 5 : 0,
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
      testIgnore: REMOTE_SSH_SPECS,
    },
    // 真实 SSH 远端（要 e2e/environments.json：开发机用本机那份，CI 由 secrets 现写，
    // 见 e2e/README.md 的 CI 车道表）。
    //
    // **trace 必须关闭**：本车道的 `overlayMountProxyRemote.spec.ts` 要把远端 sudo 口令
    // `fill()` 进密码框，而 Playwright 的 trace 会把它原样记进三个地方——动作参数
    // （`{"method":"fill","params":{"value":"<口令>"}}`）、动作日志（`fill("<口令>")`）、
    // DOM 快照（`{"__playwright_value_":"<口令>"}`）。实测见 `e2e/README.md` 的
    // 「凭证不进 artifact」小节。仓库是 public，失败时 trace 作为 artifact 上传就是公开
    // 泄露。关掉 trace 后失败现场只剩 list reporter 的输出（实测不含口令），代价是这条
    // 车道没有 trace 可看——排查靠 `E2E_DEBUG=1` 透传主进程日志与远端证据。
    { name: 'electron-ssh', testMatch: REMOTE_SSH_SPECS, use: { trace: 'off' } },
    { name: 'remote-workspace-ui', testMatch: /remoteWorkspace[\\/].+\.spec\.ts/ },
    // 远程终端页面（specs/022，同 remote-workspace-ui 的手法）：构建产物 + 假 SSH 通道
    { name: 'terminal-ui', testMatch: /terminal[\\/].+\.spec\.ts/ },
    // TUI 安装程序（无浏览器：构建 → 自解压 → 载荷可执行 → TUI 启动守卫）
    { name: 'tui-installer', testMatch: /tui[\\/].+\.spec\.ts/ },
    // PyCharm 插件宿主（specs/035，本地车道：要 e2e/environments.json 的 pycharm 段 +
    // package:pycharm 产物，不进 CI——runner 没有 PyCharm 也不该构建整个插件）
    { name: 'pycharm-plugin', testMatch: /pycharm[\\/].+\.spec\.ts/ },
  ],
});
