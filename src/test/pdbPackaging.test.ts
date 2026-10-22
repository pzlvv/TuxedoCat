import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CORE_BINARY_NAME } from '../config/project';
import { createChecker, runTests } from './helpers/harness';

/**
 * Core 调试符号（`.pdb`）的打包边界（`docs/core/standalone-core.md` 第 3.1 节的部署单元与
 * 打包布局、`docs/core/standalone-core.md` 第 3.3 节的产物落位）。
 *
 * `.pdb` 是**本地崩溃诊断**用的符号文件（`docs/core/core-remote.md` 第 2.5 节），
 * 不属于运行时产物：最终产品只携带可执行文件、`fingerprint` 与 `ripgrep/`。
 * `scripts/copy-assets.mjs` 会把整个 `resources/` 复制进 `dist/`，所以符号文件会出现在
 * `dist/resources/core/<dir>/`；打包边界必须把它挡在分发物之外。
 *
 * 覆盖点：
 * - 按 **vsce 自己的打包过滤**（`@vscode/vsce` 的 `collect`，不是复刻匹配语义）跑仓库
 *   真实的 `.vscodeignore`：`dist/resources/core/<dir>/<core.binaryName>.pdb` 不进 vsix，
 *   而同目录的可执行文件 / `fingerprint` / `ripgrep/` 与 webview 产物仍在包内；
 * - Electron 侧不显式打开 electron-builder 的 `includePdb`（默认排除 `**\/*.pdb`）。
 *
 * 在临时目录里铺同名文件 + 复制 `.vscodeignore` 后再跑 vsce 的过滤：`collect` 会遍历
 * 整个仓库（含 dist 构建产物），对真实目录跑一次要十几秒；临时目录只放这几个文件，
 * 语义与真实打包一致（匹配只看 `.vscodeignore` 与文件路径）。
 *
 * 运行方式：npm run test:all -- pdb-packaging
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');

/** 必须继续进 vsix 的运行时产物（白名单不能收窄过头） */
const SHIPPED_FILES = [
  `dist/resources/core/x64-win32/${CORE_BINARY_NAME}.exe`,
  'dist/resources/core/x64-win32/fingerprint',
  'dist/resources/core/x64-win32/ripgrep/rg.exe',
  `dist/resources/core/x64-linux/${CORE_BINARY_NAME}`,
  'dist/resources/core/x64-linux/fingerprint',
  'dist/webview/index.html',
  'assets/logo.png',
];

/** 调试符号：本地诊断产物，不能进 vsix */
const PDB_FILE = `dist/resources/core/x64-win32/${CORE_BINARY_NAME}.pdb`;

/** vsce 的打包过滤：返回 `extension/...` 形式的入包路径（`skipLicense` 关掉交互式追问） */
async function vscePackagedPaths(files: string[]): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-pdb-'));
  try {
    for (const rel of files) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), 'x');
    }
    fs.copyFileSync(path.join(REPO_ROOT, '.vscodeignore'), path.join(dir, '.vscodeignore'));
    fs.writeFileSync(path.join(dir, 'README.md'), '# probe');
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'probe', version: '0.0.1', publisher: 'p', engines: { vscode: '^1.0.0' } }),
    );
    // 延迟 require：vsce 只在打包路径上用到，别拖慢其它用例的启动
    const { collect } = require('@vscode/vsce/out/package.js') as {
      collect: (manifest: unknown, options: { cwd: string; skipLicense: boolean; allowMissingRepository: boolean }) => Promise<Array<{ path: string }>>;
    };
    const packaged = await collect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')), {
      cwd: dir,
      skipLicense: true,
      allowMissingRepository: true,
    });
    return packaged.map((file) => file.path);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

runTests('pdbPackaging', async () => {
  const { check, finish } = createChecker();

  const packaged = await vscePackagedPaths([...SHIPPED_FILES, PDB_FILE]);
  check('vsix 不含 Core 的调试符号（.pdb）', !packaged.includes(`extension/${PDB_FILE}`));
  check(
    'vsix 仍含运行时产物（可执行文件 / fingerprint / ripgrep / webview）',
    SHIPPED_FILES.every((rel) => packaged.includes(`extension/${rel}`)),
  );

  // electron-builder 默认排除 `**/*.pdb`，显式置 includePdb 才会带上——配置不许打开它
  const builderConfig = require(path.join(REPO_ROOT, 'electron-builder.config.js')) as {
    includePdb?: boolean;
  };
  check('Electron 安装包不打开 electron-builder 的 includePdb', builderConfig.includePdb !== true);

  finish();
});
