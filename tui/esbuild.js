/**
 * TUI 构建脚本：src/tui/main.ts → dist/tui.mjs（docs/tui.md 第 8 节）。
 *
 * 口径对齐 electron/esbuild.js（bundle / platform node / 同一 Core 形态 define），
 * 差异只有两处：
 * - 产物是 **ESM**：ink 5 的模块图带顶层 await（devtools 按需 import），
 *   CJS 产物在 Node 下无法加载（require(esm-with-TLA) 抛错）；
 * - jsx 用 automatic（与根 tsconfig 的 react-jsx 对齐，组件不手写 React 导入）。
 */

const esbuild = require('esbuild');
const path = require('path');
const project = require('../project.config.cjs');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * ink 的 devtools 集成经静态 import 引 react-devtools-core（可选 peer，未安装）。
 * TUI 不支持 ink devtools（调试走 --verbose 日志），桩成 undefined：
 * devtools.js 只在 INK_DEVTOOLS 开启时才会真正调用该模块。
 */
const stubReactDevtools = {
  name: 'stub-react-devtools',
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: 'react-devtools-core-stub',
      namespace: 'react-devtools-stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'react-devtools-stub' }, () => ({
      contents: 'export default undefined;',
      loader: 'js',
    }));
  },
};

/** @type {import('esbuild').BuildOptions} */
const config = {
  entryPoints: [project.resolve('src', 'tui', 'render', 'main.ts')],
  outfile: project.resolve('dist', 'tui.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  jsx: 'automatic',
  sourcemap: !production,
  minify: production,
  // 与 electron 侧同一组可选原生加速 external（ssh2 / ws 的可选依赖，缺失自退化）
  external: ['bufferutil', 'utf-8-validate', 'cpu-features', '*.node'],
  plugins: [stubReactDevtools],
  // ESM 产物里被打包进来的 CJS 依赖（signal-exit 的 require('assert')、ssh2 的
  // __dirname 等）需要 CJS 全局：注入 createRequire 与 __filename/__dirname
  // （esbuild 的 ESM 输出不自动提供）。__dirname 指向产物目录，仅满足模块加载期的
  // 路径常量计算（如 ssh2 的 pagent.exe 定位），TUI 不执行那些代码路径。
  banner: {
    js: [
      "import { createRequire as __tuiCreateRequire } from 'module';",
      "import { fileURLToPath as __tuiFileURLToPath } from 'url';",
      "import { dirname as __tuiDirname } from 'path';",
      "const require = __tuiCreateRequire(import.meta.url);",
      "const __filename = __tuiFileURLToPath(import.meta.url);",
      "const __dirname = __tuiDirname(__filename);",
    ].join('\n'),
  },
  tsconfig: project.resolve('tsconfig.json'),
  // 构建期把 Core 实现（TUXEDO_CAT_CORE）烧进产物，见 src/host/coreKind.ts
  define: { __TUXEDO_CAT_CORE_KIND__: JSON.stringify(project.coreKind) },
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
    console.log(`[esbuild:tui] Watching ${config.entryPoints[0]}...`);
  } else {
    await esbuild.build(config);
    console.log(`[esbuild:tui] Built ${config.outfile}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
