/**
 * 启动接线守卫（DEVELOPMENT.md 第 8.10 节）：
 *
 * 1. 共享骨架执行完毕后，自检快照的每个字段都成立；
 * 2. core 中导出的启动期注入点都在启动接线内登记（或属于白名单）。
 *
 * 第 2 条是「新增注入点忘了接线」的静态守卫：core 新增一个启动期 setter 却
 * 没在 `bootstrapCore.ts`（宿主侧骨架）或 `initializeCoreEvents.ts`（core 侧
 * UiEvent 订阅注册）里接线时，本测试失败。
 *
 * 运行方式：npm run test:all -- bootstrap-wiring
 */

import * as fs from 'fs';
import * as path from 'path';
import { bootstrapCore, bootstrapSnapshot } from '../host/bootstrapCore';
import { requireEventBus } from '../core/AssistantEventBus';
import {
  hasExtensionPath,
} from '../core/history/Config';
import { sessionQueue } from '../core/SessionQueue';
import { ConversationManager } from '../host/ConversationManager';
import type { SpinDesign } from '../host/SpinDesign';
import type { ConversationMetadata } from '../core/history/Conversation';
import type { SessionRuntimeState } from '../core/AssistantEventBus';
import { createChecker, runTests } from './helpers/harness';
import { createTestHost } from './helpers/fixtures';
import { getSettingsStore } from '../host/SettingsStore';
import { coreReadyCount, isCoreReady } from '../host/coreReadiness';

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

/**
 * 白名单：不需要出现在启动接线（`bootstrapCore.ts` 或 `initializeCoreEvents.ts`）的注入点。
 *
 * - `setSession*`：会话级运行时 setter，由 UiEvent 驱动，不属于启动接线。
 */
function isAllowedOutsideBootstrap(name: string): boolean {
  return name.startsWith('setSession');
}

/** 递归收集 src/core 下所有 .ts 文件路径 */
function collectCoreSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectCoreSources(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // 本节校验的是**进程内**接线（core 侧 UiEvent 订阅、注入点登记），固定用 embedded 装配；
  // Standalone 的进程 / 帧通道接线见 `standaloneBus.test.ts`。
  process.env.TUXEDO_CAT_CORE = 'embedded';

  // ── 1. 执行共享骨架并校验自检快照 ──
  const host = createTestHost();
  const conversations = new StubConversationManager(host);
  bootstrapCore(host, stubSpinDesign, conversations, {
    locale: 'zh-CN',
    log: () => undefined,
    logToConsole: false,
    extensionPath: '/tmp/tuxedo-cat-ext',
  });

  const snapshot = bootstrapSnapshot();
  check('snapshot.coreKind 为 embedded', snapshot.coreKind === 'embedded');
  check('snapshot.locale 保留宿主原始值', snapshot.locale === 'zh-CN');
  check('snapshot.eventBusRegistered', snapshot.eventBusRegistered === true);
  check('snapshot.uiCreated', snapshot.uiCreated === true);
  check('snapshot.extensionPathProvided', snapshot.extensionPathProvided === true);
  check('snapshot.sessionQueueInitialized', snapshot.sessionQueueInitialized === true);
  check('snapshot.logToConsole 保留宿主取值', snapshot.logToConsole === false);

  // ── 2. 读取入口在骨架执行完毕后可用（未注入即抛错的项） ──
  check('requireEventBus() 可用', (() => {
    try { requireEventBus(); return true; } catch { return false; }
  })());
  check('hasExtensionPath() 为真', hasExtensionPath());
  check('sessionQueue.hasCallbacks() 为真', sessionQueue.hasCallbacks());

  // ── 2b. Core 就绪与配置快照重推（docs/core-ui-separation.md 第 4.6、7 节） ──
  // `bootstrapCore` 发完 hostEnvironmentProvided 后 core 应用快照并发 coreReady；
  // 之后每次配置写盘都由 `SettingsStore` 的订阅重推整份快照。
  check('Core 已就绪（coreReady 已到达）', isCoreReady());
  check('就绪计数为 1（首次握手）', coreReadyCount() === 1);

  const store = getSettingsStore();
  let pushes = 0;
  store.subscribe(() => { pushes += 1; });
  await store.updateSettings((cfg: Record<string, any>) => {
    cfg.llm = { webSearch: false };
  });
  check('配置写盘触发快照推送', pushes === 1);
  check('重推快照后 coreReady 再来一次', coreReadyCount() === 2);
  check('重推后的快照已生效', store.getSnapshot().llm.webSearch === false);

  // ── 3. 静态守卫：core 的注入点都在骨架内登记 ──
  const coreDir = path.resolve(__dirname, '../../../src/core');
  // 启动接线分布在两处：宿主侧骨架 + core 侧 UiEvent 订阅注册
  const bootstrapSource = [
    path.resolve(__dirname, '../../../src/host/bootstrapCore.ts'),
    path.resolve(__dirname, '../../../src/core/initializeCoreEvents.ts'),
  ]
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  const exported = new Set<string>();
  for (const file of collectCoreSources(coreDir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/^export function ((?:set|initialize)[A-Za-z0-9_]*)\s*\(/gm)) {
      exported.add(match[1]);
    }
  }

  check('静态扫描到 core 的注入点', exported.size > 0);
  for (const name of [...exported].sort()) {
    if (isAllowedOutsideBootstrap(name)) continue;
    check(`${name} 已在启动接线中登记`, bootstrapSource.includes(name));
  }

  finish();
}

runTests('bootstrapWiring', run);
