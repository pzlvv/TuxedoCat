export interface ToolCallProps {
  toolName: string;
  args: Record<string, any>;
  status: 'running' | 'success' | 'fail';
  output?: string;
  isDark: boolean;
  colors: any;
  toolCallId?: string;
  /** 是否正在流式输出（Bash 等工具运行中实时刷新输出） */
  isStreaming?: boolean;
  /** 跳转到指定会话（用于子代理导航） */
  onNavigate?: (sessionId: string) => void;
  /** 当前子代理的父会话 ID */
  currentParentSessionId?: string;
  /** 用户手动展开/折叠内容（Edit diff、Write 预览等）时通知外层，用于控制自动滚动 */
  onExpandToggle?: (isOpen: boolean) => void;
  /** 内部状态即将渲染大块 preview（如 Edit diff）前通知外层预滚动 */
  onBeforePreviewRender?: () => void;
}
