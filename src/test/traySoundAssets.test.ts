import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createChecker, runTests } from './helpers/harness';

/**
 * 托盘提示音的资源与打包边界（`docs/hosts/host-matrix.md` 第 6 节的托盘提醒段落）。
 *
 * 覆盖点：
 * - `electron/assets/meow.aac` 存在且非空（Electron 侧播放的资源前提）；
 * - 按 **vsce 自己的打包过滤**（`@vscode/vsce` 的 `collect`，不是复刻它的匹配语义）跑
 *   仓库真实的 `.vscodeignore`：`electron/assets/meow.aac` 不进 vsix，而 `assets/logo.png` /
 *   `assets/logo.svg`（package.json 的 icon 与视图图标）仍在包内——白名单收窄时
 *   把图标一起排掉会红；
 * - Electron 侧 `electron-builder.config.js` 的 `files` 覆盖 `assets/` 与 `electron/assets/`，
 *   音频随应用分发。
 *
 * 音频放 `electron/assets/` 而不是 `assets/`：后者是侧栏 / 标题栏 vite 构建的 `publicDir`，
 * 放那儿会被复制进每份前端产物（Electron 包里白多三份）。
 *
 * 在临时目录里铺同名文件 + 复制 `.vscodeignore` 后再跑 vsce 的过滤：`collect` 会遍历
 * 整个仓库（含 dist 构建产物），对真实目录跑一次要十几秒；临时目录只放这几个文件，
 * 语义与真实打包一致（匹配只看 `.vscodeignore` 与文件路径）。
 *
 * 运行方式：npm run test:all -- traySoundAssets
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');
const AUDIO_REL = 'electron/assets/meow.aac';
/** 仓库里 `.vscodeignore` 明确放行、必须继续进 vsix 的图标（package.json 引用） */
const SHIPPED_ASSETS = ['assets/logo.png', 'assets/logo.svg'];

/** vsce 的打包过滤：返回 `extension/...` 形式的入包路径（`skipLicense` 关掉交互式追问） */
async function vscePackagedPaths(files: string[]): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-vsix-'));
  try {
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.mkdirSync(path.join(dir, 'electron/assets'), { recursive: true });
    for (const rel of files) fs.writeFileSync(path.join(dir, rel), 'x');
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

runTests('traySoundAssets', async () => {
  const { check, finish } = createChecker();

  const audioPath = path.join(REPO_ROOT, AUDIO_REL);
  check(`提示音资源存在且非空（${AUDIO_REL}）`, fs.existsSync(audioPath) && fs.statSync(audioPath).size > 0);

  const packaged = await vscePackagedPaths([...SHIPPED_ASSETS, AUDIO_REL]);
  check('vsix 不含 Electron 专属的提示音', !packaged.includes(`extension/${AUDIO_REL}`));
  check(
    'vsix 仍含扩展图标 / 视图图标（白名单收窄没误伤）',
    SHIPPED_ASSETS.every((rel) => packaged.includes(`extension/${rel}`)),
  );

  // Electron 打包（electron-builder）的 files 必须覆盖音频所在目录：音频随应用分发
  const builderConfig = require(path.join(REPO_ROOT, 'electron-builder.config.js')) as { files: string[] };
  check(
    'electron-builder 的 files 覆盖音频所在目录（Electron 产物携带音频）',
    builderConfig.files.includes('assets/**/*') && builderConfig.files.includes('electron/assets/**/*'),
  );

  finish();
});
