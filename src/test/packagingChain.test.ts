import * as fs from 'node:fs';
import * as path from 'node:path';
import { createChecker, runTests } from './helpers/harness';

/**
 * 发布链的平台口径（`README.md` 的「打包」一节、`docs/features/tui-installer.md` 第 4 节）。
 *
 * `package:app:installer` 的产物由 `electron-builder` 的目标集合决定，而目标集合有两处来源：
 * `electron-builder.config.js` 的 `win` 段，以及命令行上的平台选择器。**只给配置不给选择器**
 * 时 electron-builder 按宿主平台取默认目标——Linux 打包机上就是 `snap` + `AppImage`，
 * 而发布物只有 NSIS 安装包，链尾 `verify-nsis-payload` 随即因为找不到 `setup-*.exe` 失败
 * （见 `specs/defects/package-app-installer-missing-win-target.md`）。
 *
 * 这里只读 `package.json` / `electron-builder.config.js` 做静态断言：真正跑一遍
 * electron-builder 要几分钟且需要 wine，不适合放进单元测试车道。
 *
 * 运行方式：`npm run test:all -- packaging-chain`
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');

/** `package.json` 的 scripts 段（只取用得到的部分） */
function readScript(name: string): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as {
    scripts: Record<string, string>;
  };
  const script = manifest.scripts[name];
  if (script === undefined) throw new Error(`package.json 缺少脚本 ${name}`);
  return script;
}

/**
 * 脚本里 `electron-builder` 那一段的参数。
 *
 * 脚本是 `a && b && c` 形式的链，`electron-builder` 只占其中一段：按 `&&` 切段后取以
 * `electron-builder` 开头的那段，剩下的按空白切成参数表。
 */
function electronBuilderArgs(scriptName: string): string[] {
  const segment = readScript(scriptName)
    .split('&&')
    .map((part) => part.trim())
    .find((part) => part.startsWith('electron-builder '));
  if (segment === undefined) throw new Error(`${scriptName} 里没有 electron-builder 调用`);
  return segment.split(/\s+/).slice(1);
}

runTests('packagingChain', () => {
  const { check, finish } = createChecker();

  // RT-1：平台由命令行显式给出，不交给宿主默认值
  const installerArgs = electronBuilderArgs('package:app:installer');
  check(
    'package:app:installer 显式指定 win 平台',
    installerArgs.includes('--win'),
  );

  // RT-2：修复不许靠删链尾校验转绿
  const installerScript = readScript('package:app:installer');
  check(
    'package:app:installer 链尾保留 NSIS 载荷校验',
    installerScript.trimEnd().endsWith('node scripts/verify-nsis-payload.mjs'),
  );

  // RT-3：node_modules 不进包时，原生模块重建是纯副作用，且在非 Windows 宿主上必然失败
  const builderConfig = require(path.join(REPO_ROOT, 'electron-builder.config.js')) as {
    files: string[];
    npmRebuild?: boolean;
  };
  check(
    'node_modules 不进包时关闭原生模块重建',
    !builderConfig.files.includes('!node_modules/**') || builderConfig.npmRebuild === false,
  );

  finish();
});
