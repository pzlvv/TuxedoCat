import * as fs from 'fs';
import * as path from 'path';
import { bootstrapCore, bootstrapSnapshot, shutdownCore } from '../host/bootstrapCore';
import { coreBinaryFileName, corePlatformDir } from '../host/standalone/coreBinary';
import { CORE_RESOURCE_DIR } from '../config/project';
import { createTuiStore } from '../tui/store';
import { TuiUIHost } from '../tui/TuiUIHost';
import { TuiSpinDesign } from '../tui/TuiSpinDesign';
import { TuiConversationManager } from '../tui/TuiConversationManager';
import { createChecker, runTests } from './helpers/harness';

/**
 * TUI 组合根对真实 Standalone Core 的装配（docs/tui.md 第 2 节接入架构）。
 *
 * 场景：TUI 的三契约（TuiUIHost / TuiSpinDesign / TuiConversationManager）+
 * bootstrapCore → 拉起 Core 进程（stdio）→ 握手 → 宿主环境送达 →
 * requestSettingsDefaults 的回包进入 store（TUI 唯一渲染事实）。
 *
 * 需要 Standalone Core 产物（先跑 `npm run build:core`）；产物缺失时跳过。
 * 运行方式：npm run test:all -- tuiBootstrap
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');
const CORE_BINARY = path.join(
  REPO_ROOT,
  'resources',
  CORE_RESOURCE_DIR,
  corePlatformDir(process.platform, process.arch) ?? '',
  coreBinaryFileName(process.platform),
);

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  if (!fs.existsSync(CORE_BINARY)) {
    console.log(`skip: ${path.relative(REPO_ROOT, CORE_BINARY)} missing (run npm run build:core)`);
    finish();
    return;
  }

  process.env.TUXEDO_CAT_CORE = 'standalone';

  const logs: string[] = [];
  const log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  const store = createTuiStore(log);
  const initialRuntimeStates = store.getState().runtimeStates;
  const workspace = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tui-boot-'));
  try {
    const host = new TuiUIHost({ workspacePath: workspace, log, dispatch: (a) => store.dispatch(a) });
    const spin = new TuiSpinDesign((a) => store.dispatch(a));
    const conversations = new TuiConversationManager(host, (a) => store.dispatch(a));

    const bootstrapped = bootstrapCore(host, spin, conversations, {
      locale: 'zh-CN',
      log,
      logToConsole: false,
      extensionPath: REPO_ROOT,
    });

    const snapshot = bootstrapSnapshot();
    check('coreKind = standalone', snapshot.coreKind === 'standalone');
    check('UI 已创建（WebViewUI 复用）', snapshot.uiCreated === true);

    const connection = bootstrapped.client.listConnections()[0];
    check('Connection 已就绪（Core 进程拉起 + 握手）', await waitFor(() => connection?.isReady() === true));
    check('Connection 归属 TUI 工作区', connection?.workspaceRef.path.replace(/\\/g, '/') === workspace.replace(/\\/g, '/'));

    // 上行：TUI 作为 wire 协议渲染方发请求（sender 为 null）
    await bootstrapped.ui.handleWebviewMessage({ type: 'requestSettingsDefaults' }, { sender: null });
    check('settingsDefaults 回包进入 store', await waitFor(() => store.getState().settingsDefaults !== null));
    check(
      'settingsDefaults 带默认模型',
      store.getState().settingsDefaults !== null
        && typeof store.getState().settingsDefaults?.model === 'string',
    );

    // 会话建立：startNewConversation 是上行 UiEvent（core 消费，无下行消息）；
    // 可观测效果 = 连接保持就绪、无处理失败日志
    const sessionId = '11111111-2222-3333-4444-555555555555';
    store.dispatch({ type: 'tui:activateSession', sessionId });
    await bootstrapped.ui.handleWebviewMessage({ type: 'startNewConversation', sessionId }, { sender: null });
    await new Promise((resolve) => setTimeout(resolve, 300));
    check('startNewConversation 处理无失败', !logs.some((line) => line.includes('handleWebviewMessage failed')));
    check('连接保持就绪', connection?.isReady() === true);

    // 运行态拉取：回包经广播进 store（sender 为 null 的单视图语义）
    await bootstrapped.ui.handleWebviewMessage({ type: 'requestSessionRuntimeStates' }, { sender: null });
    check('运行态回包进入 store', await waitFor(() => store.getState().runtimeStates !== initialRuntimeStates));

    await shutdownCore();
    check('shutdownCore 后 Connection 全部销毁', bootstrapped.client.listConnections().length === 0);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }

  finish();
}

runTests('tuiBootstrap', run);
