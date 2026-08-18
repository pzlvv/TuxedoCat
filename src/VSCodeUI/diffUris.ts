/**
 * VSCodeUI/diffUris.ts - Diff 虚拟文档 URI 构造
 *
 * 统一使用 vscode.Uri.parse 构造 before/after URI，并保证记录、打开、关闭时
 * 使用同一套规范化后的 Uri 对象，避免 Windows/Linux 路径编码差异导致
 * closePreview 无法匹配到已打开的 diff tab。
 */
import * as vscode from 'vscode';
import { DIFF_AFTER_SCHEME, DIFF_BEFORE_SCHEME } from '../config/project.js';

export interface DiffUris {
  beforeUri: vscode.Uri;
  afterUri: vscode.Uri;
}

export function buildDiffUris(title: string): DiffUris {
  const beforeUri = vscode.Uri.parse(`${DIFF_BEFORE_SCHEME}:${encodeURIComponent(title)}`);
  const afterUri = vscode.Uri.parse(`${DIFF_AFTER_SCHEME}:${encodeURIComponent(title)}`);
  return { beforeUri, afterUri };
}
