/**
 * 配置目录管理
 */

import { join } from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { mkdirSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { logger } from '../Logger.js';
import { requireEventBus } from '../AssistantEventBus.js';
import { CONFIG_DIR_NAME } from '../../config/project.js';
import { DEFAULT_WAKE_SHORTCUT, normalizeAccelerator } from '../utils/shortcut.js';
import type { ModelTokenLimits } from '../utils/modelConfig.js';
import type { ModelRef } from '../llm/modelRef.js';

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
 * 已确保存在 settings.json 的项目对话目录缓存
 * 避免每次 appendMessage 都重复读 settings.json
 */
const ensuredProjectDirs = new Set<string>();

/**
 * 确保项目对话目录存在，并上报「目录已就绪」。
 * settings.json 用于记录该编码目录对应的完整 workspacePath，
 * 便于从 conversations 下的子目录反查原始项目路径。
 *
 * 目录本身由 core 创建（core 自己的会话数据）；**settings.json 的写归宿主**
 * （`UIHost.ensureProjectSettings`，见第 2 节规则 9），这里只上报事实。
 */
export async function ensureProjectConversationDir(projectPath: string): Promise<string> {
  const projectDir = getProjectConversationDir(projectPath);
  if (ensuredProjectDirs.has(projectDir)) {
    return projectDir;
  }
  await fs.mkdir(projectDir, { recursive: true });
  notifyProjectConversationDirReady(projectDir, projectPath);
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
    notifyProjectConversationDirReady(projectDir, projectPath);
    ensuredProjectDirs.add(projectDir);
  }
  return projectDir;
}

/** 上报「项目对话目录已就绪」：settings.json 由宿主写（core 只读不写） */
function notifyProjectConversationDirReady(projectDir: string, workspacePath: string): void {
  try {
    requireEventBus().emitToUi({ type: 'projectConversationDirReady', projectDir, workspacePath });
  } catch (error) {
    logger.error('Config', `Failed to report project conversation dir ${projectDir}: ${error}`);
  }
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
 * 为 conversations 下已存在的旧项目目录补上报一次「目录已就绪」，
 * 让宿主补写其中的 settings.json（core 只读不写）
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

  // 为已存在的旧项目目录补上报一次（目录清单 settings.json 由宿主写）
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
 * 项目根目录提供者是否已注册（启动自检用）。
 *
 * 与 hasProjectRoot() 的区别：只看"提供者有没有被注入"，不看它当前返回什么值。
 * 未打开工作目录时提供者仍然存在，属于合法的启动完成状态。
 */
export function hasProjectRootProvider(): boolean {
  return projectRootProvider !== null;
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

/** 扩展路径提供者是否已注册（启动自检用；不看当前返回值） */
export function hasExtensionPathProvider(): boolean {
  return extensionPathProvider !== null;
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

/** 记录上限：避免长期使用后字段无限增长（只保留最近使用的语言） */
const HIGHLIGHT_LANGUAGES_MAX = 60;

/**
 * 构造「把 languages 并入 highlightLanguages 字段」的 settings.json 修改器。
 *
 * core 只描述**怎么改**（字段名 / 去重 / 上限都在这里），**写盘由宿主承担**
 * （`UIHost.updateSettingsJson`，见第 2 节规则 9）。
 */
export function highlightLanguagesMutator(
  languages: readonly string[]
): (cfg: Record<string, any>) => void {
  return (cfg) => {
    const current: unknown = cfg[HIGHLIGHT_LANGUAGES_FIELD];
    const list: string[] = Array.isArray(current)
      ? current.filter((v): v is string => typeof v === 'string' && v.length > 0)
      : [];
    let changed = false;
    for (const language of languages) {
      if (typeof language !== 'string' || !language) continue;
      if (list.includes(language)) continue;
      list.push(language);
      changed = true;
    }
    if (!changed) return;
    // 超出上限时丢弃最早记录，保持字段体积可控
    cfg[HIGHLIGHT_LANGUAGES_FIELD] = list.length > HIGHLIGHT_LANGUAGES_MAX
      ? list.slice(list.length - HIGHLIGHT_LANGUAGES_MAX)
      : list;
  };
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

/**
 * 同步读取 settings.json 中指定模型身份（provider + model）的上下文信息，
 * 供各宿主在响应 webview 的 requestContextLimit 时使用。
 *
 * - ref 提供时：只查该 provider 的 modelConfigs，不回退到其它 provider
 *   （provider 不存在时记录日志，仅按内置注册表计算）。
 * - ref 未提供时：按 activeProvider 的默认模型算（视图初始化推送用）。
 * - modelConfigs：provider.modelConfigs，即 settings.json 中每个模型的
 *   context/output 覆盖值。
 *
 * 必须同时返回 modelConfigs：只按内置 MODEL_CONFIGS 注册表计算 context window
 * 会忽略用户在 settings.json 中为各模型配置的 context 覆盖，
 * 表现为「切换模型后 webview 里的 context 不跟随变化」。
 * VSCode 与 Electron 两端共用本函数，避免逻辑再次分叉。
 */
export function readModelContextSync(ref?: ModelRef): {
  model: string;
  modelConfigs: Record<string, ModelTokenLimits>;
} {
  let modelName = ref?.model ?? '';
  let modelConfigs: Record<string, ModelTokenLimits> = {};
  try {
    const settingsPath = join(getConfigHomeDir(), 'settings.json');
    const content = readFileSync(settingsPath, 'utf-8');
    const cfg = JSON.parse(content);
    const providers = cfg?.llm?.providers;
    const activeKey = cfg?.llm?.activeProvider;
    let chosenKey = '';
    if (ref) {
      if (providers?.[ref.provider]?.baseURL) {
        chosenKey = ref.provider;
      } else {
        logger.warn('readModelContextSync', `provider "${ref.provider}" 不存在，仅按内置注册表计算 context`);
      }
    } else if (activeKey && providers?.[activeKey]?.baseURL) {
      chosenKey = activeKey;
    }
    const chosenProvider = chosenKey ? providers?.[chosenKey] : undefined;
    if (chosenProvider?.modelConfigs && typeof chosenProvider.modelConfigs === 'object') {
      modelConfigs = chosenProvider.modelConfigs;
    }
    if (!modelName && chosenProvider) {
      if (typeof chosenProvider.defaultModel === 'string' && chosenProvider.defaultModel.trim()) {
        modelName = chosenProvider.defaultModel.trim();
      } else if (Array.isArray(chosenProvider.models) && chosenProvider.models.length > 0) {
        modelName = chosenProvider.models[0];
      }
    }
  } catch {
    // 读取失败：保留传入的模型名，modelConfigs 为空（回退内置注册表）
  }
  return { model: modelName, modelConfigs };
}
