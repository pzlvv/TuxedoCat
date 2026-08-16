/**
 * VSCodeUI/types.ts - VSCodeUI 模块共用接口定义
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
