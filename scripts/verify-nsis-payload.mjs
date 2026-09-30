#!/usr/bin/env node
/**
 * 校验 NSIS 安装包里的 app 载荷能被完整解压（防止 ARM64 BCJ 过滤器导致的静默丢文件）
 *
 * 为什么需要这个脚本
 * ------------------
 * electron-builder 打包 app-<arch>.7z 用的 7-Zip（toolsets/7zip.js 的 getPath7za()）
 * 与安装时负责解压的 nsis7z 插件（nsis-resources 3.4.1，2019-03-24，7-Zip 19.00 代码）
 * 是两个不同年代的 7-Zip：
 *
 *   - 打包端 7-Zip 22.00+ 认识 ARM64，会按扩展名把 ARM64 的 .exe/.dll 压成
 *     "ARM64 LZMA2" 块；
 *   - nsis7z 只有 BCJ / BCJ2 / ARM / ARMT / IA64 / PPC / SPARC / Delta 这些过滤器，
 *     没有 ARM64，这些条目解压时报 Unsupported Method；
 *   - NSIS 脚本（app-builder-lib/templates/nsis/include/extractAppPackage.nsh）
 *     没有检查 Nsis7z::Extract 的返回值 —— 安装照样"成功"，但静默少文件。
 *
 * 症状：arm64 安装包丢掉 <productName>.exe 和全部 ARM64 dll，装完点不开。
 *
 * 本脚本做三件事：
 *   1. 检查载荷里每个条目用的过滤器都在 nsis7z 支持的集合内（发现 ARM64 就失败）——
 *      这一条与打包端 7-Zip 版本无关，是真正的防回归闸门；
 *   2. 检查载荷包含主程序，且文件清单与 electron-builder 产出的 app 目录一致；
 *   3. 用 electron-builder.config.js 里固定的那个 7-Zip 21.07 测试解压（逐条 CRC 校验）。
 *      它和 nsis7z 一样不认识 ARM64 过滤器，所以能真实反映安装时的解压能力。
 *
 * 用法：node scripts/verify-nsis-payload.mjs
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = require('../project.config.cjs');
const { version } = require('../package.json');

const releaseDir = project.releaseDir;
const prefix = `${project.productName}-${version}-setup-`;
const productExe = `${project.productName}.exe`;

/**
 * nsis7z 插件（7-Zip 19.00 代码）认识的过滤器。
 * 一旦载荷里出现别的过滤器（典型就是 ARM64），安装时必然静默丢文件。
 * `Copy` 不是过滤器，是 -mx=0 时的存储方法，这里一并放行。
 */
const NSIS7Z_FILTERS = new Set(['BCJ', 'BCJ2', 'ARM', 'ARMT', 'IA64', 'PPC', 'SPARC', 'DELTA', 'COPY']);

/**
 * 比 nsis7z 新的过滤器：旧 7-Zip 列目录时认不出名字，只会打印 coder id。
 * 0x0A 就是 ARM64 过滤器（本仓库踩过的坑）。
 */
const NEWER_FILTER_IDS = new Map([['0A', 'ARM64']]);

const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * 校验用的 7za：先加载构建配置，它会设置 ELECTRON_BUILDER_7ZIP_PATH（打包用的那个
 * 7-Zip 21.07）。必须和打包端用同一个二进制：它和 nsis7z 一样不认识 ARM64 过滤器，
 * 因此一旦载荷里出现 ARM64 块，下面的测试解压就会失败。
 */
let sevenZip = null;
try {
  require('../electron-builder.config.js');
  sevenZip = process.env.ELECTRON_BUILDER_7ZIP_PATH ?? null;
} catch {
  // 配置加载失败（例如没装 7zip-bin）时退回 7zip-bin 的默认二进制
}
if (sevenZip == null) {
  try {
    ({ path7za: sevenZip } = require('7zip-bin'));
  } catch {
    console.error('[verify-nsis-payload] 缺少 7zip-bin@5.2.0，请先执行 npm install');
    process.exit(1);
  }
}

if (!fs.existsSync(releaseDir)) {
  console.error(`[verify-nsis-payload] 输出目录不存在：${releaseDir}`);
  process.exit(1);
}

const installers = fs
  .readdirSync(releaseDir)
  .filter((name) => name.startsWith(prefix) && name.endsWith('.exe'))
  .sort();

if (installers.length === 0) {
  console.error(`[verify-nsis-payload] 在 ${releaseDir} 下找不到 ${prefix}*.exe`);
  process.exit(1);
}

/** 运行 7za，返回 { status, output } */
function run7za(args) {
  const result = spawnSync(sevenZip, args, { encoding: 'utf8', maxBuffer: MAX_BUFFER });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/**
 * 解析 `7za l -slt` 输出，返回载荷条目列表。
 * 输出以空行分隔成块，每块是 `Key = Value`；首个块描述安装包自身，需要跳过。
 */
function listEntries(installer) {
  const { output } = run7za(['l', '-slt', installer]);
  const entries = [];
  let current = null;

  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === '') {
      if (current?.Path) {
        entries.push(current);
      }
      current = null;
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9_ ]*) = (.*)$/.exec(line);
    if (match) {
      current ??= {};
      current[match[1]] = match[2];
    }
  }
  if (current?.Path) {
    entries.push(current);
  }

  const self = path.basename(installer);
  return entries.filter((entry) => path.basename(entry.Path) !== self);
}

/** `Method = BCJ2 LZMA2:20 LZMA:20:lc0:lp2` → 过滤器集合 { BCJ2 }（带 `:` 的是方法，不是过滤器） */
function filtersOf(method) {
  return (method ?? '')
    .split(/\s+/)
    .filter((token) => token !== '' && !token.includes(':'))
    .map((token) => token.toUpperCase());
}

/** 目录条目：`Attributes = D`（`-slt` 不给目录打 Folder 标记，只看属性） */
function isDirectory(entry) {
  return (entry.Attributes ?? '').includes('D');
}

/** 把不认识的过滤器 token 换成人类可读的名字，例如 0A → ARM64 */
function describeFilter(token) {
  const known = NEWER_FILTER_IDS.get(token);
  return known == null ? token : `${known}（coder 0x${token}）`;
}

/** 安装包对应的 electron-builder app 目录（x64 用默认名 win-unpacked，其它架构带架构后缀） */
function appOutDirFor(arch) {
  return path.join(project.releaseDir, arch === 'x64' ? 'win-unpacked' : `win-${arch}-unpacked`);
}

function listFilesRecursively(dir) {
  const files = [];
  const walk = (current) => {
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) {
        walk(full);
      } else {
        files.push(path.relative(dir, full).split(path.sep).join('/'));
      }
    }
  };
  walk(dir);
  return files.sort();
}

const failures = [];

for (const name of installers) {
  const installer = path.join(releaseDir, name);
  const arch = name.slice(prefix.length, -'.exe'.length);
  const problems = [];

  // 1) 过滤器白名单：与打包端 7-Zip 版本无关的防回归闸门
  const entries = listEntries(installer);
  const files = entries.filter((entry) => !isDirectory(entry));
  const badFilters = new Set();
  for (const entry of files) {
    for (const filter of filtersOf(entry.Method)) {
      if (!NSIS7Z_FILTERS.has(filter)) {
        badFilters.add(`${describeFilter(filter)}（${entry.Path}）`);
      }
    }
  }
  if (badFilters.size > 0) {
    problems.push(`载荷用了 nsis7z 不支持的过滤器：${[...badFilters].join('、')}`);
  }

  // 2) 主程序必须在，且文件清单要和 app 目录一致
  if (!files.some((entry) => entry.Path === productExe)) {
    problems.push(`载荷缺少主程序 ${productExe}`);
  }

  const appOutDir = appOutDirFor(arch);
  if (!fs.existsSync(appOutDir)) {
    problems.push(`找不到 app 目录 ${path.relative(rootDir, appOutDir)}，无法比对文件清单`);
  } else {
    const expected = listFilesRecursively(appOutDir);
    const actual = files.map((entry) => entry.Path.split('\\').join('/')).sort();
    const missing = expected.filter((file) => !actual.includes(file));
    const extra = actual.filter((file) => !expected.includes(file));
    if (missing.length > 0 || extra.length > 0) {
      problems.push(
        `载荷文件清单与 ${path.relative(rootDir, appOutDir)} 不一致` +
          (missing.length > 0 ? `；缺少 ${missing.slice(0, 8).join('、')}${missing.length > 8 ? ' 等' : ''}` : '') +
          (extra.length > 0 ? `；多出 ${extra.slice(0, 8).join('、')}${extra.length > 8 ? ' 等' : ''}` : '')
      );
    }
  }

  // 3) 测试解压（逐条 CRC 校验）
  const test = run7za(['t', installer]);
  const extractBroken =
    test.status !== 0 || /Sub items Errors:\s*[1-9]/.test(test.output) || /^ERROR:/m.test(test.output);
  if (extractBroken) {
    const detail = test.output
      .split(/\r?\n/)
      .filter((line) => /ERROR:|Sub items Errors/.test(line))
      .slice(0, 8)
      .map((line) => line.trim());
    problems.push(`测试解压失败：${detail.join(' / ') || `退出码 ${test.status}`}`);
  }

  if (problems.length === 0) {
    console.log(`OK   ${name}（${files.length} 个文件）`);
  } else {
    console.log(`FAIL ${name}`);
    failures.push({ name, problems });
  }
}

if (failures.length > 0) {
  console.error('\n[verify-nsis-payload] 校验失败：安装包在安装时会静默丢文件。');
  console.error('若提示 ARM64 过滤器，说明打包端 7-Zip 太新（nsis7z 解不开）。');
  console.error('请检查 electron-builder.config.js 里的 ELECTRON_BUILDER_7ZIP_PATH /');
  console.error('ELECTRON_BUILDER_7Z_FILTER 设置，并确认 7zip-bin 仍锁在 5.2.0。\n');
  for (const failure of failures) {
    console.error(`- ${failure.name}`);
    for (const problem of failure.problems) {
      console.error(`    ${problem}`);
    }
  }
  process.exit(1);
}

console.log(`[verify-nsis-payload] 全部通过（${installers.length} 个安装包）`);
