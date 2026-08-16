/**
 * SKILL.md Frontmatter 解析器
 *
 * 解析 SKILL.md 文件中的 YAML frontmatter 头，
 * 提取 description、when_to_use、model、arguments 等元信息。
 */

import type { ParsedSkillFrontmatter } from './Types.js';

/**
 * 简单的 YAML frontmatter 解析器
 * 支持 SKILL.md 中常用的键值对，无需额外依赖
 *
 * 支持的 frontmatter 字段：
 * ---
 * description: 技能描述
 * when_to_use: 何时使用
 * model: claude-sonnet-4-20250514
 * arguments: [file-path]
 * user-invocable: true
 * version: 1.0.0
 * paths: [src/**\/*.ts]
 * ---
 *
 * @param content SKILL.md 文件内容
 * @returns 解析后的 frontmatter 数据和正文内容
 */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>
  content: string
} {
  // 检查是否以 --- 开头
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) {
    return { frontmatter: {}, content: trimmed };
  }

  // 找到第二个 ---
  const endIndex = trimmed.indexOf('---', 3);
  if (endIndex === -1) {
    return { frontmatter: {}, content: trimmed };
  }

  const frontmatterStr = trimmed.slice(3, endIndex).trim();
  const body = trimmed.slice(endIndex + 3).trimStart();

  return {
    frontmatter: parseYamlLines(frontmatterStr),
    content: body,
  };
}

/**
 * 解析简单的 YAML 键值对
 * 仅支持 SKILL.md 中使用的子集：标量值、数组、多行字符串
 */
function parseYamlLines(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');

  let currentKey: string | null = null;
  let currentArray: string[] | null = null;
  let inMultiline = false;
  let multilineKey: string | null = null;
  let multilineLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    // 多行字符串续行（以 | 或 > 开始的缩进行）
    if (inMultiline && multilineKey) {
      if (line.startsWith(' ') || line === '') {
        multilineLines.push(line);
        continue;
      } else {
        // 多行结束，保存
        result[multilineKey] = multilineLines.join('\n').trim();
        multilineKey = null;
        multilineLines = [];
        inMultiline = false;
      }
    }

    // 数组项
    if (currentKey && line.trimStart().startsWith('- ')) {
      currentArray!.push(line.trimStart().slice(2).trim());
      continue;
    }

    // 结束当前数组
    if (currentKey && currentArray) {
      result[currentKey] = currentArray;
      currentKey = null;
      currentArray = null;
    }

    // 跳过空行和注释
    const trimmedLine = line.trim();
    if (trimmedLine === '' || trimmedLine.startsWith('#')) {
      continue;
    }

    // 解析 key: value
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    if (!key) continue;

    // 多行标记 |
    if (value === '|') {
      inMultiline = true;
      multilineKey = key;
      continue;
    }

    // 数组标记
    if (value === '') {
      currentKey = key;
      currentArray = [];
      continue;
    }

    // 解析值
    result[key] = parseYamlValue(value);
  }

  // 清理
  if (currentKey && currentArray) {
    result[currentKey] = currentArray;
  }
  if (inMultiline && multilineKey) {
    result[multilineKey] = multilineLines.join('\n').trim();
  }

  return result;
}

/** 解析 YAML 标量值 */
function parseYamlValue(value: string): unknown {
  // 引号字符串
  if ((value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1);
  }

  // 布尔值
  if (value === 'true') return true;
  if (value === 'false') return false;

  // 数字
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return value.includes('.') ? parseFloat(value) : parseInt(value, 10);
  }

  // 空值
  if (value === '~' || value === 'null') return null;

  return value;
}

/**
 * 从 SKILL.md 内容中提取纯文本描述
 * 取第一段非空文本作为 fallback 描述
 */
export function extractDescriptionFromMarkdown(
  markdown: string,
  label: 'Skill' | 'Custom command' = 'Skill',
): string {
  // 移除 frontmatter
  const { content } = parseFrontmatter(markdown);

  // 查找第一段有意义的非空文本
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // 跳过标题、空行、代码块、列表标记
    if (
      trimmed &&
      !trimmed.startsWith('#') &&
      !trimmed.startsWith('```') &&
      !trimmed.startsWith('-') &&
      !trimmed.startsWith('>')
    ) {
      // 取前 150 个字符作为描述
      return trimmed.length > 150
        ? trimmed.slice(0, 147) + '...'
        : trimmed;
    }
  }

  return `${label}: ${content.slice(0, 80)}...`;
}

/**
 * 解析 frontmatter 中的 paths 字段
 * 返回路径模式列表，如果所有模式都是 **（匹配全部）则返回 undefined
 */
export function parseSkillPaths(pathsValue: unknown): string[] | undefined {
  if (!Array.isArray(pathsValue) || pathsValue.length === 0) {
    return undefined;
  }

  const patterns = pathsValue
    .map(p => String(p).replace(/\*\*$/, '')) // 去除尾部 /**
    .filter(p => p.length > 0);

  if (patterns.length === 0 || patterns.every(p => p === '**' || p === '*')) {
    return undefined;
  }

  return patterns;
}

/**
 * 解析 frontmatter 中的 arguments 字段
 * 支持字符串或字符串数组格式
 */
export function parseArgumentNames(
  args: string | string[] | undefined,
): string[] {
  if (!args) return [];
  if (Array.isArray(args)) return args;
  return [args];
}

/**
 * 解析布尔类型的 frontmatter 字段
 */
export function parseBooleanFrontmatter(value: unknown): boolean {
  if (value === true || value === 'true' || value === 'yes') return true;
  if (value === false || value === 'false' || value === 'no') return false;
  return true; // 默认为 true
}

/**
 * 确保 description 为字符串
 */
export function coerceDescriptionToString(
  description: unknown,
  _name: string,
): string | null {
  if (typeof description === 'string' && description.trim().length > 0) {
    return description.trim();
  }
  return null;
}

/**
 * 解析 SKILL.md 的所有 frontmatter 字段
 */
export function parseSkillFrontmatterFields(
  frontmatter: Record<string, unknown>,
  markdownContent: string,
  skillName: string,
  descriptionFallbackLabel: 'Skill' | 'Custom command' = 'Skill',
): ParsedSkillFrontmatter {
  const validatedDescription = coerceDescriptionToString(
    frontmatter.description,
    skillName,
  );
  const description =
    validatedDescription ??
    extractDescriptionFromMarkdown(markdownContent, descriptionFallbackLabel);

  const userInvocable =
    frontmatter['user-invocable'] === undefined
      ? true
      : parseBooleanFrontmatter(frontmatter['user-invocable']);

  const model =
    frontmatter.model === 'inherit'
      ? undefined
      : typeof frontmatter.model === 'string'
        ? frontmatter.model
        : undefined;

  return {
    displayName:
      frontmatter.name != null ? String(frontmatter.name) : undefined,
    description,
    hasUserSpecifiedDescription: validatedDescription !== null,
    argumentNames: parseArgumentNames(
      frontmatter.arguments as string | string[] | undefined,
    ),
    whenToUse: frontmatter.when_to_use as string | undefined,
    version: frontmatter.version as string | undefined,
    model,
    userInvocable,
    paths: parseSkillPaths(frontmatter.paths),
  };
}
