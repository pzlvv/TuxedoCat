/**
 * src/host/ui/types.ts - 宿主共享 UI 模块的接口定义
 */

/**
 * diff 预览的一对宿主原生句柄。
 * 单 webview 宿主（VS Code）为 vscode.Uri；多视图宿主（Electron）不使用预览句柄，
 * 因此 UserChoiceManager 以泛型参数表达该句柄类型，共享模块本身不依赖任何宿主 API。
 */
export interface DiffUriPair<TUri> {
  beforeUri: TUri;
  afterUri: TUri;
}

export interface ShowVirtualDocumentEvent {
  content: string;
  title: string;
}

export interface ShowContentInVirtualDocumentEvent {
  content: string;
  title: string;
}

export interface ShowDiffInVirtualDocumentEvent {
  beforeContent: string;
  afterContent: string;
  title: string;
}
