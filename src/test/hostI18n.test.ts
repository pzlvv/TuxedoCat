/**
 * 单测：宿主语言收敛（`docs/core-ui-separation.md` 第 4.8 节、`DEVELOPMENT.md` 第 8.7 节）。
 *
 * `primeHostLocale(hostLocale)` 把宿主 locale + `settings.json` 的 `uiLanguage`
 * 收敛到进程内 i18n（`src/host/i18n.ts`）。语义：
 * - 显式 `uiLanguage`（zh / en）覆盖宿主 / 系统语言；
 * - `auto` 才回落到宿主 locale / 系统语言。
 *
 * 两者顺序写反（先 `setHostUiLanguage` 再 `setHostLocale`）会把显式 en 覆盖回 zh，
 * 表现为「在中文系统上把界面语言设成英文却不生效」。
 *
 * 运行方式：npm run test:all -- hostI18n
 */

import * as fs from 'fs';
import * as path from 'path';
import { createChecker, runTests } from './helpers/harness';
import { makeTempDir } from './helpers/fixtures';
import { getHostLocale } from '../host/i18n';
import { primeHostLocale } from '../host/coreFacts';
import { getSettingsStore, resetSettingsStore } from '../host/SettingsStore';
import { CONFIG_DIR_NAME } from '../config/project';

const home = makeTempDir('host-i18n-home');
process.env.USERPROFILE = home;
process.env.HOME = home;

/** 写一份只含 `uiLanguage` 的 settings.json，并丢弃已缓存的 SettingsStore */
function writeUiLanguage(value: string): void {
  const dir = path.join(home, CONFIG_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ uiLanguage: value }), 'utf-8');
  resetSettingsStore();
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // 显式 en 必须覆盖中文宿主 locale（顺序写反会被 setHostLocale 改回 zh）
  writeUiLanguage('en');
  getSettingsStore().loadSync();
  primeHostLocale('zh-CN');
  check('uiLanguage=en 覆盖中文宿主 locale', getHostLocale() === 'en');

  // 显式 zh 必须覆盖英文宿主 locale
  writeUiLanguage('zh');
  getSettingsStore().loadSync();
  primeHostLocale('en-US');
  check('uiLanguage=zh 覆盖英文宿主 locale', getHostLocale() === 'zh');

  // auto 回落到宿主 locale
  writeUiLanguage('auto');
  getSettingsStore().loadSync();
  primeHostLocale('zh-CN');
  check('uiLanguage=auto 回落到宿主 locale', getHostLocale() === 'zh');

  finish();
}

runTests('hostI18n', run);
