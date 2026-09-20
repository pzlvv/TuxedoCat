/**
 * 构建 MessagesView 内存测试 web bundle。
 *
 * 变体（--variant）：
 *   full      当前实现（shiki 全量 + katex）
 *   no-shiki  用桩替换 shiki，测量 shiki 内存占用
 *   no-katex  用桩替换 rehype-katex，测量 KaTeX 内存占用
 *   neither   两者都用桩
 */
import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const variantArg = process.argv.find((a) => a.startsWith('--variant='));
const variant = variantArg ? variantArg.split('=')[1] : 'full';

const dataArg = process.argv.find((a) => a.startsWith('--data='));
const dataFile = dataArg ? dataArg.split('=')[1] : 'sessions.json';
// --data=runtime: 不内联数据，改为运行时 fetch 同目录 sessions.json（用于超大样本集）
const runtimeData = dataFile === 'runtime';
const data = runtimeData ? 'undefined' : fs.readFileSync(path.join(__dirname, dataFile), 'utf8');

const alias = {};
if (variant === 'no-shiki' || variant === 'neither') {
  alias['shiki'] = path.join(__dirname, 'stubs', 'shiki.js');
}
if (variant === 'no-katex' || variant === 'neither') {
  alias['rehype-katex'] = path.join(__dirname, 'stubs', 'rehype-katex.js');
}

const outName = variant === 'full' ? 'web.js' : `web-${variant}.js`;

await esbuild.build({
  entryPoints: [path.join(__dirname, 'harness.entry.tsx')],
  bundle: true,
  outfile: path.join(__dirname, outName),
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  define: {
    '__MEMTEST_DATA__': data,
    'process.env.NODE_ENV': '"production"',
  },
  loader: { '.tsx': 'tsx', '.ts': 'ts' },
  sourcemap: false,
  minify: false,
  logLevel: 'error',
  alias,
});

const size = fs.statSync(path.join(__dirname, outName)).size;
console.log(`[${variant}] built ${outName}: ${(size / 1048576).toFixed(2)} MB`);

// 生成对应 html（script src 指向对应 bundle）
const html = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8')
  .replace('./web.js', `./${outName}`);
const htmlName = variant === 'full' ? 'index.html' : `index-${variant}.html`;
fs.writeFileSync(path.join(__dirname, htmlName), html);
console.log(`[${variant}] wrote ${htmlName}`);

// 复制真实构建产物的 CSS（template.html 里通过 real-*.css 引用），
// 保证 harness 的布局/样式与线上一致。需要先执行 `npm run build:webview`。
const cssDir = path.resolve(__dirname, '..', '..', '..', 'dist', 'webview', 'assets');
const cssMap = {
  'antd.css': 'real-antd.css',
  'markdown.css': 'real-markdown.css',
  'index.css': 'real-index.css',
};
for (const [src, dest] of Object.entries(cssMap)) {
  const from = path.join(cssDir, src);
  if (fs.existsSync(from)) {
    fs.copyFileSync(from, path.join(__dirname, dest));
    console.log(`[${variant}] copied ${src} -> ${dest}`);
  } else {
    console.warn(`[${variant}] 缺少 ${from}，请先运行 \`npm run build:webview\``);
  }
}
