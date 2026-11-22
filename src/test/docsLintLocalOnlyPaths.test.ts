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
 * 三条断言：
 * - RT-1：把该文件临时移开（它本就不存在时直接跑），docsLint 仍须 exit 0；
 * - RT-2：豁免判定只认 `.gitignore` 覆盖的路径，不许扩大成「整目录豁免」。
 * - RT-4：仓库顶层「按设计不入库」的目录整棵不进扫描面——本机草稿目录里的符号不许
 *   让文档里的标识符「存活」（`specs/defects/docs-lint-scans-local-only-dirs.md`）。
 *
 * 运行方式：`npm run test:all -- docs-lint-local-only`
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');

/** 编译后的 docsLint 入口（`compile-tests` 的产物，与 runner 同一条车道） */
const DOCS_LINT_ENTRY = path.join(__dirname, 'docsLint.test.js');

/** 按设计不入库、本机自备的样本文件 */
const LOCAL_ONLY = 'e2e/environments.json';

/**
 * RT-4 的探针标识符：只存在于临时造出的本机专属目录里，仓库入库内容中一次都不出现
 * （`identifierUniverse` 若把它算进来，文档侧引用就「假存活」）。
 *
 * 运行时拼出来而不是写字面量：本文件自己也在 docsLint 的扫描面里（只排除
 * `docsLint.test.ts`），写成字面量就等于把符号塞进了 `identifierUniverse`，探针自证清白。
 */
const PROBE_SYMBOL = ['docsLintLocalOnlyProbe', 'Symbol'].join('');

/**
 * RT-4 的探针目录名。
 *
 * 必须同时满足两条：被 `.gitignore` 覆盖、且不在 docsLint 的 `SKIP_DIRS` 里——后者本来就
 * 不进扫描，测不到「本机专属目录被判出去」这条逻辑。`.gitignore` 里只有 `*.vsix` 这个
 * 模式能作为顶层目录名同时满足两条（其余忽略模式要么已列进 `SKIP_DIRS`，要么是本机真实
 * 存在的大目录）。
 */
const PROBE_DIR = 'docs-lint-local-only-probe.vsix';

/** RT-4 的探针文档：入库侧只见这一处引用（跑完即删） */
const PROBE_DOC = 'docs-lint-local-only-probe.md';

/** 跑一次编译后的 docsLint，返回退出码与输出 */
function runDocsLint(): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [DOCS_LINT_ENTRY], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
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
    status = runDocsLint().status;
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

  // RT-4：本机专属目录整棵不进扫描面——它的存在不许改变「文档里的标识符是否存活」
  //
  // 构造：顶层造一个被 `.gitignore` 覆盖的目录，里面放一份提到 PROBE_SYMBOL 的脚本；
  // 再在一份入库文档里引用 PROBE_SYMBOL。正确行为是**红**（符号只在非入库目录里，
  // 代码里不存在）；扫描面若包含该目录，符号就被「救活」而假绿，本地绿 / 干净克隆红
  // 的翻转正是缺陷本身。
  const probeDir = path.join(REPO_ROOT, PROBE_DIR);
  const probeDoc = path.join(REPO_ROOT, PROBE_DOC);
  fs.rmSync(probeDir, { recursive: true, force: true });
  fs.rmSync(probeDoc, { force: true });
  try {
    fs.mkdirSync(probeDir, { recursive: true });
    fs.writeFileSync(path.join(probeDir, 'probe.mjs'), `const x = {\n  ${PROBE_SYMBOL}: 1,\n};\nconsole.log(x);\n`);
    fs.writeFileSync(probeDoc, `# 探针\n\n临时文档：\`${PROBE_SYMBOL}\`\n`);
    const probe = runDocsLint();
    const missed = `标识符在代码里不存在：\`${PROBE_SYMBOL}\``;
    check(
      '本机专属目录里的符号不参与标识符存活判定',
      probe.status !== 0 && probe.output.includes(missed),
    );
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
    fs.rmSync(probeDoc, { force: true });
  }

  finish();
});
