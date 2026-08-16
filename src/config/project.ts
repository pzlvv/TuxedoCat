/**
 * 项目级统一配置入口
 *
 * 所有产品名、扩展 ID、配置目录、环境变量前缀等工程变量
 * 统一从 project.json 读取，避免在代码与构建脚本中散落硬编码。
 */
import projectConfig from './project.json';

export const PRODUCT_NAME = projectConfig.productName;
export const EXTENSION_NAME = projectConfig.extensionName;
export const COMMAND_PREFIX = projectConfig.commandPrefix;
export const CONFIG_DIR_NAME = projectConfig.configDir;
export const ENV_PREFIX = projectConfig.envPrefix;
export const ENV_MAX_OUTPUT_TOKENS = projectConfig.envMaxOutputTokens;
export const LOG_FILE_NAME = projectConfig.logFileName;
export const TMP_TASK_DIR_NAME = projectConfig.tmpTaskDirName;
export const SETTINGS_FILE_NAME = projectConfig.settingsFileName;
export const TASK_OWNER = projectConfig.taskOwner;
export const OUTPUT_CHANNEL_NAME = projectConfig.outputChannelName;
export const APP_ID = projectConfig.appId;
export const VIEW_CONTAINER_ID = projectConfig.viewContainerId;
export const VIEW_ID = projectConfig.viewId;
export const PREVIEW_SCHEME = projectConfig.schemes.preview;
export const DIFF_BEFORE_SCHEME = projectConfig.schemes.diffBefore;
export const DIFF_AFTER_SCHEME = projectConfig.schemes.diffAfter;
export const MERMAID_PANEL_ID = projectConfig.panelIds.mermaidPreview;
export const SPIN_DESIGN_PANEL_ID = projectConfig.panelIds.spinDesign;
