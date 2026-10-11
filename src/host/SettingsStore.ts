/**
 * 宿主侧的配置存储：全局 `settings.json` 与 `mcp.json` 的唯一读写点
 * （`docs/architecture/core-ui-separation.md` 第 4 节）。
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

import { mkdir } from 'fs/promises';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resolveConfigDir } from '../config/configDir.js';
import { withFileLock, writeFileAtomic } from '../core/utils/fileLock.js';
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

/**
 * 读盘结果。
 *
 * - `ok`：读到了合法对象；
 * - `missing`：文件不存在（等价于「还没配置过」，按空对象继续）；
 * - `invalid`：文件存在但读不出来（解析失败 / IO 错误）——**不可当成空配置**，
 *   更不可用它去覆盖磁盘（见 `readSettingsFile`）。
 */
type SettingsReadResult =
  | { status: 'ok'; value: Record<string, unknown> }
  | { status: 'missing' }
  | { status: 'invalid'; error: string };

/** 界面语言取值（与 `settings.json` 的 `uiLanguage` 一致） */
export type UiLanguage = 'auto' | 'zh' | 'en';

/**
 * 界面字号档位（与 `settings.json` 的 `uiFontSize` 一致）。
 *
 * 只影响 webview 的展示字号，不影响任何 Core 事实；`medium` 是当前基准，
 * `large` / `xlarge` 在基准上分别 +1px / +2px（`src/webview/fontSize.ts`）。
 */
export type UiFontSize = 'medium' | 'large' | 'xlarge';

/**
 * 界面语言的默认值（`auto` = 跟随系统）。
 *
 * `uiLanguage` 只有 UI 侧消费、不进配置快照，因此它的缺省取值由宿主在这里决定
 * （`docs/hosts/webview-facts.md` 第 2 节：默认值归宿主）。webview 不持有该取值。
 */
const DEFAULT_UI_LANGUAGE: UiLanguage = 'auto';

/**
 * 界面字号的默认值（`medium` = 当前基准）。
 *
 * 与 `uiLanguage` 同理：只有 UI 侧消费、不进配置快照，缺省取值由宿主决定，
 * webview 不持有该取值。
 */
const DEFAULT_UI_FONT_SIZE: UiFontSize = 'medium';

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
  'uiFontSize',
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
   * 现算而不是构造时缓存：`resolveConfigDir()` 读的是环境变量，测试会临时改
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

  /** 配置目录：`~/<CONFIG_DIR_NAME>`（未显式注入时；口径见 `config/configDir.ts`） */
  get configDir(): string {
    return this.configDirOption ?? resolveConfigDir();
  }

  /** settings.json 路径 */
  get settingsPath(): string {
    return join(this.configDir, 'settings.json');
  }

  /** mcp.json 路径 */
  get mcpConfigPath(): string {
    return join(this.configDir, 'mcp.json');
  }

  /** 跨进程互斥用的锁文件（多个宿主进程共写同一份 settings.json） */
  private get lockPath(): string {
    return `${this.settingsPath}.lock`;
  }

  /** 原子写入用的临时文件 */
  private get tmpPath(): string {
    return `${this.settingsPath}.tmp`;
  }

  /**
   * 读盘并产出快照（**同步**）。
   *
   * 同步是有意的：webview 首帧注入界面语言、界面字号、注入高亮语言都要求同步取值
   * （`readUiLanguage` / `readUiFontSize` / `readHighlightLanguages`）。文件只有几 KB，
   * 启动期读一次。
   *
   * `mcp.json` 只在这里读一次：之后 `updateSettings` 不会重读它，
   * 因此中途修改 `mcp.json` 不会进入快照（重开工作区生效）。
   */
  loadSync(): SettingsSnapshot {
    const read = this.readSettingsFile();
    if (read.status === 'invalid') {
      // 读不出来：保留上一次的良好快照（首次加载时为「未配置」），记一条醒目日志。
      // 不能按空配置继续——那会让界面显示「未配置」，并可能在后续写入时清空磁盘。
      this.log(`[SettingsStore] ${read.error}；按未配置继续，磁盘内容不会被覆盖`);
      if (!this.snapshot) {
        this.rawSettings = {};
        this.snapshot = resolveSettingsSnapshot(this.rawSettings);
      }
      this.mcpServers = parseMcpServerDefinitions(this.readMcpFile());
      return this.snapshot;
    }
    this.rawSettings = read.status === 'ok' ? read.value : {};
    this.warnUnknownKeys(this.rawSettings);
    this.mcpServers = parseMcpServerDefinitions(this.readMcpFile());
    this.snapshot = resolveSettingsSnapshot(this.rawSettings);
    return this.snapshot;
  }

  /**
   * 重新读盘并刷新快照（**打开设置面板 / webview 挂载时调用**）。
   *
   * 存在意义：本 store 只在启动期 `loadSync()` 一次，之后不监听文件
   * （`docs/architecture/core-ui-separation.md` 第 4.5 节）。若启动瞬间文件不可用，或用户在外部
   * 手工恢复 / 编辑了 `settings.json`，进程会一直停留在旧快照上——表现就是
   * 「设置没被读到、反复弹设置页」。这里给一个显式的重读入口，把手工修改收敛回来。
   *
   * 与 `loadSync()` 的差别：
   * - `mcp.json` 仍只在 `loadSync()` 时读一次（语义不变，重开工作区生效）；
   * - 只有内容真的变化才 `notify()`（避免每次开面板都向所有 Connection 重推快照）。
   */
  refreshFromDisk(): SettingsSnapshot {
    const read = this.readSettingsFile();
    if (read.status === 'invalid') {
      // 读不出来时保持现有快照（不要把「读失败」当成「配置被清空」）
      this.log(`[SettingsStore] ${read.error}；保持现有快照`);
      return this.getSnapshot();
    }
    const raw = read.status === 'ok' ? read.value : {};
    const firstLoad = this.snapshot === null;
    const changed = firstLoad || JSON.stringify(raw) !== JSON.stringify(this.rawSettings);
    if (!changed) return this.getSnapshot();

    this.rawSettings = raw;
    this.warnUnknownKeys(raw);
    if (firstLoad) {
      // 尚未 loadSync：mcp.json 一起读（与 loadSync 同口径）
      this.mcpServers = parseMcpServerDefinitions(this.readMcpFile());
    }
    this.snapshot = resolveSettingsSnapshot(raw);
    // 首次加载没有订阅者；运行期变化才通知（宿主据此重推快照给 Core）
    if (!firstLoad) this.notify();
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
    return lang === 'zh' || lang === 'en' || lang === 'auto' ? lang : DEFAULT_UI_LANGUAGE;
  }

  /** 界面字号（`settings.json` 的 `uiFontSize`）；只有 UI 消费，不进快照 */
  readUiFontSize(): UiFontSize {
    const size = this.rawSettings.uiFontSize;
    return size === 'medium' || size === 'large' || size === 'xlarge' ? size : DEFAULT_UI_FONT_SIZE;
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
   * 执行对 `settings.json` 的读-改-写，随后重新解析快照并通知订阅者。
   *
   * 三层保护，缺一不可（同一台机器上可能有多个宿主进程共写这一份文件）：
   *
   * 1. **进程内串行**：`writeChain` 按调用顺序排队，避免同一进程内并发写坏文件。
   * 2. **跨进程互斥**：读-改-写整体在锁内执行（`withFileLock`），避免两个宿主的
   *    读-改-写交错造成丢失更新。
   * 3. **读不出来就不写**：磁盘上存在但解析失败时**拒绝写入**并抛错。若把它当成空
   *    配置继续，就会用 `{}` + 本次改动覆盖掉用户的全部配置——这是必须避免的破坏性
   *    行为（并发写下的半截文件正是这种情形）。
   *
   * 写入本身是原子的（临时文件 + `rename`），且内容没变化时跳过写入：读者不会看到
   * 半截文件，高频调用（如记录高亮语言）也不会反复重写磁盘。
   *
   * 单个写操作失败不影响后续队列；失败原样抛给调用方。
   */
  updateSettings(mutator: SettingsJsonMutator): Promise<SettingsSnapshot> {
    const run = async (): Promise<SettingsSnapshot> => {
      await mkdir(this.configDir, { recursive: true });
      return withFileLock(this.lockPath, async () => {
        const read = this.readSettingsFile();
        if (read.status === 'invalid') {
          throw new Error(
            `拒绝覆盖 settings.json：${read.error}（文件存在但读不出来，`
            + '按空配置写入会丢失用户配置）',
          );
        }
        const cfg: Record<string, any> = read.status === 'ok' ? read.value : {};
        // 规范化文本必须在跑 mutator **之前**取：mutator 是原地改 `cfg` 的，
        // 跑完之后 `read.value` 已经跟着变了，再比较就会永远判定「没变化」。
        const onDiskText = read.status === 'ok' ? `${JSON.stringify(read.value, null, 2)}\n` : null;
        const result = mutator(cfg);
        const next = (result !== undefined ? result : cfg) as Record<string, unknown>;
        const text = `${JSON.stringify(next, null, 2)}\n`;
        // 内容没变就不落盘：既省 IO，也缩小跨进程竞争窗口。
        // 与「磁盘上现有内容的规范形式」比较，而不是与上次写入的文本比较——
        // 期间可能有别的进程改过文件。
        if (onDiskText === text) {
          this.rawSettings = next;
          this.snapshot = resolveSettingsSnapshot(next);
          return this.snapshot;
        }
        this.warnUnknownKeys(next);
        await writeFileAtomic(this.settingsPath, text, this.tmpPath);
        this.rawSettings = next;
        this.snapshot = resolveSettingsSnapshot(next);
        this.notify();
        return this.snapshot;
      });
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

  /**
   * 读 settings.json，区分「不存在」「读不出来」两种情况。
   *
   * 区分是必须的：不存在等价于「用户还没配置过」，可以按空对象继续；读不出来
   * （解析失败 / IO 错误）说明磁盘上**有**一份我们没读懂的内容，此时绝不能把它当成
   * 空配置——那会在下一次写入时用 `{}` 覆盖掉用户的全部配置。
   * 并发场景下这尤其致命：另一个进程正在写（截断 + 写入）时，读者会读到半截文件。
   */
  private readSettingsFile(): SettingsReadResult {
    let text: string;
    try {
      text = readFileSync(this.settingsPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { status: 'missing' };
      return { status: 'invalid', error: String(err) };
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { status: 'ok', value: parsed as Record<string, unknown> };
      }
      return { status: 'invalid', error: 'settings.json 的顶层不是对象' };
    } catch (err) {
      return { status: 'invalid', error: `settings.json 解析失败: ${String(err)}` };
    }
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
