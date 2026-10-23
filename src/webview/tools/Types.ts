export interface ToolCallProps {
  toolName: string;
  args: Record<string, any>;
  /**
   * 工具卡片状态。'normal' 表示**正在等待用户授权**（手动模式下工具尚未执行，
   * 见 useMessageHandler 中 isPending → 'normal' 的判定），其余为执行期/结果态。
   */
  status: 'normal' | 'running' | 'success' | 'fail';
  output?: string;
  isDark: boolean;
  colors: any;
  toolCallId?: string;
  /** 是否正在流式输出（Bash 等工具运行中实时刷新输出） */
  isStreaming?: boolean;
  /** 跳转到指定会话（用于子代理导航）；`workspaceId` 非空表示跨工作区（specs/022） */
  onNavigate?: (sessionId: string, workspaceId?: string | null) => void;
  /** 当前子代理的父会话 ID */
  currentParentSessionId?: string;
  /** 用户手动展开/折叠内容（Edit diff、Write 预览等）时通知外层，用于控制自动滚动 */
  onExpandToggle?: (isOpen: boolean) => void;
  /** 内部状态即将渲染大块 preview（如 Edit diff）前通知外层预滚动 */
  onBeforePreviewRender?: () => void;
}
