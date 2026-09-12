/**
 * 从 lucide-react 生成「CSS mask 图标」样式表与图标名清单。
 *
 * 背景：每个 lucide 图标渲染成 <svg> + N 个 <path>/<rect>/<circle>，
 * 一个图标占 2~6 个 DOM 节点。真实会话（8 个，183k 节点）里图标合计
 * 20,959 个节点（11.4%），是继代码预览 token 之后的第二大户。
 * 改成 1 个 <span> + CSS mask 后，每个图标只占 1 个节点，且颜色自动
 * 跟随 currentColor（与 lucide 的 stroke="currentColor" 语义一致）。
 *
 * 生成物（均已提交，新增图标后重跑本脚本即可）：
 *   src/webview/styles/icons.css     —— .ti / .ti-<name> 规则
 *   src/webview/icons.generated.ts   —— 图标名常量 + IconName 联合类型
 *
 * 用法: node scripts/gen-icons.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as lucide from 'lucide-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEBVIEW = path.join(ROOT, 'src', 'webview');

/** 递归收集 webview 下所有 .tsx */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/**
 * 扫描源码，找出实际用到的 lucide 图标名。
 * 判定方式：文件内 `import { A, B } from 'lucide-react'` 拿到候选名，
 * 再要求该文件里出现 `<A`（JSX 用法）或 `icon="A"` / `icon={A}`（ToolHeader 用法）。
 */
/**
 * 扫描源码，找出实际用到的图标。
 * 三个来源（迁移前后都能正确工作）：
 *   a) `<Icon name="file-text" />`  —— 迁移后的写法，kebab-case
 *   b) `icon="FileText"`           —— ToolHeader 的 prop，lucide PascalCase
 *   c) `<FileText ... />`          —— 迁移前直接使用 lucide 组件的写法
 * 返回 Map<kebabName, { pascal, files:Set }>。
 */
function collectIconNames() {
  const found = new Map(); // kebab -> { pascal, files }
  const note = (pascal, rel, kebabHint) => {
    const kebab = kebabHint || kebabOf(pascal);
    if (!(pascal in lucide)) {
      console.warn(`[warn] ${rel}: "${pascal}" 不是 lucide 图标，跳过`);
      return;
    }
    const cur = found.get(kebab);
    if (cur) cur.files.add(rel);
    else found.set(kebab, { pascal, files: new Set([rel]) });
  };

  for (const file of walk(WEBVIEW)) {
    // 去掉注释，避免文档里的示例（如 ToolHeader 的 `icon="Zap"`）被误判为真实用法
    const src = fs
      .readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/([^:])\/\/.*$/gm, '$1');
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');

    // a) <Icon name="kebab" /> / <Icon name={'kebab'} />
    for (const m of src.matchAll(/<Icon\s+name=(?:"([a-z0-9-]+)"|\{['"]([a-z0-9-]+)['"]\})/g)) {
      const kebab = m[1] || m[2];
      const pascal = PASCAL[kebab];
      if (!pascal) {
        console.warn(`[warn] ${rel}: <Icon name="${kebab}"> 无法反查 lucide 名字，跳过`);
        continue;
      }
      note(pascal, rel, kebab);
    }
    // b) icon="PascalCase"
    for (const m of src.matchAll(/icon="([A-Za-z][A-Za-z0-9]*)"/g)) note(m[1], rel);
    // c) lucide 具名导入 + <Name
    for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'lucide-react'/g)) {
      for (const raw of m[1].split(',')) {
        const n = raw.trim().split(/\s+as\s+/)[0].trim();
        if (n && new RegExp(`<${n}[\\s/>]`).test(src)) note(n, rel);
      }
    }
  }
  return found;
}

/** PascalCase -> kebab-case */
const kebabOf = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase();

/**
 * kebab -> Pascal 反查表。由 lucide 全量导出构建，因此 <Icon name="file-text" />
 * 这种迁移后的写法也能被正确识别（不依赖源码里是否还留着 lucide 引用）。
 */
const PASCAL = Object.fromEntries(
  Object.keys(lucide)
    .filter((k) => /^[A-Z]/.test(k) && lucide[k] && typeof lucide[k] === 'object')
    .map((k) => [kebabOf(k), k]),
);

/** 取出渲染后 <svg> 的内部内容 */
function innerOf(name) {
  const Comp = lucide[name];
  if (!Comp) throw new Error(`lucide 里没有图标 ${name}`);
  const html = renderToStaticMarkup(React.createElement(Comp, { size: 24 }));
  const m = html.match(/^<svg[^>]*>([\s\S]*)<\/svg>$/);
  if (!m) throw new Error(`${name} 渲染结果无法解析: ${html.slice(0, 120)}`);
  return m[1];
}

/**
 * 构造 mask 用的 data URI。
 * 要点：
 *  - stroke 固定为 black（mask 只看 alpha，颜色无意义；写 currentColor 在外部
 *    资源里会退化成黑，不如显式声明）
 *  - 属性一律用单引号，避免 CSS url("...") 里的双引号转义
 *  - 只编码 < > # 三个字符，保持可读性且体积最小
 */
function maskUri(inner) {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black'` +
    ` stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>${inner}</svg>`;
  return (
    svg
      // 属性引号统一成单引号：外层是 url("...")，内容里出现双引号会把 url 提前截断，
      // 导致 mask-image 解析失败、图标整个不渲染。
      .replace(/"/g, "'")
      .replace(/</g, '%3C')
      .replace(/>/g, '%3E')
      .replace(/#/g, '%23')
  );
}

const found = collectIconNames();
const names = [...found.keys()].sort();

const css = [
  '/* 本文件由 scripts/gen-icons.mjs 自动生成，请勿手改。',
  ' * 重新生成: node scripts/gen-icons.mjs',
  ' *',
  ' * 图标改用 CSS mask 绘制：每个图标 1 个 <span> 节点，取代 lucide 的',
  ' * <svg> + N 个 <path>/<rect>/<circle>（2~6 个节点）。颜色跟随 currentColor。',
  ' */',
  '',
  '.ti {',
  '  /* display: block 必须与 Tailwind Preflight 对 svg 的处理保持一致',
  '     （preflight: img,svg,video,canvas,audio,iframe,embed,object { display:block;',
  '     vertical-align:middle }）。若用 inline-block，图标会参与行盒计算，',
  '     非 flex 容器（如 copy/重试按钮）会因此变高：实测 copy 按钮 20px → 32px，',
  '     整个会话累计多出 106px 高度。 */',
  '  display: block;',
  '  vertical-align: middle;',
  '  background-color: currentColor;',
  '  -webkit-mask-repeat: no-repeat;',
  '  mask-repeat: no-repeat;',
  '  -webkit-mask-position: center;',
  '  mask-position: center;',
  '  -webkit-mask-size: 100% 100%;',
  '  mask-size: 100% 100%;',
  '}',
  '',
];
for (const n of names) {
  const uri = maskUri(innerOf(found.get(n).pascal));
  css.push(`.ti-${n} {`);
  css.push(`  -webkit-mask-image: url("data:image/svg+xml,${uri}");`);
  css.push(`  mask-image: url("data:image/svg+xml,${uri}");`);
  css.push('}');
}

const ts = [
  '// 本文件由 scripts/gen-icons.mjs 自动生成，请勿手改。',
  '// 重新生成: node scripts/gen-icons.mjs',
  '',
  '/** 全部可用图标名（kebab-case），与 styles/icons.css 的 .ti-<name> 一一对应 */',
  'export const ICON_NAMES = [',
  ...names.map((n) => `  '${n}',`),
  '] as const;',
  '',
  'export type IconName = (typeof ICON_NAMES)[number];',
  '',
  '/** PascalCase（lucide 命名）-> kebab-case 的映射，供 ToolHeader 等沿用 lucide 名字的调用点使用 */',
  'export const ICON_ALIAS: Record<string, IconName> = {',
  ...names.map((n) => `  ${found.get(n).pascal}: '${n}',`),
  '};',
  '',
];

fs.mkdirSync(path.join(WEBVIEW, 'styles'), { recursive: true });
fs.writeFileSync(path.join(WEBVIEW, 'styles', 'icons.css'), css.join('\n') + '\n');
fs.writeFileSync(path.join(WEBVIEW, 'icons.generated.ts'), ts.join('\n'));

console.log(`[gen-icons] ${names.length} 个图标`);
for (const n of names) {
  const { pascal, files } = found.get(n);
  const shapes = innerOf(pascal).match(/<[a-z]/g)?.length ?? 0;
  console.log(`  ${n.padEnd(20)} ${String(shapes).padStart(2)} 形状   ${[...files].map((f) => f.replace('src/webview/', '')).join(', ')}`);
}
console.log(`\nwrote src/webview/styles/icons.css (${(css.join('\n').length / 1024).toFixed(1)}KB)`);
console.log('wrote src/webview/icons.generated.ts');
