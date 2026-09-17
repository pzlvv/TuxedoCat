/**
 * src/host/ui/types.ts - 宿主共享 UI 模块的接口定义
 */

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
