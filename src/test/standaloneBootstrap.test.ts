/**
 * Standalone 装配下的启动接线（docs/core/standalone-core.md 第 3、5、7 节）：
 * - `CORE_KIND = standalone` 时 `bootstrapCore` 拉起 Core 进程并完成握手；
 * - 宿主环境经帧通道进入 Core；Core 侧的日志事件回到宿主日志出口；
 * - 自检快照报告 `coreKind = standalone` 与 UI 侧接线事实；
 * - `shutdownCore()` 结束 Core 进程。
 *
 * 需要 Standalone Core 产物（先跑 `npm run build:core`）；产物缺失时跳过。
 * 运行方式：npm run test:all -- standalone-bootstrap
 */

import * as fs from 'fs';
import * as path from 'path';
import { bootstrapCore, bootstrapSnapshot, shutdownCore } from '../host/bootstrapCore';
import { requireEventBus } from '../core/AssistantEventBus';
import { hasExtensionPath } from '../core/history/Config';
import { ConversationManager } from '../host/ConversationManager';
import type { SpinDesign } from '../host/SpinDesign';
import type { ConversationMetadata } from '../core/history/Conversation';
import type { SessionRuntimeState } from '../core/AssistantEventBus';
import { coreBinaryFileName, corePlatformDir } from '../host/standalone/coreBinary';
import { CORE_ENV_VAR, CORE_RESOURCE_DIR } from '../config/project';
import { createChecker, runTests } from './helpers/harness';
import { createTestHost } from './helpers/fixtures';

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

const REPO_ROOT = path.resolve(__dirname, '../../..');
const CORE_BINARY = path.join(
  REPO_ROOT,
  'resources',
  CORE_RESOURCE_DIR,
  corePlatformDir('win32', 'x64')!,
  coreBinaryFileName('win32'),
);

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  if (process.platform !== 'win32' || process.arch !== 'x64' || !fs.existsSync(CORE_BINARY)) {
    console.log(`skip: ${path.relative(REPO_ROOT, CORE_BINARY)} missing (run npm run build:core)`);
    finish();
    return;
  }

  process.env[CORE_ENV_VAR] = 'standalone';

  const logs: string[] = [];
  const host = createTestHost({
    getWorkspacePath: () => 'D:/repo',
  });
  const conversations = new StubConversationManager(host);

  const bootstrapped = bootstrapCore(host, stubSpinDesign, conversations, {
    locale: 'zh-CN',
    log: (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '));
    },
    logToConsole: false,
    extensionPath: REPO_ROOT,
  });

  const snapshot = bootstrapSnapshot();
  check('snapshot.coreKind 为 standalone', snapshot.coreKind === 'standalone');
  check('snapshot.eventBusRegistered', snapshot.eventBusRegistered === true);
  check('snapshot.uiCreated', snapshot.uiCreated === true);
  check('snapshot.extensionPathProvided', snapshot.extensionPathProvided === true);
  check('snapshot.locale 保留宿主原始值', snapshot.locale === 'zh-CN');

  check(
    'requireEventBus() 可用',
    (() => {
      try {
        requireEventBus();
        return true;
      } catch {
        return false;
      }
    })(),
  );

  check(
    'core 日志经帧通道回到宿主日志出口',
    await waitFor(() => logs.some((line) => line.includes('Standalone Core ready'))),
  );

  // Standalone 下 core 侧状态在 Core 进程内：进程内不注册 core 侧订阅，
  // 也不建会话队列（这些是 Core 进程的职责）。
  check('进程内不注册 core 侧扩展路径', !hasExtensionPath());

  // 连接模型（docs/core/client-connection.md）：打开的工作区对应一个 Connection
  check('启动快照报告 Connection 数', snapshot.connectionCount === 1);
  const connection = bootstrapped.client.listConnections()[0];
  check('Connection 已就绪', await waitFor(() => connection?.isReady() === true));
  check('Connection 归属当前工作区', connection?.workspaceRef.path.replace(/\\/g, '/') === 'D:/repo');

  await shutdownCore();
  check('shutdownCore() 之后 Connection 全部销毁', bootstrapped.client.listConnections().length === 0);
  check('shutdownCore() 之后总线不再就绪', (() => {
    const bus = requireEventBus() as { isReady?: () => boolean };
    return typeof bus.isReady !== 'function' || bus.isReady() === false;
  })());

  finish();
}

runTests('standalone-bootstrap', run);
