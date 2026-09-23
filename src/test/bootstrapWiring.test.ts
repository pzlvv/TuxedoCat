/**
 * 启动接线守卫（DEVELOPMENT.md 第 8.10 节）：
 *
 * 1. 共享骨架执行完毕后，自检快照的每个字段都成立；
 * 2. core 中导出的启动期注入点都在共享骨架内登记（或属于白名单）。
 *
 * 第 2 条是「新增注入点忘了接线」的静态守卫：core 新增一个 set*Provider 却
 * 没在 bootstrapCore.ts 里接线时，本测试失败。
 *
 * 运行方式：tsc -p tsconfig.test.json && node out/src/test/bootstrapWiring.test.js
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { bootstrapCore, bootstrapSnapshot } from '../host/bootstrapCore';
import { requireEventBus } from '../core/AssistantEventBus';
import {
  hasExtensionPathProvider,
  hasProjectRootProvider,
} from '../core/history/Config';
import { requireSessionWaitingForUserProvider } from '../core/sessionResources';
import { sessionQueue } from '../core/SessionQueue';
import { ConversationManager } from '../host/ConversationManager';
import type { UIHost } from '../host/UIHost';
import type { SpinDesign } from '../host/SpinDesign';
import type { ConversationMetadata } from '../core/history/Conversation';
import type { SessionRuntimeState } from '../core/AssistantEventBus';

/** 最小 UIHost 桩：骨架只读取它并把它注入 WebViewUI，不发任何消息 */
function createStubHost(): UIHost {
  return {
    sendToWebview: () => undefined,
    broadcastToWebviews: () => undefined,
    sendToWebviewView: () => undefined,
    onThemeChanged: () => undefined,
    log: () => undefined,
    getWorkspacePath: () => undefined,
    onDidChangeWorkspace: (listener) => {
      // 契约：订阅时立即回调一次当前值
      listener(undefined);
      return () => undefined;
    },
    isDarkTheme: () => false,
    getLocale: () => 'en',
    openFile: async () => undefined,
    showVirtualDocument: async () => undefined,
    showDiff: async () => undefined,
    openMermaidPreview: async () => undefined,
    closePreview: () => undefined,
    openExternalUrl: async () => undefined,
    saveTextFile: async () => ({ success: false, canceled: true }),
    closeConversationView: async () => undefined,
    updateSettingsJson: async () => undefined,
    ensureProjectSettings: async () => undefined,
  };
}

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
 * 白名单：不需要出现在 bootstrapCore.ts 的注入点。
 *
 * - `setSession*`：会话级运行时 setter，由 UiEvent 驱动，不属于启动接线；
 * - `setProjectRootProvider`：由骨架内的 `initializeHistory(host)` 间接注入。
 */
function isAllowedOutsideBootstrap(name: string): boolean {
  if (name === 'setSessionWaitingForUserProvider') return false;
  if (name.startsWith('setSession')) return true;
  if (name === 'setProjectRootProvider') return true;
  return false;
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

function run(): void {
  let passed = 0;
  let failed = 0;
  const check = (name: string, cond: boolean): void => {
    if (cond) { passed++; console.log(`ok   ${name}`); }
    else { failed++; console.log(`FAIL ${name}`); }
  };

  // ── 1. 执行共享骨架并校验自检快照 ──
  const host = createStubHost();
  const conversations = new StubConversationManager(host);
  bootstrapCore(host, stubSpinDesign, conversations, {
    locale: 'zh-CN',
    log: () => undefined,
    logToConsole: false,
    extensionPath: '/tmp/tuxedo-cat-ext',
  });

  const snapshot = bootstrapSnapshot();
  check('snapshot.locale 保留宿主原始值', snapshot.locale === 'zh-CN');
  check('snapshot.eventBusRegistered', snapshot.eventBusRegistered === true);
  check('snapshot.uiCreated', snapshot.uiCreated === true);
  check('snapshot.projectRootProviderInjected', snapshot.projectRootProviderInjected === true);
  check('snapshot.extensionPathProviderInjected', snapshot.extensionPathProviderInjected === true);
  check('snapshot.sessionQueueInitialized', snapshot.sessionQueueInitialized === true);
  check('snapshot.waitingForUserInjected', snapshot.waitingForUserInjected === true);
  check('snapshot.logToConsole 保留宿主取值', snapshot.logToConsole === false);

  // ── 2. 读取入口在骨架执行完毕后可用（未注入即抛错的项） ──
  check('requireEventBus() 可用', (() => {
    try { requireEventBus(); return true; } catch { return false; }
  })());
  check('hasProjectRootProvider() 为真', hasProjectRootProvider());
  check('hasExtensionPathProvider() 为真', hasExtensionPathProvider());
  check('sessionQueue.hasCallbacks() 为真', sessionQueue.hasCallbacks());
  check('requireSessionWaitingForUserProvider() 可用', (() => {
    try { requireSessionWaitingForUserProvider(); return true; } catch { return false; }
  })());

  // ── 3. 静态守卫：core 的注入点都在骨架内登记 ──
  const coreDir = path.resolve(__dirname, '../../../src/core');
  const bootstrapSource = fs.readFileSync(
    path.resolve(__dirname, '../../../src/host/bootstrapCore.ts'),
    'utf8',
  );
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
    check(`${name} 已在 bootstrapCore.ts 登记`, bootstrapSource.includes(name));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  assert.strictEqual(failed, 0, `${failed} bootstrap wiring check(s) failed`);
}

run();
