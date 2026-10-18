/**
 * 文件系统 Skill 加载器
 *
 * 负责从文件系统的 <CONFIG_DIR_NAME>/skills/ 目录中扫描和加载 SKILL.md 文件。
 *
 * 目录结构要求：
 *   <CONFIG_DIR_NAME>/skills/<skill-name>/SKILL.md
 *
 * 加载优先级（高到低）：
 *   managed (<CONFIG_DIR_NAME>/skills/) -> 策略管理
 *   user (~/<CONFIG_DIR_NAME>/skills/) -> 用户全局
 *   project (./<CONFIG_DIR_NAME>/skills/) -> 项目级
 *   bundled -> 编译内置
 */

import { readdir, readFile, realpath } from 'fs/promises';
import { join } from 'path';
import type { SkillCommand, SkillSource, LoadedFrom, ContentBlock } from './Types.js';
import { getBundledSkills } from './bundledSkills.js';
import { parseFrontmatter, parseSkillFrontmatterFields, parseSkillPaths } from './frontmatterParser.js';
import { substituteArguments, substituteBuiltinVariables } from './variableResolver.js';
import { logger } from '../Logger.js';
import { CONFIG_DIR_NAME } from '../../config/project.js';
import { resolveConfigDir } from '../../config/configDir.js';

/** 内部类型：Skill 与文件路径的关联 */
interface SkillWithPath {
  skill: SkillCommand
  filePath: string
}

/**
 * 从文件系统加载所有 Skill
 * 按优先级合并：managed -> user -> project
 *
 * @param cwd 当前工作目录
 * @returns 去重后的 Skill 列表
 */
export async function getSkillDirCommands(cwd: string): Promise<SkillCommand[]> {
  // user 目录走统一口径（`config/configDir.ts`）；project 目录相对 cwd
  const userSkillsDir = join(resolveConfigDir(), 'skills');
  const projectSkillsDir = join(cwd, CONFIG_DIR_NAME, 'skills');

  // 同时从 user 和 project 目录加载
  const [userSkills, projectSkills] = await Promise.all([
    loadSkillsFromSkillsDir(userSkillsDir, 'user'),
    loadSkillsFromSkillsDir(projectSkillsDir, 'project'),
  ]);

  // 合并：user 在前（低优先级），project 在后（高优先级）
  const allSkillsWithPaths = [...userSkills, ...projectSkills];

  // 通过 realpath 去重
  const fileIds = await Promise.all(
    allSkillsWithPaths.map(({ filePath }) => getFileIdentity(filePath)),
  );

  const seenFileIds = new Map<string, SkillSource>();
  const deduplicated: SkillCommand[] = [];

  for (let i = 0; i < allSkillsWithPaths.length; i++) {
    const entry = allSkillsWithPaths[i];
    if (!entry) continue;

    const fileId = fileIds[i];
    if (fileId === null || fileId === undefined) {
      deduplicated.push(entry.skill);
      continue;
    }

    const existingSource = seenFileIds.get(fileId);
    if (existingSource !== undefined) {
      logger.debug(
        'skills',
        `Skipping duplicate skill '${entry.skill.name}' (already loaded from ${existingSource})`,
      );
      continue;
    }

    seenFileIds.set(fileId, entry.skill.source);
    deduplicated.push(entry.skill);
  }

  return deduplicated;
}

/**
 * 获取全部可用 Skill（内置 + 文件系统）
 */
export async function getAllSkills(cwd: string): Promise<SkillCommand[]> {
  const [bundled, fileSkills] = await Promise.all([
    Promise.resolve(getBundledSkills()),
    getSkillDirCommands(cwd),
  ]);
  return [...bundled, ...fileSkills];
}

/**
 * 从指定的 basePath 目录加载 Skill
 * 只支持目录格式：skill-name/SKILL.md
 *
 * @param basePath <CONFIG_DIR_NAME>/skills/ 目录路径
 * @param source 来源类型
 * @returns Skill 列表（含文件路径）
 */
async function loadSkillsFromSkillsDir(
  basePath: string,
  source: SkillSource,
): Promise<SkillWithPath[]> {
  let entries;
  try {
    entries = await readdir(basePath, { withFileTypes: true });
  } catch {
    // 目录不存在或不可访问，跳过
    return [];
  }

  const results = await Promise.all(
    entries.map(async (entry): Promise<SkillWithPath | null> => {
      try {
        // 只支持目录格式
        if (!entry.isDirectory() && !entry.isSymbolicLink()) {
          return null;
        }

        const skillDirPath = join(basePath, entry.name);
        const skillFilePath = join(skillDirPath, 'SKILL.md');

        let content: string;
        try {
          content = await readFile(skillFilePath, { encoding: 'utf-8' });
        } catch {
          // SKILL.md 不存在，跳过
          return null;
        }

        const { frontmatter, content: markdownContent } = parseFrontmatter(content);

        const skillName = entry.name;
        const parsed = parseSkillFrontmatterFields(frontmatter, markdownContent, skillName);
        const paths = parseSkillPaths(frontmatter.paths);

        return {
          skill: createSkillCommand({
            ...parsed,
            skillName,
            markdownContent,
            source,
            baseDir: skillDirPath,
            loadedFrom: 'skills',
            paths,
          }),
          filePath: skillFilePath,
        };
      } catch (error) {
        logger.error('skills', `Failed to load skill from ${entry.name}:`, error);
        return null;
      }
    }),
  );

  return results.filter((r): r is SkillWithPath => r !== null);
}

/**
 * 创建一个 SkillCommand 对象
 */
export function createSkillCommand(params: {
  skillName: string
  description: string
  markdownContent: string
  argumentNames: string[]
  whenToUse: string | undefined
  version: string | undefined
  model: string | undefined
  userInvocable: boolean
  source: SkillSource
  baseDir: string | undefined
  loadedFrom: LoadedFrom
  paths: string[] | undefined
}): SkillCommand {
  const {
    skillName,
    description,
    markdownContent,
    argumentNames,
    whenToUse,
    version,
    model,
    userInvocable,
    source,
    baseDir,
    loadedFrom,
  } = params;

  return {
    type: 'prompt',
    name: skillName,
    description,
    argNames: argumentNames.length > 0 ? argumentNames : undefined,
    whenToUse,
    version,
    model,
    userInvocable,
    source,
    loadedFrom,
    skillRoot: baseDir,
    isHidden: !userInvocable,
    async getPromptForCommand(args: string): Promise<ContentBlock[]> {
      let finalContent = baseDir
        ? `Base directory for this skill: ${baseDir}\n\n${markdownContent}`
        : markdownContent;

      // 替换位置参数和命名参数
      finalContent = substituteArguments(finalContent, args, argumentNames);

      // 替换内置变量
      finalContent = substituteBuiltinVariables(
        finalContent,
        baseDir,
        undefined, // sessionId 由 ToolUseContext 提供，不在这一层
      );

      return [{ type: 'text', text: finalContent }];
    },
  };
}

/**
 * 获取文件的唯一标识（通过 realpath 解析符号链接）
 */
async function getFileIdentity(filePath: string): Promise<string | null> {
  try {
    return await realpath(filePath);
  } catch {
    return null;
  }
}
