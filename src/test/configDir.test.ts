/**
 * 单测：家目录 / 配置目录的唯一解析口径（`src/config/configDir.ts`）。
 *
 * 覆盖点：
 * - `USERPROFILE` 优先于 `HOME`（与 Rust Core 的 `home_dir()` 同序）；
 * - `HOME` 只在 `USERPROFILE` 缺失时兜底；
 * - 两者都缺失时回落到 `os.homedir()`；
 * - `resolveConfigDir()` = `<home>/<CONFIG_DIR_NAME>`。
 *
 * 为什么值得单测：口径分叉会表现成「日志写在一处、配置读在另一处」，
 * 症状是「设置没被读到」，非常难查（见 `docs/core-ui-separation.md` 第 4 节）。
 *
 * 运行方式：npm run test:all -- configDir
 */

import * as os from 'os';
import { join } from 'path';
import { resolveConfigDir, resolveHomeDir } from '../config/configDir';
import { CONFIG_DIR_NAME } from '../config/project';
import { createChecker, runTests } from './helpers/harness';

runTests('configDir', () => {
  const { check, finish } = createChecker();

  const prevProfile = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  const restore = (): void => {
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  };

  try {
    process.env.USERPROFILE = '/tmp/profile-wins';
    process.env.HOME = '/tmp/home-loses';
    check('USERPROFILE 优先于 HOME', resolveHomeDir() === '/tmp/profile-wins');

    delete process.env.USERPROFILE;
    process.env.HOME = '/tmp/home-fallback';
    check('USERPROFILE 缺失时用 HOME', resolveHomeDir() === '/tmp/home-fallback');

    delete process.env.USERPROFILE;
    delete process.env.HOME;
    check('两者都缺失时回落 os.homedir()', resolveHomeDir() === os.homedir());

    process.env.USERPROFILE = '/tmp/some-home';
    check(
      'resolveConfigDir 拼 CONFIG_DIR_NAME',
      resolveConfigDir() === join('/tmp/some-home', CONFIG_DIR_NAME),
    );
  } finally {
    restore();
  }

  finish();
});
