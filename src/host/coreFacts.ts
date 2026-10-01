/**
 * 宿主侧的「core 事实」入口（见 docs/standalone-core.md 第 10 节）。
 *
 * 宿主不直接读取 core 的磁盘数据。以下事实在两种装配下的取法不同：
 *
 * | 事实 | Embedded | Standalone |
 * | --- | --- | --- |
 * | 对话列表元数据 | `loadConversationList()` 直接读盘 | `UiRequest.conversationListRequested` |
 * | 智能命名 / 余额 / 归档展开 | core 模块直接调用 | 同名 `UiRequest` |
 *
 * 配置类事实（界面语言 / 系统语言 / 高亮语言 / 默认值 / 模型身份 / 原始 settings）
 * **不在这里**：它们全部归宿主，直接经 `SettingsStore` 读宿主自己的文件与快照
 * （`docs/core-ui-separation.md` 第 4 节，`settingsRead.ts`），不问 Core。
 * 系统语言也是宿主自己探测——i18n 归宿主，Core 不感知语言。
 *
 * 调用点统一走本模块，不再直接 import `src/core/history/**` 的读取函数。
 */

import { requireEventBus } from '../core/AssistantEventBus.js';
import type { LoadedConversation, SkillListItem } from '../core/AssistantEventBus.js';
import { getSystemLocale, setHostLocale, setHostUiLanguage } from './i18n.js';
import type { ConversationMetadata } from '../core/history/Conversation.js';
import type { ConversationSpaceInfo } from '../core/history/ConversationSpace.js';
import type { McpServerInfo } from '../core/webviewTypes.js';
import type { Message } from '../core/types.js';
import { resolveCoreKind, type CoreKind } from './coreKind.js';
import { getSettingsStore, type UiLanguage } from './SettingsStore.js';

export type { UiLanguage };

/**
 * 同步读界面语言（webview 首帧注入用）。
 *
 * `uiLanguage` 是宿主自己的字段：两种装配下都读宿主自己的 `settings.json`
 * （经 `SettingsStore`），不再向 Core 索取。
 */
export function readUiLanguage(): UiLanguage {
  return getSettingsStore().readUiLanguage();
}

/**
 * 系统语言（`zh-CN` / `en-US` 之类）。
 *
 * 宿主自己探测（`getSystemLocale()`，Windows 走 PowerShell），两种装配同一条路径：
 * i18n 归宿主，Core 不感知语言，因此没有「向 Core 要系统语言」这回事。
 * 结果在 `i18n` 内按进程缓存，只有首次调用真的探测。
 */
export function readSystemLocale(): string {
  return getSystemLocale();
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

/**
 * DeepSeek 账户余额（未配置 api.deepseek.com provider 或查询失败时为 null）。
 *
 * `sessionId` 只用于多 Connection 路由：余额按该 Connection 的配置快照查询；
 * 缺省时由 Client 落到当前 Connection。
 */
export async function requestBalance(
  sessionId?: string,
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
  return requireEventBus().requestCore({ type: 'balanceRequested', sessionId });
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
 * MCP 面板列表：服务器定义（core 的配置快照）+ 该会话生效的启用状态 + 运行时状态。
 *
 * Embedded 下 core 状态在同一进程：直接读 core 的会话配置与 MCP 管理器状态；
 * Standalone 下这些事实在 Core 进程内，经 `UiRequest.mcpServersRequested` 索取
 * （宿主不触碰 MCPHost / McpManager）。
 */
export async function requestMcpServers(
  sessionId: string | undefined,
  kind: CoreKind = resolveCoreKind(),
): Promise<McpServerInfo[]> {
  if (kind === 'embedded') {
    const [{ readMcpServers }, { getMcpManager }] = await Promise.all([
      import('../core/mcp/Config.js'),
      import('../core/mcp/Manager.js'),
    ]);
    const servers = await readMcpServers(sessionId);
    const status = getMcpManager().getServerStatus();
    return servers.map((server) => {
      const runtime = status.get(server.name);
      return {
        ...server,
        running: runtime?.running ?? false,
        toolCount: runtime?.toolCount ?? 0,
        error: runtime?.error ?? null,
        refCount: runtime?.refCount ?? 0,
      };
    });
  }
  return requireEventBus().requestCore({ type: 'mcpServersRequested', sessionId });
}

/**
 * 对话空间统计（各空间的字节数 / 文件数 / 会话数）。
 *
 * Standalone 下统计对象在 Core 的数据目录内，宿主经 `UiRequest` 索取。
 */
export async function requestConversationSpaces(
  kind: CoreKind = resolveCoreKind(),
): Promise<ConversationSpaceInfo[]> {
  if (kind === 'embedded') {
    const { getConversationSpaces } = await import('../core/history/ConversationSpace.js');
    return getConversationSpaces();
  }
  return requireEventBus().requestCore({ type: 'conversationSpacesRequested' });
}

/**
 * 等待某会话的挂起持久化完成（宿主切走会话前的收尾）。
 *
 * Embedded 下直接 `flush()` 该会话引擎；Standalone 下引擎在 Core 进程内，
 * 经 `UiRequest.flushSessionRequested` 让 Core 自己等待落盘完成。
 */
export async function requestFlushSession(
  sessionId: string,
  kind: CoreKind = resolveCoreKind(),
): Promise<void> {
  if (kind === 'embedded') {
    const { getSessionEngine } = await import('../core/QueryEngine.js');
    await getSessionEngine(sessionId)?.flush();
    return;
  }
  await requireEventBus().requestCore({ type: 'flushSessionRequested', sessionId });
}

/**
 * 加载会话内容与派生事实（宿主渲染对话 / 工具元数据 / 模型身份用）。
 *
 * Embedded 下读盘 + 读进程内事实；Standalone 下这些都在 Core 进程内，
 * 经 `UiRequest.conversationLoadRequested` 一次取齐（宿主不直接读 core 磁盘）。
 */
export async function loadConversationForHost(
  sessionId: string,
  kind: CoreKind = resolveCoreKind(),
): Promise<LoadedConversation> {
  if (kind === 'embedded') {
    const [{ loadConversation }, { getPendingToolUseIds }, conversationModule, permissionModule] =
      await Promise.all([
        import('../core/history/index.js'),
        import('../core/tools/RunTools.js'),
        import('../core/history/Conversation.js'),
        import('../core/tools/PermissionPolicy.js'),
      ]);
    const conversation = await loadConversation(sessionId);
    let hasCompactArchive = false;
    try {
      hasCompactArchive = await conversationModule.hasCompactArchive(sessionId);
    } catch {
      // 工作目录未登记 / 归档不可读：按「没有归档」处理
    }
    let agentMode: LoadedConversation['agentMode'] = null;
    try {
      agentMode = permissionModule.getStoredSessionAgentMode(sessionId) ?? null;
    } catch {
      // 未记录：由宿主回退 meta.json / settings.json 默认值
    }
    return {
      messages: conversation.messages ?? [],
      metadata: conversation.metadata ?? null,
      pendingToolUseIds: [...getPendingToolUseIds()],
      hasCompactArchive,
      agentMode,
    };
  }
  return requireEventBus().requestCore({ type: 'conversationLoadRequested', sessionId });
}

/**
 * 斜杠命令与技能列表（内置命令 + 内置技能 + 会话工作目录下的技能）。
 *
 * Embedded 下直接组装；Standalone 下 Core 侧持有同一份数据（含项目技能目录），
 * 经 `UiRequest.skillsRequested` 取回。
 */
export async function requestSkills(
  sessionId: string | undefined,
  kind: CoreKind = resolveCoreKind(),
): Promise<SkillListItem[]> {
  if (kind === 'embedded') {
    const [{ getBundledSkills }, { getSkillDirCommands }, { getBuiltinCommands }, configModule] =
      await Promise.all([
        import('../core/skills/bundledSkills.js'),
        import('../core/skills/loadSkillsDir.js'),
        import('../core/skills/builtinCommands.js'),
        import('../core/history/Config.js'),
      ]);
    const fileSkills =
      sessionId && configModule.hasProjectRoot(sessionId)
        ? await getSkillDirCommands(configModule.getProjectRoot(sessionId))
        : [];
    return [
      ...getBuiltinCommands().map((command) => ({
        name: command.name,
        description: command.description,
        isBuiltin: true,
      })),
      ...[...getBundledSkills(), ...fileSkills].map((skill) => ({
        name: skill.name,
        description: skill.description,
        isBuiltin: false,
      })),
    ];
  }
  const { skills } = await requireEventBus().requestCore({ type: 'skillsRequested', sessionId });
  return skills;
}

/**
 * 把语言收敛结果灌回宿主进程内的 i18n 模块。
 *
 * 宿主侧的原生 UI（Electron 菜单、Spin 设计器页面）用的是同一套 `tt()`；
 * 界面语言来自宿主自己的 `settings.json`，宿主 locale 由宿主启动时传入。
 * Standalone 下挂在「Core 就绪」回调上（每次握手，含崩溃重启后）：Core 进程换了
 * 一个，但宿主进程内的收敛结果不变，重跑是幂等的。
 */
export function primeHostLocale(hostLocale?: string): void {
  if (hostLocale === undefined) return;
  setHostUiLanguage(getSettingsStore().readUiLanguage());
  setHostLocale(hostLocale);
}
