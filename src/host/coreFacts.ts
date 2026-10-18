/**
 * 宿主侧的「core 事实」入口（见 docs/core/standalone-core-boundaries.md 第 2 节）。
 *
 * 宿主不直接读取 core 的磁盘数据：以下事实都在 Core 进程内，统一经同名
 * `UiRequest` 索取（对话列表 / 智能命名 / 余额 / 归档展开 / MCP 列表 / 空间统计 /
 * 落盘等待 / 会话加载 / 技能列表）。
 *
 * 配置类事实（界面语言 / 系统语言 / 高亮语言 / 默认值 / 模型身份 / 原始 settings）
 * **不在这里**：它们全部归宿主，直接经 `SettingsStore` 读宿主自己的文件与快照
 * （`docs/architecture/core-ui-separation.md` 第 4 节，`settingsRead.ts`），不问 Core。
 * 系统语言也是宿主自己探测——i18n 归宿主，Core 不感知语言。
 */

import { requireEventBus } from '../shared/AssistantEventBus.js';
import type { LoadedConversation, SkillListItem } from '../shared/AssistantEventBus.js';
import { getSystemLocale, setHostLocale, setHostUiLanguage } from './i18n.js';
import type { ConversationMetadata } from '../shared/history/Conversation.js';
import type { ConversationSpaceInfo } from '../shared/webviewTypes.js';
import type { McpServerInfo } from '../shared/webviewTypes.js';
import type { Message } from '../shared/types.js';
import { getSettingsStore, type UiLanguage, type UiFontSize } from './SettingsStore.js';

export type { UiLanguage, UiFontSize };

/**
 * 同步读界面语言（webview 首帧注入用）。
 *
 * `uiLanguage` 是宿主自己的字段：读宿主自己的 `settings.json`（经 `SettingsStore`），
 * 不向 Core 索取。
 */
export function readUiLanguage(): UiLanguage {
  return getSettingsStore().readUiLanguage();
}

/**
 * 同步读界面字号（webview 首帧注入用）。
 *
 * 与 `uiLanguage` 同口径：只有 UI 消费、不进快照，读宿主自己的
 * `settings.json`（经 `SettingsStore`）。
 */
export function readUiFontSize(): UiFontSize {
  return getSettingsStore().readUiFontSize();
}

/**
 * 系统语言（`zh-CN` / `en-US` 之类）。
 *
 * 宿主自己探测（`getSystemLocale()`，Windows 走 PowerShell）：
 * i18n 归宿主，Core 不感知语言，因此没有「向 Core 要系统语言」这回事。
 * 结果在 `i18n` 内按进程缓存，只有首次调用真的探测。
 */
export function readSystemLocale(): string {
  return getSystemLocale();
}

/** 对话列表元数据（向 Core 请求） */
export async function loadConversationListForHost(
  workspacePath?: string,
): Promise<ConversationMetadata[]> {
  return requireEventBus().requestCore({ type: 'conversationListRequested', workspacePath });
}

/**
 * 智能命名：读会话消息 + 调 LLM + 解析标题。
 *
 * 只生成标题，不落盘、不广播——改名仍由宿主发 `UiEvent.conversationRenamed` 完成。
 */
export async function requestSmartNaming(sessionId: string): Promise<string> {
  const { title } = await requireEventBus().requestCore({ type: 'smartNamingRequested', sessionId });
  return title;
}

/**
 * DeepSeek 账户余额（未配置 api.deepseek.com provider 或查询失败时为 null）。
 *
 * `sessionId` 只用于多 Connection 路由：余额按该 Connection 的配置快照查询；
 * 缺省时由 Client 落到当前 Connection。
 */
export async function requestBalance(
  sessionId?: string,
): Promise<{
  totalBalance: number;
  currency: string;
  isUnlimited: boolean;
  fetchedAt: number;
} | null> {
  return requireEventBus().requestCore({ type: 'balanceRequested', sessionId });
}

/**
 * 压缩归档展开要显示的消息序列（`归档 + [旧格式的摘要] + 当前保留区`）。
 *
 * 没有归档时返回 `null`。
 */
export async function requestCompactArchive(sessionId: string): Promise<Message[] | null> {
  return requireEventBus().requestCore({ type: 'compactArchiveRequested', sessionId });
}

/**
 * MCP 面板列表：服务器定义（core 的配置快照）+ 该会话生效的启用状态 + 运行时状态。
 *
 * 这些事实在 Core 进程内，经 `UiRequest.mcpServersRequested` 索取
 * （宿主不触碰 MCPHost / McpManager）。
 */
export async function requestMcpServers(sessionId: string | undefined): Promise<McpServerInfo[]> {
  return requireEventBus().requestCore({ type: 'mcpServersRequested', sessionId });
}

/**
 * 对话空间统计（各空间的字节数 / 文件数 / 会话数）。
 *
 * 统计对象在 Core 的数据目录内，宿主经 `UiRequest` 索取。
 */
export async function requestConversationSpaces(): Promise<ConversationSpaceInfo[]> {
  return requireEventBus().requestCore({ type: 'conversationSpacesRequested' });
}

/**
 * 等待某会话的挂起持久化完成（宿主切走会话前的收尾）。
 *
 * 引擎在 Core 进程内，经 `UiRequest.flushSessionRequested` 让 Core 自己等待落盘完成。
 */
export async function requestFlushSession(sessionId: string): Promise<void> {
  await requireEventBus().requestCore({ type: 'flushSessionRequested', sessionId });
}

/**
 * 加载会话内容与派生事实（宿主渲染对话 / 工具元数据 / 模型身份用）。
 *
 * 会话内容与派生事实都在 Core 进程内，经 `UiRequest.conversationLoadRequested`
 * 一次取齐（宿主不直接读 core 磁盘）。
 */
export async function loadConversationForHost(sessionId: string): Promise<LoadedConversation> {
  return requireEventBus().requestCore({ type: 'conversationLoadRequested', sessionId });
}

/**
 * 斜杠命令与技能列表（内置命令 + 内置技能 + 会话工作目录下的技能）。
 *
 * Core 侧持有这份数据（含项目技能目录），经 `UiRequest.skillsRequested` 取回。
 */
export async function requestSkills(sessionId: string | undefined): Promise<SkillListItem[]> {
  const { skills } = await requireEventBus().requestCore({ type: 'skillsRequested', sessionId });
  return skills;
}

/**
 * 把语言收敛结果灌回宿主进程内的 i18n 模块。
 *
 * 宿主侧的原生 UI（Electron 菜单 / 托盘、Spin 设计器页面）用的是同一套 `tt()`；
 * 界面语言来自宿主自己的 `settings.json`，宿主 locale 由宿主启动时传入。
 * 由共享骨架 `bootstrapCore` 在启动接线内同步调用（不依赖 Connection 就绪事件）；
 * Electron 还会在创建托盘 / 菜单之前提前调用一次。收敛结果只依赖宿主自己的配置，
 * 重跑幂等。
 */
export function primeHostLocale(hostLocale?: string): void {
  if (hostLocale === undefined) return;
  // 顺序不能反：先记录宿主 locale（`auto` 的兜底），再按 `uiLanguage` 收敛。
  // `setHostLocale` 内部按「宿主 locale 或系统语言是中文就用中文」重算，
  // 放在 `setHostUiLanguage` 之后会把显式选择的 en 覆盖回 zh。
  setHostLocale(hostLocale);
  setHostUiLanguage(getSettingsStore().readUiLanguage());
}
