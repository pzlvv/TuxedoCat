/**
 * 单测：配置快照的解析与宿主侧配置存储。
 *
 * 覆盖三块（`docs/core-ui-separation.md` 第 4 节）：
 * - `resolveSettingsSnapshot`：默认值补缺、白名单校验、provider 规范化、
 *   模型限值的预解析（注册表 + 用户覆盖）与兜底；
 * - `parseMcpServerDefinitions`：`mcp.json` 的包裹层、command/environment 归一、
 *   远程判定；
 * - `SettingsStore`：读盘产出快照、串行读-改-写、未知字段保留、
 *   `mcp.json` 只在 `load()` 时读一次。
 *
 * 运行方式：npm run test:all -- settingsSnapshot
 */

import * as fs from 'fs';
import * as path from 'path';
import { createChecker, runTests } from './helpers/harness';
import { makeTempDir } from './helpers/fixtures';
import { resolveSettingsSnapshot } from '../core/settingsSnapshot';
import { parseMcpServerDefinitions } from '../core/mcp/parse';
import { SettingsStore } from '../host/SettingsStore';
import { DEFAULT_API_TYPE, FALLBACK_MODEL_PARAMS } from '../core/utils/modelConfig';

runTests('settingsSnapshot', async () => {
  const { check, finish } = createChecker();

  // ==================== 默认值补缺 ====================

  const empty = resolveSettingsSnapshot(undefined);
  check('空配置：activeProvider 为空串', empty.llm.activeProvider === '');
  check('空配置：webSearch 默认开', empty.llm.webSearch === true);
  check('空配置：thinkingEffort 默认 high', empty.llm.thinkingEffort === 'high');
  check('空配置：providers 为空表', Object.keys(empty.llm.providers).length === 0);
  check('空配置：mcp.enabled 为空数组', empty.mcp.enabled.length === 0);
  check('空配置：defaultAgentMode 回落 risk', empty.defaultAgentMode === 'risk');
  check('空配置：defaultPromptMode 回落 normal', empty.defaultPromptMode === 'normal');

  const badRoot = resolveSettingsSnapshot('not an object');
  check('根不是对象：等价空配置', badRoot.llm.activeProvider === '' && badRoot.mcp.enabled.length === 0);

  // ==================== 白名单校验 ====================

  const invalid = resolveSettingsSnapshot({
    llm: { webSearch: 'yes', thinking_effort: 'bogus' },
    defaultAgentMode: 'yolo',
    defaultPromptMode: 'verbose',
    mcp: { enabled: 'a,b' },
  });
  check('webSearch 非布尔：回落默认开', invalid.llm.webSearch === true);
  check('thinking_effort 非法：回落 high', invalid.llm.thinkingEffort === 'high');
  check('defaultAgentMode 非法：回落 risk', invalid.defaultAgentMode === 'risk');
  check('defaultPromptMode 非法：回落 normal', invalid.defaultPromptMode === 'normal');
  check('mcp.enabled 非数组：回落空数组', invalid.mcp.enabled.length === 0);

  const whitelist = resolveSettingsSnapshot({
    llm: { thinking_effort: 'off' },
    defaultAgentMode: 'auto',
    defaultPromptMode: 'mixed',
    mcp: { enabled: ['a', 42, 'b', null] },
  });
  check('thinking_effort 合法值保留', whitelist.llm.thinkingEffort === 'off');
  check('defaultAgentMode 合法值保留', whitelist.defaultAgentMode === 'auto');
  check('defaultPromptMode 合法值保留', whitelist.defaultPromptMode === 'mixed');
  check('mcp.enabled 只留字符串项', whitelist.mcp.enabled.join(',') === 'a,b');

  // ==================== provider 规范化 ====================

  const providers = resolveSettingsSnapshot({
    llm: {
      activeProvider: 'opencode.ai',
      providers: {
        'opencode.ai': {
          baseURL: 'https://opencode.ai/zen/go',
          apiKey: 'sk-a',
          models: ['m1', ' m2 ', 'm1', '', 7],
        },
        'no-base-url': { apiKey: 'sk-b' },
        'not-an-object': 42,
        'empty-models': { baseURL: 'https://x', defaultModel: '  ' },
      },
    },
  });
  check(
    '缺 baseURL 的 provider 仍在快照里（baseURL 为空串）',
    providers.llm.providers['no-base-url']?.baseURL === '',
  );
  check(
    '缺 baseURL 的 provider 不能被选为 active',
    resolveSettingsSnapshot({
      llm: { activeProvider: 'x', providers: { x: { apiKey: 'k' } } },
    }).llm.activeProvider === '',
  );
  check('非对象 provider 不进快照', providers.llm.providers['not-an-object'] === undefined);
  check(
    'models 去重、trim、丢弃非字符串',
    providers.llm.providers['opencode.ai'].models.join(',') === 'm1,m2',
  );
  check(
    'defaultModel 回退 models[0]',
    providers.llm.providers['opencode.ai'].defaultModel === 'm1',
  );
  check(
    'defaultModel 全空白时回退 models[0]',
    providers.llm.providers['empty-models'].defaultModel === '',
  );
  check('activeProvider 合法值保留', providers.llm.activeProvider === 'opencode.ai');

  const danglingActive = resolveSettingsSnapshot({
    llm: { activeProvider: 'missing', providers: { a: { baseURL: 'https://a' } } },
  });
  check('activeProvider 指向不存在的 provider：回落空串', danglingActive.llm.activeProvider === '');

  // ==================== 模型限值的预解析 ====================

  const limits = resolveSettingsSnapshot({
    llm: {
      providers: {
        p: {
          baseURL: 'https://p',
          models: ['deepseek-v4-pro', 'custom-model'],
          modelConfigs: {
            'custom-model': { context: 12345, output: 678, apiType: 'Responses' },
          },
        },
      },
    },
  });
  const p = limits.llm.providers.p;
  check(
    '注册表命中的模型：context 取注册表',
    p.modelLimits['deepseek-v4-pro'].context === FALLBACK_MODEL_PARAMS.contextWindow,
  );
  check(
    '注册表命中的模型：apiType 取默认协议',
    p.modelLimits['deepseek-v4-pro'].apiType === DEFAULT_API_TYPE,
  );
  check('用户覆盖 context 生效', p.modelLimits['custom-model'].context === 12345);
  check('用户覆盖 output 生效', p.modelLimits['custom-model'].output === 678);
  check('用户覆盖 apiType 生效', p.modelLimits['custom-model'].apiType === 'Responses');
  check(
    'provider.models 里的模型都有条目',
    p.modelLimits['deepseek-v4-pro'] !== undefined && p.modelLimits['custom-model'] !== undefined,
  );
  check(
    '兜底限值等于注册表兜底',
    limits.llm.modelLimitsFallback.context === FALLBACK_MODEL_PARAMS.contextWindow
      && limits.llm.modelLimitsFallback.output === FALLBACK_MODEL_PARAMS.maxOutputTokens
      && limits.llm.modelLimitsFallback.apiType === DEFAULT_API_TYPE,
  );

  const noOverrides = resolveSettingsSnapshot({
    llm: { providers: { p: { baseURL: 'https://p', models: ['deepseek-v4-pro'] } } },
  });
  check(
    '未配 modelConfigs 的模型仍可解析',
    noOverrides.llm.providers.p.modelLimits['deepseek-v4-pro'].context
      === FALLBACK_MODEL_PARAMS.contextWindow,
  );

  const badLimits = resolveSettingsSnapshot({
    llm: {
      providers: {
        p: {
          baseURL: 'https://p',
          models: ['m'],
          modelConfigs: { m: { context: 'nope', output: NaN, apiType: 7 } },
        },
      },
    },
  });
  check(
    '非法覆盖值被丢弃、回落注册表',
    badLimits.llm.providers.p.modelLimits.m.context === FALLBACK_MODEL_PARAMS.contextWindow
      && badLimits.llm.providers.p.modelLimits.m.apiType === DEFAULT_API_TYPE,
  );

  // ==================== mcp.json 解析 ====================

  check('mcp.json 根不是对象：空列表', parseMcpServerDefinitions(null).length === 0);

  const wrapped = parseMcpServerDefinitions({
    mcp: {
      'blender-mcp': {
        type: 'local',
        command: 'uvx blender-mcp',
        environment: { BLENDER_PORT: 9876 },
      },
      'search': {
        url: 'https://search.example/mcp',
        headers: { Authorization: 'Bearer t' },
      },
      'bad-entry': 42,
    },
  });
  check('mcp 包裹层：跳过非对象条目', wrapped.length === 2);
  check('command 字符串归一为数组', wrapped[0].command.join(' ') === 'uvx blender-mcp');
  check('environment 数字转字符串', wrapped[0].environment.BLENDER_PORT === '9876');
  check('未写 type 但有 url 无 command：按 remote', wrapped[1].type === 'remote');
  check('headers 保留', wrapped[1].headers.Authorization === 'Bearer t');

  const bare = parseMcpServerDefinitions({ s1: { command: ['node', 'x.js'] } });
  check('无包裹层：根对象即服务器映射', bare.length === 1 && bare[0].name === 's1');
  check('未写 type 且有 command：local', bare[0].type === 'local');

  const altLayer = parseMcpServerDefinitions({ mcpServers: { s2: { command: 'x' } } });
  check('mcpServers 包裹层可用', altLayer.length === 1 && altLayer[0].name === 's2');

  const envAlias = parseMcpServerDefinitions({ s: { command: 'x', env: { A: '1' } } });
  check('env 是 environment 的别名', envAlias[0].environment.A === '1');

  // ==================== SettingsStore ====================

  const dir = makeTempDir('settings-store');
  const logs: string[] = [];
  const store = new SettingsStore({ configDir: dir, log: (m) => logs.push(m) });

  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({
      llm: { activeProvider: 'p', providers: { p: { baseURL: 'https://p', models: ['m'] } } },
      unknownTop: { keep: true },
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'mcp.json'),
    JSON.stringify({ mcp: { s1: { command: 'x' } } }),
    'utf8',
  );

  const loaded = store.loadSync();
  check('loadSync 产出快照', loaded.llm.activeProvider === 'p');
  check('loadSync 解析 mcp.json', store.getMcpServers().length === 1);
  check('未知顶层字段记 warning', logs.some((line) => line.includes('unknownTop')));

  // 写：串行读-改-写 + 通知
  const seen: string[] = [];
  const unsubscribe = store.subscribe((snapshot) => seen.push(snapshot.llm.webSearch ? 'on' : 'off'));
  await store.updateSettings((cfg) => {
    cfg.llm = cfg.llm || {};
    cfg.llm.webSearch = false;
  });
  check('写后快照更新', store.getSnapshot().llm.webSearch === false);
  check('写后通知订阅者', seen.length === 1 && seen[0] === 'off');
  unsubscribe();
  await store.updateSettings((cfg) => {
    cfg.llm = cfg.llm || {};
    cfg.llm.webSearch = true;
  });
  check('取消订阅后不再通知', seen.length === 1);

  // 未知字段保留
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  check('未知字段在写盘后保留', written.unknownTop?.keep === true);
  check('原有 provider 保留', written.llm.providers.p.baseURL === 'https://p');

  // mcp.json 中途修改不进快照（只在 load 时读一次）
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ mcp: { s1: {}, s2: {} } }), 'utf8');
  await store.updateSettings((cfg) => {
    cfg.defaultAgentMode = 'auto';
  });
  check('mcp.json 中途修改不重读', store.getMcpServers().length === 1);
  check('写后 defaultAgentMode 生效', store.getSnapshot().defaultAgentMode === 'auto');

  finish();
});
