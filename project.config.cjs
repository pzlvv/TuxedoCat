/**
 * 统一构建配置
 *
 * 供 esbuild / vite / electron-builder 等构建脚本使用。
 * 产品名称、扩展 ID、配置目录、环境变量前缀等工程变量统一维护在
 * src/config/project.json 中，这里只做路径增强。
 */
const path = require('path');

const project = require('./src/config/project.json');

/** 根目录绝对路径 */
const rootDir = __dirname;

/** 解析到项目根目录下的路径 */
function resolve(...segments) {
  return path.join(rootDir, ...segments);
}

/**
 * 打包产物目录（`release/`）。
 *
 * ASAN 变体（`npm run package:asan` 经环境变量 `<envPrefix>_CORE_ASAN=1` 贯穿全链路，
 * 注入见 `scripts/package-asan.mjs`）落 `release/asan/`：安装包 / vsix 文件名不带变体
 * 标记，与正式产物同目录会互相覆盖——asan 包（插桩、慢数倍）绝不能冒充 release 包分发。
 */
const ASAN_ENV_VAR = `${project.envPrefix}_CORE_ASAN`;
const releaseDir = resolve(process.env[ASAN_ENV_VAR] === '1' ? 'release/asan' : 'release');

module.exports = {
  ...project,
  rootDir,
  resolve,
  releaseDir,
  /** ASAN 变体开关的环境变量名（`scripts/build-core.mjs` 与打包链共用这一份） */
  asanEnvVar: ASAN_ENV_VAR,
  distDir: resolve(project.build.dist),
  distElectronDir: resolve(project.build.distElectron),
  extensionOut: resolve(project.build.extensionOut),
  webviewOut: resolve(project.build.webviewOut),
  monacoOut: resolve(project.build.monacoOut),
  imageViewerOut: resolve(project.build.imageViewerOut),
  sidebarOut: resolve(project.build.sidebarOut),
  titlebarOut: resolve(project.build.titlebarOut),
  remoteWorkspaceOut: resolve(project.build.remoteWorkspaceOut),
  electronMainOut: resolve(project.build.electronMainOut),
  electronPreloadOut: resolve(project.build.electronPreloadOut),
  electronSpinPreloadOut: resolve(project.build.electronSpinPreloadOut),
  electronMonacoPreloadOut: resolve(project.build.electronMonacoPreloadOut),
  electronImageViewerPreloadOut: resolve(project.build.electronImageViewerPreloadOut),
  electronMarkdownPreloadOut: resolve(project.build.electronMarkdownPreloadOut),
  electronSidebarPreloadOut: resolve(project.build.electronSidebarPreloadOut),
  electronPreferencePreloadOut: resolve(project.build.electronPreferencePreloadOut),
  electronTitlebarPreloadOut: resolve(project.build.electronTitlebarPreloadOut),
  electronTitlebarMenuPreloadOut: resolve(project.build.electronTitlebarMenuPreloadOut),
  electronRemoteWorkspacePreloadOut: resolve(project.build.electronRemoteWorkspacePreloadOut),
  electronChatPlaceholderPreloadOut: resolve(project.build.electronChatPlaceholderPreloadOut),
};
