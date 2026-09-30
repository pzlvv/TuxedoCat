#!/usr/bin/env node
/**
 * Standalone Core（Rust）的覆盖率度量。
 *
 * 用 rustc 自带的 `-C instrument-coverage` + `llvm-tools` 里的
 * `llvm-profdata` / `llvm-cov`，不依赖 cargo-llvm-cov。
 *
 * 度量对象是**产品代码**：`src/*_tests.rs` 与 `src/test_support.rs` 已被
 * `-ignore-filename-regex` 排除，因此测试代码本身不会拉高数字。
 *
 * 用法：
 *   node scripts/coverage-core.mjs              # 汇总 + 逐文件明细
 *   node scripts/coverage-core.mjs --check 80   # 低于阈值时以非 0 退出
 *   node scripts/coverage-core.mjs --html       # 额外产出 HTML 报告
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE_DIR = path.join(REPO_ROOT, 'core-rs');
const COVERAGE_DIR = path.join(CORE_DIR, 'target', 'coverage-core');
const PROFRAW_DIR = path.join(COVERAGE_DIR, 'profraw');
const PROFDATA = path.join(COVERAGE_DIR, 'core.profdata');
const HTML_DIR = path.join(COVERAGE_DIR, 'html');

/** 依赖与工具链的源码不进报告，只度量 core-rs/src 下的产品代码 */
const EXCLUDE =
  'registry[\\\\/]src|rustlib[\\\\/]src|library[\\\\/]std|_tests\\.rs$|test_support\\.rs$';
const SOURCE_ROOT = path.join(CORE_DIR, 'src').replace(/\\/g, '/');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: CORE_DIR,
    encoding: 'utf8',
    shell: false,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function mustRun(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    throw new Error(`${command} exited with ${result.status}`);
  }
  return result;
}

/** rustc 的 host triple 与随附的 llvm 工具目录 */
function locateLlvmTools() {
  const sysroot = mustRun('rustc', ['--print', 'sysroot']).stdout.trim();
  const version = mustRun('rustc', ['-vV']).stdout;
  const host = /host:\s*(\S+)/.exec(version)?.[1];
  if (!host) throw new Error('cannot determine host triple');
  const binDir = path.join(sysroot, 'lib', 'rustlib', host, 'bin');
  const exe = process.platform === 'win32' ? '.exe' : '';
  const tools = {
    profdata: path.join(binDir, `llvm-profdata${exe}`),
    cov: path.join(binDir, `llvm-cov${exe}`),
  };
  for (const tool of Object.values(tools)) {
    if (!fs.existsSync(tool)) {
      throw new Error(
        `missing ${tool}\nrun: rustup component add llvm-tools-preview`,
      );
    }
  }
  return tools;
}

/** 带插桩编译测试二进制，返回可执行文件列表 */
function buildTestBinaries() {
  const result = mustRun(
    'cargo',
    ['test', '--no-run', '--message-format=json'],
    {
      env: {
        ...process.env,
        RUSTFLAGS: '-C instrument-coverage',
        CARGO_INCREMENTAL: '0',
        LLVM_PROFILE_FILE: path.join(PROFRAW_DIR, 'core-%p-%m.profraw'),
      },
    },
  );
  const executables = [];
  for (const line of result.stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.reason === 'compiler-artifact' && message.executable) {
      executables.push(message.executable);
    }
  }
  return [...new Set(executables)];
}

/** 跑测试，产出 profraw */
function runTests(executables) {
  for (const executable of executables) {
    const result = run(executable, [], {
      stdio: 'inherit',
      env: {
        ...process.env,
        LLVM_PROFILE_FILE: path.join(PROFRAW_DIR, 'core-%p-%m.profraw'),
      },
    });
    if (result.status !== 0) {
      throw new Error(`${path.basename(executable)} reported failing tests`);
    }
  }
}

function mergeProfiles(tools) {
  const profraws = fs
    .readdirSync(PROFRAW_DIR)
    .filter((name) => name.endsWith('.profraw'))
    .map((name) => path.join(PROFRAW_DIR, name));
  if (profraws.length === 0) throw new Error('no .profraw produced');
  mustRun(tools.profdata, ['merge', '-sparse', ...profraws, '-o', PROFDATA]);
  return profraws.length;
}

function report(tools, executables, extraArgs) {
  const args = [
    'report',
    ...executables,
    `-instr-profile=${PROFDATA}`,
    `-ignore-filename-regex=${EXCLUDE}`,
    ...extraArgs,
  ];
  return mustRun(tools.cov, args).stdout;
}

/**
 * 解析 `llvm-cov report` 的明细行。
 *
 * 表格形如 `<文件>  <区域> <未覆盖> <覆盖率> <函数> …`，
 * 文件名可能含空格，因此数字部分从行尾反向匹配。
 */
function parseRows(output) {
  const pattern =
    /^(.*?)\s+(\d+)\s+(\d+)\s+(\d+\.\d+%|-)\s+(\d+)\s+(\d+)\s+(\d+\.\d+%|-)\s+(\d+)\s+(\d+)\s+(\d+\.\d+%|-)\s+(\d+)\s+(\d+)\s+(\d+\.\d+%|-)\s*$/;
  const rows = [];
  for (const line of output.split('\n')) {
    const match = pattern.exec(line);
    if (!match) continue;
    const file = match[1].trim().replace(/\\/g, '/');
    rows.push({
      file,
      regions: Number(match[2]),
      missedRegions: Number(match[3]),
      functions: Number(match[5]),
      missedFunctions: Number(match[6]),
      lines: Number(match[8]),
      missedLines: Number(match[9]),
      branches: Number(match[11]),
      missedBranches: Number(match[12]),
    });
  }
  return rows;
}

/**
 * 只保留 core-rs/src 下的产品代码。
 * llvm-cov 以 cwd（core-rs）为基准打印相对路径，依赖库则是绝对路径。
 */
function isProductFile(file) {
  if (file.endsWith('_tests.rs') || file.endsWith('test_support.rs')) return false;
  const absolute = /^[A-Za-z]:\//.test(file) || file.startsWith('/');
  if (absolute) return file.startsWith(`${SOURCE_ROOT}/`);
  return !file.includes('/');
}

function productRows(rows) {
  return rows.filter((row) => isProductFile(row.file));
}

function percent(covered, total) {
  return total === 0 ? 100 : ((covered / total) * 100);
}

function summarize(rows) {
  const sum = (key) => rows.reduce((total, row) => total + row[key], 0);
  const regions = sum('regions');
  const missedRegions = sum('missedRegions');
  const functions = sum('functions');
  const missedFunctions = sum('missedFunctions');
  const lines = sum('lines');
  const missedLines = sum('missedLines');
  const branches = sum('branches');
  const missedBranches = sum('missedBranches');
  return {
    lines: percent(lines - missedLines, lines),
    functions: percent(functions - missedFunctions, functions),
    regions: percent(regions - missedRegions, regions),
    branches: branches === 0 ? 100 : percent(branches - missedBranches, branches),
    counts: { lines, functions, regions, branches },
  };
}

function formatTable(rows, summary) {
  const name = (row) =>
    /^[A-Za-z]:\//.test(row.file) || row.file.startsWith('/')
      ? path.relative(CORE_DIR, row.file.replace(/\//g, path.sep))
      : row.file;
  const width = Math.max(4, ...rows.map((row) => name(row).length));
  const lines = [
    `${'文件'.padEnd(width)}  ${'行覆盖'.padStart(9)}  ${'函数'.padStart(9)}  ${'区域'.padStart(9)}`,
    '-'.repeat(width + 34),
  ];
  for (const row of [...rows].sort((a, b) => a.file.localeCompare(b.file))) {
    lines.push(
      `${name(row).padEnd(width)}  ` +
        `${percent(row.lines - row.missedLines, row.lines).toFixed(2).padStart(8)}%  ` +
        `${percent(row.functions - row.missedFunctions, row.functions).toFixed(2).padStart(8)}%  ` +
        `${percent(row.regions - row.missedRegions, row.regions).toFixed(2).padStart(8)}%`,
    );
  }
  lines.push('-'.repeat(width + 34));
  lines.push(
    `${'合计'.padEnd(width)}  ${summary.lines.toFixed(2).padStart(8)}%  ` +
      `${summary.functions.toFixed(2).padStart(8)}%  ${summary.regions.toFixed(2).padStart(8)}%`,
  );
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const html = args.includes('--html');
  const checkIndex = args.indexOf('--check');
  const threshold = checkIndex >= 0 ? Number.parseFloat(args[checkIndex + 1] ?? '80') : null;

  fs.rmSync(PROFRAW_DIR, { recursive: true, force: true });
  fs.mkdirSync(PROFRAW_DIR, { recursive: true });

  const tools = locateLlvmTools();
  console.log('[coverage] 编译插桩测试二进制…');
  const executables = buildTestBinaries();
  if (executables.length === 0) throw new Error('cargo produced no test executables');

  console.log('[coverage] 运行测试…');
  runTests(executables);
  const profraws = mergeProfiles(tools);
  console.log(`[coverage] 合并 ${profraws} 份 profraw`);

  const rows = productRows(parseRows(report(tools, executables, [])));
  if (rows.length === 0) throw new Error('no product source files in the coverage report');
  const summary = summarize(rows);
  process.stdout.write(`\n${formatTable(rows, summary)}\n`);

  console.log(
    `[coverage] 行 ${summary.lines.toFixed(2)}%（${summary.counts.lines} 行）  ` +
      `函数 ${summary.functions.toFixed(2)}%  区域 ${summary.regions.toFixed(2)}%`,
  );

  if (html) {
    fs.rmSync(HTML_DIR, { recursive: true, force: true });
    const args = [
      'show',
      ...executables,
      `-instr-profile=${PROFDATA}`,
      `-ignore-filename-regex=${EXCLUDE}`,
      '-format=html',
      `-output-dir=${HTML_DIR}`,
    ];
    mustRun(tools.cov, args);
    console.log(`[coverage] HTML 报告：${HTML_DIR}`);
  }

  if (threshold !== null && summary.lines < threshold) {
    console.error(
      `[coverage] 行覆盖率 ${summary.lines.toFixed(2)}% 低于阈值 ${threshold}%`,
    );
    process.exit(1);
  }
}

main();
