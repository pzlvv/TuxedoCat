/**
 * TimeoutPolicy - Bash 工具超时策略常量与命令分隔工具
 *
 * - 所有 Bash 命令默认 60s 前台超时，超时自动转入后台
 * - 例外：命令包含 sleep 子命令时不设超时（sleep 等待由通知事件打断，
 *   见 SleepDetect.ts / Exec.ts）
 */

/** Bash 默认前台超时（60s），超时自动转入后台 */
export const DEFAULT_BASH_TIMEOUT_MS = 60_000;

/** sleep 命令不设前台超时（0 = no timeout） */
export const SLEEP_NO_TIMEOUT_MS = 0;

/**
 * 将命令按分隔符拆分为独立的子命令段
 * 支持的分隔符：; && || |（仅在引号 / 命令替换之外生效）
 *
 * 引号规则（与 bash 一致）：
 * - 单引号 '...'：内部所有字符按字面处理，| ; & 等都不是分隔符
 * - 双引号 "..."：支持 \" \\ \` \$ 转义，内部的分隔符不作为分隔符
 * - 反引号 `...` 与 $(...) 命令替换：整体跳过，内部不作为分隔符
 * - 引号外的反斜杠 \ 转义下一个字符（如 \| 表示字面 |）
 *
 * 例如：
 * - `grep "a|b" file.txt` -> 只拆出 `grep "a|b" file.txt`（引号内的 | 不拆）
 * - `cat a.txt | sort && echo ok` -> ['cat a.txt', 'sort', 'echo ok']
 */
export function splitBySeparators(command: string): string[] {
  const result: string[] = [];
  let current = '';
  let i = 0;
  const n = command.length;

  const pushCurrent = (): void => {
    const trimmed = current.trim();
    if (trimmed) {
      result.push(trimmed);
    }
    current = '';
  };

  /**
   * 从 start（command[start] 为 openChar）扫描引号块，返回闭合后的下一个索引。
   * 未闭合时返回 n。
   */
  const scanQuoted = (start: number, openChar: string): number => {
    if (openChar === "'" || openChar === '`') {
      const end = command.indexOf(openChar, start + 1);
      return end === -1 ? n : end + 1;
    }
    // 双引号：支持 \ 转义
    let j = start + 1;
    while (j < n) {
      if (command[j] === '\\') {
        j += 2; // 跳过 \" \\ \` \$ 等转义序列
        continue;
      }
      if (command[j] === '"') {
        return j + 1;
      }
      j++;
    }
    return n; // 未闭合
  };

  while (i < n) {
    const ch = command[i];

    // 引号块：整体保留，内部的分隔符不作为分隔符
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = scanQuoted(i, ch);
      current += command.slice(i, end);
      i = end;
      continue;
    }

    // $(...) 命令替换：按括号配对跳过（内部引号块一并跳过）
    if (ch === '$' && command[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        const inner = command[j];
        if (inner === "'" || inner === '"' || inner === '`') {
          j = scanQuoted(j, inner);
          continue;
        }
        if (inner === '(') depth++;
        else if (inner === ')') depth--;
        j++;
      }
      current += command.slice(i, j);
      i = j;
      continue;
    }

    // 引号外的反斜杠转义：\X 整体保留（\| 不是分隔符）
    if (ch === '\\' && i + 1 < n) {
      current += ch + command[i + 1];
      i += 2;
      continue;
    }

    // 分隔符（仅在引号外生效）
    if (ch === ';') {
      pushCurrent();
      i++;
      continue;
    }
    if (ch === '&' && command[i + 1] === '&') {
      pushCurrent();
      i += 2;
      continue;
    }
    if (ch === '|' && command[i + 1] === '|') {
      pushCurrent();
      i += 2;
      continue;
    }
    if (ch === '|') {
      pushCurrent();
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  pushCurrent();
  return result;
}
