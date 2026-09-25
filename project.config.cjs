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

module.exports = {
  ...project,
  rootDir,
  resolve,
  distDir: resolve(project.build.dist),
  distElectronDir: resolve(project.build.distElectron),
  extensionOut: resolve(project.build.extensionOut),
  webviewOut: resolve(project.build.webviewOut),
  monacoOut: resolve(project.build.monacoOut),
  sidebarOut: resolve(project.build.sidebarOut),
  titlebarOut: resolve(project.build.titlebarOut),
  electronMainOut: resolve(project.build.electronMainOut),
  electronPreloadOut: resolve(project.build.electronPreloadOut),
  electronSpinPreloadOut: resolve(project.build.electronSpinPreloadOut),
  electronMonacoPreloadOut: resolve(project.build.electronMonacoPreloadOut),
  electronSidebarPreloadOut: resolve(project.build.electronSidebarPreloadOut),
  electronShortcutPreloadOut: resolve(project.build.electronShortcutPreloadOut),
  electronTitlebarPreloadOut: resolve(project.build.electronTitlebarPreloadOut),
  electronTitlebarMenuPreloadOut: resolve(project.build.electronTitlebarMenuPreloadOut),
};
