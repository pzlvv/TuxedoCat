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

/**
 * 单用例硬上限（毫秒）。**这是防挂死的兜底，不是性能目标**：任何一条用例跑到这里都
 * 说明它在等一个永远不会来的信号，失败信息里带着 Playwright 的「Test timeout」，
 * 一眼可与断言失败区分。
 *
 * 30s 档覆盖绝大多数用例（实测基线见 `e2e/README.md` 的「时间预算」一节：
 * webview / remote-workspace / terminal 全部 < 14s，tui 装完前置后每条 < 0.1s）。
 * 整应用与真实 SSH 两档另有取值，理由写在各自 project 上。逐条用例的长任务用
 * `test.setTimeout()` 显式放宽——只在用例体内声明，不做文件级放宽。
 */
const FAST_TEST_TIMEOUT_MS = 30_000;

/**
 * Electron 整应用档：真实 standalone Core + Electron 冷启动本身就要数秒，
 * 且**加第二个工作区**的那批用例在 CI 上稳定多花约 30s（实测 7 条落在 30–34.3s，
 * 同一份用例在 Windows 开发机 2–4s；根因尚未定位，见 `e2e/README.md` 的「时间预算」）。
 * 60s = 实测最长 × 1.7：容得下慢机，又不给挂死留空间。其余 118 条实测 p90 = 12.3s，
 * 30s 档对它们本来就够——这里的放宽只服务已知的这 7 条，不为「可能慢」买单。
 */
const ELECTRON_APP_TEST_TIMEOUT_MS = 60_000;

/**
 * 真实 SSH 档：每次断言背后可能是一次 WAN 往返 + 远端 daemon/Core 引导，
 * 实测中位 41s。60s 是「一次远端操作不会正常超过」的上限；确有长任务的用例
 * （等 daemon 30s 空闲退出、120 条改动一次取数、跨孤儿期的 sleep 任务等）在**用例体内**
 * 用 `test.setTimeout()` 显式放宽，并写明需要的时长——文件级放宽等于放弃这层闸门。
 */
const SSH_TEST_TIMEOUT_MS = 60_000;

/**
 * 整轮上限：一次 Playwright 调用（= 一个 CI 车道）最多跑这么久，到点连同未开始的
 * 用例一起收尾。它兜住「每条用例都没超时、但用例太多」这一档——`maxFailures`
 * 只管失败，管不了慢。
 *
 * 与 `all.yml` 的 job 上限的关系：15min < 单个 e2e job 的 `timeout-minutes`，
 * 留出产物下载 / xvfb / 上传 trace 的时间，整条 `all` 才能压进 30min。
 */
const RUN_TIMEOUT_MS = 15 * 60_000;

export default defineConfig({
  testDir: '.',
  // 默认档（30s）给四个前端车道；三个重车道的 project 各自覆盖。
  timeout: FAST_TEST_TIMEOUT_MS,
  // 整轮上限：CI 上生效，本地（`CI` 未设）不限——本地调试要看完整失败面。
  globalTimeout: process.env.CI ? RUN_TIMEOUT_MS : 0,
  // 单个断言 30s：**沿用既有取值，不放宽也不收紧**。收紧会改变通过判据（实测有
  // 7 条整应用用例在慢 runner 上整条跑到 32s，无法排除其中包含 15–30s 的合法等待），
  // 而单条用例的硬上限已经保证了「一条用例最多烧掉一档预算」。
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  // CI 不重试：重试会把每条失败用例的墙钟翻倍（5 条失败 × 60s 档 × 2 = 10min，且
  // 真实 SSH 那批的长任务用例单条就要 300s），与「失败即停、30min 内出结论」冲突；
  // 偶发失败要靠修用例，不靠重跑掩盖。
  // 本地也不重试（默认值）：调试要看到第一次的真实错误。
  retries: 0,
  // 失败早停：5 条失败即停。足够确认「不是偶发」，又能在几分钟内拿到结论——
  // 实测环境级故障（远端 daemon 引导超时，run 44973531021）会让前几条连续打红，
  // 不设上限时一条车道能烧掉几十分钟。为什么是 5：`electron-ssh` 的多条用例共用
  // 同一条远端链路，3 条时整轮只跑到第 6 条就被切断，真实失败面看不出来。
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
      timeout: ELECTRON_APP_TEST_TIMEOUT_MS,
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
    { name: 'electron-ssh', testMatch: REMOTE_SSH_SPECS, use: { trace: 'off' }, timeout: SSH_TEST_TIMEOUT_MS },
    { name: 'remote-workspace-ui', testMatch: /remoteWorkspace[\\/].+\.spec\.ts/ },
    // 远程终端页面（specs/022，同 remote-workspace-ui 的手法）：构建产物 + 假 SSH 通道
    { name: 'terminal-ui', testMatch: /terminal[\\/].+\.spec\.ts/ },
    // TUI 安装程序（无浏览器：构建 → 自解压 → 载荷可执行 → TUI 启动守卫）
    //
    // 上限 5min 而不是 30s：Playwright 的 `beforeAll` 用的是 **project 的 timeout**
    // （不是用例的），而本车道的 `beforeAll` 要跑 `build-tui-installer.mjs` 用 cargo
    // 构建被测安装器（CI 冷缓存约 1 分钟）。用例本身都在 100ms 内，长的是这条一次性前置。
    { name: 'tui-installer', testMatch: /tui[\\/].+\.spec\.ts/, timeout: 5 * 60_000 },
    // PyCharm 插件宿主（specs/035，本地车道：要 e2e/environments.json 的 pycharm 段 +
    // package:pycharm 产物，不进 CI——runner 没有 PyCharm 也不该构建整个插件）
    // 起 IDE + 装插件 + 等面板就绪本身就是分钟级（`pycharmIde.ts` 的面板查找预算
    // 180s），30s 档对它没有意义，单独给 5min。
    { name: 'pycharm-plugin', testMatch: /pycharm[\\/].+\.spec\.ts/, timeout: 5 * 60_000 },
  ],
});
