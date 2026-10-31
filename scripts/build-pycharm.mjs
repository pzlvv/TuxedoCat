#!/usr/bin/env node
/**
 * PyCharm 插件分发包构建（specs/035 FR-008）。
 *
 * 链路：校验四平台 Core 产物齐 → （缺时）构建 webview → Gradle buildPlugin
 * （prepareSandbox 把 webview/core/icons 装进插件目录）→ 产物复制到
 * release/pycharm/<extensionName>-pycharm-<version>.zip。
 *
 * 环境前置：
 * - JDK 25（2026.2 平台类文件为 Java 25）：探测序 = 环境变量 PYCHARM_JDK25 →
 *   pycharm-plugin/local.properties 的 jdk25Path → 常见安装位置；Gradle daemon 本体
 *   跑在当前 JDK（≤ 24，内嵌 Kotlin DSL 编译器不认 25 的版本串），工具链经
 *   -Porg.gradle.java.installations.paths 指向 JDK 25 只做编译。
 * - 本机 PyCharm（可选）：e2e/environments.json 的 pycharm.idePath 存在时写入
 *   local.properties 的 pycharmLocalPath（intellijPlatform local 依赖，免下载整平台）。
 *
 * 运行：npm run package:pycharm
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const project = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src/config/project.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

const PLATFORMS = ['x64-win32', 'arm64-win32', 'x64-linux', 'arm64-linux'];
const PLUGIN_DIR = path.join(repoRoot, 'pycharm-plugin');
const NPM_HINT = {
  'x64-win32': 'npm run build:core',
  'arm64-win32': 'node scripts/build-core.mjs --target aarch64-pc-windows-msvc',
  'x64-linux': 'npm run build:core:linux-x64',
  'arm64-linux': 'npm run build:core:linux-arm64',
};

function fail(message) {
  console.error(`[build-pycharm] ${message}`);
  process.exit(1);
}

function readEnvironments() {
  const file = path.join(repoRoot, 'e2e/environments.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/** 四平台 Core 产物齐备校验（缺失报构建命令，不静默出残包） */
function assertCoreArtifacts() {
  const coreDir = path.join(repoRoot, 'dist/resources', project.core.resourceDir);
  if (!fs.existsSync(coreDir)) {
    // dist 未就绪时回看源 resources/core（copy-assets 之前的直接构建产物）
    const src = path.join(repoRoot, 'resources', project.core.resourceDir);
    if (fs.existsSync(src)) return;
  }
  const missing = [];
  for (const platform of PLATFORMS) {
    const dir = fs.existsSync(path.join(coreDir, platform)) ? path.join(coreDir, platform) : path.join(repoRoot, 'resources', project.core.resourceDir, platform);
    const exe = platform.endsWith('-win32') ? '.exe' : '';
    const binary = path.join(dir, project.core.binaryName + exe);
    const fingerprint = path.join(dir, 'fingerprint');
    if (!fs.existsSync(binary) || !fs.existsSync(fingerprint)) {
      missing.push(platform);
    }
  }
  if (missing.length > 0) {
    fail(
      'Core 产物缺失：\n'
      + missing.map((p) => `  - ${p}（构建：${NPM_HINT[p]}）`).join('\n')
      + '\n构建完成后重跑 npm run package:pycharm。',
    );
  }
}

/** webview 静态资源：缺失时自动构建（链上前置） */
function ensureWebview() {
  const index = path.join(repoRoot, 'dist/webview/index.html');
  if (fs.existsSync(index)) return;
  console.log('[build-pycharm] dist/webview 缺失，执行 npm run build:webview ...');
  execFileSync('npm', ['run', 'build:webview'], { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' });
  if (!fs.existsSync(index)) fail('webview 构建后仍缺少 dist/webview/index.html');
}

/** 保证 local.properties 存在（pycharmLocalPath 来自 e2e 环境登记；不覆盖已有文件） */
function ensureLocalProperties() {
  const local = path.join(PLUGIN_DIR, 'local.properties');
  if (fs.existsSync(local)) return;
  const env = readEnvironments();
  const idePath = env.pycharm?.idePath;
  if (!idePath) return;
  // <IDE>/bin/pycharm64.exe → IDE 根目录
  const ideHome = path.dirname(path.dirname(idePath));
  fs.writeFileSync(local, `pycharmLocalPath=${ideHome.replace(/\\/g, '/')}\n`);
  console.log(`[build-pycharm] local.properties 已生成（pycharmLocalPath=${ideHome.replace(/\\/g, '/')}）`);
}

/** JDK 25 探测（编译工具链；Gradle daemon 本体用当前 JDK） */
function findJdk25() {
  const candidates = [];
  if (process.env.PYCHARM_JDK25) candidates.push(process.env.PYCHARM_JDK25);
  try {
    const local = fs.readFileSync(path.join(PLUGIN_DIR, 'local.properties'), 'utf8');
    const match = local.match(/^jdk25Path=(.+)$/m);
    if (match) candidates.push(match[1].trim());
  } catch { /* 无 local.properties 放行 */ }
  for (const base of [path.join(PLUGIN_DIR, '.tooling'), path.join(repoRoot, '.gradle-dist'), 'C:/Program Files/Eclipse Adoptium', 'C:/Program Files/Java', '/usr/lib/jvm']) {
    try {
      for (const entry of fs.readdirSync(base)) {
        if (/jdk-?25/i.test(entry)) candidates.push(path.join(base, entry));
      }
    } catch { /* 目录不存在放行 */ }
  }
  for (const candidate of candidates) {
    const java = path.join(candidate, process.platform === 'win32' ? 'bin/java.exe' : 'bin/java');
    if (!fs.existsSync(java)) continue;
    try {
      // java -version 打到 stderr
      // --version 打到 stdout（-version 走 stderr，execFileSync 取不到）
      const output = execFileSync(java, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (/^openjdk 25\./m.test(output)) return candidate;
    } catch { /* 探测失败换下一个 */ }
  }
  fail(
    '未找到 JDK 25（2026.2 平台类文件为 Java 25）。任选其一：\n'
    + '  1. 设置环境变量 PYCHARM_JDK25 指向 JDK 25 安装目录；\n'
    + '  2. pycharm-plugin/local.properties 写 jdk25Path=<JDK 25 目录>；\n'
    + '  3. 安装 Temurin/OpenJDK 25 到默认位置（Program Files / /usr/lib/jvm）。',
  );
}

function main() {
  assertCoreArtifacts();
  ensureWebview();
  ensureLocalProperties();
  const jdk25 = findJdk25();
  console.log(`[build-pycharm] JDK 25 工具链：${jdk25}`);
  console.log('[build-pycharm] gradlew buildPlugin ...');
  const gradleArgs = ['-Porg.gradle.java.installations.paths=' + jdk25.replace(/\\/g, '/'), 'buildPlugin', '--console=plain'];
  if (process.platform === 'win32') {
    // Node ≥ 22 的 .bat spawn 需要 shell 包装（EINVAL）
    execFileSync('cmd', ['/c', 'gradlew.bat', ...gradleArgs], { cwd: PLUGIN_DIR, stdio: 'inherit' });
  } else {
    execFileSync(path.join(PLUGIN_DIR, 'gradlew'), gradleArgs, { cwd: PLUGIN_DIR, stdio: 'inherit' });
  }
  const distDir = path.join(PLUGIN_DIR, 'build/distributions');
  const built = fs.readdirSync(distDir).find((f) => f.endsWith('.zip'));
  if (!built) fail('gradle buildPlugin 未产出 zip（见上方构建日志）');
  const releaseDir = path.join(repoRoot, 'release/pycharm');
  fs.mkdirSync(releaseDir, { recursive: true });
  const target = path.join(releaseDir, `${project.extensionName}-pycharm-${pkg.version}.zip`);
  fs.copyFileSync(path.join(distDir, built), target);
  console.log(`[build-pycharm] 分发包：${target}`);
}

main();
