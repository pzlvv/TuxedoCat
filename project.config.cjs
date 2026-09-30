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
 * 构建期 Core 实现（`TUXEDO_CAT_CORE=embedded|standalone`）。
 *
 * 与运行时选择变量（`src/host/coreKind.ts`）同名同取值：打包时由 esbuild `define`
 * 注入到产物里，构建脚本据此决定要不要 Rust Core、产物落到哪个目录。
 * 未设置时与源码默认值一致，为 `standalone`。
 */
function resolveCoreKind() {
  const raw = process.env.TUXEDO_CAT_CORE;
  if (raw === undefined || raw === '') return 'standalone';
  if (raw !== 'embedded' && raw !== 'standalone') {
    throw new Error(`Invalid TUXEDO_CAT_CORE="${raw}"; expected "embedded" or "standalone".`);
  }
  return raw;
}

const coreKind = resolveCoreKind();

/**
 * 打包产物目录。embedded 变体与 standalone 分开落位，互不覆盖：
 * standalone → `release/`，embedded → `release/embedded/`。
 */
const releaseDir = resolve('release', coreKind === 'embedded' ? 'embedded' : '');

module.exports = {
  ...project,
  rootDir,
  resolve,
  coreKind,
  releaseDir,
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
