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
 * 构建期 Core 实现（`<coreKindEnv>=embedded|standalone`）。
 *
 * 与运行时选择变量（`src/host/coreKind.ts`）同名同取值：打包时由 esbuild `define`
 * 注入到产物里，构建脚本据此决定要不要 Rust Core、产物落到哪个目录。
 * 未设置时与源码默认值一致，为 `standalone`。
 */
function resolveCoreKind() {
  const raw = process.env[coreKindEnv];
  if (raw === undefined || raw === '') return 'standalone';
  if (raw !== 'embedded' && raw !== 'standalone') {
    throw new Error(`Invalid ${coreKindEnv}="${raw}"; expected "embedded" or "standalone".`);
  }
  return raw;
}

/**
 * Core 实现选择变量的环境变量名（`<envPrefix>_<core.envVarSuffix>`）。
 *
 * 与运行时 `src/config/project.ts` 的 `CORE_ENV_VAR` 同一配置来源（project.json），
 * 源码不出现产品字面量。
 */
const coreKindEnv = `${project.envPrefix}_${project.core.envVarSuffix}`;

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
  coreKindEnv,
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
