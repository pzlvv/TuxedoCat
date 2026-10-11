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
 * 8. **聚合数字不手写（扩界）**：`UIHost` / `WebViewUiPort` / uiPort 窄端口 / webview 消息
 *    类型 / `onCoreEvents` 映射表的成员名与数量从代码提取，对照 `docs/contracts.md` /
 *    `docs/webview-ui.md` 的宣称值——代码加了成员而文档数字没跟上时失败。
 * 9. **文档路径存在性**：markdown 行内代码里 `src/` / `docs/` / `core-rs/` / `electron/` 等
 *    前缀的仓库路径必须存在（行内代码整体不参与章节引用扫描，但路径是「指得到的东西」，
 *    单独校验；含通配符 / 占位符的写法不在此列）。
 * 10. **UiEvent 命名风格**：全小写驼峰、过去式、无 `on` 前缀、无命令式动词开头
 *     （AGENTS.md 第 3 节；`AssistantEventBus.ts` 的联合逐成员检查）。
 * 11. **CoreEvent 触发点列**：DEVELOPMENT.md 4.1 表的「core 侧触发点」列里反引号模块名
 *     与真实 emit 位点（`src/core` 里 `emitToUi` 的所在文件）逐事件对照——重构挪动了
 *     emit 位点而没改表时失败。 UiEvent（4.3，宿主侧发起）不在此列。
 * 12. **契约可选成员冻结**：铁律 4.2 禁止 `?`；`AssistantEventBus.ts` 联合与结果映射里
 *     现存的可选字段冻结于豁免清单，出现清单之外的可选字段即失败（新字段改用
 *     `null` / 判别联合，或评审后显式扩清单）。
 * 13. **常量引用存活**：文档行内代码里引用的全大写常量 / 环境变量名必须仍出现在代码里
 *     （含 `src/config/project.json` 的键）——常量改名 / 删除而文档没跟上时失败。
 * 14. **事件载荷列逐字段对照**：第 4.1 / 4.2 / 4.3 表的「载荷」列逐行解析字段名，与
 *     `AssistantEventBus.ts` 对应联合成员的顶层字段双向对照——成员名检查是「出现在第 4 章
 *     任意位置」级别，同名成员在别的行出现即通过；载荷列这里补上逐行口径
 *     （`userMessageSubmitted.workspacePath` 就是这类漂移的实例）。
 * 15. **反引号标识符存活**：文档行内代码里的标识符（小驼峰 / 大驼峰，非全大写）必须出现在
 *     代码里；`模块.函数` 形式的引用解析到同名模块文件后逐符号校验——函数改名 / 模块不存在
 *     而文档没跟上时失败（`registerWorkspaceUiEvents` / `updateHeader` 是实例）。
 * 16. **文档内代码块来源标注**：含 `export` / 顶层声明的 fenced 代码块必须标注 `src=<路径>`
 *     （或标「示意」豁免）；标注后块内声明名、方法调用名、`export function` 的 async 旗标
 *     与真实文件逐项比对——文档手抄代码与实现脱节时失败（3.6 的签名漂移是实例）。
 * 17. **清单对照扩界**：`SettingsSnapshot` 字段表（`core-ui-separation.md` 4.3）、
 *     `SpinDesign` / `ConversationManager` 成员表（`contracts.md` §2 / §4）、`WebViewUI`
 *     对外方法表（`webview-ui.md` §4）与对应接口 / 类的成员双向对照——手抄清单漏行时失败。
 * 18. **US ↔ e2e 映射双向对照**：`user-stories.md` 附录表与 `e2e` 下各 spec 文件实际的
 *     `US-xx` 引用逐文件双向一致（多列 / 少列 / 引用不存在的 US 都失败）。
 * 19. **npm run 脚本名存活**：文档行内代码里的 `npm run <script>` 必须存在于
 *     `package.json` scripts（TODO.md 除外——它描述的是尚未做的）。
 * 20. **打包平台集合单源**：`scripts/build-core.mjs` 的 `PACKAGE_DIRS` 平台目录名必须全部
 *     出现在 `README.md`（README 手写平台清单而脚本扩平台时失败）。
 * 21. **禁「表 #N」行号引用**：代码注释与文档禁止「表 #N / 表格 #N」写法——事件表重编号时
 *     行号引用静默腐烂（`表 #32` / `#41` 是实例），一律点名事件名。
 * 22. **specs/ 改动规格结构**：`specs/<NNN>-<slug>/` 三件套齐全（spec 或 defect + plan +
 *     tasks）、H1 前缀、必填章节、FR / AC / T 编号与覆盖（tasks 覆盖全部 FR、追溯矩阵
 *     逐 FR 一行、AC 回指 FR 且为 GIVEN / WHEN / THEN 一行式）、plan 宪章检查四项义务、
 *     status 取值合法、`[待澄清]` 标记必须带去向链接且实施中 / 已收敛清零（口径见
 *     `specs/README.md`）；编号与 `docs/archive/specs/` 已归档编号不复用。
 * 23. **主题规格 frontmatter**：`docs/` 顶层规格（README.md 地图除外）必须带 owner /
 *     last_reviewed（YYYY-MM-DD）——规格所有权与新鲜度的可执行下限；引用源码的时间
 *     对比是独立报告（`scripts/docs-freshness.mjs`，只出报告不进门禁）。
 *
 * `tmp_*` 临时文件、`docs/archive/` 冻结档案与 `specs/_templates/` 模板不参与校验；
 * 代码块（fenced / 行内反引号）不参与
 * 文档侧扫描——块内是示例与引用样本，不是文档结构的一部分（例外：第 16 项对标注 `src=` 的
 * fenced 块做与真实文件的比对）。
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

/**
 * 描述「尚未落地内容」的文档（specs/README.md 守卫口径）：TODO.md 与 specs/。
 * 存在性类检查（行内代码路径、常量 / 标识符、npm run 脚本名）豁免——spec 与待办引用
 * 的路径、脚本、常量尚未存在是常态；落地后由 docs/ 的全量对照兜底。
 */
const FUTURE_WORK_DOC = (rel: string): boolean => rel === 'TODO.md' || rel.startsWith('specs/');

function readText(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

/** 列出仓库内参与扫描的文件（相对根的 POSIX 路径）；`tmp_*` 临时文件不属于文档体系 */
function listFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('tmp_')) continue;
      if (entry.name === '_templates') continue; // specs/_templates/ 模板不参与校验（保留目录名）
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

/**
 * 取 marker 之后第一个 `{` 的配平块，收集其中的成员名（`name(` 方法 / `name:` 属性）。
 * 用于把「接口 / 对象类型字面量有多少成员」从代码推导出来（AGENTS.md 第 0 节
 * 「聚合数字不手写」），对照文档宣称值。括号深度计数跳过多行签名里的参数行
 * （如 `postConversationLoaded(\n  sessionId: string, …)` 的参数不是成员）。
 */
function blockMemberNames(source: string, marker: RegExp): string[] {
  const from = source.search(marker);
  if (from < 0) throw new Error(`marker not found: ${marker}`);
  const open = source.indexOf('{', from);
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  const names: string[] = [];
  let parenDepth = 0;
  for (const rawLine of source.slice(open, end).split('\n')) {
    const member = parenDepth === 0 ? /^\s+(?:readonly )?([a-zA-Z0-9_]+)\s*[(:;]/.exec(rawLine) : null;
    if (member && member[1] !== undefined) names.push(member[1]);
    for (const ch of rawLine) {
      if (ch === '(') parenDepth += 1;
      else if (ch === ')') parenDepth -= 1;
    }
  }
  return names;
}

// ---------- 共享：去注释（联合成员字段提取用） ----------
/** 去掉块注释与整行行注释——字段名必须从代码而非注释文本里提取 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** 取 `from` 之后第一个 `{` 的配平块（含两端花括号）——接口 / 类体提取用 */
function balancedBlock(source: string, from: number): string {
  const open = source.indexOf('{', from);
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  return source.slice(open, end + 1);
}

/**
 * 块内**第一层深度**的字段名（区别于 `blockMemberNames` 的拍平行为：
 * 嵌套对象字面量里的同名字段不计）。
 */
function depthOneFieldNames(blockText: string): string[] {
  const fields: string[] = [];
  let depth = 0;
  for (const line of blockText.split('\n')) {
    const m = /^\s+(?:readonly\s+)?([a-zA-Z0-9_]+)\s*[(:;]/.exec(line);
    if (m && m[1] !== undefined && depth === 1) fields.push(m[1]);
    for (const ch of line) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
  }
  return fields;
}

/** 类 / abstract class 的类级成员名（2 空格缩进行；方法体内部的行更深，不会命中） */
function classMemberNames(source: string, declMarker: RegExp): string[] {
  const at = source.search(declMarker);
  if (at < 0) throw new Error(`class marker not found: ${declMarker}`);
  const names: string[] = [];
  for (const line of balancedBlock(source, at).split('\n')) {
    if (/^ {2}(?:static|private)\b/.test(line)) continue;
    const m = /^ {2}(?:abstract\s+|protected\s+|async\s+)*(?:async\s+)?([a-zA-Z_][A-Za-z0-9_]*)\s*[(<]/.exec(line);
    if (m && m[1] !== undefined) names.push(m[1]);
  }
  return names;
}

/**
 * 解析 `AssistantEventBus.ts` 里某组联合的每个成员的**载荷字段**（第 14 项）：
 * type 名 → 顶层字段名数组。只收成员对象第一层深度上的 `name:` ——嵌套对象字面量
 * （`images?` 的元素、`result` / `change` 的判别联合分支）里的同名字段不计。
 */
function unionMemberFields(source: string, unionName: string): Map<string, string[]> {
  const lines = stripComments(source).split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`^export type ${unionName}\\s*=`).test(lines[i])) { start = i + 1; break; }
  }
  if (start < 0) throw new Error(`union ${unionName} not found`);
  const result = new Map<string, string[]>();
  const fieldsOf = (memberText: string): string[] => {
    const fields: string[] = [];
    for (const m of memberText.matchAll(/\b([a-zA-Z][a-zA-Z0-9_]*)\??\s*:/g)) {
      const name = m[1];
      if (name === undefined || name === 'type') continue;
      let depth = 0;
      for (const ch of memberText.slice(0, m.index)) {
        if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
      }
      if (depth === 0) fields.push(name);
    }
    return fields;
  };
  let memberText: string | null = null;
  let memberType = '';
  let depth = 0;
  const flush = (): void => {
    if (memberText === null) return;
    // type 名从完整成员文本提取（多行成员的 `type:` 不在首行）
    const t = memberText.match(/type:\s*'([a-zA-Z]+)'/);
    result.set(t && t[1] !== undefined ? t[1] : memberType, fieldsOf(memberText));
    memberText = null;
    memberType = '';
  };
  for (let i = start; i < lines.length; i++) {
    if (/^(export |declare )/.test(lines[i])) break;
    const opened = lines[i].match(/^\s*\|\s*\{(.*)$/);
    if (opened && memberText === null) {
      memberText = opened[1] ?? '';
      memberType = memberText.match(/type:\s*'([a-zA-Z]+)'/)?.[1] ?? '';
      depth = 1;
      for (const ch of memberText) {
        if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
      }
      if (depth <= 0) flush();
      continue;
    }
    if (memberText !== null) {
      memberText += `\n${lines[i]}`;
      for (const ch of lines[i]) {
        if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
      }
      if (depth <= 0) flush();
    }
  }
  flush();
  return result;
}

/** 解析事件表「载荷」列的字段名：顶层逗号切分，每段取第一个反引号 token 的 `:` 前半（去 `?`） */
function payloadFields(cell: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of cell) {
    if (ch === '(' || ch === '（') depth += 1;
    else if (ch === ')' || ch === '）') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  const fields: string[] = [];
  for (const part of parts) {
    const token = part.match(/`([^`]+)`/)?.[1];
    if (token === undefined) continue;
    const name = token.split(/[:：]/)[0]?.trim().replace(/\?$/, '') ?? '';
    if (/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) fields.push(name);
  }
  return fields;
}

/** 解析第 4.x 节的事件表行：表头定位「`type`」与「载荷」列，逐行取事件名与载荷字段 */
function parseEventRows(section: string): Array<{ type: string; payload: string[] }> {
  const rows: Array<{ type: string; payload: string[] }> = [];
  let typeCol = -1;
  let payloadCol = -1;
  for (const line of section.split('\n')) {
    if (!/^\|/.test(line)) continue;
    const cells = line.split(/(?<!\\)\|/).map((c) => c.trim());
    if (cells.every((c) => /^-*$/.test(c))) continue; // 分隔行
    const headerType = cells.findIndex((c) => c === '`type`');
    if (headerType >= 0 && cells.includes('载荷')) {
      typeCol = headerType;
      payloadCol = cells.indexOf('载荷');
      continue;
    }
    if (typeCol < 0) continue;
    if (!/^\d+$/.test(cells[1] ?? '')) continue; // 事件行都有 # 列；节尾的对照表（首列是散文）不算
    const type = (cells[typeCol] ?? '').replace(/`/g, '');
    if (/^[a-zA-Z]+$/.test(type)) rows.push({ type, payload: payloadFields(cells[payloadCol] ?? '') });
  }
  return rows;
}

/**
 * 扫 `src/core` 里全部 `emitToUi(` 调用（含多行字面量：事件名取调用点后 300 字符窗口内
 * 的 `type: '...'`），产出 事件名 → 发出文件的模块名（相对 `src/core`、去 `.ts`），
 * 以及全部模块名的集合（触发点列的「模块宇宙」）。
 * 事件名不在调用点的（变量传播）抓不到——当前词汇表没有这种写法，出现时这里会
 * 表现为「文档列了模块而代码抓不到」，按漂移暴露。
 */
function coreEmitModules(): { emits: Map<string, Set<string>>; universe: Set<string> } {
  const emits = new Map<string, Set<string>>();
  const universe = new Set<string>();
  const coreDir = path.join(REPO_ROOT, 'src', 'core');
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ts') || entry.name.includes('.test.') || entry.name === 'AssistantEventBus.ts') continue;
      universe.add(path.relative(coreDir, full).split(path.sep).join('/').replace(/\.ts$/, ''));
      const src = fs.readFileSync(full, 'utf-8');
      let at = 0;
      for (;;) {
        const found = src.indexOf('emitToUi(', at);
        if (found < 0) break;
        const m = src.slice(found, found + 300).match(/type: '([a-zA-Z]+)'/);
        if (m && m[1] !== undefined) {
          const module = path.relative(coreDir, full).split(path.sep).join('/').replace(/\.ts$/, '');
          const set = emits.get(m[1]) ?? new Set<string>();
          set.add(module);
          emits.set(m[1], set);
        }
        at = found + 'emitToUi('.length;
      }
    }
  };
  walk(coreDir);
  return { emits, universe };
}

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

  // ---------- 8. 聚合数字不手写（扩界）：契约成员 / 消息类型 / 映射表 ----------
  const contracts = readText('docs/contracts.md');
  const webviewUi = readText('docs/webview-ui.md');
  const uiHostSrc = readText('src/host/UIHost.ts');
  const portsSrc = readText('src/host/ui/ports.ts');
  const handlerSrc = readText('src/host/ui/webviewMessageHandler.ts');
  const webViewUiSrc = readText('src/host/WebViewUI.ts');

  const uiHostSelf = blockMemberNames(uiHostSrc, /export interface UIHost\b/);
  const workspaceProvider = blockMemberNames(uiHostSrc, /export interface WorkspaceProvider\b/);
  const hostClaim = /共 (\d+) 个：`UIHost` 自身 (\d+) 个 \+ 继承 `WorkspaceProvider` 的 (\d+) 个/.exec(contracts);
  checker.check(
    `contracts.md 的 UIHost 成员数（代码：自身 ${uiHostSelf.length} + 继承 ${workspaceProvider.length}）与宣称一致`,
    hostClaim !== null
    && Number(hostClaim[1]) === uiHostSelf.length + workspaceProvider.length
    && Number(hostClaim[2]) === uiHostSelf.length
    && Number(hostClaim[3]) === workspaceProvider.length,
  );
  const carriedClaim = /`UIHost` 已承载 (\d+) 个成员/.exec(contracts);
  checker.check(
    'contracts.md 第 2 节的 UIHost 成员数与代码一致',
    carriedClaim !== null && Number(carriedClaim[1]) === uiHostSelf.length,
  );

  const uiPortMembers = blockMemberNames(handlerSrc, /uiPort\?: \{/);
  const uiPortClaim = /窄端口 `uiPort`（只声明自己用到的 (\d+) 个成员）/.exec(contracts);
  checker.check(
    `contracts.md 的 uiPort 窄端口成员数与代码一致（实际 ${uiPortMembers.length}）`,
    uiPortClaim !== null && Number(uiPortClaim[1]) === uiPortMembers.length,
  );

  const webViewUiPort = blockMemberNames(portsSrc, /export interface WebViewUiPort\b/);
  const missingPort = webViewUiPort.filter((n) => !contracts.includes(`\`${n}(`));
  checker.check(
    `WebViewUiPort 全部 ${webViewUiPort.length} 个成员名都在 contracts.md 出现`,
    missingPort.length === 0,
  );
  for (const n of missingPort) {
    console.log(`     缺失: ${n}`);
  }

  const entryCount = (handlerSrc.match(/entry\('/g) ?? []).length;
  const msgClaim = /(\d+) 个消息类型/.exec(contracts);
  checker.check(
    `contracts.md 的 webview 消息类型数与 buildMessageHandlers 一致（实际 ${entryCount}）`,
    msgClaim !== null && Number(msgClaim[1]) === entryCount,
  );

  const coreHandlerKeys = blockMemberNames(webViewUiSrc, /private buildCoreEventHandlers/);
  const onCoreEventsClaim = /\| `onCoreEvents` \| (\d+) \|/.exec(webviewUi);
  checker.check(
    `webview-ui.md 的 onCoreEvents 数量与 WebViewUI 映射表一致（实际 ${coreHandlerKeys.length}）`,
    onCoreEventsClaim !== null && Number(onCoreEventsClaim[1]) === coreHandlerKeys.length,
  );
  const renderClaim = /(\d+) 个渲染（/.exec(webviewUi);
  const controlClaim = /(\d+) 个控制面与事实通知（/.exec(webviewUi);
  checker.check(
    'webview-ui.md 渲染 + 控制面分区数之和与映射表总数一致',
    renderClaim !== null && controlClaim !== null
    && Number(renderClaim[1]) + Number(controlClaim[1]) === coreHandlerKeys.length,
  );
  const eventsRow = webviewUi.split('\n').find((l) => l.includes('`onCoreEvents` |')) ?? '';
  const listedEvents = new Set(
    [...eventsRow.matchAll(/`([a-zA-Z]+)`/g)].map((m) => m[1]).filter((t) => t !== 'onCoreEvents'),
  );
  const keySet = new Set(coreHandlerKeys);
  const unlisted = coreHandlerKeys.filter((k) => !listedEvents.has(k));
  const phantom = [...listedEvents].filter((t) => !keySet.has(t));
  checker.check(
    `onCoreEvents 名单双向一致（缺 ${unlisted.length} / 多 ${phantom.length}）`,
    unlisted.length === 0 && phantom.length === 0,
  );
  for (const k of unlisted) console.log(`     代码有、文档未列: ${k}`);
  for (const t of phantom) console.log(`     文档列了、代码没有: ${t}`);

  // ---------- 9. 行内代码里的仓库路径必须存在 ----------
  const REPO_PATH_PREFIX = /^(?:src|docs|specs|core-rs|electron|tui-rs|scripts|e2e|installer-rs|assets|resources)\//;
  const brokenPaths: string[] = [];
  for (const rel of mdFiles) {
    // TODO.md 与 specs/ 描述的是**计划**（如「新增 docs/guide/」），路径尚不存在是常态，不参与本检查
    if (FUTURE_WORK_DOC(rel)) continue;
    const lines = readText(rel).split(/\r?\n/);
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; continue; }
      if (inFence) continue;
      // 链接的 href 已由第 2 项校验；这里只看行内代码里的裸路径
      const linkRemoved = raw.replace(MD_LINK, ' ');
      for (const m of linkRemoved.matchAll(/`([^`\n]+)`/g)) {
        const token = m[1] ?? '';
        if (!token.includes('/') || !REPO_PATH_PREFIX.test(token)) continue;
        if (/[<>*[\]\s]/.test(token) || token.includes('...')) continue; // 通配 / 占位符不是具体路径
        // `path.rs::symbol`（测试名 / 导出符号）与 `path.md#锚点` 都只校验文件部分
        const filePart = token.split('::')[0].split('#')[0].replace(/\/+$/, '');
        if (filePart !== '' && !fs.existsSync(path.join(REPO_ROOT, filePart))) {
          brokenPaths.push(`${rel}:${i + 1} 路径不存在：\`${token}\``);
        }
      }
    }
  }
  checker.check(`行内代码里的仓库路径全部存在（失效 ${brokenPaths.length} 处）`, brokenPaths.length === 0);
  for (const b of brokenPaths.slice(0, 20)) {
    console.log(`     ${b}`);
  }

  // ---------- 10. UiEvent 命名风格（AGENTS.md 第 3 节） ----------
  const COMMAND_VERB = /^(?:set|update|open|clear|refresh|toggle|show|hide|apply|reset|sync|init|register|send|push|mark|load|save|close|start|stop|begin)[A-Z]/;
  const namingProblems = unionMemberNames(busSource, 'UiEvent')
    .map((name) => {
      if (!/^[a-z][a-zA-Z0-9]*$/.test(name)) return `${name}：不是全小写驼峰`;
      if (/^on/.test(name)) return `${name}：带 on 前缀`;
      if (COMMAND_VERB.test(name)) return `${name}：命令式动词开头（UiEvent 用过去式）`;
      return null;
    })
    .filter((p): p is string => p !== null);
  checker.check(`UiEvent 命名风格（违规 ${namingProblems.length} 处）`, namingProblems.length === 0);
  for (const p of namingProblems) {
    console.log(`     ${p}`);
  }

  // ---------- 11. CoreEvent 触发点列与真实 emit 位点对照 ----------
  const { emits, universe } = coreEmitModules();
  const ch41 = ch4.slice(ch4.indexOf('### 4.1'), ch4.indexOf('### 4.2'));
  const triggerProblems: string[] = [];
  let previousDocumented = new Set<string>();
  for (const line of ch41.split('\n')) {
    if (!/^\| \d+ \|/.test(line)) continue;
    const cols = line.split('|');
    const type = (cols[2] ?? '').trim().replace(/`/g, '');
    const triggerCell = (cols[4] ?? '').trim();
    // 触发点列的约定：模块名一律反引号包裹、形如 `Query` / `history/Conversation`；
    // 括号里的散文说明（事件名、设置键、其它文档）不参与对照。判定按三档：
    // 含 `/` 或大写开头且在模块宇宙里 → 模块；形状像模块但宇宙里没有 → 拼写漂移；
    // 其余（小写开头的事件名 / 键名）→ 忽略。`同上` 沿用上一行的清单。
    const classified = (token: string): 'module' | 'phantom' | 'ignore' => {
      if (!/^[A-Za-z][A-Za-z0-9]*(\/[A-Za-z0-9]+)*$/.test(token)) return 'ignore';
      if (token.includes('/') || /^[A-Z]/.test(token)) return universe.has(token) ? 'module' : 'phantom';
      return universe.has(token) ? 'module' : 'ignore';
    };
    let documented: Set<string>;
    let phantoms: string[];
    if (triggerCell === '同上') {
      documented = previousDocumented;
      phantoms = [];
    } else {
      documented = new Set();
      phantoms = [];
      for (const m of triggerCell.matchAll(/`([^`]+)`/g)) {
        const token = m[1];
        if (token === undefined) continue;
        const kind = classified(token);
        if (kind === 'module') documented.add(token);
        else if (kind === 'phantom') phantoms.push(token);
      }
    }
    previousDocumented = documented;
    const actual = emits.get(type) ?? new Set<string>();
    const missing = [...actual].filter((m) => !documented.has(m)).sort();
    if (missing.length > 0 || phantoms.length > 0) {
      triggerProblems.push(
        `#${type} 触发点列与 emit 位点不一致（缺 ${missing.join(' / ') || '—'}，写错 ${phantoms.join(' / ') || '—'}）`,
      );
    }
  }
  checker.check(`4.1 触发点列与真实 emit 位点一致（漂移 ${triggerProblems.length} 处）`, triggerProblems.length === 0);
  for (const p of triggerProblems) {
    console.log(`     ${p}`);
  }

  // ---------- 12. 契约可选成员冻结（铁律 4.2 的现状豁免清单） ----------
  // 存量豁免（只减不增；新增可选成员必须改用 null / 判别联合，或评审后显式扩清单）：
  // - `userMessageSubmitted`：images / filePath / fileSelectedLines / fileHidden /
  //   agentMode / thinkingMode / model / webSearch / workspacePath / deferEcho
  //   （宿主按 wire 组装，字段缺省即「本次消息没带」，与「值为 null」语义不同）；
  // - `editRolledBack`：filePath（`input.file_path` 缺失时的兜底路径）；
  // - `CoreRequestResultMap.userChoice`：reply（用户可写附言）；
  // - `UiRequest`：conversationListRequested.workspacePath、balanceRequested /
  //   mcpServersRequested / skillsRequested 的 sessionId（无会话上下文的请求不带）；
  // - `images` 元素的 mediaType / width / height（dataUrl 自带类型与尺寸时的省写）。
  const OPTIONAL_FIELD_ALLOWLIST = new Set([
    'images', 'mediaType', 'width', 'height', 'filePath', 'fileSelectedLines', 'fileHidden',
    'agentMode', 'thinkingMode', 'model', 'webSearch', 'workspacePath', 'deferEcho', 'reply',
    'sessionId',
  ]);
  const optionalFieldHits = [...busSource.matchAll(/\b([a-zA-Z]+)\?:/g)]
    .map((m) => m[1] ?? '')
    .filter((name) => !OPTIONAL_FIELD_ALLOWLIST.has(name));
  checker.check(
    `契约可选成员冻结（清单外 ${optionalFieldHits.length} 处）`,
    optionalFieldHits.length === 0,
  );
  for (const name of new Set(optionalFieldHits)) {
    console.log(`     新增可选字段未走豁免清单: ${name}?`);
  }

  // ---------- 13. 常量引用存活 ----------
  // 文档行内代码里引用的全大写名（常量 / 环境变量 / 工程配置键）必须仍出现在代码里：
  // 常量改名 / 删除而文档没跟上时失败（STREAM_CAP_CHARS 就是这类漂移的实例）。
  // 值不在此校验——文档里的值是给人读的散文（「2 小时」），逐字对照会破坏可读性。
  const CAPS_TOKEN = /\b[A-Z][A-Z0-9_]{2,}\b/g;
  const isCapsName = (token: string): boolean => /^[A-Z][A-Z0-9_]{2,}$/.test(token);
  const codeUniverse = new Set<string>();
  for (const rel of [...codeFiles, 'src/config/project.json']) {
    for (const m of readText(rel).matchAll(CAPS_TOKEN)) {
      if (m[0] !== undefined) codeUniverse.add(m[0]);
    }
  }
  const missingConsts: string[] = [];
  for (const rel of mdFiles) {
    // TODO.md 与 specs/ 描述的是尚未做的，引用不存在的名字是常态
    if (FUTURE_WORK_DOC(rel)) continue;
    const lines = readText(rel).split(/\r?\n/);
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; continue; }
      if (inFence) continue;
      for (const m of raw.replace(MD_LINK, ' ').matchAll(/`([^`\n]+)`/g)) {
        const token = m[1] ?? '';
        if (!isCapsName(token)) continue;
        if (!codeUniverse.has(token)) {
          missingConsts.push(`${rel}:${i + 1} 引用的名字在代码里不存在：\`${token}\``);
        }
      }
    }
  }
  checker.check(`文档引用的常量 / 环境变量名全部存活（失效 ${missingConsts.length} 处）`, missingConsts.length === 0);
  for (const b of missingConsts.slice(0, 20)) {
    console.log(`     ${b}`);
  }

  // ---------- 14. 事件载荷列与联合类型逐字段对照 ----------
  {
    const sections: Array<[string, string]> = [
      ['CoreEvent', '### 4.1'],
      ['CoreRequest', '### 4.2'],
      ['UiEvent', '### 4.3'],
    ];
    const payloadProblems: string[] = [];
    for (const [unionName, marker] of sections) {
      const from = ch4.indexOf(marker);
      const next = ch4.indexOf('\n### ', from + 1);
      const section = ch4.slice(from, next < 0 ? undefined : next);
      const documented = new Map(parseEventRows(section).map((r) => [r.type, r.payload]));
      const actual = unionMemberFields(busSource, unionName);
      for (const [type, fields] of actual) {
        const docFields = documented.get(type);
        if (docFields === undefined) {
          payloadProblems.push(`${unionName}.${type} 不在 ${marker} 表中`);
          continue;
        }
        const missing = fields.filter((f) => !docFields.includes(f));
        const extra = docFields.filter((f) => !fields.includes(f));
        if (missing.length > 0 || extra.length > 0) {
          payloadProblems.push(
            `${unionName}.${type} 载荷列与联合不一致（缺 ${missing.join(' / ') || '—'}，多 ${extra.join(' / ') || '—'}）`,
          );
        }
      }
      for (const type of documented.keys()) {
        if (!actual.has(type)) payloadProblems.push(`${marker} 表列了不存在的成员 ${type}`);
      }
    }
    checker.check(`事件载荷列与联合类型逐字段一致（漂移 ${payloadProblems.length} 处）`, payloadProblems.length === 0);
    for (const p of payloadProblems) console.log(`     ${p}`);
  }

  // ---------- 15. 反引号标识符存活 ----------
  {
    const identifierUniverse = new Set<string>();
    /** TS 文件模块 basename（无扩展名）→ 内容（`模块.符号` 引用按此解析，含一层 extends 基类）。
     * 只收 TS：Rust 与 TS 常有同名模块（`llm` / `config` / `host`），文档里的点引用
     * 多是 TS 键路径或实例调用，跨语言同名会让模块级校验变成误报源。 */
    const fileModules = new Map<string, string[]>();
    for (const rel of codeFiles) {
      const text = readText(rel);
      for (const m of text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]+\b/g)) {
        if (m[0] !== undefined) identifierUniverse.add(m[0]);
      }
      if (!/\.(?:test\.)?tsx?$/.test(rel)) continue; // 点引用只对 TS 模块做精确校验
      const base = (rel.split('/').pop() ?? '').replace(/\.(?:test\.)?tsx?$/, '');
      if (base !== '') {
        identifierUniverse.add(base); // 模块名本身（如 `coreEventParity`）也是合法引用
        const list = fileModules.get(base) ?? [];
        list.push(text);
        fileModules.set(base, list);
      }
    }
    // 只减不增：确实只存在于文档的概念在此豁免——
    // 反面教材点名（「架构中不设 X」）与外部产品名；
    const IDENT_EXEMPT = new Set<string>([
      'Playwright',
      'WebViewEventBus', 'WebViewNotifier', 'WebViewController', 'AssistantNotifier', 'AssistantController',
    ]);
    // `前缀.符号` 里不是模块引用的键路径 / 内置 API / 打包产物名
    const DOTTED_EXEMPT = new Set<string>(['core.binaryName', 'core.deployPrefix', 'path.relative', 'app.asar']);
    const KNOWN_EXT = new Set(['ts', 'tsx', 'js', 'mjs', 'cjs', 'rs', 'json', 'md', 'html', 'css']);
    const identProblems: string[] = [];
    for (const rel of mdFiles) {
      if (FUTURE_WORK_DOC(rel)) continue; // TODO 与 specs/ 描述尚未做的
      const lines = readText(rel).split(/\r?\n/);
      let inFence = false;
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; continue; }
        if (inFence) continue;
        for (const m of raw.replace(MD_LINK, ' ').matchAll(/`([^`\n]+)`/g)) {
          const token = m[1] ?? '';
          const dotted = token.match(/^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/);
          if (dotted && dotted[1] !== undefined && dotted[2] !== undefined) {
            const [prefix, symbol] = [dotted[1], dotted[2]];
            if (KNOWN_EXT.has(symbol)) continue; // `engine.rs` / `sessionRuntime.ts` 是文件名
            if (DOTTED_EXEMPT.has(token)) continue;
            const texts = fileModules.get(prefix);
            if (texts === undefined) {
              // 前缀不是文件模块（实例变量 / 目录 / 内置对象如 `shell.openExternal`）：
              // 只查符号是否在全库存在
              if (!identifierUniverse.has(symbol)) {
                identProblems.push(`${rel}:${i + 1} ${prefix}.${symbol}：符号在代码里不存在`);
              }
              continue;
            }
            if (!texts.some((t) => new RegExp(`\\b${symbol}\\b`).test(t))) {
              // 命中继承链（子类文件里引用基类成员）不算漂移：查一层 extends 基类
              const bases = new Set<string>();
              for (const t of texts) {
                for (const b of t.matchAll(/extends\s+([A-Za-z0-9_]+)/g)) {
                  if (b[1] !== undefined) bases.add(b[1]);
                }
              }
              const baseTexts = [...bases].flatMap((b) => fileModules.get(b) ?? []);
              // 模块未命中但全库存在（实例调用 / 跨模块同名）不算漂移；只拦「哪里都没有」的符号
              if (!baseTexts.some((t) => new RegExp(`\\b${symbol}\\b`).test(t))
                && !identifierUniverse.has(symbol)) {
                identProblems.push(`${rel}:${i + 1} ${prefix}.${symbol}：符号在 ${prefix} 模块里不存在`);
              }
            }
            continue;
          }
          if (/\W/.test(token)) continue; // 路径 / 键路径 / 命令交给其它检查
          if (!/^[A-Za-z][A-Za-z0-9]{3,}$/.test(token)) continue;
          if (!/[a-z]/.test(token)) continue; // 全大写交给第 13 项
          if (IDENT_EXEMPT.has(token)) continue;
          if (!identifierUniverse.has(token)) {
            identProblems.push(`${rel}:${i + 1} 标识符在代码里不存在：\`${token}\``);
          }
        }
      }
    }
    checker.check(`反引号标识符全部存活（失效 ${identProblems.length} 处）`, identProblems.length === 0);
    for (const b of identProblems.slice(0, 20)) console.log(`     ${b}`);
  }

  // ---------- 16. 文档内代码块来源标注 ----------
  {
    const fenceProblems: string[] = [];
    for (const rel of mdFiles) {
      const lines = readText(rel).split(/\r?\n/);
      let inFence = false;
      let info = '';
      let startLine = 0;
      const block: string[] = [];
      const checkFence = (): void => {
        const content = block.join('\n');
        if (!/\bexport\s+/.test(content)) return; // 无导出声明的示例不强制标注
        const srcMatch = /(?:^|\s)src=(\S+)/.exec(info);
        if (srcMatch === null || srcMatch[1] === undefined) {
          if (!info.includes('示意')) {
            fenceProblems.push(`${rel}:${startLine} 含导出声明的代码块缺 src= 来源标注（纯示意写「示意」）`);
          }
          return;
        }
        const targetRel = srcMatch[1];
        const targetPath = path.join(REPO_ROOT, targetRel);
        if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
          fenceProblems.push(`${rel}:${startLine} src= 目标不存在：${targetRel}`);
          return;
        }
        const target = targetRel.replace(/\\/g, '/');
        const targetText = readText(target);
        for (const m of content.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:function|class|interface|type|const|enum)\s+([A-Za-z0-9_]+)/g)) {
          const name = m[1];
          if (name !== undefined && !new RegExp(`\\b${name}\\b`).test(targetText)) {
            fenceProblems.push(`${rel}:${startLine} 代码块声明的 ${name} 不在 ${target}`);
          }
        }
        for (const m of content.matchAll(/export\s+(async\s+)?function\s+([A-Za-z0-9_]+)/g)) {
          const name = m[2];
          if (name === undefined) continue;
          const t = new RegExp(`export\\s+(async\\s+)?function\\s+${name}\\b`).exec(targetText);
          if (t === null) {
            fenceProblems.push(`${rel}:${startLine} ${target} 无 export function ${name}`);
          } else if ((m[1] !== undefined) !== (t[1] !== undefined)) {
            fenceProblems.push(`${rel}:${startLine} ${name} 的 async 旗标与 ${target} 不一致`);
          }
        }
        for (const line of block) {
          const cm = /^\s+(?:readonly\s+|private\s+|protected\s+|public\s+|static\s+|abstract\s+|async\s+|get\s+|set\s+)*([a-zA-Z_][A-Za-z0-9_]*)\s*\(/.exec(line);
          if (cm === null || cm[1] === undefined) continue;
          const name = cm[1];
          if (['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'await', 'function'].includes(name)) continue;
          if (!new RegExp(`\\b${name}\\b`).test(targetText)) {
            fenceProblems.push(`${rel}:${startLine} 代码块引用的 ${name}( 不在 ${target}`);
          }
        }
      };
      for (let i = 0; i < lines.length; i++) {
        if (/^\s*(```|~~~)/.test(lines[i])) {
          if (!inFence) { inFence = true; info = lines[i]; startLine = i + 1; block.length = 0; }
          else { inFence = false; checkFence(); }
          continue;
        }
        if (inFence) block.push(lines[i]);
      }
    }
    checker.check(`文档内代码块来源标注与比对（问题 ${fenceProblems.length} 处）`, fenceProblems.length === 0);
    for (const p of fenceProblems.slice(0, 20)) console.log(`     ${p}`);
  }

  // ---------- 17. 清单对照扩界 ----------
  {
    const listProblems: string[] = [];
    const diffNames = (expected: string[], found: string[], label: string): void => {
      const missing = expected.filter((n) => !found.includes(n));
      const extra = found.filter((n) => !expected.includes(n));
      if (missing.length > 0 || extra.length > 0) {
        listProblems.push(`${label} 与代码不一致（缺 ${missing.join(' / ') || '—'}，多 ${extra.join(' / ') || '—'}）`);
      }
    };
    // (a) SettingsSnapshot ↔ core-ui-separation.md 4.3 字段表（嵌套 llm / mcp 展开成点路径）
    const snapshotSrc = readText('src/core/settingsSnapshot.ts');
    const snapIface = balancedBlock(snapshotSrc, snapshotSrc.search(/export interface SettingsSnapshot\b/));
    const snapshotExpected: string[] = [];
    for (const top of depthOneFieldNames(snapIface)) {
      if (top === 'llm' || top === 'mcp') {
        const subAt = snapIface.search(new RegExp(`\\n\\s+${top}:\\s*\\{`));
        for (const f of depthOneFieldNames(balancedBlock(snapIface, subAt))) snapshotExpected.push(`${top}.${f}`);
      } else {
        snapshotExpected.push(top);
      }
    }
    const sep43 = readText('docs/core-ui-separation.md');
    const part43 = sep43.slice(sep43.indexOf('### 4.3'), sep43.indexOf('### 4.4'));
    const snapshotDoc = [...part43.matchAll(/^\| `([a-zA-Z0-9_.]+)` \|/gm)].map((m) => m[1] ?? '');
    diffNames(snapshotExpected, snapshotDoc, 'core-ui-separation.md 4.3 快照字段表');
    // (b) SpinDesign ↔ contracts.md §2 成员表
    const spinMembers = blockMemberNames(readText('src/host/SpinDesign.ts'), /export interface SpinDesign\b/);
    const spinPart = contracts.slice(contracts.indexOf('## 2. Spin'), contracts.indexOf('## 3.'));
    const spinDoc = [...spinPart.matchAll(/^\| `([a-zA-Z0-9_]+)\(/gm)].map((m) => m[1] ?? '');
    diffNames(spinMembers, spinDoc, 'contracts.md §2 SpinDesign 成员表');
    // (c) ConversationManager ↔ contracts.md §4 基类成员表
    const cmMembers = classMemberNames(readText('src/host/ConversationManager.ts'), /export abstract class ConversationManager\b/)
      .filter((n) => n !== 'constructor');
    const cmFrom = contracts.indexOf('**用抽象类而不是接口**');
    const cmPart = contracts.slice(cmFrom, contracts.indexOf('两个实现：', cmFrom));
    const cmDoc = [...cmPart.matchAll(/^\| `([a-zA-Z0-9_]+)\(/gm)].map((m) => m[1] ?? '');
    diffNames(cmMembers, cmDoc, 'contracts.md §4 ConversationManager 基类成员表');
    // (d) WebViewUI 公有方法 ↔ webview-ui.md §4 对外方法表
    const publicMethods: string[] = [];
    for (const line of webViewUiSrc.split('\n')) {
      if (/^ {2}(?:static|private)\b/.test(line)) continue;
      const mm = /^ {2}(?:async\s+)?([a-zA-Z_][A-Za-z0-9_]*)\s*[(<]/.exec(line);
      if (mm && mm[1] !== undefined) publicMethods.push(mm[1]);
    }
    // 豁免 = 内部消费 / 经映射表调用的入口（只减不增）；`on*` 是 CoreEvent / CoreRequest 处理器家族
    const HOST_METHOD_EXEMPT = new Set([
      'postToWebview', 'postConversationLoaded', 'dropSession', 'isSessionOpen', 'openSpinDesign',
      'refreshConversations', 'getSessionRuntimeStatesSnapshot', 'noteSessionActivity',
      'requestToolPermission', 'requestUserChoice',
    ]);
    const hostFacing = publicMethods.filter((n) => !/^on[A-Z]/.test(n) && !HOST_METHOD_EXEMPT.has(n));
    const part4 = webviewUi.slice(webviewUi.indexOf('## 4. 对外方法'), webviewUi.indexOf('## 5.'));
    const section4Doc = [...part4.matchAll(/^\| `([a-zA-Z0-9_]+)\(/gm)].map((m) => m[1] ?? '')
      // 文档里的 on* 行是子模块回调（不在宿主直接调用面），双侧都不参与对照
      .filter((n) => !/^on[A-Z]/.test(n));
    diffNames(hostFacing, section4Doc, 'webview-ui.md §4 对外方法表');
    for (const n of new Set(section4Doc)) {
      if (!publicMethods.includes(n)) listProblems.push(`webview-ui.md §4 列的 ${n}( 不是 WebViewUI 的公有方法`);
    }
    checker.check(`契约 / 快照 / 方法清单与代码一致（问题 ${listProblems.length} 处）`, listProblems.length === 0);
    for (const p of listProblems) console.log(`     ${p}`);
  }

  // ---------- 18. US ↔ e2e 映射双向对照 ----------
  {
    const usBySpec = new Map<string, string[]>();
    for (const rel of files) {
      if (!rel.startsWith('e2e/') || !rel.endsWith('.spec.ts')) continue;
      const refs = [...readText(rel).matchAll(/\bUS-(\d+)\b/g)].map((m) => m[1] ?? '');
      usBySpec.set(rel, [...new Set(refs)].sort());
    }
    const userStories = readText('docs/user-stories.md');
    const appendix = userStories.slice(userStories.indexOf('## 附录'));
    const docBySpec = new Map<string, string[]>();
    for (const m of appendix.matchAll(/^\| `([^`]+)` \|([^|]*)\|/gm)) {
      const file = m[1];
      if (file === undefined || !file.startsWith('e2e/')) continue;
      const us = [...(m[2] ?? '').matchAll(/US-(\d+)/g)].map((x) => x[1] ?? '');
      docBySpec.set(file, [...new Set(us)].sort());
    }
    const usProblems: string[] = [];
    for (const [file, refs] of usBySpec) {
      const listed = docBySpec.get(file);
      if (refs.length === 0) {
        if (listed !== undefined) usProblems.push(`${file} 无 US 引用但附录表列了 US-${listed.join(' / US-')}`);
        continue;
      }
      if (listed === undefined) {
        usProblems.push(`${file} 引用 US-${refs.join(' / US-')} 但附录表没有该文件的行`);
        continue;
      }
      const missing = refs.filter((r) => !listed.includes(r));
      const extra = listed.filter((r) => !refs.includes(r));
      if (missing.length > 0 || extra.length > 0) {
        const fmt = (rs: string[]): string => rs.map((r) => `US-${r}`).join(' / ') || '—';
        usProblems.push(`${file} 附录映射不一致（缺 ${fmt(missing)}，多 ${fmt(extra)}）`);
      }
    }
    for (const file of docBySpec.keys()) {
      if (!usBySpec.has(file)) usProblems.push(`附录表列的 ${file} 不存在`);
    }
    checker.check(`US ↔ e2e 映射双向一致（问题 ${usProblems.length} 处）`, usProblems.length === 0);
    for (const p of usProblems) console.log(`     ${p}`);
  }

  // ---------- 19. npm run 脚本名存活 ----------
  {
    const packageJson = JSON.parse(readText('package.json')) as { scripts?: Record<string, string> };
    const scripts = new Set(Object.keys(packageJson.scripts ?? {}));
    const scriptProblems: string[] = [];
    for (const rel of mdFiles) {
      if (FUTURE_WORK_DOC(rel)) continue; // TODO 与 specs/ 描述尚未做的
      const lines = readText(rel).split(/\r?\n/);
      let inFence = false;
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; continue; }
        if (inFence) continue;
        for (const m of raw.replace(MD_LINK, ' ').matchAll(/`npm run ([a-zA-Z0-9:_-]+)`/g)) {
          const name = m[1];
          if (name !== undefined && !scripts.has(name)) {
            scriptProblems.push(`${rel}:${i + 1} npm run ${name} 不在 package.json`);
          }
        }
      }
    }
    checker.check(`npm run 脚本名全部存活（失效 ${scriptProblems.length} 处）`, scriptProblems.length === 0);
    for (const b of scriptProblems.slice(0, 20)) console.log(`     ${b}`);
  }

  // ---------- 20. 打包平台集合单源 ----------
  {
    const buildCore = readText('scripts/build-core.mjs');
    const dirs = [...(buildCore.match(/PACKAGE_DIRS\s*=\s*\[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)]
      .map((m) => m[1] ?? '');
    const readme = readText('README.md');
    const missingPlatforms = dirs.filter((d) => !readme.includes(d));
    checker.check(
      `README 平台清单与 PACKAGE_DIRS 一致（${dirs.join(' / ')}）`,
      dirs.length > 0 && missingPlatforms.length === 0,
    );
    for (const d of missingPlatforms) console.log(`     README 缺平台目录：${d}`);
  }

  // ---------- 21. 禁「表 #N」行号引用 ----------
  {
    const tableRefProblems: string[] = [];
    for (const rel of codeFiles) {
      const lines = readText(rel).split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (/表(?:格)?\s*#\d+|节\s*#\d+/.test(lines[i])) {
          tableRefProblems.push(`${rel}:${i + 1} 禁止「表 / 节 #N」行号引用（点名事件名 / 成员名）`);
        }
      }
    }
    for (const rel of mdFiles) {
      const lines = readText(rel).split(/\r?\n/);
      let inFence = false;
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; continue; }
        if (inFence) continue;
        if (/表(?:格)?\s*#\d+|节\s*#\d+/.test(raw)) {
          tableRefProblems.push(`${rel}:${i + 1} 禁止「表 / 节 #N」行号引用（点名事件名 / 成员名）`);
        }
      }
    }
    checker.check(`无「表 #N」行号引用（命中 ${tableRefProblems.length} 处）`, tableRefProblems.length === 0);
    for (const b of tableRefProblems.slice(0, 20)) console.log(`     ${b}`);
  }

  // ---------- 22. specs/ 改动规格结构（specs/README.md 的工作流口径） ----------
  {
    const specProblems: string[] = [];
    const SPEC_STATUSES = new Set(['起草', '待评审', '实施中', '已收敛']);
    /** 三件套的 H1 前缀（不含 `# `） */
    const H1_PREFIX: Record<string, string> = {
      'spec.md': '改动规格：',
      'defect.md': '缺陷规格：',
    };
    const PLAN_H1 = '实施方案：';
    const TASKS_H1 = '任务分解：';
    const SPEC_SECTIONS = [
      '影响基线', '用户场景与验收标准', '功能需求', '边界与错误路径', '非目标',
      '对需求基线的影响', '追溯矩阵', '待澄清', '收敛记录',
    ];
    const DEFECT_SECTIONS = [
      '影响基线', '现状', '期望', '不变量', '回归测试',
      '对需求基线的影响', '追溯矩阵', '待澄清', '收敛记录',
    ];
    const PLAN_SECTIONS = ['技术方案', '受影响模块与契约', '宪章检查', '被否决的替代方案'];
    const CHARTER_ITEMS = ['分层', '铁律', 'parity', '文档同步'];

    const headingTitle = (line: string): string | null => {
      const m = /^##\s+(.+?)\s*$/.exec(line);
      return m && m[1] !== undefined ? m[1] : null;
    };
    const hasSection = (text: string, keyword: string): boolean =>
      text.split(/\r?\n/).some((line) => {
        const title = headingTitle(line);
        return title !== null && title.includes(keyword);
      });
    /** `## <含 keyword 的标题>` 到下一个 `## ` 之间的正文（subsection 不截断） */
    const sectionBody = (text: string, keyword: string): string => {
      const body: string[] = [];
      let started = false;
      for (const line of text.split(/\r?\n/)) {
        const title = headingTitle(line);
        if (title !== null) {
          if (started) break;
          if (title.includes(keyword)) started = true;
          continue;
        }
        if (started) body.push(line);
      }
      return body.join('\n');
    };
    /**
     * `[待澄清]` 标记检查：行内代码与 fenced 块里的出现是文档（写法说明）不算标记；
     * 实施中 / 已收敛不允许残留，起草 / 待评审的标记必须同行带去向链接。
     */
    const scanClarification = (relPath: string, text: string, status: string): void => {
      let inFence = false;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i] ?? '';
        if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; continue; }
        if (inFence) continue;
        const noInline = raw.replace(/`[^`\n]*`/g, '``');
        if (!noInline.includes('[待澄清]')) continue;
        if (status === '实施中' || status === '已收敛') {
          specProblems.push(`${relPath}:${i + 1} 实施中 / 已收敛的 spec 不允许残留待澄清标记（实施前清零）`);
          continue;
        }
        if (!noInline.includes('](')) {
          specProblems.push(`${relPath}:${i + 1} 待澄清标记必须同行带去向链接（ADR / DEVELOPMENT.md 第 6 章 / 非目标）`);
        }
      }
    };

    const specsDir = path.join(REPO_ROOT, 'specs');
    if (fs.existsSync(specsDir)) {
      const specDirName = /^\d{3}-[a-z0-9-]+$/;
      const listSpecDirs = (dir: string): string[] =>
        fs.readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && specDirName.test(e.name))
          .map((e) => e.name);
      const liveSpecs = listSpecDirs(specsDir);
      const archiveSpecsDir = path.join(REPO_ROOT, 'docs', 'archive', 'specs');
      const archivedSpecs = fs.existsSync(archiveSpecsDir) ? listSpecDirs(archiveSpecsDir) : [];

      // 编号三位递增、全库不复用（specs/ 与 docs/archive/specs/ 合并查重）
      const seenNums = new Map<string, string>();
      for (const name of [...liveSpecs, ...archivedSpecs]) {
        const num = name.slice(0, 3);
        const prev = seenNums.get(num);
        if (prev !== undefined) specProblems.push(`specs 编号 ${num} 重复：${prev} 与 ${name}`);
        else seenNums.set(num, name);
      }

      for (const name of liveSpecs) {
        const dirFiles = new Set(fs.readdirSync(path.join(specsDir, name)));
        const specFile = ['spec.md', 'defect.md'].find((f) => dirFiles.has(f));
        if (specFile === undefined) specProblems.push(`specs/${name}: 缺 spec.md（缺陷改动用 defect.md 替代）`);
        for (const required of ['plan.md', 'tasks.md']) {
          if (!dirFiles.has(required)) specProblems.push(`specs/${name}: 缺 ${required}`);
        }
        if (specFile === undefined) continue;

        const specRel = `specs/${name}/${specFile}`;
        const specText = readText(specRel);
        const h1 = /^#\s+(.+?)\s*$/m.exec(specText)?.[1] ?? '';
        const h1Prefix = H1_PREFIX[specFile] ?? '';
        if (h1Prefix === '' || !h1.startsWith(h1Prefix)) {
          specProblems.push(`${specRel}: H1 应以「${h1Prefix}」开头`);
        }
        const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(specText)?.[1] ?? '';
        const status = /^status:\s*(\S+)\s*$/m.exec(fm)?.[1] ?? '';
        if (!SPEC_STATUSES.has(status)) {
          specProblems.push(`${specRel}: frontmatter status 非法「${status}」（起草 / 待评审 / 实施中 / 已收敛）`);
        }
        for (const keyword of specFile === 'spec.md' ? SPEC_SECTIONS : DEFECT_SECTIONS) {
          if (!hasSection(specText, keyword)) specProblems.push(`${specRel}: 缺「${keyword}」章节`);
        }

        // FR / AC / 追溯矩阵 / tasks 覆盖只对功能规格（spec.md）强制；缺陷形态以 RT 条目为键，
        // 只查章节齐全与非空（上面已查）。
        const frs = [...specText.matchAll(/^### (FR-\d{3})：/gm)].map((m) => m[1] ?? '');
        const frSet = new Set(frs);
        const taskText = dirFiles.has('tasks.md') ? readText(`specs/${name}/tasks.md`) : '';
        const taskLines = [...taskText.matchAll(/^- \[( |x)\] \*\*(T\d{3})\*\*(.*)$/gm)];
        const taskFrs = new Set<string>();
        for (const m of taskLines) {
          for (const f of (m[3] ?? '').matchAll(/FR-\d{3}/g)) taskFrs.add(f[0]);
        }
        const tIds = taskLines.map((m) => m[2] ?? '');
        for (const t of tIds) {
          if (tIds.indexOf(t) !== tIds.lastIndexOf(t)) {
            specProblems.push(`specs/${name}/tasks.md: ${t} 重复`);
          }
        }
        if (specFile === 'spec.md') {
          if (frs.length === 0) specProblems.push(`${specRel}: 无 FR-nnn 功能需求条目`);
          for (const fr of frSet) {
            if (frs.indexOf(fr) !== frs.lastIndexOf(fr)) specProblems.push(`${specRel}: ${fr} 重复定义`);
          }
          const acLines = [...specText.matchAll(/^\s*- \*\*(AC-\d+)\*\*（(FR-\d{3})）：(.*)$/gm)];
          for (const m of acLines) {
            const acId = m[1] ?? '';
            const fr = m[2] ?? '';
            const line = m[3] ?? '';
            if (!frSet.has(fr)) specProblems.push(`${specRel}: ${acId} 回指不存在的 ${fr}`);
            if (!(line.includes('GIVEN') && line.includes('WHEN') && line.includes('THEN'))) {
              specProblems.push(`${specRel}: ${acId} 不是 GIVEN / WHEN / THEN 一行式`);
            }
          }
          for (const fr of frSet) {
            if (!acLines.some((m) => m[2] === fr)) specProblems.push(`${specRel}: ${fr} 无验收标准`);
            if (!taskFrs.has(fr)) specProblems.push(`specs/${name}/tasks.md: 未覆盖 ${fr}`);
          }
          for (const fr of taskFrs) {
            if (!frSet.has(fr)) specProblems.push(`specs/${name}/tasks.md: 回指不存在的 ${fr}`);
          }
          // 追溯矩阵：逐 FR 一行；覆盖列「自动」要求实现与测试落点非空，
          // 「无自动覆盖」要求同行给出理由
          const matrixText = sectionBody(specText, '追溯矩阵');
          const matrixRows = [...matrixText.matchAll(/^\| (FR-\d{3}) \|(.*)$/gm)];
          for (const fr of frSet) {
            const rows = matrixRows.filter((m) => m[1] === fr);
            if (rows.length === 0) { specProblems.push(`${specRel}: 追溯矩阵缺 ${fr} 行`); continue; }
            if (rows.length > 1) specProblems.push(`${specRel}: 追溯矩阵 ${fr} 多行`);
            const cells = (rows[0]?.[2] ?? '').split('|').map((c) => c.trim());
            const impl = cells[0] ?? '';
            const test = cells[1] ?? '';
            const coverage = cells[2] ?? '';
            if (coverage.startsWith('无自动覆盖')) {
              if (coverage.trim() === '无自动覆盖') {
                specProblems.push(`${specRel}: 追溯矩阵 ${fr} 登记无自动覆盖但未写理由`);
              }
            } else if (coverage !== '自动' || impl === '' || impl === '—' || test === '' || test === '—') {
              specProblems.push(`${specRel}: 追溯矩阵 ${fr} 覆盖列应为「自动」或「无自动覆盖 + 理由」`);
            }
          }
          for (const m of matrixRows) {
            if (!frSet.has(m[1] ?? '')) specProblems.push(`${specRel}: 追溯矩阵列了不存在的 ${m[1] ?? ''}`);
          }
        }

        // plan.md：H1、必填章节、宪章检查四项义务
        if (dirFiles.has('plan.md')) {
          const planRel = `specs/${name}/plan.md`;
          const planText = readText(planRel);
          const planH1 = /^#\s+(.+?)\s*$/m.exec(planText)?.[1] ?? '';
          if (!planH1.startsWith(PLAN_H1)) specProblems.push(`${planRel}: H1 应以「${PLAN_H1}」开头`);
          for (const keyword of PLAN_SECTIONS) {
            if (!hasSection(planText, keyword)) specProblems.push(`${planRel}: 缺「${keyword}」章节`);
          }
          const charter = sectionBody(planText, '宪章检查');
          for (const keyword of CHARTER_ITEMS) {
            if (!charter.includes(keyword)) specProblems.push(`${planRel}: 宪章检查缺「${keyword}」项`);
          }
          scanClarification(planRel, planText, status);
        }
        // tasks.md：H1 与待澄清标记
        if (dirFiles.has('tasks.md')) {
          const tasksRel = `specs/${name}/tasks.md`;
          const tasksH1 = /^#\s+(.+?)\s*$/m.exec(taskText)?.[1] ?? '';
          if (!tasksH1.startsWith(TASKS_H1)) specProblems.push(`${tasksRel}: H1 应以「${TASKS_H1}」开头`);
          if (taskLines.length === 0) specProblems.push(`${tasksRel}: 无 T 编号任务条目`);
          scanClarification(tasksRel, taskText, status);
        }
        scanClarification(specRel, specText, status);
      }
    }
    checker.check(`specs/ 改动规格结构与闸门（问题 ${specProblems.length} 处）`, specProblems.length === 0);
    for (const p of specProblems.slice(0, 20)) console.log(`     ${p}`);
  }

  // ---------- 23. 主题规格 frontmatter（owner / last_reviewed，规格新鲜度） ----------
  {
    const fmProblems: string[] = [];
    const docsDir = path.join(REPO_ROOT, 'docs');
    const topicSpecs = fs.readdirSync(docsDir)
      .filter((f) => f.endsWith('.md') && f !== 'README.md');
    for (const f of topicSpecs) {
      const rel = `docs/${f}`;
      const text = readText(rel);
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
      if (fm === undefined) {
        fmProblems.push(`${rel}: 缺 frontmatter（owner / last_reviewed）`);
        continue;
      }
      const owner = /^owner:\s*(.+?)\s*$/m.exec(fm)?.[1] ?? '';
      const reviewed = /^last_reviewed:\s*(\d{4}-\d{2}-\d{2})\s*$/m.exec(fm)?.[1] ?? '';
      if (owner === '') fmProblems.push(`${rel}: frontmatter 缺 owner`);
      if (reviewed === '') fmProblems.push(`${rel}: frontmatter 缺 last_reviewed（YYYY-MM-DD）`);
    }
    checker.check(`主题规格 frontmatter 字段齐全（问题 ${fmProblems.length} 处）`, fmProblems.length === 0);
    for (const p of fmProblems.slice(0, 20)) console.log(`     ${p}`);
  }

  checker.finish();
}

runTests('docsLint', main);
