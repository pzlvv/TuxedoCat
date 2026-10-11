/**
 * 文档一致性守卫（`docs/README.md` 的分类法、AGENTS.md 第 0 节的「章节引用对应」）。
 *
 * 契约：文档描述现状，聚合数字不手写维护。本用例把这些做成可执行断言：
 *
 * 1. **事件词汇表一致**：DEVELOPMENT.md 第 3.1 节的汇总表（数量）与 `src/core/AssistantEventBus.ts`
 *    的四组联合类型逐组对照；`CoreEvent` / `CoreRequest` / `UiEvent` 的每个成员名都必须
 *    出现在第 4 章的事件表里（`UiRequest` 的成员按规格落在 `docs/standalone-core.md` 第 10 节）。
 *    新增事件忘了更新文档时直接失败。
 * 2. **文档侧：跨文档引用必须是链接**：全部 markdown 中，内链的文件与 `#anchor` 必须存在
 *    （锚点按 GitHub 的 slug 规则，fixture 见 SLUG_FIXTURES）；「文件名 + 第 N 节」的文字形式
 *    禁止（一律改写成链接）；裸「第 N 节」只允许**同文件自引用**；区间（如「第 1–3 节」）
 *    两端都要落在本文件（或链接目标）。
 * 3. **代码侧：章节引用必须点名目标文件**：`.ts` / `.tsx` / `.rs` / `.mjs` / `.cjs` 中禁止裸
 *    「第 N 节」（读者与工具都无法定位）；「文件名 + 第 N 节」的目标文件与章节必须存在，
 *    枚举（「第 3、4 节」）与区间逐个编号校验。
 * 4. **文档地图覆盖**：`docs/` 下每个规格都在 `docs/README.md` 的地图里登记；每个子目录导读
 *    `<dir>/README.md` 也在地图里（新增 / 移动文档必须更新地图）。
 * 5. **ADR 完整性**：`docs/adr/` 编号连续且唯一、状态取值合法、被取代指向存在的文件。
 * 6. **术语禁别名**：`UIHost` / `UiEvent` 等固化术语命中别名清单即失败。
 * 7. **DEVELOPMENT.md 体积棘轮**：总行数 ≤ 棘轮值，只降不升；主动减体积后手动下调棘轮值。
 *
 * `tmp_*` 临时文件与 `docs/archive/` 冻结档案不参与校验；代码块（fenced / 行内反引号）不参与
 * 文档侧扫描——块内是示例与引用样本，不是文档结构的一部分。
 *
 * 运行方式：npm run test:all -- docs-lint
 */

import * as fs from 'fs';
import * as path from 'path';
import projectConfig from '../config/project.json';
import { createChecker, runTests } from './helpers/harness';

/** 仓库根：编译产物在 `out/src/test/`，往上三层 */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** 不参与扫描的目录（构建产物 / 依赖 / 数据目录）；配置目录名从定义处取（`docs/product-identity.md`） */
const SKIP_DIRS = new Set([
  '.git', '.zcode', 'node_modules', 'out', 'dist', 'dist-electron', 'release',
  'coverage', 'test-results', 'playwright-report', '.vscode-test', 'target',
  'resources', projectConfig.configDir,
]);

const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.rs', '.md', '.mjs', '.cjs']);

function readText(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

/** 列出仓库内参与扫描的文件（相对根的 POSIX 路径）；`tmp_*` 临时文件不属于文档体系 */
function listFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('tmp_')) continue;
      if (entry.name === 'docs' && dir === REPO_ROOT) {
        // docs 全目录参与（README 地图与规格互相引用要校验），archive 除外
        for (const sub of fs.readdirSync(path.join(dir, entry.name), { withFileTypes: true })) {
          if (sub.name === 'archive') continue;
          const full = path.join(dir, entry.name, sub.name);
          if (sub.isDirectory()) walk(full);
          else if (SCAN_EXTENSIONS.has(path.extname(sub.name))) out.push(path.relative(REPO_ROOT, full).replace(/\\/g, '/'));
        }
        continue;
      }
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) out.push(path.relative(REPO_ROOT, full).replace(/\\/g, '/'));
    }
  };
  walk(REPO_ROOT);
  return out;
}

// ---------- GitHub slug 规则（与 github-slugger 对齐的子集：小写、去标点、空格转 -、重名追加 -1） ----------
/**
 * GitHub 生成标题锚点：先小写，删除字母 / 数字 / 记号（\p{M}）以外的标点与符号，
 * 再把空格逐个换成 `-`（**不折叠**连续空格）。VS Code 预览会折叠空格，二者不一致时以 GitHub 为准。
 */
function githubSlug(title: string): string {
  const stripped = title.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N} _-]/gu, '');
  return stripped.replace(/ /g, '-');
}

/** slug 算法 fixture：标题 → 期望锚点（含「连续空格不折叠」与 CJK 用例，防实现漂移） */
const SLUG_FIXTURES: ReadonlyArray<readonly [string, string]> = [
  ['5.9 同一字段的默认值只有一处', '59-同一字段的默认值只有一处'],
  ['3. 核心契约：AssistantEventBus', '3-核心契约assistanteventbus'],
  ['12. 远程服务（`start` / `kill`）', '12-远程服务start--kill'],
  ['5. 译层映射（`host.rs` ⇆ TS 宿主行为）', '5-译层映射hostrs--ts-宿主行为'],
  ['4.3 UiEvent（UI → core，单向）', '43-uieventui--core单向'],
  ['1. 手工转后台：能力', '1-手工转后台能力'],
  ['EP-8 桌面端窗口与标题栏（桌面端）', 'ep-8-桌面端窗口与标题栏桌面端'],
  ['a_b - c', 'a_b---c'],
];

/** markdown 的标题登记表：编号节（`## 4.1 x`）与其锚点，外加全部标题的锚点集合 */
interface HeadingIndex {
  anchors: Set<string>;
  sections: Map<string, { anchor: string; title: string }>;
}

const headingCache = new Map<string, HeadingIndex>();

function headingIndex(rel: string): HeadingIndex {
  const cached = headingCache.get(rel);
  if (cached) return cached;
  const anchors = new Set<string>();
  const sections = new Map<string, { anchor: string; title: string }>();
  const seen = new Map<string, number>();
  let inFence = false;
  for (const line of readText(rel).split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (!m || m[1] === undefined) continue;
    const title = m[1];
    const slug = githubSlug(title);
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    const anchor = n === 0 ? slug : `${slug}-${n}`;
    anchors.add(anchor);
    const num = title.match(/^(\d+(?:\.\d+)*)\.?\s/);
    if (num && num[1] !== undefined) sections.set(num[1], { anchor, title });
  }
  const index: HeadingIndex = { anchors, sections };
  headingCache.set(rel, index);
  return index;
}

/** 解析引用的数字列表：「3.1 / 4.5」→ 枚举，「6–10」→ 区间；分隔符与端点逐个保留 */
function parseNumBlob(blob: string): { numbers: string[]; isInterval: boolean } {
  const numbers: string[] = [];
  let isInterval = false;
  for (const token of blob.split(/[\s/、,]+/)) {
    if (!token) continue;
    const parts = token.split(/[–—-]/).filter((p) => p !== '');
    if (parts.length > 1) isInterval = true;
    numbers.push(...parts);
  }
  return { numbers, isInterval };
}

/** 解析引用目标文件：`docs/…` 是仓库根相对；`../` 相对当前文件；裸名是根文件或 docs 内文件 */
function resolveTargetFile(fromRel: string, fileRef: string): string | null {
  const candidates: string[] = [];
  if (fileRef.startsWith('docs/')) {
    candidates.push(fileRef);
  } else if (fileRef.startsWith('../') || fileRef.startsWith('./') || fileRef.includes('/')) {
    candidates.push(path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), fileRef)));
  } else {
    candidates.push(
      path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), fileRef)),
      fileRef,
      `docs/${fileRef}`,
    );
  }
  for (const candidate of candidates) {
    const full = path.join(REPO_ROOT, candidate);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      return path.relative(REPO_ROOT, full).replace(/\\/g, '/');
    }
  }
  return null;
}

/** 限定引用（「文件名 + 第 N 节/章」，含枚举与区间）与裸引用（「第 N 节/章」） */
const QUALIFIED_REF = /`?((?:docs\/)?[A-Za-z0-9][\w-]*\.md)`?\s*(?:的\s*)?第\s*([0-9][0-9.\s/、,–—-]*?)\s*(节|章)/g;
const BARE_REF = /第\s*([0-9][0-9.\s/、,–—-]*?)\s*(节|章)/g;
const MD_LINK = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function checkNumbers(
  target: string,
  numbers: readonly string[],
  where: string,
  what: string,
  broken: string[],
): void {
  const { sections } = headingIndex(target);
  const missing = numbers.filter((n) => !sections.has(n));
  if (missing.length > 0) broken.push(`${where} ${what}——${target} 无第 ${missing.join(' / ')} 节`);
}

/** 解析 `AssistantEventBus.ts` 里某组联合的成员 type 名单（按 `export type X =` 到下一个顶层声明） */
function unionMemberNames(source: string, unionName: string): string[] {
  const lines = source.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`^export type ${unionName}\\s*=`).test(lines[i])) { start = i + 1; break; }
  }
  if (start < 0) throw new Error(`union ${unionName} not found`);
  const names: string[] = [];
  for (let i = start; i < lines.length; i++) {
    // 下一个顶层声明即联合结束
    if (/^(export |declare )/.test(lines[i])) break;
    const single = lines[i].match(/^\s*\|\s*\{\s*type:\s*'([a-zA-Z]+)'/);
    if (single && single[1] !== undefined) { names.push(single[1]); continue; }
    if (/^\s*\|\s*\{\s*$/.test(lines[i])) {
      // 多行成员：type 在随后几行
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const m = lines[j].match(/^\s*type:\s*'([a-zA-Z]+)'/);
        if (m && m[1] !== undefined) { names.push(m[1]); break; }
      }
    }
  }
  return names;
}

/** 术语与代码一致（AGENTS.md 第 0 节）：固化术语 → 禁止的别名 */
const TERM_ALIASES: ReadonlyArray<readonly [string, RegExp]> = [
  ['UIHost', /\b(?:UiHost|UIhost)\b/],
  ['UiEvent', /\bUIEvent\b/],
  ['UiRequest', /\bUIRequest\b/],
  ['WebViewUI', /\bWebviewUI\b/],
  ['WebViewUiPort', /\b(?:WebViewUIPort|WebviewUiPort)\b/],
  ['sessionRuntime', /\bSessionRuntime\b/],
];

/** DEVELOPMENT.md 体积棘轮（AGENTS.md 第 0 节「控体积」的可执行形态）：只降不升，主动减体积后下调 */
const DEV_LINE_RATCHET = 1237;

function main(): void {
  const checker = createChecker();

  // ---------- 0. slug 算法 fixture ----------
  const slugFailures = SLUG_FIXTURES.filter(([title, expected]) => githubSlug(title) !== expected);
  checker.check(
    `GitHub slug 算法 fixture（${SLUG_FIXTURES.length} 例）`,
    slugFailures.length === 0,
  );
  for (const [title, expected] of slugFailures) {
    console.log(`     「${title}」→「${githubSlug(title)}」，期望「${expected}」`);
  }
  {
    // 重名标题追加 -1
    const probe = '# x\n\n## 重复\n\n## 重复\n';
    const probeFile = path.join(REPO_ROOT, 'tmp_slugprobe.md');
    fs.writeFileSync(probeFile, probe);
    const anchors = headingIndex('tmp_slugprobe.md').anchors;
    fs.rmSync(probeFile);
    headingCache.delete('tmp_slugprobe.md');
    checker.check('重名标题锚点追加 -1', anchors.has('重复') && anchors.has('重复-1'));
  }

  // ---------- 1. 事件词汇表 ----------
  const busSource = readText('src/core/AssistantEventBus.ts');
  const dev = readText('DEVELOPMENT.md');
  const ch4 = dev.split('## 4. 事件列表')[1]?.split('## 5. ')[0] ?? '';
  const standaloneCore = readText('docs/standalone-core.md');

  const counts: Record<string, number> = {};
  for (const union of ['CoreEvent', 'CoreRequest', 'UiEvent', 'UiRequest'] as const) {
    const names = unionMemberNames(busSource, union);
    counts[union] = names.length;

    // 汇总表宣称的数量（两种表式：3.1 的「词汇表|方向|语义|数量」与第 4 章的「组|方向|数量|处理方」）
    const forms = [
      '\\| `' + union + '` \\|[^|]+\\|[^|]+\\| (\\d+) \\|',
      '\\| `' + union + '` \\|[^|]+\\| (\\d+) \\|',
    ];
    const claimed = forms.flatMap((f) =>
      [...dev.matchAll(new RegExp(f, 'g'))].map((m) => Number(m[1])));
    checker.check(
      `${union} 汇总数量 ${claimed.join('/')} 与类型联合一致（实际 ${names.length}）`,
      claimed.length > 0 && claimed.every((c) => c === names.length),
    );

    // 成员名单：前三组以反引号包裹出现在第 4 章事件表；UiRequest 在规格里写作
    // `UiRequest.<name>` 整体，按裸名匹配 standalone-core
    const corpus = union === 'UiRequest' ? standaloneCore : ch4;
    const missing = names.filter((n) => (union === 'UiRequest' ? !corpus.includes(n) : !corpus.includes(`\`${n}\``)));
    checker.check(`${union} 全部 ${names.length} 个成员名都在文档中出现`, missing.length === 0);
    if (missing.length > 0) {
      console.log(`     缺失: ${missing.join(', ')}`);
    }
  }
  const totalClaimed = /共 (\d+) 个事件/.exec(dev);
  const totalActual = counts.CoreEvent + counts.CoreRequest + counts.UiEvent + counts.UiRequest;
  checker.check(
    `「共 N 个事件」总数一致（文档 ${totalClaimed?.[1] ?? '未写'}，实际 ${totalActual}）`,
    totalClaimed !== null && Number(totalClaimed[1]) === totalActual,
  );

  // ---------- 2 / 3. 章节引用（文档侧必须是链接；代码侧必须点名文件） ----------
  const files = listFiles().filter((rel) => rel !== 'src/test/docsLint.test.ts');
  const mdFiles = files.filter((rel) => rel.endsWith('.md'));
  const codeFiles = files.filter((rel) => !rel.endsWith('.md'));

  const brokenRefs: string[] = [];
  for (const rel of mdFiles) {
    const lines = readText(rel).split(/\r?\n/);
    const selfIndex = headingIndex(rel);
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; continue; }
      if (inFence) continue;
      const where = `${rel}:${i + 1}`;
      // 行内代码不是文档结构（AGENTS.md 的约定示例、事件名等都在里面），先移除再扫
      const text = raw.replace(/`[^`\n]*`/g, '``');

      // 2a. markdown 内链：文件与锚点必须存在；链接文本里的章节号也要落在目标文件
      for (const m of text.matchAll(MD_LINK)) {
        const href = m[2];
        if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:')) continue;
        const hashAt = href.indexOf('#');
        const filePart = hashAt >= 0 ? href.slice(0, hashAt) : href;
        const anchor = hashAt >= 0 ? href.slice(hashAt + 1) : null;
        const target = filePart === '' ? rel : resolveTargetFile(rel, decodeURIComponent(filePart));
        if (target === null) {
          brokenRefs.push(`${where} 链接目标不存在：(${href})`);
          continue;
        }
        if (anchor !== null) {
          let decoded = anchor;
          try { decoded = decodeURIComponent(anchor); } catch { /* 原样比对 */ }
          if (!headingIndex(target).anchors.has(decoded)) {
            brokenRefs.push(`${where} 锚点不存在：(${href})`);
          }
        }
        const textNums = [...m[1].matchAll(BARE_REF)].flatMap((n) => parseNumBlob(n[1] ?? '').numbers);
        if (textNums.length > 0) {
          checkNumbers(target, textNums, where, `链接文本「${m[1]}」`, brokenRefs);
        }
      }

      // 2b. 跨文档引用的文字形式禁止（一律写成链接）
      const linkRemoved = text.replace(MD_LINK, ' ');
      const qualifiedSpans: Array<[number, number]> = [];
      for (const m of linkRemoved.matchAll(QUALIFIED_REF)) {
        qualifiedSpans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
        brokenRefs.push(`${where} 跨文档引用必须写成链接：「${m[0].trim()}」`);
      }
      // 2c. 裸「第 N 节」只允许同文件自引用；区间两端都校验
      const overlaps = (start: number, end: number): boolean =>
        qualifiedSpans.some(([a, b]) => start < b && end > a);
      for (const m of linkRemoved.matchAll(BARE_REF)) {
        const start = m.index ?? 0;
        if (overlaps(start, start + m[0].length)) continue;
        const { numbers } = parseNumBlob(m[1] ?? '');
        const missing = numbers.filter((n) => !selfIndex.sections.has(n));
        if (missing.length > 0) {
          brokenRefs.push(`${where} 裸引用必须同文件自引用或写成链接：「${m[0].trim()}」（本文件无第 ${missing.join(' / ')} 节）`);
        }
      }
    }
  }

  // 3. 代码侧：裸引用禁止；限定引用逐个校验
  for (const rel of codeFiles) {
    const lines = readText(rel).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const where = `${rel}:${i + 1}`;
      const line = lines[i];
      const qualifiedSpans: Array<[number, number]> = [];
      for (const m of line.matchAll(QUALIFIED_REF)) {
        qualifiedSpans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
        const target = resolveTargetFile(rel, m[1] ?? '');
        if (target === null) {
          brokenRefs.push(`${where} 引用目标文件不存在：「${m[0].trim()}」`);
          continue;
        }
        checkNumbers(target, parseNumBlob(m[2] ?? '').numbers, where, `「${m[0].trim()}」`, brokenRefs);
      }
      const overlaps = (start: number, end: number): boolean =>
        qualifiedSpans.some(([a, b]) => start < b && end > a);
      for (const m of line.matchAll(BARE_REF)) {
        const start = m.index ?? 0;
        if (overlaps(start, start + m[0].length)) continue;
        brokenRefs.push(`${where} 禁止裸章节引用（点名目标文件）：「${m[0].trim()}」`);
      }
    }
  }
  checker.check(`章节引用全部有效（失效 ${brokenRefs.length} 处）`, brokenRefs.length === 0);
  for (const b of brokenRefs.slice(0, 20)) {
    console.log(`     ${b}`);
  }

  // ---------- 4. 文档地图覆盖 ----------
  const docMap = readText('docs/README.md');
  const docFiles = fs.readdirSync(path.join(REPO_ROOT, 'docs'))
    .filter((f) => f.endsWith('.md') && f !== 'README.md');
  const unmapped = docFiles.filter((f) => !docMap.includes(f));
  checker.check(`docs/README.md 地图覆盖全部规格（缺 ${unmapped.length} 篇）`, unmapped.length === 0);
  for (const f of unmapped) {
    console.log(`     未登记: docs/${f}`);
  }
  // 子目录导读 <dir>/README.md 也在地图里（根 README 与地图自身除外）
  const subReadmes = files.filter((rel) => rel.endsWith('/README.md') && rel !== 'docs/README.md');
  const unmappedReadmes = subReadmes.filter((rel) => !docMap.includes(rel));
  checker.check(`子目录导读全部登记进地图（${subReadmes.length} 篇，缺 ${unmappedReadmes.length}）`, unmappedReadmes.length === 0);
  for (const rel of unmappedReadmes) {
    console.log(`     未登记: ${rel}`);
  }

  // ---------- 5. ADR 完整性 ----------
  const adrDir = path.join(REPO_ROOT, 'docs/adr');
  const adrFiles = fs.readdirSync(adrDir)
    .filter((f) => /^\d{4}-[a-z0-9-]+\.md$/.test(f))
    .sort();
  const adrNumbers = adrFiles.map((f) => Number(f.slice(0, 4)));
  const consecutive = adrNumbers.every((n, i) => n === i + 1);
  checker.check(`ADR 编号连续且唯一（${adrFiles.length} 篇）`, consecutive);
  const adrProblems: string[] = [];
  for (const f of adrFiles) {
    const content = readText(`docs/adr/${f}`);
    const status = /^- 状态：(.+)$/m.exec(content)?.[1]?.trim() ?? '';
    if (!status.startsWith('已采纳') && !status.startsWith('被取代')) {
      adrProblems.push(`docs/adr/${f}: 状态取值非法「${status}」（应为 已采纳 / 被取代）`);
    }
    if (status.startsWith('被取代')) {
      const supersededBy = /(?:Superseded by|被取代[：:])\s*(?:ADR-)?(\d{4})/.exec(content)?.[1];
      const target = supersededBy === undefined
        ? null
        : adrFiles.find((x) => x.startsWith(supersededBy));
      if (target === undefined || target === null) {
        adrProblems.push(`docs/adr/${f}: 被取代指向的 ADR 不存在`);
      }
    }
  }
  checker.check('ADR 状态取值与被取代指向合法', adrProblems.length === 0);
  for (const p of adrProblems) {
    console.log(`     ${p}`);
  }

  // ---------- 6. 术语禁别名 ----------
  const aliasHits: string[] = [];
  for (const rel of mdFiles) {
    const lines = readText(rel).split(/\r?\n/);
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; continue; }
      if (inFence) continue;
      for (const [term, alias] of TERM_ALIASES) {
        if (alias.test(raw)) aliasHits.push(`${rel}:${i + 1} ${term} 的别名（应用「${term}」）`);
      }
    }
  }
  checker.check(`固化术语无别名（命中 ${aliasHits.length} 处）`, aliasHits.length === 0);
  for (const h of aliasHits.slice(0, 20)) {
    console.log(`     ${h}`);
  }

  // ---------- 7. DEVELOPMENT.md 体积棘轮 ----------
  const devLines = dev.split(/\r?\n/).length;
  checker.check(
    `DEVELOPMENT.md 行数 ${devLines} ≤ 棘轮 ${DEV_LINE_RATCHET}（只降不升）`,
    devLines <= DEV_LINE_RATCHET,
  );

  checker.finish();
}

runTests('docsLint', main);
