/**
 * 跨平台运行子进程的小工具。
 *
 * Windows 上 `npm` / `vsce` 等是 `.cmd` 包装脚本，必须经 shell 才能解析。Node 对
 * 「`shell: true` + args 数组」的组合已弃用（DEP0190：参数只会拼接、不做转义），
 * 因此这里在 Windows 下把命令与参数拼成**单条命令字符串**交给 shell，参数引号由
 * [`quoteWindowsArg`] 负责；非 Windows 直接 exec，不经 shell 解释。
 *
 * 与 `src/core/mcp/Client.ts` 的 `McpStdioClient.start()` 保持同一策略。
 */
import { spawnSync } from 'node:child_process';

/**
 * Windows cmd 下对单个参数加引号。
 *
 * 含空格或 cmd 元字符（`"&|<>^()`）的值必须加引号，否则会被拆成多个参数或触发
 * 重定向 / 管道；内层引号按 cmd 约定用 `""` 转义。
 */
export function quoteWindowsArg(value) {
  if (value === '') return '""';
  if (!/[\s"&|<>^()]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * 同步运行一条命令（`spawnSync` 的跨平台封装）。
 *
 * @param {string} command 可执行文件名（如 `npm` / `vsce`）
 * @param {string[]} args 参数数组
 * @param {import('node:child_process').SpawnSyncOptions} [options]
 */
export function spawnCommandSync(command, args, options = {}) {
  if (process.platform === 'win32') {
    const line = [command, ...args].map(quoteWindowsArg).join(' ');
    return spawnSync(line, { ...options, shell: true });
  }
  return spawnSync(command, args, options);
}
