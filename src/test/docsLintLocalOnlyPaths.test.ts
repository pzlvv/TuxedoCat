import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createChecker, runTests } from './helpers/harness';

/**
 * docsLint 存在性检查与「按设计不入库」的本机文件
 * （`specs/defects/docs-lint-flags-gitignored-paths.md`）。
 *
 * `e2e/environments.json` 含 SSH 凭证、由 `.gitignore` 排除，每台机器自己准备；`e2e/README.md`
 * 与缺陷规格在行内代码里引用它是正当的。docsLint 的路径存在性检查若只看本机文件系统，
 * 干净克隆与 CI 上就必红——红绿取决于本机有没有准备凭证，与仓库内容无关。
 *
 * 两条断言：
 * - RT-1：把该文件临时移开（它本就不存在时直接跑），docsLint 仍须 exit 0；
 * - RT-2：豁免判定只认 `.gitignore` 覆盖的路径，不许扩大成「整目录豁免」。
 *
 * 运行方式：`npm run test:all -- docs-lint-local-only`
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');

/** 编译后的 docsLint 入口（`compile-tests` 的产物，与 runner 同一条车道） */
const DOCS_LINT_ENTRY = path.join(__dirname, 'docsLint.test.js');

/** 按设计不入库、本机自备的样本文件 */
const LOCAL_ONLY = 'e2e/environments.json';

/** 跑一次编译后的 docsLint，返回退出码 */
function runDocsLint(): number | null {
  const result = spawnSync(process.execPath, [DOCS_LINT_ENTRY], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return result.status;
}

runTests('docsLintLocalOnlyPaths', () => {
  const { check, finish } = createChecker();

  // RT-1：本机没有那份凭证文件时，docsLint 不许因此变红
  const target = path.join(REPO_ROOT, LOCAL_ONLY);
  const backup = `${target}.docs-lint-bak`;
  const present = fs.existsSync(target);
  if (present) fs.renameSync(target, backup);
  let status: number | null = null;
  try {
    status = runDocsLint();
  } finally {
    if (present) fs.renameSync(backup, target);
  }
  check('缺少本机专属文件时 docsLint 仍绿', status === 0);

  // RT-2：豁免只认 .gitignore 覆盖的路径（同目录入库文件与拼错路径都不许被豁免）
  const helperPath = path.join(__dirname, 'helpers', 'docPathExistence.js');
  check('本机专属判定模块存在', fs.existsSync(helperPath));
  if (fs.existsSync(helperPath)) {
    const { isLocalOnlyPath } = require(helperPath) as { isLocalOnlyPath: (rel: string) => boolean };
    check('本机专属判定只认 .gitignore 覆盖的路径', isLocalOnlyPath(LOCAL_ONLY));
    check('入库文件不判为本机专属', !isLocalOnlyPath('e2e/environments.example.json'));
    check('不存在的普通路径不判为本机专属', !isLocalOnlyPath('e2e/does-not-exist.json'));
    // RT-3：目录专属 gitignore 模式（`resources/core/`，build-core.mjs 的产物落点）在
    // 路径本机缺失时仍豁免——git 对「不存在的无斜杠路径」按文件解读，目录专属模式
    // 永不命中，干净克隆与 CI 上会误报失效引用（smoke 车道首跑实证）
    const dirFixture = path.join(REPO_ROOT, 'resources', 'core');
    const dirBackup = `${dirFixture}.docs-lint-bak`;
    const dirPresent = fs.existsSync(dirFixture);
    if (dirPresent) fs.renameSync(dirFixture, dirBackup);
    try {
      check('目录专属 gitignore 模式在本机缺失时仍豁免', isLocalOnlyPath('resources/core'));
    } finally {
      if (dirPresent) fs.renameSync(dirBackup, dirFixture);
    }
  }

  finish();
});
