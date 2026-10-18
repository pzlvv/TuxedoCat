/**
 * core 侧的展示事实类型（core 产出、webview 消费）。
 *
 * webview 消息协议本身在 `src/host/webviewMessages.ts`（host ↔ webview 的
 * wire 联合类型，按方向拆分）；core 不感知消息协议，只提供下面这些
 * 「事实的形状」，由 host 组装进消息载荷。
 */

/** 一个 MCP 服务器的展示信息（来自 ~/<configDir>/mcp.json + settings.json 启用状态） */
export interface McpServerInfo {
  /** 服务器名（mcp.json 中的 key） */
  name: string;
  /** 传输类型，如 local / stdio / remote / http / sse */
  type: string;
  /** 启动命令（统一为数组形式；远程传输时为空数组） */
  command: string[];
  /** 环境变量（仅 local 传输） */
  environment: Record<string, string>;
  /** 远程 MCP 端点（Streamable HTTP 或旧版 SSE 的入口地址；仅 remote 传输） */
  url: string;
  /** 远程请求附带的 HTTP 头（如 Authorization；仅 remote 传输） */
  headers: Record<string, string>;
  /** 是否启用（来自 settings.json，默认 false） */
  enabled: boolean;
  /** 运行时：进程是否已连接（未启用时为 false） */
  running?: boolean;
  /** 运行时：已发现的工具数量 */
  toolCount?: number;
  /** 运行时：启动/运行错误信息，null 表示正常 */
  error?: string | null;
  /** 运行时：当前引用该服务器的会话数（引用计数模型） */
  refCount?: number;
}

/**
 * 一个 provider 及其模型列表（供输入框菜单按 provider 分组展示）。
 * 模型名与 provider 分开存放，不拼接。
 */
export interface ProviderModels {
  /** provider key（baseURL 的 hostname） */
  key: string;
  /** 该 provider 的模型列表 */
  models: string[];
}

/** 对话空间统计信息（唯一定义在 `history/ConversationSpace.ts`，此处只转出） */
/** 单个对话空间的统计信息（统计本身由 Core 计算，见 history/ConversationSpace.ts） */
export interface ConversationSpaceInfo {
  /** 对话空间标识 */
  dirName: string;
  /** 对话空间对应的项目路径 */
  projectPath: string;
  /** 该空间的总大小（字节） */
  sizeBytes: number;
  /** 该空间内的文件数 */
  fileCount: number;
  /** 该空间内的会话数 */
  conversationCount: number;
  /**
   * 项目目录是否已不存在（`projectPath` 为空时恒为 false，无从判定不提示）。
   * core 的统计顺带核实这个事实（统计在 core 侧机器上跑，本地 / 远程口径一致）；
   * 「要不要提示清理」由 UI 决定。
   */
  workspaceMissing: boolean;
}
