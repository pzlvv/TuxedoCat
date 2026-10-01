/**
 * 宿主侧的配置存储：全局 `settings.json` 与 `mcp.json` 的唯一读写点
 * （`docs/core-ui-separation.md` 第 4 节）。
 *
 * 职责：
 * - **读**：读盘 → 调 `resolveSettingsSnapshot` 补默认值、规范化 → 产出一份配置快照；
 * - **写**：串行化「读-改-写」，保留未知字段，写盘后重新解析并通知订阅者；
 * - **订阅**：快照变化时通知（Connection 建立时就绪推送 + 变更推送）。
 *
 * Core 侧不感知这两个文件的路径；`mcp.json` 只在 `load()` 时读一次，中途修改不通知
 * Core（重开工作区生效）。`settings.json` 的外部修改同样不监听：设置面板是唯一受支持
 * 的写入口。
 */

import { mkdir, writeFile } from 'fs/promises';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { CONFIG_DIR_NAME } from '../config/project.js';
import { logger } from '../core/Logger.js';
import { HIGHLIGHT_LANGUAGES_FIELD } from './highlightLanguages.js';
import type { ModelRef } from '../core/llm/modelRef.js';
import {
  resolveSettingsSnapshot,
  type McpServerDefinition,
  type SettingsSnapshot,
} from '../core/settingsSnapshot.js';
import { parseMcpServerDefinitions } from '../core/mcp/parse.js';

/** settings.json 修改器：同步改 cfg；返回非 undefined 时作为新的完整配置写回 */
export type SettingsJsonMutator = (cfg: Record<string, any>) => void | Record<string, any>;

/** 界面语言取值（与 `settings.json` 的 `uiLanguage` 一致） */
export type UiLanguage = 'auto' | 'zh' | 'en';

/**
 * 顶层已知字段。
 *
 * 不在这里的字段视为未知：**原样保留**（读-改-写不会丢），但记一条 warning，
 * 提示可能是拼写错误或来自更新版本。
 */
const KNOWN_TOP_LEVEL_KEYS = new Set([
  // 快照覆盖的字段
  'llm',
  'mcp',
  'defaultAgentMode',
  'defaultPromptMode',
  // UI 专属字段（不进快照，但属于本文件）
  'uiLanguage',
  'highlightLanguages',
  // 历史遗留字段：保留在文件里，Core 与快照都不读
  'theme',
  'shortcut',
  'defaultModel',
  'enableUsageStats',
  'features',
]);

/** provider 条目的已知字段 */
const KNOWN_PROVIDER_KEYS = new Set(['baseURL', 'apiKey', 'models', 'defaultModel', 'modelConfigs']);

export interface SettingsStoreOptions {
  /** 配置目录；默认 `~/<CONFIG_DIR_NAME>` */
  configDir?: string;
  /** 日志出口（未知字段 warning 等）；默认丢弃 */
  log?: (message: string) => void;
}

/** 读盘或解析失败时使用的空配置（等价于「用户还没配置过」） */
const EMPTY_SETTINGS: Record<string, unknown> = {};

export class SettingsStore {
  /**
   * 显式配置目录（测试注入）；为 null 时每次按 `~/<CONFIG_DIR_NAME>` 现算。
   *
   * 现算而不是构造时缓存：`os.homedir()` 读的是环境变量，测试会临时改
   * `HOME` / `USERPROFILE`（`balanceProviderKey.test.ts` 等），缓存住会读到旧值。
   */
  private readonly configDirOption: string | null;
  private readonly log: (message: string) => void;

  /** 串行写队列：所有写操作按调用顺序排队，避免并发写坏文件或丢失更新 */
  private writeChain: Promise<void> = Promise.resolve();

  private rawSettings: Record<string, unknown> = EMPTY_SETTINGS;
  private mcpServers: readonly McpServerDefinition[] = [];
  private snapshot: SettingsSnapshot | null = null;
  private readonly listeners = new Set<(snapshot: SettingsSnapshot) => void>();

  constructor(options: SettingsStoreOptions = {}) {
    this.configDirOption = options.configDir ?? null;
    this.log = options.log ?? (() => {});
  }

  /** 配置目录：`~/<CONFIG_DIR_NAME>`（未显式注入时） */
  get configDir(): string {
    return this.configDirOption ?? join(homedir(), CONFIG_DIR_NAME);
  }

  /** settings.json 路径 */
  get settingsPath(): string {
    return join(this.configDir, 'settings.json');
  }

  /** mcp.json 路径 */
  get mcpConfigPath(): string {
    return join(this.configDir, 'mcp.json');
  }

  /**
   * 读盘并产出快照（**同步**）。
   *
   * 同步是有意的：webview 首帧注入界面语言、注入高亮语言都要求同步取值
   * （`readUiLanguage` / `readHighlightLanguages`）。文件只有几 KB，启动期读一次。
   *
   * `mcp.json` 只在这里读一次：之后 `updateSettings` 不会重读它，
   * 因此中途修改 `mcp.json` 不会进入快照（重开工作区生效）。
   */
  loadSync(): SettingsSnapshot {
    this.rawSettings = this.readSettingsFile();
    this.warnUnknownKeys(this.rawSettings);
    this.mcpServers = parseMcpServerDefinitions(this.readMcpFile());
    this.snapshot = resolveSettingsSnapshot(this.rawSettings);
    return this.snapshot;
  }

  /** 当前快照；未 `loadSync()` 时抛错（接线缺失必须在启动期暴露） */
  getSnapshot(): SettingsSnapshot {
    if (!this.snapshot) {
      throw new Error('SettingsStore.getSnapshot() is called before loadSync().');
    }
    return this.snapshot;
  }

  /** 当前 MCP 服务器定义（`loadSync()` 时解析的结果） */
  getMcpServers(): readonly McpServerDefinition[] {
    if (!this.snapshot) {
      throw new Error('SettingsStore.getMcpServers() is called before loadSync().');
    }
    return this.mcpServers;
  }

  /**
   * 原始 settings 对象（宿主侧设置面板用）。
   *
   * 只读，不要原地改：改配置一律走 `updateSettings`。返回类型放宽为 `any`，
   * 与 `SettingsJsonMutator` 的取值口径一致（面板要读任意字段）。
   */
  getRawSettings(): Record<string, any> {
    return this.rawSettings;
  }

  /** 界面语言（`settings.json` 的 `uiLanguage`）；只有 UI 消费，不进快照 */
  readUiLanguage(): UiLanguage {
    const lang = this.rawSettings.uiLanguage;
    return lang === 'zh' || lang === 'en' || lang === 'auto' ? lang : 'auto';
  }

  /** 已记录的 Shiki 语言列表（`settings.json` 的 `highlightLanguages`）；只有 UI 消费，不进快照 */
  readHighlightLanguages(): string[] {
    const list = this.rawSettings[HIGHLIGHT_LANGUAGES_FIELD];
    if (!Array.isArray(list)) return [];
    return list.filter((item): item is string => typeof item === 'string' && item.length > 0);
  }

  /**
   * 某模型身份（provider + model）的上下文上限。
   *
   * 用快照里**已解析**的限值，不再查内置注册表：未配置 provider 或模型未命中时用
   * `llm.modelLimitsFallback`。
   */
  readContextLimit(ref?: ModelRef): number {
    const llm = this.getSnapshot().llm;
    const providerKey = ref?.provider && llm.providers[ref.provider] ? ref.provider : llm.activeProvider;
    const provider = providerKey ? llm.providers[providerKey] : undefined;
    if (!provider) return llm.modelLimitsFallback.context;
    const model = ref?.model || provider.defaultModel;
    return (provider.modelLimits[model] ?? llm.modelLimitsFallback).context;
  }

  /**
   * 串行化执行对 `settings.json` 的读-改-写，随后重新解析快照并通知订阅者。
   *
   * 单个写操作失败不影响后续队列；失败原样抛给调用方。
   */
  updateSettings(mutator: SettingsJsonMutator): Promise<SettingsSnapshot> {
    const run = async (): Promise<SettingsSnapshot> => {
      const cfg = this.readSettingsFile();
      const result = mutator(cfg);
      const next = (result !== undefined ? result : cfg) as Record<string, unknown>;
      this.warnUnknownKeys(next);
      await mkdir(this.configDir, { recursive: true });
      await writeFile(this.settingsPath, JSON.stringify(next, null, 2), 'utf-8');
      this.rawSettings = next;
      this.snapshot = resolveSettingsSnapshot(next);
      this.notify();
      return this.snapshot;
    };

    const next = this.writeChain.then(run, run);
    this.writeChain = next.then(() => {}, () => {});
    return next;
  }

  /** 订阅快照变化；返回取消订阅函数 */
  subscribe(listener: (snapshot: SettingsSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 读 settings.json；文件不存在或解析失败时按空对象处理 */
  private readSettingsFile(): Record<string, unknown> {
    try {
      const parsed = JSON.parse(readFileSync(this.settingsPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 文件不存在或解析失败，按空对象处理
    }
    return {};
  }

  /** 读 mcp.json；文件不存在或解析失败时返回 undefined（解析器按空列表处理） */
  private readMcpFile(): unknown {
    try {
      return JSON.parse(readFileSync(this.mcpConfigPath, 'utf8'));
    } catch {
      return undefined;
    }
  }

  private notify(): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        this.log(`[SettingsStore] listener failed: ${String(error)}`);
      }
    }
  }

  /** 未知字段只记 warning、不丢：读-改-写会原样保留它们 */
  private warnUnknownKeys(cfg: Record<string, unknown>): void {
    for (const key of Object.keys(cfg)) {
      if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
        this.log(`[SettingsStore] unknown settings.json key "${key}"; kept as-is`);
      }
    }
    const llm = cfg.llm;
    if (!llm || typeof llm !== 'object' || Array.isArray(llm)) return;
    const providers = (llm as Record<string, unknown>).providers;
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return;
    for (const [key, provider] of Object.entries(providers as Record<string, unknown>)) {
      if (!provider || typeof provider !== 'object' || Array.isArray(provider)) continue;
      for (const field of Object.keys(provider as Record<string, unknown>)) {
        if (!KNOWN_PROVIDER_KEYS.has(field)) {
          this.log(`[SettingsStore] unknown settings.json key "llm.providers.${key}.${field}"; kept as-is`);
        }
      }
    }
  }
}

/** 宿主侧共享的配置存储实例（配置目录为 `~/<CONFIG_DIR_NAME>`） */
let sharedStore: SettingsStore | null = null;

export function getSettingsStore(): SettingsStore {
  if (!sharedStore) {
    sharedStore = new SettingsStore({
      log: (message: string) => logger.warn('SettingsStore', message),
    });
  }
  return sharedStore;
}

/** 测试用：丢弃共享实例，下次 `getSettingsStore()` 重新建 */
export function resetSettingsStore(): void {
  sharedStore = null;
}
