/**
 * 单测：宿主侧会话落盘库的项目清单 `workspace.meta.json` 行为
 * （`src/shared/history/Config.ts`）。
 *
 * `ensureProjectConversationDir` 在首次确保某个项目对话目录时写入
 * `<projectDir>/workspace.meta.json`（记录完整 workspacePath）；
 * `ensureConfigDirs` 还会为已存在的目录补写一次。
 * Core 侧同一格式由 `core-rs/src/config.rs` 的 `ensure_project_conversation_dir` /
 * `ensure_config_dirs` 实现（用例 `core-rs/src/config_tests.rs`）。
 *
 * 运行方式：npm run test:all -- project-conversation-dir
 */

import * as fs from 'fs';
import { join } from 'path';
import { createChecker, runTests } from './helpers/harness';
import { makeTempDir } from './helpers/fixtures';
import {
  ensureProjectConversationDir,
  getProjectConversationDir,
} from '../shared/history/Config';

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  const root = makeTempDir('project-dir-ready-parity');
  checkSeparatorVariants();

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

/** 分隔符写法归一（Windows）：同一目录的 \ 与 / 写法解析到同一份对话数据，
 * 不再为写法差异裂成两个对话空间（实测缺陷：d:/git/X 与 d:\git\X 各出一个空间）。 */
function checkSeparatorVariants(): void {
  if (process.platform !== 'win32') return;
  const { check } = createChecker();
  const backslash = 'D:\\parity-merge\\demo';
  const forward = 'D:/parity-merge/demo';
  const backslashDir = getProjectConversationDir(backslash);
  fs.mkdirSync(backslashDir, { recursive: true });
  check('正斜杠写法解析到已存在的反斜杠目录', getProjectConversationDir(forward) === backslashDir);
  check('反斜杠写法保持稳定', getProjectConversationDir(backslash) === backslashDir);
}

runTests('projectConversationDir', run);
