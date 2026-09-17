/**
 * 工作目录 AGENTS.md 读取
 *
 * 读取工作目录下的 AGENTS.md，作为项目级上下文原样追加到 system prompt 末尾。
 * 文件不存在 / 读取失败 / 内容为空时返回 null。
 */

import { readFile } from 'fs/promises';
import { join } from 'path';

/** 项目上下文文件名 */
export const AGENTS_MD_FILENAME = 'AGENTS.md';

/**
 * 读取工作目录下的 AGENTS.md。
 * @param cwd 工作目录
 * @returns 文件内容（已去除首尾空白）；文件不存在、读取失败或内容为空时返回 null
 */
export async function readAgentsMd(cwd: string): Promise<string | null> {
  if (!cwd) {
    return null;
  }

  try {
    const content = await readFile(join(cwd, AGENTS_MD_FILENAME), 'utf8');
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
