/**
 * 启动接线守卫（docs/hosts/host-bootstrap.md 第 5 节）：
 *
 * 1. 共享骨架执行完毕后，自检快照的每个字段都成立；
 * 2. 注入的 Core 通道上能收到宿主环境与配置快照（连接建立即推送、写盘后重推）。
 *
 * 运行方式：npm run test:all -- bootstrap-wiring
 */

import { ConversationManager } from '../host/ConversationManager';
import type { SpinDesign } from '../host/SpinDesign';
import { bootstrapCore, bootstrapSnapshot, shutdownCore } from '../host/bootstrapCore';
import { requireEventBus } from '../shared/AssistantEventBus';
import type { SessionRuntimeState } from '../shared/AssistantEventBus';
import type { ConversationMetadata } from '../shared/history/Conversation';
import type { OpenedCoreChannel } from '../host/Client';
import { createChecker, runTests } from './helpers/harness';
import { createTestHost, makeTempDir } from './helpers/fixtures';
import { createTestBus } from './helpers/testBus';
import { getSettingsStore, resetSettingsStore } from '../host/SettingsStore';
import { getHostLocale } from '../host/i18n';

class StubConversationManager extends ConversationManager {
  protected async dispatchList(_list: readonly ConversationMetadata[]): Promise<void> {
    /* 桩：不分发 */
  }

  protected dispatchStates(_states: readonly SessionRuntimeState[]): void {
    /* 桩：不分发 */
  }
}

const stubSpinDesign: SpinDesign = {
  open: async () => undefined,
  refresh: async () => undefined,
};

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // 配置存储读写宿主自己的 `settings.json`：HOME 指向临时目录，避免污染真实用户配置。
  // 也必须隔离：用例把 `llm.webSearch` 改成 `false` 来触发订阅，若真实配置已是 `false`
  // 内容不变、订阅不触发，用例会「自中毒」失败。必须在 `getSettingsStore()` 首次调用
  // （`bootstrapCore` 内）之前设置 HOME 并丢弃可能已建的共享实例。
  const home = makeTempDir('bootstrap-wiring-home');
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  resetSettingsStore();

  // ── 1. 执行共享骨架并校验自检快照（Core 通道用内存总线注入）──
  const host = createTestHost();
  const conversations = new StubConversationManager(host);
  /** 通道侧收到的 hostEnvironmentProvided 条数 */
  let snapshots = 0;
  const openChannel = (): OpenedCoreChannel => {
    const bus = createTestBus();
    bus.onUiEvent('hostEnvironmentProvided', () => { snapshots += 1; });
    return { bus, dispose: async () => undefined };
  };
  bootstrapCore(host, stubSpinDesign, conversations, {
    locale: 'zh-CN',
    log: () => undefined,
    logToConsole: false,
    extensionPath: '/tmp/ext',
    openStandaloneChannel: () => openChannel(),
  });

  const snapshot = bootstrapSnapshot();
  check('snapshot.locale 保留宿主原始值', snapshot.locale === 'zh-CN');
  check('snapshot.eventBusRegistered', snapshot.eventBusRegistered === true);
  check('snapshot.uiCreated', snapshot.uiCreated === true);
  check('snapshot.extensionPathProvided', snapshot.extensionPathProvided === true);
  check('snapshot.logToConsole 保留宿主取值', snapshot.logToConsole === false);
  check('snapshot.connectionCount ≥ 1', snapshot.connectionCount >= 1);

  // 宿主语言在骨架内**同步**收敛：不依赖 Connection 就绪事件（Standalone 要等
  // Core 进程握手）。locale='zh-CN' + 未配置 uiLanguage（auto）→ 中文。
  check('宿主语言已在 bootstrapCore 内同步收敛', getHostLocale() === 'zh');

  // ── 2. 读取入口在骨架执行完毕后可用 ──
  check('requireEventBus() 可用', (() => {
    try { requireEventBus(); return true; } catch { return false; }
  })());

  // ── 3. 配置快照：连接建立即送达，写盘后整份重推 ──
  // 空工作区占位 Connection 建立时就会推送一次快照
  const waitFirst = (count: number): Promise<void> =>
    count > 0
      ? Promise.resolve()
      : new Promise((resolve) => setTimeout(resolve, 5));
  await waitFirst(snapshots);
  check('连接建立即推送宿主环境与配置快照', snapshots >= 1);

  const store = getSettingsStore();
  let pushes = 0;
  store.subscribe(() => { pushes += 1; });
  await store.updateSettings((cfg: Record<string, any>) => {
    cfg.llm = { webSearch: false };
  });
  check('配置写盘触发快照推送', pushes === 1);
  check('重推后的快照已生效', store.getSnapshot().llm.webSearch === false);

  await shutdownCore();
  finish();
}

runTests('bootstrapWiring', run);
