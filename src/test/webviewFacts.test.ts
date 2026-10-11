/**
 * 单测：webview 不持有配置事实的默认值（`docs/hosts/webview-facts.md`，docs/architecture/principles.md 第 10 节）。
 *
 * 用静态扫描锁定三条不变量：
 * 1. webview 源码不出现配置字段的默认值字面量（webSearch / thinkingEffort / agentMode /
 *    promptMode / uiLanguage / enableUsageStats）——这些取值由宿主的快照解析决定；
 * 2. webview 不 import 任何「配置默认值」模块（`settingsSnapshot` / `SettingsStore` /
 *    `llm/config`），只允许 import 跨层服务地址 `core/endpoints`；
 * 3. 会话配置的状态初值是 `undefined`（未到达），不是某个默认值。
 *
 * 为什么用静态扫描：这类「悄悄加回一个兜底」的改动不会被行为测试发现——它只在
 * 「宿主还没回话」的窗口里生效，而那正是最难构造的时序。
 *
 * 运行方式：npm run test:all -- webviewFacts
 */

import * as fs from 'fs';
import * as path from 'path';
import { createChecker, runTests } from './helpers/harness';

/** 递归收集目录下所有 .ts / .tsx 文件 */
function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSources(full));
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** 去掉注释，避免注释里的说明文字被当成代码命中 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// 编译产物在 out/src/test/，源码在 src/：与 bootstrapWiring.test.ts 同一口径
const REPO_ROOT = path.resolve(__dirname, '../../..');
const WEBVIEW_DIR = path.join(REPO_ROOT, 'src', 'webview');

runTests('webviewFacts', () => {
  const { check, finish } = createChecker();
  const files = collectSources(WEBVIEW_DIR);
  check('扫描到 webview 源码', files.length > 10);

  // ── 1. 不出现配置字段的默认值字面量 ──
  // 命中条件 = 同一行里既提到该字段、又对它写了 `?? 字面量` / `|| 字面量` 兜底。
  // 这样既能抓到真正的兜底，又不会误伤无关的布尔兜底（如 hasActiveQuery ?? false）。
  const literalPatterns: Array<{ field: string; fieldRe: RegExp; fallbackRe: RegExp }> = [
    { field: 'webSearch', fieldRe: /websearch/i, fallbackRe: /(?:\?\?|\|\|)\s*(?:true|false)\b/ },
    { field: 'thinkingEffort', fieldRe: /thinking/i, fallbackRe: /(?:\?\?|\|\|)\s*'(?:off|low|high|max)'/ },
    { field: 'agentMode', fieldRe: /agentmode/i, fallbackRe: /(?:\?\?|\|\|)\s*'(?:manual|risk|auto)'/ },
    { field: 'promptMode', fieldRe: /promptmode/i, fallbackRe: /(?:\?\?|\|\|)\s*'(?:normal|minimal|mixed)'/ },
    { field: 'uiLanguage', fieldRe: /language/i, fallbackRe: /(?:\?\?|\|\|)\s*'(?:auto|zh|en)'/ },
  ];
  for (const { field, fieldRe, fallbackRe } of literalPatterns) {
    const hits: string[] = [];
    for (const file of files) {
      const source = stripComments(fs.readFileSync(file, 'utf8'));
      for (const line of source.split('\n')) {
        if (fieldRe.test(line) && fallbackRe.test(line)) {
          hits.push(`${path.relative(REPO_ROOT, file)}: ${line.trim()}`);
        }
      }
    }
    check(`${field} 不在 webview 里兜底默认值`, hits.length === 0);
    for (const hit of hits) console.log(`     ${hit}`);
  }

  // ── 2. 不 import 配置默认值模块 ──
  const forbiddenImports = [
    'settingsSnapshot',
    'host/SettingsStore',
    'llm/config',
  ];
  const violations: string[] = [];
  for (const file of files) {
    const source = stripComments(fs.readFileSync(file, 'utf8'));
    for (const line of source.split('\n')) {
      if (!/^\s*import\b/.test(line)) continue;
      for (const forbidden of forbiddenImports) {
        if (line.includes(forbidden)) {
          violations.push(`${path.relative(REPO_ROOT, file)}: ${line.trim()}`);
        }
      }
    }
  }
  check('webview 不 import 配置默认值模块', violations.length === 0);
  for (const v of violations) console.log(`     ${v}`);

  // ── 3. 会话配置的状态初值是 undefined ──
  const appSource = stripComments(fs.readFileSync(path.join(WEBVIEW_DIR, 'App.tsx'), 'utf8'));
  for (const state of ['agentMode', 'thinkingMode', 'promptMode', 'webSearch']) {
    const re = new RegExp(`useState<[^>]*>\\(undefined\\)`);
    const declared = new RegExp(`const \\[${state}, set\\w+\\] = useState`);
    const line = appSource.split('\n').find((l) => declared.test(l)) ?? '';
    check(`App.tsx 的 ${state} 以 undefined 起`, re.test(line));
  }
  const sessionStateSource = stripComments(
    fs.readFileSync(path.join(WEBVIEW_DIR, 'sessionState.ts'), 'utf8'),
  );
  for (const field of ['agentMode', 'promptMode', 'thinkingMode', 'webSearch']) {
    check(
      `createSessionState 的 ${field} 为 undefined`,
      new RegExp(`\\b${field}: undefined`).test(sessionStateSource),
    );
  }

  finish();
});
