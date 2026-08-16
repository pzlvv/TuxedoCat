import type { HostInfo } from '../host/types';

declare module '*.css' {
  const content: string;
  export default content;
}

declare module 'github-markdown.css';

declare global {
  interface Window {
    __vscodeLocale?: string;
    __systemLocale?: string;
    /** 宿主能力声明（由 extension.ts / electron preload 注入） */
    __hostInfo?: HostInfo;
    __hasWorkspace?: boolean;
    __sessionId?: string;
    __currentSessionId?: string | null;
    __segLogged?: Set<string>;
    /** 开启后输出 [Profile]/[TokenDebug] 等诊断日志（性能优化用，默认关闭） */
    __debugEnabled?: boolean;
    logoUri?: string;
    vscode?: { postMessage(message: unknown): void };
    electronAPI?: {
      postMessage(message: unknown): void;
      onMessage?: (callback: (message: unknown) => void) => void;
      getWorkspacePath?: () => string;
      getSessionId?: () => string;
    };
  }
}

export {};
