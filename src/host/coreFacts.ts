/**
 * 宿主侧的「core 事实」入口（见 docs/standalone-core.md 第 10 节）。
 *
 * 宿主不直接读取 core 的磁盘数据。以下三项事实在两种装配下的取法不同：
 *
 * | 事实 | Embedded | Standalone |
 * | --- | --- | --- |
 * | 对话列表元数据 | `loadConversationList()` 直接读盘 | `UiRequest.conversationListRequested` |
 * | 界面语言 | `readUiLanguageSync()` 直接读盘 | `UiRequest.uiLanguageRequested` |
 * | 配置目录 | `getConfigHomeDir()` 计算 | `UiRequest.configHomeDirRequested` |
 *
 * Standalone 下三项都经 `requestCore` 向 Core 索取：界面语言与配置目录在握手完成
 * 后预热成同步可读的缓存（webview 首帧注入需要同步取值），对话列表按需现取
 * （`conversationListChanged` 驱动的 `ConversationManager.refresh()` 会重新请求）。
 *
 * 调用点统一走本模块，不再直接 import `src/core/history/**` 的读取函数。
 */

import { requireEventBus } from '../core/AssistantEventBus.js';
import { getConfigHomeDir, readUiLanguageSync } from '../core/history/Config.js';
import { getSystemLocale, setCoreLocale, setCoreUiLanguage } from '../core/i18n.js';
import type { ConversationMetadata } from '../core/history/Conversation.js';
import type { Message } from '../core/types.js';
import { resolveCoreKind, type CoreKind } from './coreKind.js';

/** 界面语言取值（与 `settings.json` 的 `uiLanguage` 一致） */
export type UiLanguage = 'auto' | 'zh' | 'en';

let uiLanguage: UiLanguage = 'auto';
let systemLocale = '';
let configHomeDir: string | null = null;
let primed = false;

/** 测试用：清空缓存 */
export function resetCoreFacts(): void {
  uiLanguage = 'auto';
  systemLocale = '';
  configHomeDir = null;
  primed = false;
}

/** 同步读界面语言（webview 首帧注入用） */
export function readUiLanguage(kind: CoreKind = resolveCoreKind()): UiLanguage {
  if (kind === 'embedded') return readUiLanguageSync();
  // 握手完成前回落 'auto'：与 `readUiLanguageSync` 读盘失败时的取值一致，
  // 是「还没有答案」而不是「答案是英文」。预热在 Core 每次就绪时都会重跑。
  return uiLanguage;
}

/**
 * 同步读配置目录。
 *
 * Standalone 下未预热时抛错：配置目录是 core 的事实，猜一个值会让调用方
 * 悄悄写到错误的路径上，属于必须暴露的接线错误。
 */
export function readConfigHomeDir(kind: CoreKind = resolveCoreKind()): string {
  if (kind === 'embedded') return getConfigHomeDir();
  if (configHomeDir === null) {
    throw new Error(
      'core facts are not primed yet: the config home directory is a core fact ' +
      'and is only available after the Standalone Core handshake.',
    );
  }
  return configHomeDir;
}

/**
 * 系统语言（`zh-CN` / `en-US` 之类）。
 *
 * Embedded 下宿主自己探测（`getSystemLocale()`，Windows 走 PowerShell）；
 * Standalone 下由 Core 探测并缓存——宿主不再为同一台机器重复起一次 PowerShell。
 * 预热前回落空串（与探测失败同一口径）。
 */
export function readSystemLocale(kind: CoreKind = resolveCoreKind()): string {
  if (kind === 'embedded') return getSystemLocale();
  return systemLocale;
}

/** 对话列表元数据（Embedded 读盘；Standalone 向 Core 请求） */
export async function loadConversationListForHost(
  workspacePath?: string,
  kind: CoreKind = resolveCoreKind(),
): Promise<ConversationMetadata[]> {
  if (kind === 'embedded') {
    const { loadConversationList } = await import('../core/history/index.js');
    return loadConversationList(workspacePath);
  }
  return requireEventBus().requestCore({ type: 'conversationListRequested', workspacePath });
}

/**
 * 智能命名：读会话消息 + 调 LLM + 解析标题。
 *
 * 只生成标题，不落盘、不广播——改名仍由宿主发 `UiEvent.conversationRenamed` 完成，
 * 两种装配下宿主后续代码完全相同。
 */
export async function requestSmartNaming(
  sessionId: string,
  kind: CoreKind = resolveCoreKind(),
): Promise<string> {
  if (kind === 'embedded') {
    const [{ loadConversation }, { resolveSmartTitle }] = await Promise.all([
      import('../core/history/index.js'),
      import('../core/history/smartNaming.js'),
    ]);
    const conversation = await loadConversation(sessionId);
    return resolveSmartTitle(sessionId, conversation.messages ?? []);
  }
  const { title } = await requireEventBus().requestCore({ type: 'smartNamingRequested', sessionId });
  return title;
}

/** DeepSeek 账户余额（未配置 api.deepseek.com provider 或查询失败时为 null） */
export async function requestBalance(
  kind: CoreKind = resolveCoreKind(),
): Promise<{
  totalBalance: number;
  currency: string;
  isUnlimited: boolean;
  fetchedAt: number;
} | null> {
  if (kind === 'embedded') {
    const { fetchBalance } = await import('../core/utils/balance.js');
    return fetchBalance();
  }
  return requireEventBus().requestCore({ type: 'balanceRequested' });
}

/**
 * 压缩归档展开要显示的消息序列（`归档 + [旧格式的摘要] + 当前保留区`）。
 *
 * 没有归档时返回 `null`。
 */
export async function requestCompactArchive(
  sessionId: string,
  kind: CoreKind = resolveCoreKind(),
): Promise<Message[] | null> {
  if (kind === 'embedded') {
    const { loadCompactArchive, loadConversation } = await import('../core/history/index.js');
    const archived = await loadCompactArchive(sessionId);
    if (!archived || archived.length === 0) return null;
    const isSummary = (message: Message): boolean =>
      message.type === 'user' && (message as { isCompactSummary?: boolean }).isCompactSummary === true;
    const summaryCount = archived.filter(isSummary).length;
    try {
      const conversation = await loadConversation(sessionId);
      const compressedSummaries = conversation.messages.filter(isSummary);
      const retained = conversation.messages.filter(
        (message) =>
          (message.type === 'user' || message.type === 'assistant') && !isSummary(message),
      );
      return summaryCount === 0 && compressedSummaries.length > 0
        ? [...archived, ...compressedSummaries, ...retained]
        : [...archived, ...retained];
    } catch {
      // 主 JSONL 读取失败时只展开归档部分（与 Embedded 的 catch 分支一致）
      return archived;
    }
  }
  return requireEventBus().requestCore({ type: 'compactArchiveRequested', sessionId });
}

/**
 * 保存 LLM 全局配置（设置面板）。
 *
 * Standalone 下整段 mutation 在 Core 侧执行（要读磁盘上的旧 `modelConfigs` 与内置
 * 模型注册表）；Embedded 下由宿主写盘，本函数只做「同样的输入 → 同样的输出」的
 * 兜底：不参与（返回 `null`），调用方走原来的宿主写盘路径。
 */
export async function requestLlmConfigSave(
  payload: Record<string, unknown>,
  kind: CoreKind = resolveCoreKind(),
): Promise<{
  model: string;
  modelProvider: string;
  activeProvider: string;
  thinkingEffort: 'off' | 'low' | 'high' | 'max';
  agentMode: 'manual' | 'risk' | 'auto';
  promptMode: 'normal' | 'minimal' | 'mixed';
  webSearch: boolean;
  providers: Array<{ key: string; models: string[] }>;
  activeModel: string;
  activeModelProvider: string;
} | null> {
  if (kind === 'embedded') return null;
  return requireEventBus().requestCore({ type: 'llmConfigSaveRequested', payload });
}

/** Standalone 下是否已预热（测试与诊断用） */
export function coreFactsPrimed(): boolean {
  return primed;
}

/**
 * Standalone 握手完成后预热同步可读的缓存。
 *
 * 由 `bootstrapCore` 挂在「Core 就绪」回调上：每次握手（含崩溃重启后）都重跑一次，
 * Core 侧换了配置目录或语言也能跟上。失败不抛给调用方——预热失败只影响
 * 同步读取点回落默认值，不该让启动流程失败。
 */
export async function primeCoreFacts(hostLocale?: string): Promise<void> {
  const bus = requireEventBus();
  const [language, home, system] = await Promise.all([
    bus.requestCore({ type: 'uiLanguageRequested' }),
    bus.requestCore({ type: 'configHomeDirRequested' }),
    bus.requestCore({ type: 'systemLocaleRequested' }),
  ]);
  uiLanguage = language;
  configHomeDir = home;
  systemLocale = system;
  primed = true;

  // 把 core 的语言收敛结果灌回宿主进程内的 i18n 模块：宿主侧的原生 UI
  // （Electron 菜单、Spin 设计器页面）用的是同一套 `tt()`，必须与 Core 一致。
  // 顺序与 Embedded 的 `initializeCoreEvents` → `hostEnvironmentProvided` 相同。
  if (hostLocale !== undefined) {
    setCoreUiLanguage(language);
    setCoreLocale(hostLocale);
  }
}
