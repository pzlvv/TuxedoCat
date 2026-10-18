const esbuild = require('esbuild');
const project = require('./project.config.cjs');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const config = {
  entryPoints: [project.resolve('src', 'extension.ts')],
  bundle: true,
  outfile: project.extensionOut,
  // ssh2（SSH 接入，见 docs/core-daemon.md 第 12 节）的可选原生加速模块：
  // `cpu-features` 与 `*.node` 运行时缺失也能正常工作，标记 external 避免 esbuild
  // 因解析不到 `.node` 而构建失败（与 electron/esbuild.js 同一口径）。
  external: ['vscode', 'cpu-features', '*.node'],
  format: 'cjs',
  platform: 'node',
  target: 'node16',
  sourcemap: !production,
  minify: production,
  tsconfig: 'tsconfig.json',
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
    console.log('[esbuild] Watching for changes...');
  } else {
    await esbuild.build(config);
    console.log('[esbuild] Build complete.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
