/**
 * 变量解析引擎
 *
 * 负责在 Skill 的 Markdown 内容中执行变量替换：
 * - $ARGUMENTS：用户传入的全部参数
 * - $0, $1, $2...：按 argNames 映射的位置参数
 * - ${SKILL_DIR}：Skill 文件所在目录路径
 * - ${SESSION_ID}：当前会话 ID
 */

import type { ContentBlock } from './Types.js';

/**
 * 在文本中替换位置参数
 * 支持 $0, $1, $2... 和 $ARGUMENTS
 *
 * @param content 原始文本
 * @param args 用户传入的参数字符串
 * @param argNames 参数名称列表（若提供，则支持 $name 形式的命名参数）
 * @returns 替换后的文本
 */
export function substituteArguments(
  content: string,
  args: string,
  argNames: string[],
): string {
  let result = content;

  // 替换 $ARGUMENTS 为完整参数字符串
  if (args) {
    result = result.replace(/\$ARGUMENTS/g, args);
  }

  // 替换位置参数 $0, $1, $2...
  if (args && argNames.length > 0) {
    const argValues = parsePositionalArgs(args, argNames.length);
    for (let i = 0; i < argValues.length; i++) {
      result = result.replace(new RegExp(`\\$${i}`, 'g'), argValues[i]);
    }
  } else if (args) {
    // 没有 argNames 时，$0 替换为完整参数
    result = result.replace(/\$0/g, args);
  }

  // 替换命名参数（$argName）
  if (args && argNames.length > 0) {
    const argValues = parsePositionalArgs(args, argNames.length);
    for (let i = 0; i < argNames.length; i++) {
      const name = argNames[i];
      if (name && i < argValues.length) {
        result = result.replace(new RegExp(`\\$\\{${name}\\}`, 'g'), argValues[i]);
        result = result.replace(new RegExp(`\\$${name}\\b`, 'g'), argValues[i]);
      }
    }
  }

  return result;
}

/**
 * 解析位置参数
 * 按空格分割，支持引号包裹的参数
 *
 * @param args 参数字符串
 * @param count 需要多少个参数
 * @returns 解析后的参数数组
 */
export function parsePositionalArgs(args: string, count: number): string[] {
  const result: string[] = [];
  let current = '';
  let inQuote: string | null = null;
  let escape = false;

  for (const ch of args) {
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }

    if (ch === '\\') {
      escape = true;
      continue;
    }

    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }

    if (ch === ' ') {
      if (current) {
        result.push(current);
        current = '';
        if (result.length >= count) break;
      }
      continue;
    }

    current += ch;
  }

  if (current) {
    result.push(current);
  }

  // 补齐剩余参数为空字符串
  while (result.length < count) {
    result.push('');
  }

  return result;
}

/**
 * 替换内置变量
 * ${SKILL_DIR} -> skill 所在目录
 * ${SESSION_ID} -> 当前会话 ID
 *
 * @param content 原始文本
 * @param skillDir Skill 文件所在目录（若有）
 * @param sessionId 当前会话 ID（若有）
 * @returns 替换后的文本
 */
export function substituteBuiltinVariables(
  content: string,
  skillDir: string | undefined,
  sessionId: string | undefined,
): string {
  let result = content;

  if (skillDir) {
    const normalizedDir = process.platform === 'win32'
      ? skillDir.replace(/\\/g, '/')
      : skillDir;
    result = result.replace(/\$\{SKILL_DIR\}/g, normalizedDir);
  }

  if (sessionId) {
    result = result.replace(/\$\{SESSION_ID\}/g, sessionId);
  }

  return result;
}

/**
 * 在 Prompt 内容前插入 Base directory 提示
 * 告知模型 Skill 的参考文件所在目录，方便其使用 Read/Grep 读取
 */
export function prependBaseDir(
  blocks: ContentBlock[],
  baseDir: string,
): ContentBlock[] {
  const prefix = `Base directory for this skill: ${baseDir}\n\n`;
  if (blocks.length > 0 && blocks[0]?.type === 'text') {
    return [
      { type: 'text', text: prefix + blocks[0]!.text } satisfies ContentBlock,
      ...blocks.slice(1),
    ];
  }
  return [{ type: 'text', text: prefix } satisfies ContentBlock, ...blocks];
}
