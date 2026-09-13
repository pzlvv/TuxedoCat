/**
 * Bash 工具验证逻辑
 */

import type { BashToolInput } from './Types.js';
import type { ValidationResult } from '../Tool.js';
import { splitBySeparators } from './TimeoutPolicy.js';

/**
 * 只读命令列表
 *
 * 只读定义：只读取系统状态/文件/进程信息，不修改任何状态、文件、配置，
 * 不发送网络请求，不写入任何持久化数据。
 *
 * 注意：复合命令（如 cmd1 && cmd2）需要所有子命令均为只读才放行。
 */
export const READONLY_COMMANDS = new Set([
  // --- 文件查看 ---
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'file',
  'tree',
  'du',
  'ls',
  'find',
  'grep',
  'which',
  'whereis',
  'locate',
  'type',
  'command',
  'getconf',
  // --- 文本处理（只读） ---
  'sort',
  'uniq',
  'cut',
  'paste',
  'join',
  'tr',
  'column',
  'nl',
  'awk',
  // --- 输出（低风险） ---
  'echo',
  'printf',
  // --- 路径工具 ---
  'basename',
  'dirname',
  'realpath',
  'readlink',
  // --- 数据处理（只读） ---
  'jq',
  'yq',
  // --- 校验和（只读） ---
  'sha256sum',
  'sha1sum',
  'md5sum',
  'cksum',
  'sum',
  // --- 比较（只读） ---
  'diff',
  'cmp',
  'comm',
  // --- 压缩文件查看（只读） ---
  'zcat',
  'zgrep',
  'zless',
  'bzcat',
  'xzcat',
  'zipinfo',
  // --- 文本生成/格式化（只读） ---
  'seq',
  'shuf',
  'fold',
  'fmt',
  'expand',
  'unexpand',
  // --- 二进制查看（只读） ---
  'od',
  'xxd',
  'hexdump',
  'strings',
  // --- 目录导航 ---
  'cd',
  'pwd',
  // --- 进程/系统状态 ---
  'ps',
  'jobs',
  'uptime',
  'dmesg',
  'df',
  'free',
  'uname',
  'hostname',
  'id',
  'whoami',
  'printenv',
  'env',
  'alias',
  'last',
  'history',
  'date',
  // --- 设备调试 ---
  'hdc',
  // --- 低风险写入操作
  'mkdir',
]);

/**
 * 只读多词命令列表
 * 对于像 `git status`、`git diff HEAD` 这样的命令，第一个单词 `git` 本身不足以判断，
 * 需要通过 `git` 加后续子命令的组合来判定。
 *
 * 注意：`git` 不在 READONLY_COMMANDS 中，因为 git add/commit/push/reset 等是写入操作。
 * 所有只读 git 子命令必须在此白名单中显式列出，否则视为非只读。
 *
 * 判断逻辑（见 _extractCommandPair）：
 * - 取命令的前两个词（cmd + arg1，如果有的话）
 * - 先在 multiWordReadonlyPairs 中精确匹配
 * - 如果匹配不到，再回退到 READONLY_COMMANDS 判断单个 cmd
 */
export const MULTI_WORD_READONLY_PAIRS = new Set([
  // --- Git 只读子命令 ---
  'git status',
  'git diff',
  'git log',
  'git show',
  'git branch',
  'git ls-remote',
  'git ls-files',
  'git ls-tree',
  'git rev-parse',
  'git rev-list',
  'git describe',
  'git for-each-ref',
  'git stash list',
  'git stash show',
  'git remote',
  'git config',
  'git submodule',
  'git grep',
  'git blame',
  'git shortlog',
  'git count-objects',
]);

/**
 * 破坏性命令列表
 * 注意：cp、mv 不属于破坏性命令（风险模式下无需确认）
 */
export const DESTRUCTIVE_COMMANDS = new Set([
  'dd',
  'mkfs',
  'format',
  'fdisk',
  'shred',
  'wipe',
]);

/**
 * 检查是否为只读命令
 * 支持复合命令（按 ; && || | 分割），所有子命令均为只读时才返回 true
 */
export function isReadOnly(input: BashToolInput): boolean {
  return _allCommandsReadOnly(input.command);
}

/**
 * 检查是否为破坏性命令（仅检查第一个命令）
 */
export function isDestructive(input: BashToolInput): boolean {
  const firstCommand = _extractFirstCommand(input.command);
  return DESTRUCTIVE_COMMANDS.has(firstCommand);
}

/**
 * 检查是否可以并发执行
 */
export function isConcurrencySafe(input: BashToolInput): boolean {
  return isReadOnly(input);
}

/**
 * 提取命令字符串中的第一个命令名
 */
function _extractFirstCommand(command: string): string {
  const segments = splitBySeparators(command);
  if (segments.length === 0) {
    return '';
  }
  return segments[0].split(/\s+/)[0];
}

/**
 * 提取命令的前两个词（cmd 和第一个参数），用于多词命令匹配。
 * 例如 "git status --short" => "git status"，"git diff HEAD~1" => "git diff"。
 * 如果只有一个词，返回单此；如果多于一个词，只保留前两个。
 */
function _extractCommandPair(segment: string): string {
  const parts = segment.split(/\s+/);
  if (parts.length === 1) {
    return parts[0];
  }
  return parts[0] + ' ' + parts[1];
}

/**
 * 检查命令中的所有子命令是否均为只读命令
 */
function _allCommandsReadOnly(command: string): boolean {
  const segments = splitBySeparators(command);

  if (segments.length === 0) {
    return false;
  }

  for (const segment of segments) {
    // 优先匹配多词命令对（如 "git status"）
    const pair = _extractCommandPair(segment);
    if (MULTI_WORD_READONLY_PAIRS.has(pair)) {
      continue; // 该段是只读的多词命令
    }
    // 回退到单命令匹配
    const cmd = segment.split(/\s+/)[0];
    if (!cmd || !READONLY_COMMANDS.has(cmd)) {
      return false;
    }
  }

  return true;
}

/**
 * 验证输入
 */
export async function validateInput(input: BashToolInput): Promise<ValidationResult> {
  if (!input.command || input.command.trim().length === 0) {
    return {
      result: false,
      message: 'Command cannot be empty',
      errorCode: 400,
    };
  }

  // 检查命令长度（防止过长的命令）
  if (input.command.length > 10000) {
    return {
      result: false,
      message: 'Command is too long (max 10000 characters)',
      errorCode: 413,
    };
  }

  // TODO: 添加更多验证
  // - 检测危险的管道命令
  // - 验证路径是否存在

  return { result: true };
}
