/**
 * 对等测试：项目清单 `workspace.meta.json`（Embedded ↔ Standalone）。
 *
 * Embedded `ensureProjectConversationDir` 在首次确保某个项目对话目录时，由 Core 自己
 * 写入 `<projectDir>/workspace.meta.json`（记录完整 workspacePath）；宿主不参与写盘。
 * `ensureConfigDirs` 还会为已存在的目录补写一次。
 *
 * Standalone 侧同一行为由 `core-rs/src/config.rs` 的
 * `ensure_project_conversation_dir` / `ensure_config_dirs` 实现，
 * 对应用例 `core-rs/src/config_tests.rs` 的
 * `ensure_project_conversation_dir_writes_meta_once_and_backfills`。
 *
 * 运行方式：npm run test:all -- project-conversation-dir-parity
 */

import * as fs from 'fs';
import { join } from 'path';
import { createChecker, runTests } from './helpers/harness';
import { makeTempDir } from './helpers/fixtures';
import {
  ensureProjectConversationDir,
  getProjectConversationDir,
} from '../core/history/Config';

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  const root = makeTempDir('project-dir-ready-parity');

  try {
    const dir = await ensureProjectConversationDir(root);
    await ensureProjectConversationDir(root);

    const metaPath = join(dir, 'workspace.meta.json');
    check('目录已创建', fs.existsSync(dir));
    check('projectDir 落在 conversations 根下', dir === getProjectConversationDir(root));
    check('Core 自己写了项目清单', fs.existsSync(metaPath));
    check(
      '清单记录了 workspacePath',
      JSON.parse(fs.readFileSync(metaPath, 'utf8')).workspacePath === root,
    );
    check('不再有宿主写的 settings.json', !fs.existsSync(join(dir, 'settings.json')));
  } finally {
    finish();
  }
}

runTests('project-conversation-dir-parity', run);
