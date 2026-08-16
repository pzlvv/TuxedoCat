/**
 * Electron 主进程 / preload 构建脚本
 * 将 electron/main.ts、preload.ts、spinPreload.ts 打包为 CJS 到 dist-electron/
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
  external: ['electron'],
  tsconfig: project.resolve('tsconfig.json'),
};

const entries = [
  { entryPoints: [project.resolve('electron', 'main.ts')], outfile: project.electronMainOut },
  { entryPoints: [project.resolve('electron', 'preload.ts')], outfile: project.electronPreloadOut },
  { entryPoints: [project.resolve('electron', 'spinPreload.ts')], outfile: project.electronSpinPreloadOut },
  { entryPoints: [project.resolve('electron', 'monacoPreload.ts')], outfile: project.electronMonacoPreloadOut },
  { entryPoints: [project.resolve('electron', 'sidebarPreload.ts')], outfile: project.electronSidebarPreloadOut },
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
