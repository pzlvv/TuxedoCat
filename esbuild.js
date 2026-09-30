const esbuild = require('esbuild');
const project = require('./project.config.cjs');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const config = {
  entryPoints: [project.resolve('src', 'extension.ts')],
  bundle: true,
  outfile: project.extensionOut,
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node16',
  sourcemap: !production,
  minify: production,
  tsconfig: 'tsconfig.json',
  // 构建期把 Core 实现（TUXEDO_CAT_CORE）烧进产物，见 src/host/coreKind.ts
  define: { __TUXEDO_CAT_CORE_KIND__: JSON.stringify(project.coreKind) },
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
