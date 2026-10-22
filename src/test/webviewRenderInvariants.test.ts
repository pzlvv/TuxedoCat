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

  finish();
});
