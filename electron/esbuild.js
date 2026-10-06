/**
 * Electron 主进程 / preload 构建脚本
 * 将 electron/main.ts 与各 preload（preload / spinPreload / monacoPreload /
 * imageViewerPreload / sidebarPreload / shortcutPreload / titlebarPreload / titlebarMenuPreload /
 * remoteWorkspacePreload）打包为 CJS 到 dist-electron/
 */
const esbuild = require('esbuild');
const path = require('path');
const project = require('../project.config.cjs');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const baseConfig = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  // bufferutil / utf-8-validate 是 ws 的可选原生加速模块，运行时缺失也能正常工作；
  // 标记为 external 避免 esbuild 因解析不到它们而报错。
  // cpu-features / *.node 同理：ssh2（SSH 接入，docs/core-daemon.md 第 12 节）的
  // 可选原生加速，缺失时 ssh2 自己退化到纯 JS 实现。
  external: ['electron', 'bufferutil', 'utf-8-validate', 'cpu-features', '*.node'],
  tsconfig: project.resolve('tsconfig.json'),
  // 构建期把 Core 实现（coreKind）烧进产物，见 src/host/coreKind.ts
  define: { __CORE_KIND__: JSON.stringify(project.coreKind) },
};

const entries = [
  { entryPoints: [project.resolve('electron', 'main.ts')], outfile: project.electronMainOut },
  { entryPoints: [project.resolve('electron', 'preload.ts')], outfile: project.electronPreloadOut },
  { entryPoints: [project.resolve('electron', 'spinPreload.ts')], outfile: project.electronSpinPreloadOut },
  { entryPoints: [project.resolve('electron', 'monacoPreload.ts')], outfile: project.electronMonacoPreloadOut },
  { entryPoints: [project.resolve('electron', 'imageViewerPreload.ts')], outfile: project.electronImageViewerPreloadOut },
  { entryPoints: [project.resolve('electron', 'sidebarPreload.ts')], outfile: project.electronSidebarPreloadOut },
  { entryPoints: [project.resolve('electron', 'shortcutPreload.ts')], outfile: project.electronShortcutPreloadOut },
  { entryPoints: [project.resolve('electron', 'titlebarPreload.ts')], outfile: project.electronTitlebarPreloadOut },
  { entryPoints: [project.resolve('electron', 'titlebarMenuPreload.ts')], outfile: project.electronTitlebarMenuPreloadOut },
  { entryPoints: [project.resolve('electron', 'remoteWorkspacePreload.ts')], outfile: project.electronRemoteWorkspacePreloadOut },
  { entryPoints: [project.resolve('electron', 'chatPlaceholderPreload.ts')], outfile: project.electronChatPlaceholderPreloadOut },
];

async function main() {
  for (const entry of entries) {
    const config = { ...baseConfig, ...entry };
    if (watch) {
      const ctx = await esbuild.context(config);
      await ctx.watch();
      console.log(`[esbuild:electron] Watching ${entry.entryPoints[0]}...`);
    } else {
      await esbuild.build(config);
      console.log(`[esbuild:electron] Built ${entry.outfile}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
