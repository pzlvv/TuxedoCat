/**
 * 单测：webview 渲染不变量——条件返回不得在 hooks 之前、语言探测必须容忍缺失路径
 * （`specs/defects/tool-card-missing-file-path-crash.md` 的 RT-1 / RT-2 / RT-3）。
 *
 * 为什么用静态扫描：两条不变量都落在 `.tsx` 组件里，而 `tsconfig.test.json` 把
 * `src/webview/**` 排除在编译范围外（DOM lib / jsx / module 配置与单测不同），
 * 单测进程里拿不到可渲染的组件实例。但这两条不变量本身不需要真实渲染：
 *
 * - RT-1 是 hooks 调用顺序的结构性质：React 按调用顺序匹配 hooks，同一个组件实例两次
 *   渲染的 hooks 数量不同就直接抛错；webview 没有 error boundary，整棵树卸载＝白屏。
 *   典型触发是「模型漏传 file_path → args 补齐后重渲染同一张卡片」。
 * - RT-2 是语言探测函数的入参契约：模型漏传 file_path 是合法输入（core 的 displayArgs
 *   只在 args 带 file_path 时才补这个键），函数必须自己兜住缺失路径，而不是指望每个
 *   调用点各自判空；函数体内的 `.split` 等解引用由 `npm run check-types:webview` 的
 *   类型收窄兜住。
 * - RT-3 是 Write 高亮 effect 的前置条件：没有路径时卡片走 unknown file 分支，不必
 *   跑高亮；路径后补时又必须重跑（所以 filePath 同时在 guard 与依赖里）。
 *
 * 运行方式：npm run test:all -- webview-render-invariants
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { createChecker, runTests } from './helpers/harness';

// 编译产物在 out/src/test/，源码在 src/：与 webviewFacts.test.ts 同一口径
const REPO_ROOT = path.resolve(__dirname, '../../..');
const WEBVIEW_DIR = path.join(REPO_ROOT, 'src', 'webview');

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

function parse(file: string): ts.SourceFile {
  const source = fs.readFileSync(file, 'utf8');
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.ES2022,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function rel(file: string): string {
  return path.relative(REPO_ROOT, file).replace(/\\/g, '/');
}

// ────────────────────────────────────────────────────────────────────
// RT-1：hooks 不得出现在条件返回之后
// ────────────────────────────────────────────────────────────────────

const HOOK_NAME_RE = /^use[A-Z][A-Za-z0-9]*$/;

function hookNameOf(call: ts.CallExpression): string {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return '';
}

/**
 * 语句内是否调用 hooks。不进入嵌套函数体：那里的调用不属于本次渲染的 hooks 序列
 * （例如 `const handleCopy = () => { … }` 里的普通函数调用）。
 * `useMemo(() => …)` 这类「hook 调用把箭头当参数」仍能命中——外层 CallExpression
 * 在遍历到箭头之前就已判定。
 */
function hasHookCall(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found || ts.isFunctionLike(n)) return;
    if (ts.isCallExpression(n) && HOOK_NAME_RE.test(hookNameOf(n))) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** 语句内是否 return（同样不进入嵌套函数体） */
function hasReturn(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found || ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function functionLabel(node: ts.FunctionLikeDeclaration): string {
  return node.name && ts.isIdentifier(node.name) ? node.name.text : '<匿名函数>';
}

/**
 * 带块体函数体的函数节点。`ts.isFunctionLike` 会把调用签名（`CallSignatureDeclaration`）
 * 也算进来，那类节点没有 `body`，所以这里单独收窄。
 */
type BlockBodyFunction = ts.FunctionLikeDeclaration & { body: ts.Block };

function isBlockBodyFunction(node: ts.Node): node is BlockBodyFunction {
  const isFunction = ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node);
  return isFunction && !!node.body && ts.isBlock(node.body);
}

interface HooksOrderViolation {
  file: string;
  functionName: string;
  guardLine: number;
  hookLine: number;
}

/** 组件体内「带 return 的 if」之后仍调用 hooks 的位置 */
function findHooksAfterConditionalReturn(file: string, sourceFile: ts.SourceFile): HooksOrderViolation[] {
  const violations: HooksOrderViolation[] = [];
  const visit = (node: ts.Node): void => {
    if (isBlockBodyFunction(node)) {
      const statements = node.body.statements;
      const guardIndex = statements.findIndex((s) => ts.isIfStatement(s) && hasReturn(s));
      if (guardIndex >= 0) {
        for (let i = guardIndex + 1; i < statements.length; i++) {
          if (hasHookCall(statements[i])) {
            violations.push({
              file,
              functionName: functionLabel(node),
              guardLine: lineOf(sourceFile, statements[guardIndex]),
              hookLine: lineOf(sourceFile, statements[i]),
            });
            break;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

// ────────────────────────────────────────────────────────────────────
// RT-2：getLanguageFromPath 容忍缺失路径
// ────────────────────────────────────────────────────────────────────

interface LanguageProbe {
  file: string;
  line: number;
  /** 第一个形参的类型文本（没有类型注解时为 null） */
  paramType: string | null;
  paramName: string | null;
  /** 函数体首条语句是「形参判空后返回」 */
  guarded: boolean;
}

function isFunctionInitializer(node: ts.Expression | undefined): node is ts.ArrowFunction | ts.FunctionExpression {
  return !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

function findLanguageProbes(file: string, sourceFile: ts.SourceFile): LanguageProbe[] {
  const probes: LanguageProbe[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === 'getLanguageFromPath'
      && isFunctionInitializer(node.initializer)
    ) {
      const fn = node.initializer;
      const param = fn.parameters[0];
      const paramName = param && ts.isIdentifier(param.name) ? param.name.text : null;
      const first = ts.isBlock(fn.body) ? fn.body.statements[0] : undefined;
      probes.push({
        file,
        line: lineOf(sourceFile, node),
        paramType: param?.type ? param.type.getText(sourceFile) : null,
        paramName,
        guarded: !!paramName && isMissingGuard(first, paramName),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return probes;
}

/** 首条语句是否是 `if (!<param>) { return … }`（单行无花括号形式同样算） */
function isMissingGuard(statement: ts.Statement | undefined, paramName: string): boolean {
  if (!statement || !ts.isIfStatement(statement)) return false;
  const condition = statement.expression;
  if (!ts.isPrefixUnaryExpression(condition) || condition.operator !== ts.SyntaxKind.ExclamationToken) {
    return false;
  }
  const operand = condition.operand;
  if (!ts.isIdentifier(operand) || operand.text !== paramName) return false;
  return hasReturn(statement.thenStatement);
}

// ────────────────────────────────────────────────────────────────────
// RT-3：Write 高亮 effect 的前置条件与依赖
// ────────────────────────────────────────────────────────────────────

interface HighlightEffect {
  file: string;
  line: number;
  /** 回调体内有 `if (!filePath …) return;` */
  guarded: boolean;
  /** 依赖数组里含 filePath */
  dependsOnPath: boolean;
}

function findHighlightEffects(file: string, sourceFile: ts.SourceFile): HighlightEffect[] {
  const effects: HighlightEffect[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'useEffect'
      && node.arguments.length > 0
    ) {
      const callback = node.arguments[0];
      const body = isFunctionInitializer(callback) ? callback.body : undefined;
      if (body && ts.isBlock(body) && mentionsIdentifier(body, 'getLanguageFromPath')) {
        const deps = node.arguments[1];
        effects.push({
          file,
          line: lineOf(sourceFile, node),
          guarded: body.statements.some(
            (s) => ts.isIfStatement(s)
              && mentionsIdentifier(s.expression, 'filePath')
              && hasReturn(s.thenStatement),
          ),
          dependsOnPath: !!deps && mentionsIdentifier(deps, 'filePath'),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return effects;
}

// ────────────────────────────────────────────────────────────────────
// untrusted-payload-crashes：不可信载荷与状态不同步导致的运行时崩溃
// （`specs/defects/webview-untrusted-payload-crashes.md` 的 RT-1 ~ RT-4）
// ────────────────────────────────────────────────────────────────────

/**
 * RT-1：同一个语句列表里不得出现**相邻且完全相同的两条语句**。
 *
 * 这是复制粘贴的语法特征：`resumeFollowOnChoiceRespond();` 连写两遍会让强制回底
 * 多推一次，且与兄弟 handler「每次应答只复位一次」的口径不一致。只比相邻两条而
 * 不是「同函数内出现过两次」——后者会把 if / else 两支里的同样语句、switch 各 case
 * 的 `e.preventDefault()` 全部误判（实测 17 处噪音）。
 */
interface DuplicateStatement {
  file: string;
  line: number;
  text: string;
}

function findAdjacentDuplicateStatements(file: string, sourceFile: ts.SourceFile): DuplicateStatement[] {
  const hits: DuplicateStatement[] = [];
  const visit = (node: ts.Node): void => {
    const statements = ts.isBlock(node) || ts.isSourceFile(node)
      || ts.isCaseClause(node) || ts.isDefaultClause(node)
      ? node.statements
      : undefined;
    if (statements) {
      for (let i = 1; i < statements.length; i++) {
        const previous = statements[i - 1].getText(sourceFile);
        if (previous.length > 0 && previous === statements[i].getText(sourceFile)) {
          hits.push({ file, line: lineOf(sourceFile, statements[i]), text: previous });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return hits;
}

/**
 * RT-2：`metaParam` 的初值必须是含 `typeof` 判断的条件表达式。
 *
 * `meta` 由 `toUiMessage` 从磁盘 JSONL 原样透传（`msg.meta as Record<string, unknown>`），
 * `as string | undefined` 只是类型断言，运行时不校验：`meta.param` 为数字 / 对象时
 * `.startsWith` 直接抛 TypeError，没有 error boundary 的整棵树随之卸载。
 */
interface MetaParamDeclaration {
  file: string;
  line: number;
  /** 初值文本，便于失败时定位 */
  initializer: string;
  /** 初值里含 typeof 判断 */
  typeChecked: boolean;
}

function findMetaParamDeclarations(file: string, sourceFile: ts.SourceFile): MetaParamDeclaration[] {
  const found: MetaParamDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === 'metaParam'
    ) {
      const initializer = node.initializer ? node.initializer.getText(sourceFile) : '';
      found.push({
        file,
        line: lineOf(sourceFile, node),
        initializer,
        typeChecked: /\btypeof\b/.test(initializer),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * RT-3：`<UserChoiceOverlay>` 必须带 `key`。
 *
 * `QuestionOverlay` 的 `drafts` 由 `useState(初值函数)` 一次性建立，没有任何 effect
 * 让它跟随 `questions` 变化。同一会话的请求被新请求替换时（`UserChoiceQueue.enqueue`
 * 会 reject 旧请求），不重挂载就会在新 id 下取到 `undefined` 草稿，`draft.otherSelected`
 * 抛错。`docs/features/ask-user-question.md` 的「逐页状态」已定义「视图重建从第一页开始」。
 */
interface ChoiceOverlayUsage {
  file: string;
  line: number;
  hasKeyAttribute: boolean;
}

function findChoiceOverlayUsages(file: string, sourceFile: ts.SourceFile): ChoiceOverlayUsage[] {
  const found: ChoiceOverlayUsage[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (node.tagName.getText(sourceFile) === 'UserChoiceOverlay') {
        found.push({
          file,
          line: lineOf(sourceFile, node),
          hasKeyAttribute: node.attributes.properties.some(
            (property) => ts.isJsxAttribute(property) && property.name.getText(sourceFile) === 'key',
          ),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * RT-4：沿 `parentSessionId` 上溯的 `while` 必须有环保护。
 *
 * 同一份数据在递归渲染侧有 `MAX_DEPTH` 保护（`ConversationTreeItem.tsx`，注释写明
 * 「circular reference」），说明成环是被承认的脏数据形态；本处无保护时 A→B→A
 * 会让 `setExpandedSubSessions` 的 updater 同步死循环、锁死主线程。
 */
interface AncestorLoop {
  file: string;
  line: number;
  /** 循环体里出现已访问集合或深度上限 */
  guarded: boolean;
}

function findAncestorLoops(file: string, sourceFile: ts.SourceFile): AncestorLoop[] {
  const found: AncestorLoop[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isWhileStatement(node) && node.expression.getText(sourceFile).includes('convById.has')) {
      const body = node.statement.getText(sourceFile);
      found.push({
        file,
        line: lineOf(sourceFile, node),
        guarded: /\b(visited|seen)\b|MAX_DEPTH|\bdepth\b/i.test(body),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** 子树里是否出现指定标识符（不进入嵌套函数体） */
function mentionsIdentifier(node: ts.Node, name: string): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found || ts.isFunctionLike(n)) return;
    if (ts.isIdentifier(n) && n.text === name) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

// ────────────────────────────────────────────────────────────────────
// 用例
// ────────────────────────────────────────────────────────────────────

runTests('webviewRenderInvariants', () => {
  const { check, finish } = createChecker();
  const files = collectSources(WEBVIEW_DIR);
  const parsed = files.map((file) => ({ file, sourceFile: parse(file) }));
  check('扫描到 webview 源码', files.length > 20);

  // ── RT-1 ──
  const orderViolations = parsed.flatMap(({ file, sourceFile }) => findHooksAfterConditionalReturn(file, sourceFile));
  check('hooks 不在条件返回之后', orderViolations.length === 0);
  for (const v of orderViolations) {
    console.log(`     ${rel(v.file)} ${v.functionName}：guard@${v.guardLine} → hook@${v.hookLine}`);
  }

  // ── RT-2 ──
  const probes = parsed.flatMap(({ file, sourceFile }) => findLanguageProbes(file, sourceFile));
  check('找到语言探测函数定义', probes.length > 0);
  for (const probe of probes) {
    const where = `${rel(probe.file)}:${probe.line}`;
    check(`${where} 形参类型含 undefined`, !!probe.paramType && /\bundefined\b/.test(probe.paramType));
    check(`${where} 首条语句对形参判空返回`, probe.guarded);
  }

  // ── RT-3 ──
  const effects = parsed.flatMap(({ file, sourceFile }) => findHighlightEffects(file, sourceFile));
  check('找到 Write 高亮 effect', effects.length > 0);
  for (const effect of effects) {
    const where = `${rel(effect.file)}:${effect.line}`;
    check(`${where} 缺 filePath 时不跑高亮`, effect.guarded);
    check(`${where} 依赖数组含 filePath`, effect.dependsOnPath);
  }

  // ──────────────────────────────────────────────────────────────────
  // untrusted-payload-crashes（specs/defects/webview-untrusted-payload-crashes.md）
  // 本组的 RT 编号属于该缺陷规格，与上面 tool-card-missing-file-path-crash 的
  // RT-1 ~ RT-3 是两个不同的追溯键，故用前缀区分。
  // ──────────────────────────────────────────────────────────────────

  // ── RT-1：相邻重复语句 ──
  const duplicateStatements = parsed.flatMap(({ file, sourceFile }) =>
    findAdjacentDuplicateStatements(file, sourceFile));
  check('同一语句列表内无相邻重复语句', duplicateStatements.length === 0);
  for (const hit of duplicateStatements) {
    console.log(`     ${rel(hit.file)}:${hit.line} 重复语句：${hit.text}`);
  }

  // ── RT-2：meta.param 取值前判类型 ──
  const metaParams = parsed.flatMap(({ file, sourceFile }) => findMetaParamDeclarations(file, sourceFile));
  check('找到 metaParam 声明', metaParams.length > 0);
  for (const declaration of metaParams) {
    const where = `${rel(declaration.file)}:${declaration.line}`;
    check(`${where} meta.param 取值前判字符串类型`, declaration.typeChecked);
    if (!declaration.typeChecked) {
      console.log(`     ${where} 初值：${declaration.initializer}`);
    }
  }

  // ── RT-3：选择框按 choiceId 重挂载 ──
  const overlayUsages = parsed.flatMap(({ file, sourceFile }) => findChoiceOverlayUsages(file, sourceFile));
  check('找到 UserChoiceOverlay 渲染点', overlayUsages.length > 0);
  for (const usage of overlayUsages) {
    check(`${rel(usage.file)}:${usage.line} 选择框按 choiceId 重挂载`, usage.hasKeyAttribute);
  }

  // ── RT-4：祖先链遍历有环保护 ──
  const ancestorLoops = parsed.flatMap(({ file, sourceFile }) => findAncestorLoops(file, sourceFile));
  check('找到祖先链遍历', ancestorLoops.length > 0);
  for (const loop of ancestorLoops) {
    check(`${rel(loop.file)}:${loop.line} 祖先链遍历有环保护`, loop.guarded);
  }

  finish();
});
