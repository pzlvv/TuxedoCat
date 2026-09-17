/**
 * 内置 Skill 注册与管理
 *
 * 提供 registerBundledSkill() 用于注册编译时内置的 Skill，
 * 以及 getBundledSkills() 获取所有已注册的内置 Skill。
 *
 * 内置 Skill 不依赖文件系统，直接通过代码注册。
 * 支持可选的参考文件（files），首次调用时自动提取到磁盘。
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { constants as fsConstants } from 'fs';
import { dirname } from 'path';
import type { BundledSkillDefinition, ContentBlock, SkillCommand } from './Types.js';
import { logger } from '../Logger.js';
import { CONFIG_DIR_NAME } from '../../config/project.js';
import { getCommitSkillDefinition } from './bundled/commit.js';
import { getSpinCommandDefinition } from './bundled/spin.js';
import { registerBuiltinCommand, checkSkillConflict } from './builtinCommands.js';

/** 内部注册表 */
const bundledSkills: SkillCommand[] = [];

/**
 * 注册一个内置 Skill
 *
 * Bundled skills are compiled into the extension bundle and available to all users.
 *
 * @param definition Skill 定义
 */
export function registerBundledSkill(definition: BundledSkillDefinition): void {
  // 检查是否与内置命令冲突
  if (checkSkillConflict(definition.name, definition.aliases)) {
    logger.warn(
      'bundledSkills',
      `Skill "${definition.name}" will be IGNORED due to conflict with built-in command.`,
    );
    return;
  }

  const { files } = definition;

  let skillRoot: string | undefined;
  let getPromptForCommand = definition.getPromptForCommand;

  // 如果有参考文件，需要提取到磁盘
  if (files && Object.keys(files).length > 0) {
    skillRoot = getBundledSkillExtractDir(definition.name);

    // 首次调用时提取文件
    let extractionPromise: Promise<string | null> | undefined;
    const inner = definition.getPromptForCommand;
    getPromptForCommand = async (args: string) => {
      extractionPromise ??= extractBundledSkillFiles(definition.name, files);
      const extractedDir = await extractionPromise;
      const blocks = await inner(args);
      if (extractedDir === null) return blocks;
      return prependBaseDir(blocks, extractedDir);
    };
  }

  const command: SkillCommand = {
    type: 'prompt',
    name: definition.name,
    description: definition.description,
    aliases: definition.aliases,
    whenToUse: definition.whenToUse,
    model: definition.model,
    userInvocable: definition.userInvocable ?? true,
    source: 'bundled',
    loadedFrom: 'bundled',
    skillRoot,
    isHidden: !(definition.userInvocable ?? true),
    getPromptForCommand,
  };

  bundledSkills.push(command);
}

/**
 * 获取所有注册的内置 Skill
 * 返回副本防止外部修改
 */
export function getBundledSkills(): SkillCommand[] {
  return [...bundledSkills];
}

/**
 * 清除所有内置 Skill 注册（用于测试）
 */
export function clearBundledSkills(): void {
  bundledSkills.length = 0;
}

/**
 * 获取内置 Skill 参考文件的提取目录
 */
function getBundledSkillExtractDir(skillName: string): string {
  // 使用 ~/<CONFIG_DIR_NAME>/.skills/ 作为提取根目录
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const extractRoot = path.join(homeDir, CONFIG_DIR_NAME, '.skills');
  return path.join(extractRoot, skillName);
}

/**
 * 提取内置 Skill 的参考文件到磁盘
 * 首次调用时执行，方便模型通过 Read/Grep 读取
 */
async function extractBundledSkillFiles(
  skillName: string,
  files: Record<string, string>,
): Promise<string | null> {
  const dir = getBundledSkillExtractDir(skillName);
  try {
    await writeSkillFiles(dir, files);
    return dir;
  } catch (e) {
    logger.warn(
      'bundledSkills',
      `Failed to extract bundled skill '${skillName}' to ${dir}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

async function writeSkillFiles(
  dir: string,
  files: Record<string, string>,
): Promise<void> {
  // 按父目录分组，每个目录 mkdir 一次
  const byParent = new Map<string, Array<[string, string]>>();
  for (const [relPath, content] of Object.entries(files)) {
    const target = resolveSkillFilePath(dir, relPath);
    const parent = dirname(target);
    const entry: [string, string] = [target, content];
    const group = byParent.get(parent);
    if (group) group.push(entry);
    else byParent.set(parent, [entry]);
  }

  await Promise.all(
    [...byParent].map(async ([parent, entries]) => {
      await fs.mkdir(parent, { recursive: true, mode: 0o700 });
      await Promise.all(entries.map(([p, c]) => safeWriteFile(p, c)));
    }),
  );
}

/**
 * 安全写入文件
 * 使用 O_EXCL|O_NOFOLLOW 防止符号链接攻击
 */
async function safeWriteFile(filePath: string, content: string): Promise<void> {
  const flags =
    process.platform === 'win32'
      ? 'wx'
      : fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0);

  const fh = await fs.open(filePath, flags as number | string, 0o600);
  try {
    await fh.writeFile(content, 'utf8');
  } finally {
    await fh.close();
  }
}

/**
 * 规范化并验证 Skill 相对路径
 * 防止路径遍历攻击（..)
 */
function resolveSkillFilePath(baseDir: string, relPath: string): string {
  const normalized = path.normalize(relPath);
  if (
    path.isAbsolute(normalized) ||
    normalized.split(path.sep).includes('..') ||
    normalized.split('/').includes('..')
  ) {
    throw new Error(`Bundled skill file path escapes skill dir: ${relPath}`);
  }
  return path.join(baseDir, normalized);
}

/**
 * 在 Prompt 内容前插入 Base directory 提示
 */
function prependBaseDir(
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

// 在模块加载时自动注册所有内置 Skill
(function initBuiltinSkills(): void {
  // 注册内置命令（优先于 Skill）
  registerBuiltinCommand(getSpinCommandDefinition());

  // 注册内置 Skill（与内置命令冲突的 Skill 会被跳过，并记录 WARNING）
  registerBundledSkill(getCommitSkillDefinition());
})();
