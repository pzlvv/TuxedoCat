/**
 * 单测：宿主侧配置读取与保存（`docs/core-ui-separation.md` 第 4 节）。
 *
 * 覆盖四块：
 * - `settingsRead`：面板载荷、默认值、模型身份校验与回落；
 * - `applyLlmConfigSave`：设置面板整段 mutation（provider 表 / `modelConfigs` 补齐 /
 *   顶层默认值 / MCP 默认启用列表）；
 * - `SettingsStore.subscribe`：写盘后重新解析快照并通知（宿主据此重推快照）；
 * - `SettingsStore` 的写保护：读不出来就拒绝覆盖、内容未变不落盘、写入原子；
 * - 就绪门禁：Core 收到 `hostEnvironmentProvided` 之前拒绝其它 `UiEvent`，
 *   收到后发 `coreReady`。
 *
 * 运行方式：npm run test:all -- hostSettings
 */

import * as fs from 'fs';
import * as path from 'path';
import { createChecker, runTests } from './helpers/harness';
import { makeTempDir } from './helpers/fixtures';
import { resolveSettingsSnapshot } from '../core/settingsSnapshot';
import { SettingsStore } from '../host/SettingsStore';
import { applyLlmConfigSave } from '../host/llmConfigSave';
import {
  readActiveModelRef,
  readDefaultAgentMode,
  readDefaultPromptMode,
  readDefaultThinkingEffort,
  readDefaultWebSearch,
  readHasActiveProviderSetting,
  readLlmConfigPanelPayload,
  resolveModelRef,
} from '../host/settingsRead';

/** 一份可用的 provider 配置（宿主侧写进 settings.json 的形态） */
function rawSettings(): Record<string, unknown> {
  return {
    llm: {
      activeProvider: 'api.deepseek.com',
      webSearch: true,
      thinking_effort: 'high',
      providers: {
        'api.deepseek.com': {
          baseURL: 'https://api.deepseek.com',
          apiKey: 'sk-deepseek',
          models: ['deepseek-chat'],
        },
        'openrouter.ai': {
          baseURL: 'https://openrouter.ai/api/v1',
          apiKey: 'sk-or',
          models: ['a/one', 'b/two'],
          defaultModel: 'b/two',
        },
      },
    },
    defaultAgentMode: 'risk',
    defaultPromptMode: 'normal',
    mcp: { enabled: [] },
  };
}

runTests('hostSettings', async () => {
  const { check, finish } = createChecker();

  // ==================== 宿主侧配置读取 ====================

  const snapshot = resolveSettingsSnapshot(rawSettings());
  check('默认思考强度来自快照', readDefaultThinkingEffort(snapshot) === 'high');
  check('默认工作模式来自快照', readDefaultAgentMode(snapshot) === 'risk');
  check('默认提示词模式来自快照', readDefaultPromptMode(snapshot) === 'normal');
  check('默认联网搜索来自快照', readDefaultWebSearch(snapshot) === true);
  check('已配置 activeProvider', readHasActiveProviderSetting(snapshot));

  const activeRef = readActiveModelRef(snapshot);
  check(
    'active 模型身份 = activeProvider + 其默认模型',
    activeRef?.provider === 'api.deepseek.com' && activeRef.model === 'deepseek-chat',
  );

  const panel = readLlmConfigPanelPayload(snapshot);
  check('面板载荷带上 activeProvider', panel.activeProvider === 'api.deepseek.com');
  check('面板载荷列出全部可用 provider', panel.providers.length === 2);
  check(
    '面板载荷的默认模型取 active provider',
    panel.defaultModel === 'deepseek-chat' && panel.apiKey === 'sk-deepseek',
  );

  // 各模型的限值与协议随载荷下发：面板只显示，不自己推断
  // （`docs/webview-facts.md` 第 6 节）。
  const deepseekInfo = panel.providers.find((p) => p.key === 'api.deepseek.com');
  check('面板载荷带 provider 的 modelConfigs', !!deepseekInfo?.modelConfigs);
  check(
    'modelConfigs 覆盖该 provider 的全部模型',
    Object.keys(deepseekInfo?.modelConfigs ?? {}).includes('deepseek-chat'),
  );
  check(
    'modelConfigs 的 apiType 是已解析的合法协议',
    ['Responses', 'OpenAI', 'Anthropic'].includes(deepseekInfo?.modelConfigs['deepseek-chat']?.apiType ?? ''),
  );
  check(
    'modelConfigs 带已解析的 context / output',
    (deepseekInfo?.modelConfigs['deepseek-chat']?.context ?? 0) > 0
      && (deepseekInfo?.modelConfigs['deepseek-chat']?.output ?? 0) > 0,
  );

  // 未配置 activeProvider 时按「未配置」处理
  const unconfigured = resolveSettingsSnapshot({});
  check('未配置时没有 active 模型身份', readActiveModelRef(unconfigured) === undefined);
  check('未配置时 readHasActiveProviderSetting 为 false', !readHasActiveProviderSetting(unconfigured));
  check('未配置时面板回落 DeepSeek 地址', readLlmConfigPanelPayload(unconfigured).baseURL.includes('api.deepseek.com'));

  // ==================== 模型身份校验与回落 ====================

  check(
    '身份合法：原样返回',
    (() => {
      const r = resolveModelRef(snapshot, { provider: 'openrouter.ai', model: 'a/one' });
      return r?.provider === 'openrouter.ai' && r.model === 'a/one';
    })(),
  );
  check(
    '模型不在 provider 列表：回落该 provider 的默认模型',
    (() => {
      const r = resolveModelRef(snapshot, { provider: 'openrouter.ai', model: 'gone' });
      return r?.provider === 'openrouter.ai' && r.model === 'b/two';
    })(),
  );
  check(
    'provider 已移除：回落 active provider 的默认模型',
    (() => {
      const r = resolveModelRef(snapshot, { provider: 'removed.example', model: 'x' });
      return r?.provider === 'api.deepseek.com' && r.model === 'deepseek-chat';
    })(),
  );
  check(
    '未记录身份：取 active provider 的默认模型',
    (() => {
      const r = resolveModelRef(snapshot, undefined);
      return r?.provider === 'api.deepseek.com' && r.model === 'deepseek-chat';
    })(),
  );
  check('没有任何可用 provider：返回 undefined', resolveModelRef(unconfigured, undefined) === undefined);
  check(
    '没有任何可用 provider：即使记录了身份也返回 undefined',
    resolveModelRef(unconfigured, { provider: 'x', model: 'y' }) === undefined,
  );
  check(
    'provider 存在但模型列表为空：保留 provider 与原模型',
    (() => {
      const s = resolveSettingsSnapshot({
        llm: {
          activeProvider: 'p',
          providers: { p: { baseURL: 'https://p', apiKey: 'k', models: [] } },
        },
      });
      const r = resolveModelRef(s, { provider: 'p', model: '' });
      return r?.provider === 'p' && r.model === '';
    })(),
  );

  // ==================== 保存 mutation ====================

  // 普通保存：只写顶层默认值，不碰 provider 表
  {
    const cfg: Record<string, any> = rawSettings();
    applyLlmConfigSave(cfg, {
      webSearch: false,
      thinkingEffort: 'low',
      defaultAgentMode: 'auto',
      defaultPromptMode: 'mixed',
    });
    check('普通保存写入 webSearch', cfg.llm.webSearch === false);
    check('普通保存写入 thinking_effort', cfg.llm.thinking_effort === 'low');
    check('普通保存写入 defaultAgentMode', cfg.defaultAgentMode === 'auto');
    check('普通保存写入 defaultPromptMode', cfg.defaultPromptMode === 'mixed');
    check('普通保存不动 provider 表', Object.keys(cfg.llm.providers).length === 2);
    check('普通保存不动 activeProvider', cfg.llm.activeProvider === 'api.deepseek.com');
  }

  // 同值不重写：避免每次保存都覆盖一遍预设字段
  {
    const cfg: Record<string, any> = rawSettings();
    applyLlmConfigSave(cfg, { thinkingEffort: 'high', webSearch: true, defaultAgentMode: 'risk' });
    check('同值不重写 thinking_effort', cfg.llm.thinking_effort === 'high');
    check('同值不重写 webSearch', cfg.llm.webSearch === true);
  }

  // provider 保存：按 baseURL 的 hostname 建键、trim、去重、补 modelConfigs
  {
    const cfg: Record<string, any> = {
      llm: {
        providers: {
          'api.deepseek.com': {
            baseURL: 'https://api.deepseek.com',
            apiKey: 'sk-old',
            models: ['deepseek-chat'],
            // 用户手填的限值必须保留
            modelConfigs: { 'deepseek-chat': { context: 12345, output: 678 } },
          },
        },
      },
    };
    applyLlmConfigSave(cfg, {
      saveProviders: true,
      activeProvider: 'openrouter.ai',
      providers: [
        { baseURL: '  https://api.deepseek.com  ', apiKey: '  sk-new  ', models: [' deepseek-chat ', 'deepseek-chat'] },
        { baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-or', models: ['a/one'], defaultModel: ' a/one ' },
        // 缺 apiKey 的条目整条跳过
        { baseURL: 'https://skipped.example', models: ['m'] },
      ],
    });
    check('provider 键取 baseURL 的 hostname', !!cfg.llm.providers['api.deepseek.com']);
    check('provider 条目按 hostname 建键', !!cfg.llm.providers['openrouter.ai']);
    check('缺 apiKey 的 provider 被跳过', !cfg.llm.providers['skipped.example']);
    check('baseURL / apiKey 被 trim', cfg.llm.providers['api.deepseek.com'].apiKey === 'sk-new');
    check(
      '模型列表 trim 并去重',
      JSON.stringify(cfg.llm.providers['api.deepseek.com'].models) === JSON.stringify(['deepseek-chat']),
    );
    check(
      '用户手填的 context/output 限值被保留',
      cfg.llm.providers['api.deepseek.com'].modelConfigs['deepseek-chat'].context === 12345
        && cfg.llm.providers['api.deepseek.com'].modelConfigs['deepseek-chat'].output === 678,
    );
    check(
      '新 provider 的模型限值从注册表补齐',
      cfg.llm.providers['openrouter.ai'].modelConfigs['a/one'].context > 0,
    );
    check('defaultModel 被 trim 后写入', cfg.llm.providers['openrouter.ai'].defaultModel === 'a/one');
    check('activeProvider 取面板选择', cfg.llm.activeProvider === 'openrouter.ai');
  }

  // activeProvider 指向不存在的 provider：回落第一个
  {
    const cfg: Record<string, any> = { llm: {} };
    applyLlmConfigSave(cfg, {
      saveProviders: true,
      activeProvider: 'nope.example',
      providers: [{ baseURL: 'https://a.example', apiKey: 'k', models: [] }],
    });
    check('activeProvider 非法时回落第一个 provider', cfg.llm.activeProvider === 'a.example');
  }

  // 面板传了模型 -> 协议映射：写进 modelConfigs.apiType
  {
    const cfg: Record<string, any> = { llm: {} };
    applyLlmConfigSave(cfg, {
      saveProviders: true,
      providers: [{
        baseURL: 'https://a.example',
        apiKey: 'k',
        models: ['m'],
        modelApiTypes: { m: 'Responses', other: 'bogus' },
      }],
    });
    check('面板的协议映射写进 modelConfigs', cfg.llm.providers['a.example'].modelConfigs.m.apiType === 'Responses');
    check('非法的协议值被忽略', cfg.llm.providers['a.example'].modelConfigs.other === undefined);
  }

  // uiLanguage：只有 UI 消费，不进快照
  {
    const cfg: Record<string, any> = {};
    applyLlmConfigSave(cfg, { language: 'zh' });
    check('显式语言写入 uiLanguage', cfg.uiLanguage === 'zh');
    applyLlmConfigSave(cfg, { language: 'auto' });
    check('auto 删除 uiLanguage（回落默认）', cfg.uiLanguage === undefined);
    applyLlmConfigSave(cfg, { language: 'fr' });
    check('非法语言不写入', cfg.uiLanguage === undefined);
  }

  // uiFontSize：只有 UI 消费，不进快照
  {
    const cfg: Record<string, any> = {};
    applyLlmConfigSave(cfg, { fontSize: 'large' });
    check('显式字号写入 uiFontSize', cfg.uiFontSize === 'large');
    applyLlmConfigSave(cfg, { fontSize: 'xlarge' });
    check('特大字号写入 uiFontSize', cfg.uiFontSize === 'xlarge');
    applyLlmConfigSave(cfg, { fontSize: 'medium' });
    check('medium 删除 uiFontSize（回落默认）', cfg.uiFontSize === undefined);
    applyLlmConfigSave(cfg, { fontSize: 'huge' });
    check('非法字号不写入', cfg.uiFontSize === undefined);
  }

  // SettingsStore 读字号：缺省与非法取值都回落到 medium
  {
    const dir = makeTempDir('host-settings-font-size');
    const settingsPath = path.join(dir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ uiFontSize: 'xlarge' }, null, 2), 'utf8');
    const store = new SettingsStore({ configDir: dir });
    store.loadSync();
    check('读盘读到显式字号', store.readUiFontSize() === 'xlarge');

    fs.writeFileSync(settingsPath, JSON.stringify({ uiFontSize: 'huge' }, null, 2), 'utf8');
    const store2 = new SettingsStore({ configDir: dir });
    store2.loadSync();
    check('非法字号回落到 medium', store2.readUiFontSize() === 'medium');

    fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2), 'utf8');
    const store3 = new SettingsStore({ configDir: dir });
    store3.loadSync();
    check('缺省字号为 medium', store3.readUiFontSize() === 'medium');
  }

  // MCP 默认启用列表
  {
    const cfg: Record<string, any> = { mcp: { enabled: ['old'], other: 1 }, x: 2 };
    applyLlmConfigSave(cfg, { mcpServers: ['a', 'a', 'b', 3] });
    check('MCP 默认列表整体替换并去重', JSON.stringify(cfg.mcp.enabled) === JSON.stringify(['a', 'b']));
    check('MCP 段的其它字段保留', cfg.mcp.other === 1);
    check('顶层其它字段保留', cfg.x === 2);
  }

  // 面板没带 mcpServers：不动 mcp.enabled
  {
    const cfg: Record<string, any> = { mcp: { enabled: ['keep'] } };
    applyLlmConfigSave(cfg, { webSearch: false });
    check('未传 mcpServers 时不动默认列表', JSON.stringify(cfg.mcp.enabled) === JSON.stringify(['keep']));
  }

  // ==================== SettingsStore 订阅（宿主重推快照的触发点） ====================

  {
    const dir = makeTempDir('host-settings-subscribe');
    const store = new SettingsStore({ configDir: dir });
    store.loadSync();

    const seen: number[] = [];
    store.subscribe((next) => {
      seen.push(Object.keys(next.llm.providers).length);
    });

    const before = store.getSnapshot();
    check('订阅前快照没有 provider', Object.keys(before.llm.providers).length === 0);

    await store.updateSettings((cfg) => {
      applyLlmConfigSave(cfg, {
        saveProviders: true,
        providers: [{ baseURL: 'https://a.example', apiKey: 'k', models: ['m'] }],
      });
    });

    check('写盘后通知订阅者一次', seen.length === 1);
    check('通知的是重新解析后的快照', seen[0] === 1);
    check('getSnapshot 立刻拿到新值', Object.keys(store.getSnapshot().llm.providers).length === 1);

    // 写盘确实落到了磁盘（不是只改内存）
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    check('配置确实写盘', !!onDisk.llm.providers['a.example']);

    // UI 专属字段的写入同样触发通知（快照内容不变，Core 侧是幂等重同步）
    await store.updateSettings((cfg) => {
      cfg.highlightLanguages = ['ts'];
    });
    check('UI 专属字段写入也触发通知', seen.length === 2);
    check('快照内容不受 UI 专属字段影响', Object.keys(store.getSnapshot().llm.providers).length === 1);
  }

  // ==================== refreshFromDisk（手工改文件后重读，无需重载窗口） ====================

  {
    const dir = makeTempDir('host-settings-refresh');
    const store = new SettingsStore({ configDir: dir });
    store.loadSync();
    check('初始快照为未配置', store.getSnapshot().llm.activeProvider === '');

    const seen: string[] = [];
    store.subscribe((next) => {
      seen.push(next.llm.activeProvider);
    });

    store.refreshFromDisk();
    check('文件未变时不通知订阅者', seen.length === 0);

    // 模拟用户在外部手工写入 / 恢复 settings.json
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        llm: {
          activeProvider: 'api.deepseek.com',
          providers: {
            'api.deepseek.com': { baseURL: 'https://api.deepseek.com', apiKey: 'sk-x' },
          },
        },
      }),
      'utf8',
    );

    const refreshed = store.refreshFromDisk();
    check('refreshFromDisk 读到外部修改', refreshed.llm.activeProvider === 'api.deepseek.com');
    check('内容变化时通知订阅者一次', seen.length === 1 && seen[0] === 'api.deepseek.com');

    store.refreshFromDisk();
    check('再次 refresh 不重复通知', seen.length === 1);
  }

  // ==================== 写保护：读不出来就绝不覆盖 ====================
  // 多个宿主进程共写同一份 settings.json，写者可能读到「别人正在写」的半截文件。
  // 把解析失败当成空配置继续写，会用 {} + 本次改动覆盖掉用户的全部配置。

  {
    const dir = makeTempDir('host-settings-corrupt');
    const settingsPath = path.join(dir, 'settings.json');
    const broken = '{ "llm": { "activeProvider": "x" },,, BROKEN';
    fs.writeFileSync(settingsPath, broken, 'utf8');

    const store = new SettingsStore({ configDir: dir });
    const snapshot = store.loadSync();
    check('解析失败时 loadSync 不抛错', !!snapshot);
    check('解析失败时快照按未配置处理', snapshot.llm.activeProvider === '');

    let rejected = false;
    try {
      await store.updateSettings((cfg) => {
        cfg.highlightLanguages = ['ts'];
      });
    } catch {
      rejected = true;
    }
    check('解析失败时拒绝写入', rejected);
    check('磁盘内容原样保留（未被清空）', fs.readFileSync(settingsPath, 'utf8') === broken);

    // 文件被修好后可以正常写入
    fs.writeFileSync(settingsPath, JSON.stringify({ llm: { activeProvider: 'p' } }), 'utf8');
    await store.updateSettings((cfg) => {
      cfg.highlightLanguages = ['ts'];
    });
    const repaired = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    check('文件修好后可写入且保留已有字段', repaired.llm.activeProvider === 'p');
  }

  // ==================== 内容未变化时不落盘 ====================

  {
    const dir = makeTempDir('host-settings-noop');
    const settingsPath = path.join(dir, 'settings.json');
    // 先落一份已有配置：只有「文件已存在且内容没变」才该跳过写入
    fs.writeFileSync(settingsPath, JSON.stringify({ llm: { activeProvider: 'p' } }, null, 2), 'utf8');

    const store = new SettingsStore({ configDir: dir });
    store.loadSync();

    const seen: number[] = [];
    store.subscribe(() => seen.push(1));

    await store.updateSettings((cfg) => {
      // 不改任何字段
      void cfg;
    });
    check('空改动不通知订阅者', seen.length === 0);

    await store.updateSettings((cfg) => {
      cfg.highlightLanguages = ['ts'];
    });
    check('真实改动通知一次', seen.length === 1);

    const before = fs.readFileSync(settingsPath, 'utf8');
    await store.updateSettings((cfg) => {
      // 重复写入同一份内容
      cfg.highlightLanguages = ['ts'];
    });
    check('重复写入同一内容不再通知', seen.length === 1);
    check('重复写入同一内容不改变文件', fs.readFileSync(settingsPath, 'utf8') === before);
  }

  // ==================== 写入原子性：不留临时文件 / 锁文件 ====================

  {
    const dir = makeTempDir('host-settings-atomic');
    const store = new SettingsStore({ configDir: dir });
    store.loadSync();
    await store.updateSettings((cfg) => {
      cfg.uiLanguage = 'zh';
    });
    check('写入后没有残留 .tmp', !fs.existsSync(path.join(dir, 'settings.json.tmp')));
    check('写入后没有残留 .lock', !fs.existsSync(path.join(dir, 'settings.json.lock')));
    check('写入内容是完整 JSON', (() => {
      try {
        JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
        return true;
      } catch {
        return false;
      }
    })());
  }

  finish();
});
