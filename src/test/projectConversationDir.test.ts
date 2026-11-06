/**
 * 单测：宿主侧项目对话目录的路径解析（`src/shared/history/Config.ts`）。
 *
 * 会话数据（含 `workspace.meta.json`）由 Core 独占写入，宿主只解析路径做只读访问：
 * 本用例锁「解码后的目录落在 conversations 根下」与「分隔符两种写法解析到同一份数据」。
 * Core 侧的编码与清单写入由 `core-rs/src/config_tests.rs` 锁定。
 *
 * 运行方式：npm run test:unit -- project-conversation-dir
 */

import * as fs from 'fs';
import { join } from 'path';
import { createChecker, runTests } from './helpers/harness';
import { makeTempDir } from './helpers/fixtures';
import { getConversationDir, getProjectConversationDir, projectDirCandidates } from '../shared/history/Config';

// 家目录指到临时目录：路径解析落在隔离的 conversations 根下，不碰真实用户数据。
// （`resolveConfigDir` 是调用期读环境变量的，因此模块顶部设置即生效）
const home = makeTempDir('project-dir-home');
process.env.USERPROFILE = home;
process.env.HOME = home;

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  const root = makeTempDir('project-dir-ready-parity');
  checkSeparatorVariants();

  try {
    const dir = getProjectConversationDir(root);
    // 编码目录名 = 绝对路径的 encodeURIComponent（与 core-rs/src/config.rs 同一口径）
    check(
      'projectDir 落在 conversations 根下',
      dir === join(getConversationDir(), projectDirCandidates(root)[0] ?? ''),
    );
    check('解析不创建目录（写入归 Core）', !fs.existsSync(dir));
    check('宿主不再写项目清单', !fs.existsSync(join(dir, 'workspace.meta.json')));
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
