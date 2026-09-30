/**
 * 对等测试：「项目对话目录已就绪」事件（Embedded ↔ Standalone）。
 *
 * Embedded `ensureProjectConversationDir` 在首次确保某个项目对话目录时上报一次
 * `CoreEvent.projectConversationDirReady`（带 `projectDir` / `workspacePath`），
 * 宿主据此在目录里写 `settings.json`（记录完整 workspacePath）；`ensureConfigDirs`
 * 还会为已存在的旧目录补上报一次。core 只上报事实，不写 settings.json。
 *
 * Standalone 侧同一行为由 `core-rs/src/config.rs` 的
 * `ensure_project_conversation_dir` / `ensure_config_dirs` 实现，
 * 对应用例 `core-rs/src/config_tests.rs` 的
 * `ensure_project_conversation_dir_announces_once_and_backfills`。
 *
 * 运行方式：npm run test:all -- project-conversation-dir-parity
 */

import * as fs from 'fs';
import { createEventBus } from '../host/EventBus';
import { setGlobalEventBus, resetGlobalEventBus } from '../core/AssistantEventBus';
import { createChecker, runTests } from './helpers/harness';
import { createRecordingCoreEventHandlers, makeTempDir } from './helpers/fixtures';
import {
  ensureProjectConversationDir,
  getProjectConversationDir,
} from '../core/history/Config';

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  const recording = createRecordingCoreEventHandlers();
  const bus = createEventBus();
  bus.onCoreEvents(recording.handlers);
  setGlobalEventBus(bus);
  const root = makeTempDir('project-dir-ready-parity');

  try {
    const dir = await ensureProjectConversationDir(root);
    await ensureProjectConversationDir(root);

    const events = recording.received('projectConversationDirReady');
    check('目录 ensure 两次只上报一次', events.length === 1);
    check('事件携带 projectDir', events[0]?.projectDir === getProjectConversationDir(root));
    check('事件携带 workspacePath', events[0]?.workspacePath === root);
    check('目录已创建', fs.existsSync(dir));
    check('projectDir 落在 conversations 根下', dir === getProjectConversationDir(root));
  } finally {
    resetGlobalEventBus();
    finish();
  }
}

runTests('project-conversation-dir-parity', run);
