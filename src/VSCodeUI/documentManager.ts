/**
 * VSCodeUI/documentManager.ts - 文档/Diff/预览管理
 * 管理虚拟文档、diff 预览文档的打开和关闭
 */
import * as vscode from 'vscode';
import type { ShowContentInVirtualDocumentEvent, ShowDiffInVirtualDocumentEvent } from './types.js';
import { DIFF_AFTER_SCHEME, DIFF_BEFORE_SCHEME, PRODUCT_NAME } from '../config/project.js';

/**
 * DocumentManager - 管理虚拟文档和 diff 预览的打开/关闭
 */
export class DocumentManager {
  private outputChannel: vscode.OutputChannel | undefined;
  /** 当前打开的预览文档 URIs */
  public currentPreviewUris: vscode.Uri[] = [];
  /** 当前打开的 diff 的哈希值 */
  public currentDiffHash: string = '';
  private onShowContentInVirtualDocumentCallback?: (event: ShowContentInVirtualDocumentEvent) => void | Promise<void>;
  private onShowDiffInVirtualDocumentCallback?: (event: ShowDiffInVirtualDocumentEvent) => void | Promise<void>;

  constructor(outputChannel: vscode.OutputChannel | undefined) {
    this.outputChannel = outputChannel;
  }

  private log(...args: unknown[]): void {
    this.outputChannel?.appendLine(args.map(a => String(a)).join(' '));
  }

  setShowContentCallback(callback: (event: ShowContentInVirtualDocumentEvent) => void | Promise<void>): void {
    this.onShowContentInVirtualDocumentCallback = callback;
  }

  setShowDiffCallback(callback: (event: ShowDiffInVirtualDocumentEvent) => void | Promise<void>): void {
    this.onShowDiffInVirtualDocumentCallback = callback;
  }

  /**
   * 关闭当前打开的预览文档（diff 预览或其他虚拟文档）
   */
  closePreview(): void {
    if (this.currentPreviewUris.length === 0) {
      return;
    }

    this.log(`[VSCodeUI] Closing preview documents: ${this.currentPreviewUris.length}`);

    try {
      const tabGroups = vscode.window.tabGroups;
      const allTabs = tabGroups.all;

      const tabsToClose: vscode.Tab[] = [];
      for (const group of allTabs) {
        for (const tab of group.tabs) {
          if (tab.input instanceof vscode.TabInputText) {
            const tabUri = tab.input.uri;
            if (this.currentPreviewUris.some(uri => uri.toString() === tabUri.toString())) {
              tabsToClose.push(tab);
            }
          } else if (tab.input instanceof vscode.TabInputTextDiff) {
            const originalUri = tab.input.original;
            const modifiedUri = tab.input.modified;
            if (this.currentPreviewUris.some(uri =>
              uri.toString() === originalUri.toString() ||
              uri.toString() === modifiedUri.toString()
            )) {
              tabsToClose.push(tab);
            }
          }
        }
      }

      for (const tab of tabsToClose) {
        try {
          vscode.window.tabGroups.close(tab);
          this.log(`[VSCodeUI] Closed tab: ${tab.label}`);
        } catch (_err) {
          this.log(`[VSCodeUI] Failed to close tab: ${_err}`);
        }
      }
    } catch (err) {
      this.log(`[VSCodeUI] Error closing preview tabs: ${err}`);
    }

    this.currentPreviewUris = [];
  }

  /**
   * 展示 diff 虚拟文档
   * 由 webview 消息或 user choice 触发
   */
  async showDiff(options: {
    filePath?: string;
    newContent?: string;
    title?: string;
    beforeContent?: string;
    afterContent?: string;
    onShowContent?: (event: ShowContentInVirtualDocumentEvent) => void;
  }): Promise<void> {
    const { filePath, newContent, title, beforeContent: providedBeforeContent, afterContent: providedAfterContent, onShowContent } = options;
    this.log(`[VSCodeUI] showDiffInVirtualDocument: ${title || filePath}`);

    const displayTitle = `[${PRODUCT_NAME}] ${title || filePath}`;

    let beforeContent = providedBeforeContent || '';
    const afterContent = providedAfterContent || newContent || '';

    // 如果没有提供 beforeContent，从文件读取
    if (!beforeContent && filePath) {
      try {
        const fs = await import('fs/promises');
        beforeContent = await fs.readFile(filePath, 'utf-8');
      } catch {
        this.log(`[VSCodeUI] File not found or cannot read, showing new content only: ${filePath}`);
        if (onShowContent || this.onShowContentInVirtualDocumentCallback) {
          const callback = onShowContent || this.onShowContentInVirtualDocumentCallback!;
          callback({
            content: afterContent,
            title: title || filePath
          });
        }
        return;
      }
    }

    if (this.onShowDiffInVirtualDocumentCallback) {
      const newDiffHash = `${beforeContent.length}-${afterContent.length}-${beforeContent.substring(0, 100)}-${afterContent.substring(0, 100)}`;

      if (this.currentDiffHash === newDiffHash) {
        this.log(`[VSCodeUI] Same diff already open, skipping: ${title || filePath}`);
      } else {
        if (this.currentPreviewUris.length > 0) {
          this.closePreview();
        }

        this.currentDiffHash = newDiffHash;

        const result = this.onShowDiffInVirtualDocumentCallback!({
          beforeContent,
          afterContent: newContent || '',
          title: displayTitle,
        });
        if (result && typeof result.then === 'function') {
          await result;
        }

        this.currentPreviewUris.push(
          vscode.Uri.parse(`${DIFF_BEFORE_SCHEME}:${encodeURIComponent(displayTitle)}`),
          vscode.Uri.parse(`${DIFF_AFTER_SCHEME}:${encodeURIComponent(displayTitle)}`)
        );
      }
    } else {
      this.log('[VSCodeUI] Warning: No callback registered for ShowDiffInVirtualDocument');
    }
  }
}
