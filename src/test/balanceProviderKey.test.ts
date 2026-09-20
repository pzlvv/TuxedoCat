/**
 * 余额查询的 provider / Key 解析单元测试（core/llm/config.ts 的 getDeepSeekProviderApiKey
 * 与 core/utils/balance.ts 的 fetchBalance 跳过逻辑）。
 *
 * 运行方式（两种都支持）：
 *   1. 独立运行：`npx tsc -p tsconfig.test.json && node out/src/test/balanceProviderKey.test.js`
 *   2. 在 vscode-test 的 mocha 环境下自动注册为测试用例。
 *
 * 背景：余额接口只有 DeepSeek 官方提供（https://api.deepseek.com/user/balance）。
 * 旧实现用 getConfig() 取 **active provider** 的 apiKey，而 active provider 常常是
 * 第三方网关（opencode.ai / z.ai ...），于是每次查询都稳定拿到
 * `401 Authorization Required`。现在固定按域名找 api.deepseek.com provider：
 * 找不到就不发请求（返回 null）。
 *
 * 测试手法：把 HOME/USERPROFILE 指向临时目录并在其中写 settings.json，
 * 再动态 import 被测模块（静态 import 会被提升到环境变量设置之前）。
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CONFIG_DIR = '.tuxedo-cat';

/** 在临时 HOME 下写 settings.json 并返回该 HOME 路径 */
function makeTempHome(settings: unknown): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tuxedo-balance-'));
  if (settings !== undefined) {
    const dir = path.join(home, CONFIG_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8');
  }
  return home;
}

/** 在指定 HOME 下执行：切环境变量 → 清缓存 → 动态加载模块 */
async function withHome<T>(
  settings: unknown,
  fn: (configMod: typeof import('../core/llm/config')) => Promise<T>,
): Promise<T> {
  const home = makeTempHome(settings);
  const prevProfile = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    const configMod = await import('../core/llm/config');
    configMod.clearConfigCache();
    const historyConfig = await import('../core/history/Config');
    historyConfig.resetSettingsCache();
    return await fn(configMod);
  } finally {
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** 构造 settings.json：providers 为 { key: { baseURL, apiKey } } */
function settings(providers: Record<string, { baseURL: string; apiKey?: string }>, activeProvider?: string) {
  return { llm: { model: 'deepseek-flash', maxTokens: 8192, providers, activeProvider } };
}

interface Case {
  name: string;
  run: () => void | Promise<void>;
}

const CASES: Case[] = [
  {
    name: '没有 api.deepseek.com provider → 返回 null（跳过余额查询）',
    run: async () => {
      await withHome(
        settings({ 'opencode.ai': { baseURL: 'https://opencode.ai/zen/go', apiKey: 'sk-gateway' } }, 'opencode.ai'),
        async (m) => {
          assert.strictEqual(await m.getDeepSeekProviderApiKey(), null, '第三方网关 provider 不算数');
        },
      );
    },
  },
  {
    name: '存在 api.deepseek.com provider → 返回它的 key',
    run: async () => {
      await withHome(
        settings({ 'api.deepseek.com': { baseURL: 'https://api.deepseek.com', apiKey: 'sk-deepseek' } }, 'api.deepseek.com'),
        async (m) => {
          assert.strictEqual(await m.getDeepSeekProviderApiKey(), 'sk-deepseek');
        },
      );
    },
  },
  {
    name: 'active provider 是第三方网关时，仍取 api.deepseek.com 的 key（本次修复的核心）',
    run: async () => {
      await withHome(
        settings(
          {
            'opencode.ai': { baseURL: 'https://opencode.ai/zen/go', apiKey: 'sk-gateway' },
            'api.deepseek.com': { baseURL: 'https://api.deepseek.com', apiKey: 'sk-deepseek' },
          },
          'opencode.ai',
        ),
        async (m) => {
          assert.strictEqual(
            await m.getDeepSeekProviderApiKey(),
            'sk-deepseek',
            '不能拿 active provider（网关）的 key 去查 DeepSeek 余额',
          );
        },
      );
    },
  },
  {
    name: 'baseURL 带 /v1 路径 → 按 hostname 匹配',
    run: async () => {
      await withHome(
        settings({ 'api.deepseek.com': { baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-deepseek' } }),
        async (m) => {
          assert.strictEqual(await m.getDeepSeekProviderApiKey(), 'sk-deepseek');
        },
      );
    },
  },
  {
    name: 'provider key 是自定义名字，但 baseURL 指向 api.deepseek.com → 匹配',
    run: async () => {
      await withHome(
        settings({ deepseek: { baseURL: 'https://api.deepseek.com', apiKey: 'sk-custom-key-name' } }),
        async (m) => {
          assert.strictEqual(await m.getDeepSeekProviderApiKey(), 'sk-custom-key-name');
        },
      );
    },
  },
  {
    name: 'hostname 大小写与端口不敏感',
    run: async () => {
      await withHome(
        settings({ 'api.deepseek.com': { baseURL: 'https://API.DeepSeek.com:443/v1/', apiKey: 'sk-upper' } }),
        async (m) => {
          assert.strictEqual(await m.getDeepSeekProviderApiKey(), 'sk-upper');
        },
      );
    },
  },
  {
    name: 'api.deepseek.com provider 没配 apiKey → 返回 null',
    run: async () => {
      await withHome(
        settings({ 'api.deepseek.com': { baseURL: 'https://api.deepseek.com' } }),
        async (m) => {
          assert.strictEqual(await m.getDeepSeekProviderApiKey(), null);
        },
      );
    },
  },
  {
    name: 'apiKey 只有空白字符 → 视为未配置，返回 null',
    run: async () => {
      await withHome(
        settings({ 'api.deepseek.com': { baseURL: 'https://api.deepseek.com', apiKey: '   ' } }),
        async (m) => {
          assert.strictEqual(await m.getDeepSeekProviderApiKey(), null);
        },
      );
    },
  },
  {
    name: 'apiKey 前后空格 → 返回时 trim',
    run: async () => {
      await withHome(
        settings({ 'api.deepseek.com': { baseURL: 'https://api.deepseek.com', apiKey: '  sk-trimmed  ' } }),
        async (m) => {
          assert.strictEqual(await m.getDeepSeekProviderApiKey(), 'sk-trimmed');
        },
      );
    },
  },
  {
    name: 'settings.json 不存在 → 返回 null 且不抛异常',
    run: async () => {
      await withHome(undefined, async (m) => {
        assert.strictEqual(await m.getDeepSeekProviderApiKey(), null);
      });
    },
  },
  {
    name: '多个第三方 provider 混在一起时只认 deepseek',
    run: async () => {
      await withHome(
        settings(
          {
            'z.ai': { baseURL: 'https://api.z.ai/api', apiKey: 'sk-zai' },
            'opencode.ai': { baseURL: 'https://opencode.ai/zen/go', apiKey: 'sk-gateway' },
            'api.deepseek.com': { baseURL: 'https://api.deepseek.com', apiKey: 'sk-deepseek' },
            'llm.goaichat.top': { baseURL: 'https://llm.goaichat.top/v1', apiKey: 'sk-other' },
          },
          'z.ai',
        ),
        async (m) => {
          assert.strictEqual(await m.getDeepSeekProviderApiKey(), 'sk-deepseek');
        },
      );
    },
  },
  {
    name: '没有 deepseek provider 时 fetchBalance 直接返回 null（不发请求）',
    run: async () => {
      await withHome(
        settings({ 'opencode.ai': { baseURL: 'https://opencode.ai/zen/go', apiKey: 'sk-gateway' } }, 'opencode.ai'),
        async () => {
          const { fetchBalance } = await import('../core/utils/balance');
          const started = Date.now();
          const info = await fetchBalance();
          assert.strictEqual(info, null, '没有 api.deepseek.com provider 时应返回 null');
          // 走网络的话不可能这么快返回；这里断言它没有真的发请求
          assert.ok(Date.now() - started < 1000, '应直接跳过，不应等待网络');
        },
      );
    },
  },
];

// mocha 环境（vscode-test）下注册为测试用例；否则独立运行并返回退出码。
if (typeof (globalThis as { suite?: unknown }).suite === 'function') {
  const g = globalThis as unknown as {
    suite: (name: string, fn: () => void) => void;
    test: (name: string, fn: () => void | Promise<void>) => void;
  };
  g.suite('balanceProviderKey', () => {
    for (const c of CASES) {
      g.test(c.name, async () => {
        await c.run();
      });
    }
  });
} else {
  void (async () => {
    let failed = 0;
    for (const c of CASES) {
      try {
        await c.run();
        console.log(`ok   ${c.name}`);
      } catch (err) {
        failed++;
        console.log(`FAIL ${c.name}`);
        console.log(String((err as Error).message).split('\n').map((l) => `     ${l}`).join('\n'));
      }
    }
    console.log(failed === 0 ? `\n全部通过（${CASES.length} 个用例）` : `\n${failed}/${CASES.length} 个用例失败`);
    process.exit(failed === 0 ? 0 : 1);
  })();
}
