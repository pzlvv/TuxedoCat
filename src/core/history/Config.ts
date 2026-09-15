/**
 * 配置目录管理
 */

import { join } from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { logger } from '../Logger.js';
import { CONFIG_DIR_NAME } from '../../config/project.js';
import { DEFAULT_WAKE_SHORTCUT, normalizeAccelerator } from '../utils/shortcut.js';

/**
 * 获取配置目录（CONFIG_DIR_NAME）
 * Windows: %USERPROFILE%\<CONFIG_DIR_NAME>
 * macOS/Linux: ~/<CONFIG_DIR_NAME>
 */
export function getConfigHomeDir(): string {
  const homeDir = os.homedir();
  return join(homeDir, CONFIG_DIR_NAME);
}

/**
 * 获取对话目录路径（根目录）
 */
export function getConversationDir(): string {
  return join(getConfigHomeDir(), 'conversations');
}

/**
 * 获取特定项目的对话目录路径
 * @param projectPath - 项目路径
 * @returns 编码后的项目对话目录
 */
export function getProjectConversationDir(projectPath: string): string {
  // URL 编码项目路径（Windows 路径中的 \ 会被编码为 %5C）
  const encodedPath = encodeURIComponent(projectPath);
  // 单级目录名不能超过 255 字符（Windows NTFS 限制），超长则使用哈希
  if (encodedPath.length <= 255) {
    return join(getConversationDir(), encodedPath);
  }
  // 超长路径：SHA256 哈希前 16 位 + 路径最后一级的简短编码名称（取前 32 字符），
  // 组合后约 49 字符，远低于 255 限制
  const hash = createHash('sha256').update(projectPath).digest('hex').substring(0, 16);
  // 提取最后一级路径组件（如 "CA_TA"），便于人眼识别
  const normalizedPath = projectPath.replace(/[\\/]+$/, '');
  const lastSegment = normalizedPath.split(/[\\/]/).pop() || '';
  const encodedLast = encodeURIComponent(lastSegment).substring(0, 32);
  return join(getConversationDir(), `${hash}_${encodedLast}`);
}

/**
 * 获取项目对话目录中的 settings.json 路径
 * @param projectPath - 项目路径
 */
export function getProjectSettingsPath(projectPath: string): string {
  return join(getProjectConversationDir(projectPath), 'settings.json');
}

/**
 * 已确保存在 settings.json 的项目对话目录缓存
 * 避免每次 appendMessage 都重复读 settings.json
 */
const ensuredProjectDirs = new Set<string>();

/**
 * 确保项目对话目录存在，并在其中写入/更新 settings.json。
 * settings.json 用于记录该编码目录对应的完整 workspacePath，
 * 便于从 conversations 下的子目录反查原始项目路径。
 */
export async function ensureProjectConversationDir(projectPath: string): Promise<string> {
  const projectDir = getProjectConversationDir(projectPath);
  if (ensuredProjectDirs.has(projectDir)) {
    return projectDir;
  }
  await fs.mkdir(projectDir, { recursive: true });
  await writeProjectSettings(projectDir, projectPath);
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
    writeProjectSettingsSync(projectDir, projectPath);
    ensuredProjectDirs.add(projectDir);
  }
  return projectDir;
}

async function writeProjectSettings(projectDir: string, workspacePath: string): Promise<void> {
  const settingsPath = join(projectDir, 'settings.json');
  let settings: Record<string, unknown> = {};
  try {
    const content = await fs.readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
      if (settings.workspacePath === workspacePath) {
        return;
      }
    }
  } catch {
    // 文件不存在或解析失败，按空对象重建
  }
  settings.workspacePath = workspacePath;
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function writeProjectSettingsSync(projectDir: string, workspacePath: string): void {
  const settingsPath = join(projectDir, 'settings.json');
  let settings: Record<string, unknown> = {};
  try {
    const content = readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
      if (settings.workspacePath === workspacePath) {
        return;
      }
    }
  } catch {
    // 文件不存在或解析失败，按空对象重建
  }
  settings.workspacePath = workspacePath;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
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
 * 为 conversations 下已存在的旧项目目录补写 settings.json
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
          logger.error('Config', `Failed to write settings.json for ${entry.name}: ${error}`);
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

  // 为已存在的旧项目目录补写 settings.json（记录 workspacePath）
  await backfillProjectSettings();
}

/**
 * 项目根目录提供者
 * 允许外部传入项目路径（如从 VSCode workspace）
 */
let projectRootProvider: (() => string | undefined) | null = null;

/**
 * 设置项目根目录提供者
 */
export function setProjectRootProvider(provider: () => string | undefined): void {
  projectRootProvider = provider;
}

/**
 * 当前是否有可用的项目根目录（宿主已打开工作目录）
 *
 * 与 getProjectRoot() 的区别：只判断、不取值也不抛错，
 * 供"没有工作目录时降级"的调用点做前置守卫：
 *
 *   if (!hasProjectRoot()) return [];
 *   const root = getProjectRoot();
 */
export function hasProjectRoot(): boolean {
  return !!projectRootProvider?.();
}

/**
 * 获取当前项目根目录（绝对路径）
 *
 * 必须通过 setProjectRootProvider 设置提供者；未设置或返回空值时抛错，
 * 让"没有工作目录"这类问题在调用点显式暴露，而不是静默拿到一个错误路径。
 * 需要降级处理（如宿主尚未打开工作目录）的调用点，先用 hasProjectRoot() 守卫。
 */
export function getProjectRoot(): string {
  const root = projectRootProvider?.();
  if (root) {
    return root;
  }
  throw new Error(
    'Project root is not configured. ' +
    'Please call setProjectRootProvider() before using getProjectRoot(). ' +
    'In VSCode extension, this is typically done in initializeHistory().'
  );
}

/**
 * 扩展路径提供者
 * 允许外部传入扩展安装路径（如从 VSCode ExtensionContext）
 */
let extensionPathProvider: (() => string | undefined) | null = null;

/**
 * 设置扩展路径提供者
 */
export function setExtensionPathProvider(provider: () => string | undefined): void {
  extensionPathProvider = provider;
}

/**
 * 获取扩展安装路径
 * 必须通过 setExtensionPathProvider 设置扩展路径提供者
 * 如果未设置或返回空值，则抛出错误
 */
export function getExtensionPath(): string {
  if (extensionPathProvider) {
    const extPath = extensionPathProvider();
    if (extPath) {
      return extPath;
    }
  }
  throw new Error(
    'Extension path is not configured. ' +
    'Please call setExtensionPathProvider() before using getExtensionPath().'
  );
}

/**
 * 当前活跃的会话 ID
 */
let activeSessionId: string;

/**
 * 设置当前活跃的会话 ID
 */
export function setActiveSessionId(sessionId: string): void {
  activeSessionId = sessionId;
}

/**
 * 获取当前活跃的会话 ID
 */
export function getActiveSessionId(): string {
  return activeSessionId;
}

/**
 * settings.json 缓存
 */
let cachedSettings: Record<string, any> | null = null;

/**
 * 重新读取 settings.json（清除缓存）
 */
export function resetSettingsCache(): void {
  cachedSettings = null;
}

/**
 * 读取 settings.json（~/<CONFIG_DIR_NAME>/settings.json）
 */
export async function readSettingsJson(): Promise<Record<string, any>> {
  if (cachedSettings) return cachedSettings;
  const settingsPath = join(getConfigHomeDir(), 'settings.json');

  let settings: Record<string, any> = {};

  try {
    const content = await fs.readFile(settingsPath, 'utf-8');
    settings = JSON.parse(content);
  } catch {
    // 文件不存在或解析失败，从空对象开始
  }

  cachedSettings = settings;
  return settings;
}

/**
 * settings.json 写操作串行队列
 * 防止多个写入口（handleSetModel、handleSaveLLMConfig、saveApiKeyToSettings 等）
 * 并发"读-改-写"导致文件损坏或字段丢失（丢失更新）。
 */
let settingsWriteChain: Promise<void> = Promise.resolve();

/**
 * 串行化执行对 ~/<CONFIG_DIR_NAME>/settings.json 的读-改-写操作
 *
 * 所有写操作按调用顺序排队执行（Promise 链），避免并发写同一文件造成：
 *  - 文件被截断/交错写坏（Windows 下 writeFile 非原子）
 *  - 后写者覆盖先写者的字段（丢失更新）
 *
 * @param mutator 同步修改 cfg 对象；返回值若非 undefined 则作为新的完整配置写回
 * @returns 写入完成后的 Promise
 */
export function updateSettingsJson(
  mutator: (cfg: Record<string, any>) => void | Record<string, any>
): Promise<void> {
  const run = async (): Promise<void> => {
    const settingsPath = join(getConfigHomeDir(), 'settings.json');
    let cfg: Record<string, any> = {};
    try {
      const content = await fs.readFile(settingsPath, 'utf-8');
      cfg = JSON.parse(content);
    } catch {
      // 文件不存在或解析失败，从空对象开始
    }
    const result = mutator(cfg);
    const nextCfg = (result !== undefined ? result : cfg) as Record<string, any>;
    await fs.mkdir(getConfigHomeDir(), { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify(nextCfg, null, 2), 'utf-8');
    // 清除缓存，下次读取时重新加载
    cachedSettings = null;
  };

  // 串行执行：上一个完成后才开始下一个；单个失败不影响后续队列
  const next = settingsWriteChain.then(run, run);
  settingsWriteChain = next.catch(() => {});
  return next;
}



/**
 * 保存 API Key 到 settings.json
 * 用于 LLM 配置中 apiKey 为空时，通过密码输入框获取后保存
 * 通过 updateSettingsJson 串行化写入，避免并发写坏文件
 */
export async function saveApiKeyToSettings(apiKey: string): Promise<void> {
  try {
    await updateSettingsJson((cfg) => {
      if (!cfg.llm) cfg.llm = {};
      // 新结构：apiKey 只保存到 activeProvider 对应的 provider 内
      const activeKey = cfg.llm.activeProvider;
      if (activeKey && cfg.llm.providers?.[activeKey]) {
        cfg.llm.providers[activeKey].apiKey = apiKey;
      }
    });
  } catch (e) {
    logger.error('Config', `保存 API Key 到 settings.json 失败: ${e}`);
  }
}

/**
 * 同步读取 settings.json 中的 UI 语言设置（'auto' | 'zh' | 'en'）。
 * 供各宿主在创建 webview 时同步注入 window.__uiLocale，避免首帧语言闪变。
 * 读取失败或未配置时返回 'auto'。
 */
export function readUiLanguageSync(): 'auto' | 'zh' | 'en' {
  try {
    const { readFileSync } = require('fs') as typeof import('fs');
    const settingsPath = join(getConfigHomeDir(), 'settings.json');
    const content = readFileSync(settingsPath, 'utf-8');
    const cfg = JSON.parse(content);
    const lang = cfg?.uiLanguage;
    return lang === 'zh' || lang === 'en' || lang === 'auto' ? lang : 'auto';
  } catch {
    return 'auto';
  }
}

/**
 * Shiki 已使用语言在 settings.json 中的字段名。
 * webview 侧语法高亮全部改为按需加载，加载过的语言记录在此，
 * 下次启动时宿主据此注入并预热，避免重复的首次加载延迟。
 */
export const HIGHLIGHT_LANGUAGES_FIELD = 'highlightLanguages';

/** 记录上限：避免长期使用后字段无限增长（只保留最近使用的语言） */
const HIGHLIGHT_LANGUAGES_MAX = 60;

/**
 * 同步读取 settings.json 中已记录的 Shiki 语言列表。
 * 供各宿主在创建 webview 时同步注入 window.__highlightLanguages。
 * 读取失败、未配置或格式非法时返回空数组。
 */
export function readHighlightLanguagesSync(): string[] {
  try {
    const { readFileSync } = require('fs') as typeof import('fs');
    const settingsPath = join(getConfigHomeDir(), 'settings.json');
    const content = readFileSync(settingsPath, 'utf-8');
    const cfg = JSON.parse(content);
    const list = cfg?.[HIGHLIGHT_LANGUAGES_FIELD];
    if (!Array.isArray(list)) return [];
    return list.filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}

/**
 * 记录一个已被 webview 按需加载的 Shiki 语言，供下次启动预热。
 * 已存在时直接返回，不做任何写入（避免每次高亮都触发磁盘写）。
 * 通过 updateSettingsJson 串行化写入，避免与其他 settings 写入口并发损坏文件。
 */
export async function recordHighlightLanguage(language: string): Promise<void> {
  if (typeof language !== 'string' || !language) return;
  try {
    const existing = readHighlightLanguagesSync();
    if (existing.includes(language)) return;

    await updateSettingsJson((cfg) => {
      const current: unknown = cfg[HIGHLIGHT_LANGUAGES_FIELD];
      const list: string[] = Array.isArray(current)
        ? current.filter((v): v is string => typeof v === 'string' && v.length > 0)
        : [];
      if (list.includes(language)) return;
      list.push(language);
      // 超出上限时丢弃最早记录，保持字段体积可控
      cfg[HIGHLIGHT_LANGUAGES_FIELD] = list.length > HIGHLIGHT_LANGUAGES_MAX
        ? list.slice(list.length - HIGHLIGHT_LANGUAGES_MAX)
        : list;
    });
  } catch (e) {
    logger.error('Config', `记录高亮语言到 settings.json 失败: ${e}`);
  }
}

/**
 * 同步读取 settings.json 中的唤醒快捷键（Electron accelerator 形式）。
 * 未配置、读取失败或配置非法时返回默认值 Ctrl+Alt+X。
 */
export function readWakeShortcutSync(): string {
  try {
    const settingsPath = join(getConfigHomeDir(), 'settings.json');
    const content = readFileSync(settingsPath, 'utf-8');
    const cfg = JSON.parse(content);
    return normalizeAccelerator(cfg?.shortcut) || DEFAULT_WAKE_SHORTCUT;
  } catch {
    return DEFAULT_WAKE_SHORTCUT;
  }
}
