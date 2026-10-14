/**
 * 品牌字面量守卫（`docs/hosts/product-identity.md`）。
 *
 * 契约：产品身份只允许出现在两个**定义处**——
 * - `src/config/project.json`：工程变量（配置目录、环境变量前缀、命令前缀、面板 id …）；
 * - `package.json`：VS Code 扩展清单身份（扩展名、publisher、command / view id）。
 *
 * 其余文件（源码 / 构建脚本 / 用例 / 文档 / 工作区配置）一律经变量引用，
 * 注释与文档用 `<product-name>` / `<configDir>` / `<envPrefix>` 之类占位。
 * `package-lock.json` 由 `package.json` 生成，随定义处变化，单独放行。
 *
 * 本用例做两件事：
 * 1. 全仓扫描「品牌变体」（由 `extensionName` / `productName` 派生的分隔符变体），
 *    除放行清单外零命中；
 * 2. 校验两个定义处的身份字段互相一致（改一处忘了另一处直接失败）。
 *
 * 运行方式：npm run test:all -- brand-literal
 */

import * as fs from 'fs';
import * as path from 'path';
import projectConfig from '../config/project.json';
import { createChecker, runTests } from './helpers/harness';

/** 仓库根：编译产物在 `out/src/test/`，往上三层 */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** 不参与扫描的目录（构建产物 / 依赖 / 数据目录） */
const SKIP_DIRS = new Set([
  '.git',
  '.zcode',
  'node_modules',
  'out',
  'dist',
  'dist-electron',
  'release',
  'coverage',
  'test-results',
  'playwright-report',
  '.vscode-test',
  'target',
  'resources',
  projectConfig.configDir,
]);

/**
 * 放行的定义处与生成物（相对仓库根的 POSIX 路径）。
 *
 * - `src/config/project.json` / `package.json`：品牌定义处；
 * - `package-lock.json`：由 `package.json` 的 name 生成；
 * - `AGENTS.md`：引用会话技能目录的**真实路径**（分档闸门的起草入口，目录名即品牌
 *   字面量，指路必须写实）。
 *
 * 各 crate 的 `Cargo.lock` 不在放行清单里：三个 Rust crate 的包名保持中性
 * （`standalone-core` / `standalone-tui` / `standalone-tui-installer`），
 * 锁文件里本就不该出现产品字面量。
 */
const ALLOWED_FILES = new Set([
  'src/config/project.json',
  'package.json',
  'package-lock.json',
  'AGENTS.md',
]);

/** 二进制后缀直接跳过（图片 / 字体 / 可执行文件） */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.icns',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.zip', '.gz', '.7z', '.exe', '.dll', '.so', '.dylib', '.node',
  '.vsix', '.pdf', '.mp4', '.wasm',
]);

/**
 * 由产品名派生的「品牌变体」：分隔符统一化后的各种写法。
 *
 * 例：`extensionName` 为 `foo-bar` → `foo-bar` / `foo_bar` / `foo bar` / `foobar`。
 * 只保留长度 ≥ 5 的变体，避免短产品名把普通英文单词误判成品牌字面量。
 */
function brandVariants(...names: readonly string[]): string[] {
  const variants = new Set<string>();
  for (const name of names) {
    const trimmed = name.trim();
    if (trimmed === '') continue;
    const compact = trimmed.replace(/[^A-Za-z0-9]+/g, '');
    for (const variant of [
      trimmed,
      trimmed.replace(/[^A-Za-z0-9]+/g, '-'),
      trimmed.replace(/[^A-Za-z0-9]+/g, '_'),
      trimmed.replace(/[^A-Za-z0-9]+/g, ' '),
      compact,
    ]) {
      if (variant.length >= 5) variants.add(variant.toLowerCase());
    }
  }
  return [...variants];
}

/** 收集仓库里的全部文本文件（相对 POSIX 路径 + 绝对路径） */
function collectTextFiles(dir: string, out: Array<{ rel: string; abs: string }>): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectTextFiles(abs, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (ALLOWED_FILES.has(rel)) continue;
    if (BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    out.push({ rel, abs });
  }
}

/** 文本文件判定：前 8KB 里没有 NUL 字节 */
function looksTextual(buffer: Buffer): boolean {
  return !buffer.subarray(0, 8192).includes(0);
}

interface PackageManifest {
  name: string;
  displayName: string;
  publisher: string;
  author: string;
  repository: { url: string };
  contributes: {
    commands: Array<{ command: string }>;
    viewsContainers: { secondarySidebar: Array<{ id: string; title: string }> };
    views: Record<string, Array<{ id: string }>>;
  };
}

function run(): void {
  const { check, finish } = createChecker();

  // ── 1. 两个定义处的身份字段一致性 ──
  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'),
  ) as PackageManifest;
  const container = manifest.contributes.viewsContainers.secondarySidebar[0];
  const view = manifest.contributes.views[container.id]?.[0];
  const command = manifest.contributes.commands[0];
  check('package.json name = project.extensionName', manifest.name === projectConfig.extensionName);
  check('package.json displayName = project.productName', manifest.displayName === projectConfig.productName);
  check('package.json publisher = project.publisher', manifest.publisher === projectConfig.publisher);
  check('package.json author = project.author', manifest.author === projectConfig.author);
  check('package.json repository.url = project.repositoryUrl', manifest.repository.url === projectConfig.repositoryUrl);
  check(
    'package.json 命令 id 由 commandPrefix 派生',
    command?.command === `${projectConfig.commandPrefix}.open`,
  );
  check('package.json viewContainer id = project.viewContainerId', container?.id === projectConfig.viewContainerId);
  check('package.json viewContainer title = project.productName', container?.title === projectConfig.productName);
  check('package.json view id = project.viewId', view?.id === projectConfig.viewId);

  // ── 2. 全仓扫描：除定义处 / 生成物外零命中 ──
  const variants = brandVariants(projectConfig.extensionName, projectConfig.productName);
  check('品牌变体非空', variants.length > 0);

  const files: Array<{ rel: string; abs: string }> = [];
  collectTextFiles(REPO_ROOT, files);
  check('扫到了源文件（目录遍历正常）', files.length > 100);

  const hits: string[] = [];
  for (const file of files) {
    const buffer = fs.readFileSync(file.abs);
    if (!looksTextual(buffer)) continue;
    const lower = buffer.toString('utf-8').toLowerCase();
    for (const variant of variants) {
      if (!lower.includes(variant)) continue;
      const line = buffer
        .toString('utf-8')
        .split(/\r?\n/)
        .findIndex((text) => text.toLowerCase().includes(variant));
      hits.push(`${file.rel}:${line + 1} 命中「${variant}」`);
      break;
    }
  }

  if (hits.length > 0) {
    console.error('\n品牌字面量只允许出现在 src/config/project.json 与 package.json：');
    for (const hit of hits.slice(0, 50)) console.error(`  ${hit}`);
    if (hits.length > 50) console.error(`  …还有 ${hits.length - 50} 处`);
  }
  check(`全仓无散落品牌字面量（扫 ${files.length} 个文本文件）`, hits.length === 0);

  finish();
}

runTests('brandLiteral', run);
