/**
 * 配置目录管理
 */

import { join } from 'path';
import * as fs from 'fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { logger } from '../Logger.js';
import { resolveConfigDir } from '../../config/configDir.js';

/**
 * 项目清单文件名（`docs/architecture/core-ui-separation.md` 第 4.1 节）。
 *
 * 位于 `<conversations>/<project>/` 下，记录该编码目录对应的完整 workspacePath，
 * 便于从 conversations 下的子目录反查原始项目路径。读写都归 Core。
 */
export const WORKSPACE_META_FILE = 'workspace.meta.json';

/**
 * 获取配置目录（CONFIG_DIR_NAME）。
 *
 * 家目录口径统一在 `config/configDir.ts`（与宿主 `SettingsStore` / Core 侧一致）。
 */
export function getConfigHomeDir(): string {
  return resolveConfigDir();
}

/**
 * 获取对话目录路径（根目录）
 */
export function getConversationDir(): string {
  return join(getConfigHomeDir(), 'conversations');
}

/**
 * Windows 下同一目录的分隔符两种写法（`D:\a\b` 与 `D:/a\b`）会各自编码成不同的
 * 对话空间目录，同一项目裂成两条统计。统一成反斜杠（与资源管理器一致）后再编码；
 * 非 Windows 平台分隔符就是 `/`，原样保留（远程 Linux core 的路径不动）。
 *
 * `posix: true` 用于**远程工作区路径**：路径属于远端机器，按远端 POSIX 语义恒等
 * 归一（与 `electron/sidebarFiles.ts` `resolveWithinRoot` 的 `posix` 选项同一约定）
 * ——宿主是 Windows 时也不能把远端 `/srv/app` 归一成 `\srv\app`。
 */
function normalizeWorkspacePath(projectPath: string, posix = false): string {
  return process.platform === 'win32' && !posix ? projectPath.replace(/\//g, '\\') : projectPath;
}

/** 超长路径的哈希形态目录名：SHA256 前 16 位 + 末级路径编码前 32 字符 */
function encodeHashedProjectDir(projectPath: string): string {
  const hash = createHash('sha256').update(projectPath).digest('hex').substring(0, 16);
  const normalizedPath = projectPath.replace(/[\\/]+$/, '');
  const lastSegment = normalizedPath.split(/[\\/]/).pop() || '';
  const encodedLast = encodeURIComponent(lastSegment).substring(0, 32);
  return `${hash}_${encodedLast}`;
}

/**
 * 项目对话目录的编码候选（纯函数、不读盘）：归一形态优先，分隔符历史写法次之，
 * 全部超长（>255）时收敛为单个哈希形态。
 *
 * 本地（`getProjectConversationDir` 的 existsSync 探测）与远程（SFTP stat 探测，
 * specs/030 宿主读 `workspace.meta.json`）共用同一份候选顺序。
 */
export function projectDirCandidates(projectPath: string, options: { posix?: boolean } = {}): string[] {
  const normalized = normalizeWorkspacePath(projectPath, options.posix === true);
  const primary = normalized === projectPath ? [normalized] : [normalized, projectPath];
  const direct = primary.filter((candidate) => encodeURIComponent(candidate).length <= 255);
  if (direct.length > 0) {
    return direct.map((candidate) => encodeURIComponent(candidate));
  }
  return [encodeHashedProjectDir(normalized)];
}

/**
 * 获取特定项目的对话目录路径
 * @param projectPath - 项目路径
 * @returns 编码后的项目对话目录
 *
 * 归一形态优先；按历史写法编码的目录已存在时沿用（新旧写法解析到同一份对话数据，
 * 不再为分隔符写法的差异新建第二个空间）。
 */
export function getProjectConversationDir(projectPath: string): string {
  const candidates = projectDirCandidates(projectPath);
  for (const encoded of candidates) {
    const existing = join(getConversationDir(), encoded);
    if (existsSync(existing)) {
      return existing;
    }
  }
  // 单级目录名不能超过 255 字符（Windows NTFS 限制）：候选里有超长的都没建过目录，
  // 兜底用首个候选（projectDirCandidates 在全部超长时已收敛为哈希形态）
  return join(getConversationDir(), candidates[0]);
}

/**
 * 已确保存在项目清单的项目对话目录缓存
 * 避免每次 appendMessage 都重复读 workspace.meta.json
 */
const ensuredProjectDirs = new Set<string>();

/**
 * 确保项目对话目录存在，并写入项目清单 `workspace.meta.json`。
 *
 * 目录与清单都由 Core 创建与写入（Core 自己的会话数据）；清单记录该编码目录对应的
 * 完整 workspacePath，便于从 conversations 下的子目录反查原始项目路径。宿主不参与写盘。
 */
export async function ensureProjectConversationDir(projectPath: string): Promise<string> {
  const projectDir = getProjectConversationDir(projectPath);
  if (ensuredProjectDirs.has(projectDir)) {
    return projectDir;
  }
  await fs.mkdir(projectDir, { recursive: true });
  await writeWorkspaceMeta(projectDir, projectPath);
  ensuredProjectDirs.add(projectDir);
  return projectDir;
}

/**
 * ensureProjectConversationDir 的同步版本，供同步创建会话文件/UI 路径使用
 */
export function ensureProjectConversationDirSync(projectPath: string): string {
  const projectDir = getProjectConversationDir(projectPath);
  if (!ensuredProjectDirs.has(projectDir)) {
    mkdirSync(projectDir, { recursive: true });
    writeWorkspaceMetaSync(projectDir, projectPath);
    ensuredProjectDirs.add(projectDir);
  }
  return projectDir;
}

/** 写项目清单（幂等：workspacePath 未变化时不重复写盘） */
async function writeWorkspaceMeta(projectDir: string, workspacePath: string): Promise<void> {
  const metaPath = join(projectDir, WORKSPACE_META_FILE);
  let meta: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      meta = parsed as Record<string, unknown>;
      if (meta.workspacePath === workspacePath) {
        return;
      }
    }
  } catch {
    // 文件不存在或解析失败，按空对象重建
  }
  meta.workspacePath = workspacePath;
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/** 写项目清单的同步版本（幂等） */
function writeWorkspaceMetaSync(projectDir: string, workspacePath: string): void {
  const metaPath = join(projectDir, WORKSPACE_META_FILE);
  let meta: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      meta = parsed as Record<string, unknown>;
      if (meta.workspacePath === workspacePath) {
        return;
      }
    }
  } catch {
    // 文件不存在或解析失败，按空对象重建
  }
  meta.workspacePath = workspacePath;
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/**
 * 将目录名解码为原始项目路径；仅当目录名是完整的 encodeURIComponent 结果时返回。
 * 超长路径的哈希目录名无法反解，返回 null。
 */
function decodeProjectDirName(dirName: string): string | null {
  try {
    const decoded = decodeURIComponent(dirName);
    return encodeURIComponent(decoded) === dirName ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * 为 conversations 下已存在的项目目录补写项目清单（Core 自己写）
 */
async function backfillProjectSettings(): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(getConversationDir(), { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const workspacePath = decodeProjectDirName(entry.name);
        if (!workspacePath) return;
        try {
          await ensureProjectConversationDir(workspacePath);
        } catch (error) {
          logger.error('Config', `Failed to write workspace meta for ${entry.name}: ${error}`);
        }
      })
  );
}

/**
 * 确保配置目录存在
 */
export async function ensureConfigDirs(): Promise<void> {
  const configDir = getConfigHomeDir();
  const conversationDir = getConversationDir();

  try {
    // 两个目录并行创建，避免串行 I/O 等待
    await Promise.all([
      fs.mkdir(configDir, { recursive: true }),
      fs.mkdir(conversationDir, { recursive: true }),
    ]);
  } catch (error) {
    console.error('[Config] Failed to create config directories:', error);
    throw error;
  }

  // 为已存在的旧项目目录补上报一次（目录清单 settings.json 由宿主写）
  await backfillProjectSettings();
}

/**
 * 会话工作目录表（sessionId → 工作目录绝对路径）。
 *
 * 工作目录是对话的属性：同一进程内可同时存在归属不同工作目录的对话
 * （Electron 多标签）。core 按 sessionId 查表解析目录，不存在「活动工作目录」
 * 这类进程级概念——「哪个对话在前台」是 UI 自己的状态。
 *
 * 登记时机：会话首次被 core 解析目录之前（宿主在新建 / 加载对话时登记），
 * 或 core 读到落盘元数据后按 `project` 校正（loadConversation）；
 * 子对话继承父对话的工作目录。
 */
const sessionWorkspaces = new Map<string, string>();

/** 登记会话的工作目录（新建 / 加载对话、子对话继承父对话时调用） */
export function setSessionWorkspace(sessionId: string, workspacePath: string): void {
  if (typeof sessionId !== 'string' || !sessionId) return;
  if (typeof workspacePath !== 'string' || !workspacePath) return;
  sessionWorkspaces.set(sessionId, workspacePath);
}

/** 注销会话的工作目录（会话被回收 / 删除时调用） */
export function clearSessionWorkspace(sessionId: string): void {
  sessionWorkspaces.delete(sessionId);
}

/** 清空会话工作目录表（进程级资源释放） */
export function clearAllSessionWorkspaces(): void {
  sessionWorkspaces.clear();
}

/** 读取会话的工作目录（未登记时返回 undefined） */
export function getSessionWorkspace(sessionId: string | null | undefined): string | undefined {
  if (!sessionId) return undefined;
  return sessionWorkspaces.get(sessionId);
}

/**
 * 该会话是否已有可用的项目根目录。
 *
 * 与 getProjectRoot() 的区别：只判断、不取值也不抛错，
 * 供「没有工作目录时降级」的调用点做前置守卫：
 *
 *   if (!hasProjectRoot(sessionId)) return [];
 *   const root = getProjectRoot(sessionId);
 */
export function hasProjectRoot(sessionId?: string | null): boolean {
  return !!getSessionWorkspace(sessionId);
}

/**
 * 获取会话的项目根目录（绝对路径）。
 *
 * 目录是会话的属性，只从会话工作目录表取；未登记时抛错，让「会话缺工作目录」
 * 这类接线问题在调用点显式暴露，而不是静默拿到一个错误路径。
 * 需要降级处理的调用点，先用 hasProjectRoot(sessionId) 守卫。
 */
export function getProjectRoot(sessionId?: string | null): string {
  const scoped = getSessionWorkspace(sessionId);
  if (scoped) {
    return scoped;
  }
  throw new Error(
    `Project root is not configured for session ${sessionId ?? '(none)'}. ` +
    'The session workspace is registered by the host before core resolves a ' +
    'session directory (see setSessionWorkspace).'
  );
}

/**
 * 扩展 / 应用根目录（ripgrep 等资源的定位基准）。
 *
 * 由 `UiEvent.hostEnvironmentProvided` 写入；未收到事件前为 undefined。
 */
let extensionPath: string | undefined;

/**
 * 记录扩展 / 应用根目录。
 *
 * 唯一写入入口是 `initializeCoreEvents` 的 `hostEnvironmentProvided` 订阅。
 */
export function setExtensionPath(path: string): void {
  extensionPath = typeof path === 'string' && path ? path : undefined;
}

/** 扩展路径是否已上报（启动自检用；不看当前值是否非空） */
export function hasExtensionPath(): boolean {
  return !!extensionPath;
}

/**
 * 获取扩展安装路径
 * 未收到 `UiEvent.hostEnvironmentProvided` 时抛错
 */
export function getExtensionPath(): string {
  if (extensionPath) {
    return extensionPath;
  }
  throw new Error(
    'Extension path is not configured. ' +
    'It is written by UiEvent.hostEnvironmentProvided; ' +
    'getExtensionPath() is called before that event arrived.'
  );
}
