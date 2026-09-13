/**
 * /spin 命令共享逻辑。
 *
 * VSCodeUI.onCommandSend 与 ElectronUI.onCommandSend 原为重复的：
 * design 子命令分发 + spin.json 存在性检查（不存在则打开设计器）。
 * 宿主差异（如何确定工作目录、日志通道）由调用方处理。
 */
import * as path from 'path';
import { getProjectConversationDir } from './Config.js';

/** 读取磁盘上最新的 spin.json 内容（重试保护见各宿主原实现） */
export function spinJsonPathFor(workspacePath: string): string {
  return path.join(getProjectConversationDir(workspacePath), 'spin.json');
}

/**
 * /spin 命令的 spin.json 存在性检查：
 * 无 spin.json 时应打开设计器（返回 true）。
 * 目录/文件不可读时按"存在"处理（不打开），与原实现一致。
 */
export function shouldOpenSpinDesign(workspacePath: string | undefined): boolean {
  if (!workspacePath) return false;
  const fs = require('fs') as typeof import('fs');
  try {
    return !fs.existsSync(spinJsonPathFor(workspacePath));
  } catch {
    return false;
  }
}
