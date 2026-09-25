/**
 * 系统环境信息获取
 * 获取 OS、Git、Shell 等系统级动态信息
 *
 * 设计原则：
 * - 不依赖 cwd 的部分在模块加载时后台启动预加载
 * - 依赖 cwd 的部分（Git 信息）在调用时实时获取
 * - 命令检测在模块加载时后台启动一次，调用时如果还没跑完则等待
 */

import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { SystemDynamicInfo } from './SystemPrompt.js';
import { findSuitableShell } from '../tools/bash/ShellDetector.js';
import { getBundledSkills } from '../skills/bundledSkills.js';
import { getSkillDirCommands } from '../skills/loadSkillsDir.js';
import { formatSkillListing } from '../tools/skill/Prompt.js';
import { logger } from '../Logger.js';

const execAsync = promisify(exec);

/** 后台运行的命令检测 Promise（模块加载时启动，后续 await 即可） */
const availableCommandsPromise: Promise<string[] | undefined> = detectAvailableCommandsStart();

/**
 * 模块级缓存：**按工作目录**缓存预热后的系统动态信息。
 *
 * 必须按 cwd 分桶：多工作目录宿主（Electron）里同时存在归属不同目录的会话，
 * 每个会话的 system prompt 都要读自己目录的 git 信息 / 技能清单。此前用单个
 * 全局缓存，只要预热过活动目录，其它目录的会话就会命中活动目录的结果（串目录）。
 *
 * 由 warmupSystemDynamicInfo 在扩展激活 / 工作区切换时预热活动目录；
 * getSystemDynamicInfo 命中同 cwd 的条目才复用，否则现算并写入。
 */
const cachedSystemDynamicInfo = new Map<string, SystemDynamicInfo>();
/** 缓存条目上限：打开过的工作目录数量有限，超出后按插入顺序淘汰最旧的 */
const SYSTEM_DYNAMIC_CACHE_MAX = 8;

/**
 * 提前预热系统动态信息，将耗时前置到启动阶段。
 * 调用方（bootstrapCore 的工作区订阅）不 await，后台执行。
 *
 * 预热是**刷新**语义：先丢弃该 cwd 的旧条目再重算，因此切回一个已打开过的
 * 工作目录时，git 信息 / 技能清单都是当前的。
 */
export async function warmupSystemDynamicInfo(cwd: string): Promise<void> {
  try {
    cachedSystemDynamicInfo.delete(cwd);
    await getSystemDynamicInfo(cwd);
  } catch {
    // 预热失败不影响主流程
  }
}

/**
 * 在模块加载时后台预加载不依赖 cwd 的系统静态信息
 * 这样 getSystemDynamicInfo 被调用时可以快速拿到这部分数据
 */
interface PreloadedStaticInfo {
  platform: string;
  osType: string;
  osRelease: string;
  shell: string;
  shellName: string | undefined;
  availableCommands: string[] | undefined;
}
const preloadedStaticInfoPromise: Promise<PreloadedStaticInfo> = preloadStaticInfo();

/**
 * 在模块加载时后台启动预加载不依赖 cwd 的系统静态信息
 */
async function preloadStaticInfo(): Promise<PreloadedStaticInfo> {
  try {
    // availableCommandsPromise 不阻塞预加载，单独获取
    const [shellName] = await Promise.all([
      getShellName(),
      // 注意：availableCommands 不在此处 await，避免阻塞 getSystemDynamicInfo
      // 改为在 getSystemDynamicInfo 中非阻塞地获取
    ]);

    return {
      platform: os.platform(),
      osType: os.type(),
      osRelease: os.release(),
      shell: getShellInfo(),
      shellName,
      availableCommands: undefined, // 由 getSystemDynamicInfo 单独非阻塞获取
    };
  } catch {
    // 预加载失败不影响主流程，提供 fallback 值
    return {
      platform: os.platform(),
      osType: os.type(),
      osRelease: os.release(),
      shell: getShellInfo(),
      shellName: undefined,
      availableCommands: undefined,
    };
  }
}

/**
 * 在后台获取 shell 名称（不依赖 cwd）
 */
async function getShellName(): Promise<string | undefined> {
  try {
    const shellInfo = await findSuitableShell();
    return shellInfo.name;
  } catch {
    return undefined;
  }
}

/**
 * 获取后台缓存的可用命令列表（供 AgentTool 等模块复用）
 * 如果后台检测尚未完成则等待
 */
export function getAvailableCommands(): Promise<string[] | undefined> {
  return availableCommandsPromise;
}

/**
 * 检查是否在 Git 仓库中
 */
async function getGitInfo(cwd: string): Promise<{ isGit: boolean; branch?: string }> {
  try {
    // 检查是否在 Git 仓库中
    const { stdout: gitDir } = await execAsync('git rev-parse --git-dir', {
      cwd,
      timeout: 5000,
    });

    if (!gitDir) {
      return { isGit: false };
    }

    // 获取当前分支
    const { stdout: branch } = await execAsync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      timeout: 5000,
    });

    return {
      isGit: true,
      branch: branch.trim() || undefined,
    };
  } catch {
    // 如果当前目录不是 Git 仓库或 Git 不可用，返回非 Git 环境
    return { isGit: false };
  }
}

/**
 * 获取 Shell 信息
 * 优先使用 findSuitableShell() 的检测结果，其次回退到环境变量
 */
function getShellInfo(): string {
  // 如果已有缓存的 shell 检测结果，直接使用其 type
  try {
    const { getCurrentShellType } = require('../tools/bash/ShellDetector.js');
    const type = getCurrentShellType();
    if (type) return type;
  } catch {
    // fallback to env
  }

  const shell = process.env.SHELL || process.env.ComSpec || 'unknown';

  // 简化 shell 路径显示
  if (shell.includes('/bash')) {
    return 'bash';
  } else if (shell.includes('/zsh')) {
    return 'zsh';
  } else if (shell.includes('/fish')) {
    return 'fish';
  } else if (shell.includes('cmd.exe')) {
    return 'cmd';
  } else if (shell.includes('powershell') || shell.includes('pwsh')) {
    return 'powershell';
  }

  return shell;
}

/**
 * 在后台启动命令检测（不 await，后续通过 availableCommandsPromise 获取结果）
 */
function detectAvailableCommandsStart(): Promise<string[] | undefined> {
  return (async () => {
    try {
      return await detectAvailableCommandsSync();
    } catch {
      return undefined;
    }
  })();
}

/**
 * 检测常见命令是否可用（同步执行，等待结果）
 * 使用 which/where 确认命令是否存在并可执行
 */
async function detectAvailableCommandsSync(): Promise<string[]> {
  const candidates = [
    'python3', 'python', 'node', 'npm', 'npx',
    'go', 'rustc', 'cargo',
    'java', 'javac', 'mvn', 'gradle',
    'gcc', 'g++', 'make', 'cmake',
    'php', 'ruby', 'perl',
    'dotnet', 'deno', 'bun',
    'pip', 'pip3', 'pnpm', 'yarn',
  ];

  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  const available: string[] = [];

  // 并发检测所有命令，每批 6 个以避免同时 spawn 过多进程
  const batchSize = 6;
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (cmd) => {
        try {
          await execAsync(`${whichCmd} ${cmd}`, { timeout: 3000 });
          return cmd;
        } catch {
          return null;
        }
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        available.push(result.value);
      }
    }
  }

  return available.sort();
}

/**
 * 获取系统动态环境信息
 * @param cwd 当前工作目录（由 UI 层提供）
 * @returns 系统动态信息（命中**同 cwd** 的预热缓存才复用，否则现算并写缓存）
 */
export async function getSystemDynamicInfo(cwd: string): Promise<SystemDynamicInfo> {
  // 只复用同 cwd 的缓存：不同工作目录的 git 信息 / 技能清单不同，不能跨目录命中
  const cached = cachedSystemDynamicInfo.get(cwd);
  if (cached) {
    return cached;
  }

  logger.info('SystemEnvironment', 'Collecting system dynamic info...');
  const t0 = Date.now();

  // 使用预加载的静态数据（模块加载时已在后台准备，不含 availableCommands）
  const staticInfo = await preloadedStaticInfoPromise;

  // 后台获取 availableCommands（不阻塞，如果还没完成就返回 undefined）
  const availableCommands: string[] | undefined = await Promise.race([
    availableCommandsPromise,
    new Promise<undefined>((resolve) => { setTimeout(() => resolve(undefined), 0); }),
  ]);

  // Git 信息：依赖 cwd，在缓存未命中（或预热刷新）时现算
  const gitInfo = await getGitInfo(cwd);

  // 获取可用的 Skill 列表（需要 cwd，实时获取）
  let availableSkills: string | undefined;
  try {
    const [bundled, fileSkills] = await Promise.all([
      Promise.resolve(getBundledSkills()),
      getSkillDirCommands(cwd),
    ]);
    const allSkills = [...bundled, ...fileSkills];
    const listing = formatSkillListing(allSkills);
    if (listing) {
      availableSkills = `## Available Skills

You have access to the following skills. Use the Skill tool to invoke them.

${listing}

To invoke a skill, use the Skill tool with the skill name and optional arguments.
Example: \`{ "skill": "commit", "args": "-m 'message'" }\``;
    }
  } catch {
    // fallback: 不提供 Skill 列表
  }

  const info: SystemDynamicInfo = {
    isGit: gitInfo.isGit,
    gitBranch: gitInfo.branch,
    platform: staticInfo.platform,
    osType: staticInfo.osType,
    osRelease: staticInfo.osRelease,
    shell: staticInfo.shell,
    shellName: staticInfo.shellName,
    availableCommands,
    availableSkills,
  };

  // 写入按 cwd 分桶的缓存（超出上限时淘汰最旧的条目，避免长会话里无限增长）
  if (cachedSystemDynamicInfo.size >= SYSTEM_DYNAMIC_CACHE_MAX) {
    const oldest = cachedSystemDynamicInfo.keys().next().value;
    if (oldest !== undefined) cachedSystemDynamicInfo.delete(oldest);
  }
  cachedSystemDynamicInfo.set(cwd, info);

  logger.info('SystemEnvironment', `System dynamic info collected in ${Date.now() - t0}ms`);
  return info;
}
