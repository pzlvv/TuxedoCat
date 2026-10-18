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
 */
const releaseDir = resolve('release');

module.exports = {
  ...project,
  rootDir,
  resolve,
  releaseDir,
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
  electronSidebarPreloadOut: resolve(project.build.electronSidebarPreloadOut),
  electronShortcutPreloadOut: resolve(project.build.electronShortcutPreloadOut),
  electronTitlebarPreloadOut: resolve(project.build.electronTitlebarPreloadOut),
  electronTitlebarMenuPreloadOut: resolve(project.build.electronTitlebarMenuPreloadOut),
  electronRemoteWorkspacePreloadOut: resolve(project.build.electronRemoteWorkspacePreloadOut),
  electronChatPlaceholderPreloadOut: resolve(project.build.electronChatPlaceholderPreloadOut),
};
