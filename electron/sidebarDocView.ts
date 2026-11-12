/**
 * 文档视图的数据逻辑（specs/030 FR-003 / FR-004）。
 *
 * 解析与组装是纯函数；git 命令执行器抽成接口（本地实现 `localGitRunner` 在此，
 * 远程实现由 `electron/main.ts` 用 SSH exec 组装），可在单测里直接驱动
 * （`src/test/sidebarDocView.test.ts` 假 runner + `sidebarDocViewGit.test.ts` 真实
 * 临时 git 仓）。排序复用 `sidebarFiles.ts` 的唯一一份比较器。
 */

import { execFile } from 'child_process';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { sortSidebarEntries } from './sidebarFiles.js';

/** 文档视图条目：path 是工作区根相对路径（'/' 分隔）；行数仅 git 口径有值（记录口径 null） */
export interface DocEntry {
  path: string;
  plus: number | null;
  minus: number | null;
}

export type DocListResult =
  | { ok: true; mode: 'git' | 'record'; entries: DocEntry[] }
  | { ok: false; error: string };

/** git 子命令执行器（args 不含 `git` 与 `-C root`，由实现补齐）。spawn 失败 / 超时抛错 */
export interface GitCommandRunner {
  run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  /**
   * 多条 git 命令**一次往返**执行，结果按入参顺序返回。
   *
   * 远程（SSH）工作区上每 `run` 一次就是一次网络往返：变更清单的三条事实
   * （HEAD / diff / 未跟踪）各自往返一次，条目一多这段固定开销就压在用户眼前
   * （`specs/defects/remote-change-list-n-plus-one-round-trips.md`）。本地实现逐条
   * spawn（本地无往返成本，且不经 shell）。
   *
   * 单条命令失败（非零退出 / 超时）**不**让整批抛错：退出码与 stderr 原样回给调用方，
   * 由它按既有判别值分流（例如无 HEAD 的仓 `rev-parse HEAD` 必然非零）。
   */
  runBatch(commands: string[][]): Promise<Array<{ code: number; stdout: string; stderr: string }>>;
  /** 读工作区内相对路径的文本内容；读不到返回 null */
  readFile(rel: string): Promise<string | null>;
  /**
   * 多条相对路径的行数，**一次往返**取回（未跟踪文件按全文计新增用）。
   *
   * 远程实现让内容留在远端机器上数行数，只回传"路径 → 行数"；逐文件 `readFile`
   * 会把整份文件内容经 SFTP 拉回宿主只为数行数。读不到的路径不进结果，
   * 调用方按 0 行处理（与 `readFile` 返回 null 同口径）。
   */
  lineCounts(rels: readonly string[]): Promise<Map<string, number>>;
  /** 存在性检查（记录口径过滤已删除用） */
  exists(rel: string): Promise<boolean>;
}

/** 本地工作区的 git 执行器：spawn `git -C <root>`，不经 shell（args 数组直传，无注入面） */
export function localGitRunner(root: string): GitCommandRunner {
  const run = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-C', root, ...args],
        { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
        (err, stdout, stderr) => {
          const exitCode = (err as null | { code?: number })?.code;
          if (err && typeof exitCode !== 'number') {
            reject(err instanceof Error ? err : new Error(String(err)));
            return;
          }
          resolve({ code: exitCode ?? 0, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
  return {
    run,
    // 本地没有往返成本：逐条跑比拼一段 shell 更简单，也避免把参数交给 shell 解析。
    runBatch: async (commands) => {
      const results: Array<{ code: number; stdout: string; stderr: string }> = [];
      for (const args of commands) results.push(await run(args));
      return results;
    },
    readFile: async (rel) => {
      try {
        return await fsp.readFile(path.join(root, rel), 'utf8');
      } catch {
        return null;
      }
    },
    lineCounts: async (rels) => {
      const counts = new Map<string, number>();
      for (const rel of rels) {
        try {
          counts.set(rel, countLines(await fsp.readFile(path.join(root, rel), 'utf8')));
        } catch {
          // 读不到＝不计数：调用方按 0 行处理（与 readFile 返回 null 同口径）
        }
      }
      return counts;
    },
    exists: async (rel) => {
      try {
        await fsp.stat(path.join(root, rel));
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** git 探测：`yes`（在仓内）/ `no`（不在仓内，分流到记录口径）/ 失败（显式错误） */
export type GitProbe = 'yes' | 'no' | { error: string };

export async function probeGitWorkspace(runner: GitCommandRunner): Promise<GitProbe> {
  let out: { code: number; stdout: string; stderr: string };
  try {
    out = await runner.run(['rev-parse', '--is-inside-work-tree']);
  } catch (err) {
    return { error: `git 执行失败: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (out.code === 0 && out.stdout.trim() === 'true') return 'yes';
  if (out.code !== 0 && /not a git repository/i.test(out.stderr)) return 'no';
  return { error: `git 探测失败（code ${out.code}）: ${out.stderr.trim()}` };
}

/**
 * 解开 git 的 C 风格引号路径（`core.quotepath` 的输出格式）。
 *
 * git 对含 `"` / `\` / 制表符 / 换行等字符的路径**总是**用双引号包裹并逐字符转义
 * （`"a\"b.md"`、`"tab\tname.md"`）；`-c core.quotepath=false` 只关掉非 ASCII 的
 * 八进制转义，关不掉这条规则。不解开的话，回查存在性必然失败，条目被当成已删除过滤掉
 * ——这类文件在文档视图里整条消失（specs/defects/sidebar-doc-view-quoted-git-paths.md）。
 *
 * 三位八进制 `\nnn` 是**原始字节**（git 对控制字符用它，非 ASCII 在 quotepath 打开时
 * 也是逐字节转义），因此连续的八进制转义要按 UTF-8 解码，不能逐个 `fromCharCode`
 * ——那样 `\303\274` 会变成两个 latin-1 字符而不是 `ü`。
 *
 * 未加引号的路径原样返回（含 `old => new` 这类重命名写法，由调用方后续归一）。
 *
 * **不 trim**：文件名允许首尾空格（` lead.md` / `trail.md `），git 对这类名字既不
 * 加引号也不转义——按行读到的原文就是文件名，trim 会把它们变成不存在的路径而整条丢
 * （specs/defects/sidebar-doc-view-quoted-git-paths.md）。行尾的 `\r` 由调用方按
 * 行切分时处理。
 */
export function unquoteGitPath(raw: string): string {
  const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) {
    return text;
  }
  const body = text.slice(1, -1);
  const pieces: string[] = [];
  /** 待解码的连续八进制字节（UTF-8 序列可能跨多个转义） */
  let bytes: number[] = [];
  const flushBytes = (): void => {
    if (bytes.length === 0) return;
    pieces.push(Buffer.from(bytes).toString('utf8'));
    bytes = [];
  };
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== '\\') {
      flushBytes();
      pieces.push(ch);
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) {
      flushBytes();
      pieces.push('\\');
      break;
    }
    i += 1;
    const octal = /^[0-7]{3}/.exec(body.slice(i));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += 2;
      continue;
    }
    flushBytes();
    switch (next) {
      case 'a': pieces.push('\x07'); break;
      case 'b': pieces.push('\b'); break;
      case 'f': pieces.push('\f'); break;
      case 'n': pieces.push('\n'); break;
      case 'r': pieces.push('\r'); break;
      case 't': pieces.push('\t'); break;
      case 'v': pieces.push('\v'); break;
      case '"': pieces.push('"'); break;
      case '\\': pieces.push('\\'); break;
      // 认不出的转义按字面保留（不吞字符）
      default: pieces.push(`\\${next}`);
    }
  }
  flushBytes();
  return pieces.join('');
}

/** 重命名路径形态归一到新名：`old => new` 取 new；目录重命名 `a/{o => n}b` 取 `a/nb` */
export function normalizeRenamedPath(raw: string): string | null {
  let cleaned = unquoteGitPath(raw);
  const brace = /^(.*?)\{(.*?) => (.*?)\}(.*)$/.exec(cleaned);
  if (brace) cleaned = `${brace[1]}${brace[3]}${brace[4]}`;
  const whole = /^(.*) => (.*)$/.exec(cleaned);
  if (whole) cleaned = whole[2];
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * 解析 `git diff --numstat -M` 输出（制表符分隔 `add<TAB>del<TAB>path`）。
 * 跳过二进制行（`-` 计数）与 `0/0` 行——`-M` 下纯重命名 / 仅位置变更呈现为 `0 0`，
 * 正好由这条规则剔除；带修改的重命名行归一到新路径。
 */
export function parseNumstat(text: string): DocEntry[] {
  const entries: DocEntry[] = [];
  for (const line of text.split('\n')) {
    // 只跳空行：路径可以首尾是空格，不能整行 trim
    if (line.length === 0) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [addText, delText, ...restPath] = parts;
    const rawPath = restPath.join('\t');
    if (addText === '-' || delText === '-') continue; // 二进制
    const plus = Number(addText);
    const minus = Number(delText);
    if (!Number.isFinite(plus) || !Number.isFinite(minus)) continue;
    if (plus === 0 && minus === 0) continue; // 纯重命名 / 仅位置变更
    const normalized = normalizeRenamedPath(rawPath);
    if (normalized === null) continue;
    entries.push({ path: normalized, plus, minus });
  }
  return entries;
}

/** 解析 `git ls-files` 输出：每行一个路径（C 风格引号按 git 的转义还原）。
 *
 * 只跳**空行**：文件名可以首尾是空格，不能 trim（见 `unquoteGitPath`）。 */
export function parseLsFiles(text: string): string[] {
  return text
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    .filter((line) => line.length > 0)
    .map((line) => unquoteGitPath(line));
}

/** 计行（git 口径）：末尾换行不另计一行；空文件 0 行 */
export function countLines(text: string): number {
  if (text === '') return 0;
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

/**
 * 所有只读取数共用的 git 前缀参数（本地 / 远程同一份）。
 *
 * - `--no-optional-locks` 与 `core.untrackedCache=false` / `core.fsmonitor=false`：
 *   取数时 git 在 stat 信息陈旧的情况下会重写 `.git/index`，而变更视图自己正挂着
 *   `.git` 哨兵（`electron/sidebarDocWatch.ts`），写一次就触发一轮全量重扫。这三个开关
 *   关掉 git 的自动索引维护。
 * - `core.quotepath=false`：非 ASCII 路径不解成八进制转义（含引号的路径仍走 C 风格
 *   引号，由 `unquoteGitPath` 还原）。
 */
export const GIT_COMMON_ARGS: readonly string[] = [
  '--no-optional-locks',
  '-c', 'core.quotepath=false',
  '-c', 'core.untrackedCache=false',
  '-c', 'core.fsmonitor=false',
];

/** 剥掉 `GIT_COMMON_ARGS` 前缀后的其余参数（子命令 + 它自己的参数） */
export function gitTail(args: readonly string[]): string[] {
  const matches = GIT_COMMON_ARGS.every((token, index) => args[index] === token);
  return matches ? args.slice(GIT_COMMON_ARGS.length) : [...args];
}

/**
 * 变更清单取数的四条 git 事实，按**固定顺序**拼进一次性批处理。
 *
 * 顺序即契约：`collectGitEntries` 按序号取值。集中在这里而不是散在调用点，是因为
 * 「一次往返」的收益全靠这三条同批发出，任何一条单独 `run` 就退回旧形态
 * （`specs/defects/remote-change-list-n-plus-one-round-trips.md`）。
 */
export function buildChangeCommands(scope: ChangeScope): string[][] {
  const pathspec = pathspecFor(scope);
  return [
    // 0：有没有 HEAD（无 HEAD 的新仓走索引全文计新增）
    [...GIT_COMMON_ARGS, 'rev-parse', '--verify', '-q', 'HEAD'],
    // 1：与 HEAD 的差异。`--diff-filter=d` 让 git 自己剔掉删除（此前是取数后逐条 stat），
    //    `--relative` 保证工作区是仓库子目录时输出的仍是工作区相对路径——否则这些路径
    //    回查不到、整条消失（`specs/defects/remote-change-list-n-plus-one-round-trips.md`）。
    [
      ...GIT_COMMON_ARGS,
      'diff', '--numstat', '-M', '--relative', '--diff-filter=d', 'HEAD', '--', ...pathspec,
    ],
    // 2：索引内容（只有无 HEAD 的新仓用得上，按全文计新增）
    [...GIT_COMMON_ARGS, 'ls-files', '--', ...pathspec],
    // 3：未跟踪文件（遵循 .gitignore）；行数由 `lineCounts` 另一次批量取回
    [...GIT_COMMON_ARGS, 'ls-files', '--others', '--exclude-standard', '--', ...pathspec],
  ];
}

/** 批处理输出里每条命令的段标记（`parseGitBatchOutput` 与脚本共用的唯一定义处） */
const BATCH_MARK = '__GIT_BATCH_';

/**
 * 把 N 条 git 命令拼成一段 POSIX sh 脚本，供远程一次 exec 执行。
 *
 * 每条命令的输出按标记分段：`BEGIN_i` → stdout → `CODE_i<退出码>` → `ERR_i` → stderr
 * → `ERREND_i`。分开标 stdout / stderr 的边界，是因为命令可能只写其中一个（无 HEAD 的
 * `rev-parse` 只有退出码、没有 stderr），靠"行数"推断边界必然错位。
 *
 * 参数逐个单引号转义（`'` → `'\''`）：pathspec 里的 `*.md` 必须原样到达 git，不能被
 * shell 展开。单条命令的退出码用 `$?` 单独记录——`set -e` 会让首个非零退出直接中断，
 * 那正是「无 HEAD 的新仓」这条正常路径。
 *
 * 脚本整体退出码恒为 0：判定交给每条命令自己的 `CODE_i` 段，与逐条 `run` 的语义一致。
 */
export function buildGitBatchScript(commands: readonly string[][]): string {
  const shQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
  const lines: string[] = [];
  commands.forEach((args, index) => {
    lines.push(`printf '%s\\n' "${BATCH_MARK}BEGIN_${index}__"`);
    lines.push(`git ${args.map(shQuote).join(' ')} 2>"$tmpdir/err${index}"`);
    lines.push(`printf '%s%s\\n' "${BATCH_MARK}CODE_${index}__" "$?"`);
    lines.push(`printf '%s\\n' "${BATCH_MARK}ERR_${index}__"`);
    lines.push(`cat "$tmpdir/err${index}"`);
    // 不额外补前导换行：stderr 自带尾换行时边界就落在 ERREND 之前，空 stderr 时
    // ERREND 紧接 ERR 标志行——两种情况都不产生伪造的空行。
    lines.push(`printf '%s\\n' "${BATCH_MARK}ERREND_${index}__"`);
  });
  // 临时目录只用来暂存各条命令的 stderr：stdout 必须直接进管道，否则大输出会被
  // 「先攒全量再打印」拖成内存与延迟双高。
  return [
    'tmpdir=$(mktemp -d) || exit 1',
    'trap \'rm -rf "$tmpdir"\' EXIT',
    ...lines,
  ].join('\n');
}

/** 一条批处理命令的结果（与逐条 `run` 的回包同形） */
export interface GitBatchReply {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * 还原 `buildGitBatchScript` 的输出：按标记切出每条命令的 `code` / `stdout` / `stderr`。
 *
 * 每个段在输出里的形态固定为（`printf '%s\n'` 只补一个换行）：
 *
 * ```
 * __GIT_BATCH_BEGIN_i__
 * <stdout 原文>
 * __GIT_BATCH_CODE_i__<退出码>
 * __GIT_BATCH_ERR_i__
 * <stderr 原文>
 * __GIT_BATCH_ERREND_i__
 * ```
 *
 * 段数对不上就抛错——错位还原会把 A 命令的输出当成 B 命令的，界面表现为「变更清单
 * 莫名空/莫名多」，比直接报错难查得多。
 */
export function parseGitBatchOutput(stdout: string, commandCount: number): GitBatchReply[] {
  const markerOf = (kind: string, index: number): string => `${BATCH_MARK}${kind}_${index}__`;
  /**
   * 标志行**之后**的位置（跳过标志自身与它的尾换行）。
   *
   * 不把前导 `\n` 写进标记里找：每个标志行都由 `printf '%s\n'` 单独打印，末尾必然
   * 跟着一个换行；用「裸标记 + 消费尾换行」一套规则，第一段（输出开头、无前导换行）
   * 与后续段（前面是上一段的尾换行）才一致。
   */
  const afterMarker = (kind: string, index: number): number => {
    const at = stdout.indexOf(markerOf(kind, index));
    if (at < 0) return -1;
    const end = at + markerOf(kind, index).length;
    return stdout[end] === '\n' ? end + 1 : end;
  };
  const replies: GitBatchReply[] = [];
  for (let index = 0; index < commandCount; index += 1) {
    const bodyStart = afterMarker('BEGIN', index);
    const codeAt = stdout.indexOf(markerOf('CODE', index));
    const errMarkerAt = stdout.indexOf(markerOf('ERR', index));
    const errBodyStart = afterMarker('ERR', index);
    const errEndAt = stdout.indexOf(markerOf('ERREND', index));
    if (bodyStart < 0 || codeAt < 0 || errMarkerAt < 0 || errBodyStart < 0 || errEndAt < 0
      || !(bodyStart <= codeAt && codeAt < errMarkerAt && errBodyStart <= errEndAt)) {
      throw new Error(`git 批处理输出缺第 ${index} 段（期望 ${commandCount} 段）`);
    }
    // stdout 正文：BEGIN 标志行之后到 CODE 标志行之前。CODE 标志行由一个 `\n` 起头，
    // 它属于**分隔**而不是 git 的输出（git 自己的尾换行已经在内容里），因此只剥这一个。
    const bodyEnd = codeAt > 0 && stdout[codeAt - 1] === '\n' ? codeAt - 1 : codeAt;
    const body = bodyEnd > bodyStart ? `${stdout.slice(bodyStart, bodyEnd)}\n` : '';
    const exitEnd = (() => {
      const lineEnd = stdout.indexOf('\n', codeAt);
      return lineEnd < 0 ? stdout.length : lineEnd;
    })();
    const exitText = stdout.slice(codeAt + markerOf('CODE', index).length, exitEnd);
    // stderr 正文：ERR 标志行之后到 ERREND 标志行之前（同样只剥分隔用的那一个换行）
    const errEnd = errEndAt > 0 && stdout[errEndAt - 1] === '\n' ? errEndAt - 1 : errEndAt;
    const stderr = errEnd > errBodyStart ? `${stdout.slice(errBodyStart, errEnd)}\n` : '';
    replies.push({
      code: Number.parseInt(exitText.trim(), 10),
      stdout: body,
      stderr,
    });
  }
  return replies;
}

/**
 * 变更清单的取数范围（specs/041 FR-002）：`doc` 只看 Markdown（文档视图的既有口径），
 * `all` 不限定类型（「全部变更」视图）。两者的差别只有 pathspec，解析与过滤完全同一份。
 */
export type ChangeScope = 'doc' | 'all';

/**
 * pathspec 的**唯一定义处**（specs/041 FR-002「不复制第二份解析」）。
 *
 * git 的 `--` 之后为空表示「全匹配」，因此 `all` 返回空数组而不是省略 `--`——
 * 三个调用点都保留 `--`，把「限定范围」这件事收在这一个函数里。
 */
export function pathspecFor(scope: ChangeScope): string[] {
  return scope === 'doc' ? ['*.md', '*.markdown'] : [];
}

/**
 * git 口径取数：与 HEAD 比较（含已暂存与未暂存）+ 未跟踪全文计行。
 *
 * 只读与往返：四条 git 事实（HEAD / diff / 索引 / 未跟踪）合成**一次** `runBatch`，未跟踪文件
 * 的行数由**一次** `lineCounts` 取回，已删除由 git 的 `--diff-filter=d` 自己剔掉——
 * 于是远程工作区上这次取数的网络往返与条目数无关（此前是每个条目一次 SFTP）。
 * 见 `specs/defects/remote-change-list-n-plus-one-round-trips.md`。
 */
export async function collectGitEntries(
  runner: GitCommandRunner,
  scope: ChangeScope = 'doc',
): Promise<DocListResult> {
  const pathspec = pathspecFor(scope);
  const commands = buildChangeCommands(scope);
  let replies: Array<{ code: number; stdout: string; stderr: string }>;
  try {
    replies = await runner.runBatch(commands);
  } catch (err) {
    return { ok: false, error: `git 执行失败: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (replies.length !== commands.length) {
    return { ok: false, error: `git 批处理回包缺段（期望 ${commands.length} 段，收到 ${replies.length} 段）` };
  }
  const [head, numstat, indexed, untracked] = replies as [
    { code: number; stdout: string; stderr: string },
    { code: number; stdout: string; stderr: string },
    { code: number; stdout: string; stderr: string },
    { code: number; stdout: string; stderr: string },
  ];
  // 无 HEAD 的新仓：索引里的全部按新增计全文行数（相对空树）
  const hasHead = head.code === 0;

  const map = new Map<string, DocEntry>();
  /** 需要靠批量计行补行数的路径（未跟踪 + 无 HEAD 时的已暂存） */
  const pendingLineCounts: string[] = [];
  if (hasHead) {
    if (numstat.code !== 0) {
      return { ok: false, error: `git diff 失败: ${numstat.stderr.trim()}` };
    }
    for (const entry of parseNumstat(numstat.stdout)) map.set(entry.path, entry);
  } else {
    if (indexed.code !== 0) {
      return { ok: false, error: `git ls-files 失败: ${indexed.stderr.trim()}` };
    }
    for (const rel of parseLsFiles(indexed.stdout)) {
      map.set(rel, { path: rel, plus: 0, minus: 0 });
      pendingLineCounts.push(rel);
    }
  }

  if (untracked.code !== 0) {
    return { ok: false, error: `git ls-files --others 失败: ${untracked.stderr.trim()}` };
  }
  for (const rel of parseLsFiles(untracked.stdout)) {
    if (map.has(rel)) continue;
    map.set(rel, { path: rel, plus: 0, minus: 0 });
    pendingLineCounts.push(rel);
  }

  // 未跟踪 / 无 HEAD 的条目按**全文行数**计新增：内容留在目标机器上数，一次取回全部行数。
  if (pendingLineCounts.length > 0) {
    const counts = await runner.lineCounts(pendingLineCounts);
    for (const rel of pendingLineCounts) {
      const entry = map.get(rel);
      if (!entry) continue;
      map.set(rel, { ...entry, plus: counts.get(rel) ?? 0 });
    }
  }

  const entries = [...map.values()];
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { ok: true, mode: 'git', entries };
}

/** 记录口径取数：`modifiedDocs` 里的现存文件（不显示行数），已删除的过滤 */export async function collectRecordEntries(
  paths: readonly string[],
  exists: (rel: string) => Promise<boolean>,
): Promise<DocEntry[]> {
  const entries: DocEntry[] = [];
  for (const rel of paths) {
    if (await exists(rel)) entries.push({ path: rel, plus: null, minus: null });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

/** 文档视图的渲染行（主进程铺平：目录在前、层级深度已算好，渲染层直接映射） */
export interface DocRow {
  name: string;
  /** 相对路径（'/' 分隔） */
  rel: string;
  kind: 'directory' | 'file';
  depth: number;
  /** 仅文件且 git 口径有值 */
  plus: number | null;
  minus: number | null;
}

/**
 * 扁平条目 → 渲染行：只保留命中文档的路径分支，**全部层级默认展开**（行序即完整
 * 展开序）；目录在前、同类按名称排序（复用 `sortSidebarEntries` 唯一一份比较器）。
 */
export function buildDocRows(entries: readonly DocEntry[]): DocRow[] {
  const dirsByPath = new Map<string, Set<string>>();
  const filesByPath = new Map<string, Array<{ name: string; entry: DocEntry }>>();
  for (const entry of entries) {
    const parts = entry.path.split('/');
    const name = parts.pop();
    if (name === undefined || name.length === 0) continue;
    let dir = '';
    for (const part of parts) {
      const parent = dir;
      dir = dir === '' ? part : `${dir}/${part}`;
      if (!dirsByPath.has(parent)) dirsByPath.set(parent, new Set());
      dirsByPath.get(parent)!.add(part);
    }
    if (!filesByPath.has(dir)) filesByPath.set(dir, []);
    filesByPath.get(dir)!.push({ name, entry });
  }

  const rows: DocRow[] = [];
  const walk = (dir: string, depth: number): void => {
    const childDirs = [...(dirsByPath.get(dir) ?? [])];
    const childFiles = filesByPath.get(dir) ?? [];
    const sorted = sortSidebarEntries([
      ...childDirs.map((name) => ({ name, kind: 'directory' as const, mtimeMs: null })),
      ...childFiles.map((file) => ({ name: file.name, kind: 'file' as const, mtimeMs: null })),
    ]);
    for (const item of sorted) {
      const rel = dir === '' ? item.name : `${dir}/${item.name}`;
      const file = item.kind === 'file' ? childFiles.find((f) => f.name === item.name) : undefined;
      rows.push({
        name: item.name,
        rel,
        kind: item.kind,
        depth,
        plus: file?.entry.plus ?? null,
        minus: file?.entry.minus ?? null,
      });
      if (item.kind === 'directory') walk(rel, depth + 1);
    }
  };
  walk('', 0);
  return rows;
}
