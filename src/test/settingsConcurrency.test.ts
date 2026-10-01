/**
 * 单测：多宿主进程共写 `settings.json` 不丢数据（`docs/core-ui-separation.md` 第 4.6 节）。
 *
 * 场景：同一台机器上同时跑着 VS Code 扩展宿主与多个 Electron 实例，它们读同一份
 * `~/.tuxedo-cat/settings.json`。`SettingsStore.updateSettings` 是「读-改-写」，
 * 早期实现有三处会**销毁用户配置**：
 *
 * 1. `writeFile` 先截断再写入（非原子）→ 并发读者会读到半截文件；
 * 2. 读失败被当成空配置 → 紧接着的写入用 `{}` + 本次改动覆盖磁盘；
 * 3. 没有跨进程互斥 → 读-改-写交错，后写者丢掉先写者的改动。
 *
 * 本用例用真实子进程复现上述竞争，断言：既有字段一个不少、每个进程的改动都在。
 * 这是回归测试——修复前该用例会看到 `llm` / `providers` 整段消失。
 *
 * 运行方式：npm run test:all -- settingsConcurrency
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { createChecker, runTests } from './helpers/harness';
import { makeTempDir } from './helpers/fixtures';

/**
 * 子进程里跑的写循环。
 *
 * 用真实子进程而不是 `Promise.all`：进程内写操作本来就被 `writeChain` 串行化了，
 * 只有跨进程才可能触发本用例要覆盖的竞争。
 */
const WORKER_SOURCE = `
const { SettingsStore } = require(process.argv[2]);
const store = new SettingsStore({ configDir: process.argv[3] });
store.loadSync();
(async () => {
  for (let i = 0; i < 25; i++) {
    await store.updateSettings((cfg) => {
      const list = Array.isArray(cfg.highlightLanguages) ? cfg.highlightLanguages : [];
      if (!list.includes(process.argv[4])) list.push(process.argv[4]);
      cfg.highlightLanguages = list;
    });
  }
})().catch((err) => { console.error(String(err)); process.exit(1); });
`;

/** 跑一个子进程写循环，resolve 其退出码 */
function runWorker(workerPath: string, storePath: string, configDir: string, tag: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, storePath, configDir, tag], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** 修复前会丢字段的初始配置 */
function seededSettings(): Record<string, unknown> {
  return {
    llm: {
      activeProvider: 'opencode.ai',
      webSearch: true,
      thinking_effort: 'high',
      providers: {
        'opencode.ai': {
          baseURL: 'https://opencode.ai/zen/go',
          apiKey: 'sk-secret',
          models: ['a', 'b'],
          defaultModel: 'a',
        },
      },
    },
    uiLanguage: 'zh',
    defaultAgentMode: 'risk',
    defaultPromptMode: 'mixed',
  };
}

const WORKER_COUNT = 6;

runTests('settingsConcurrency', async () => {
  const { check, finish } = createChecker();

  const dir = makeTempDir('settings-concurrency');
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(seededSettings(), null, 2), 'utf8');

  // 子进程里 require 的是编译产物（本测试文件也在 out/ 下）
  const storePath = path.resolve(__dirname, '../host/SettingsStore.js');
  const workerPath = path.join(dir, 'worker.js');
  fs.writeFileSync(workerPath, WORKER_SOURCE, 'utf8');

  const tags = Array.from({ length: WORKER_COUNT }, (_, i) => `w${i}`);
  const codes = await Promise.all(
    tags.map((tag) => runWorker(workerPath, storePath, dir, tag)),
  );
  check('全部子进程正常退出', codes.every((code) => code === 0));

  const raw = fs.readFileSync(settingsPath, 'utf8');
  let parsed: any;
  let parseOk = true;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parseOk = false;
  }
  check('并发写入后文件仍是完整 JSON', parseOk);

  if (parseOk) {
    const seed = seededSettings() as any;
    check('llm 段未被清空', !!parsed.llm);
    check('activeProvider 保留', parsed.llm?.activeProvider === seed.llm.activeProvider);
    check('webSearch 保留', parsed.llm?.webSearch === true);
    check('thinking_effort 保留', parsed.llm?.thinking_effort === 'high');
    check(
      'provider 表完整（含 apiKey / models / defaultModel）',
      JSON.stringify(parsed.llm?.providers?.['opencode.ai'])
        === JSON.stringify(seed.llm.providers['opencode.ai']),
    );
    check('uiLanguage 保留', parsed.uiLanguage === 'zh');
    check('defaultAgentMode 保留', parsed.defaultAgentMode === 'risk');
    check('defaultPromptMode 保留', parsed.defaultPromptMode === 'mixed');

    // 每个进程的改动都必须留下：跨进程互斥生效，没有丢失更新
    const languages: string[] = Array.isArray(parsed.highlightLanguages) ? parsed.highlightLanguages : [];
    const missing = tags.filter((tag) => !languages.includes(tag));
    check(`全部 ${WORKER_COUNT} 个进程的改动都在`, missing.length === 0);
    for (const tag of missing) console.log(`     丢失的改动：${tag}`);
  }

  check('没有残留 .tmp', !fs.existsSync(`${settingsPath}.tmp`));
  check('没有残留 .lock', !fs.existsSync(`${settingsPath}.lock`));

  finish();
});
