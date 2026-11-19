/**
 * 本机执行的挂载代理 shell（specs/051 FR-004）。
 *
 * 两个宿主（VS Code / Electron）在本机部署时行为完全一致：起一个 `sh -c` 子进程、
 * 把 stdin 写完后立刻关闭、收集 stdout / stderr 与退出码。差异只在「代理产物的路径
 * 怎么定位」，那由调用方传入。
 *
 * ## 为什么用 `sh -c` 而不是 `spawn(cmd, args)`
 *
 * 安装命令里含 `sudo` 与重定向语义（`sudo -S ... --install`），`sudo` 必须先于目标
 * 程序被 shell 解析才能正确传递 stdin。这里传的是**常量命令串**（不含任何用户输入，
 * FR-009 末句），因此不存在注入面。
 *
 * ## 不分配 pty
 *
 * FR-004 第 3 条明令禁止为密码路径分配 pty（pty 缓冲会留下回显）。用普通 pipe 时
 * `sudo -S` 直接从 stdin 读密码、也不回显，正好符合要求。
 */

import { spawn } from 'node:child_process';

import type { MountProxyExecResult, MountProxyShell } from './mountProxyInstall.js';

/** 单条安装命令的超时（含远端慢速 sudo 认证与文件落盘） */
const EXEC_TIMEOUT_MS = 60_000;

/**
 * 用本机 `sh -c` 执行一条命令。
 *
 * `stdin` 写完即 `end()`：留多余输入会让 `sudo` 用它自己重试（FR-004 第 3 条）。
 */
export function createLocalMountProxyShell(options: {
  /** 目标主机名；本机部署恒为 `null`（远端场景由 SSH shell 覆写） */
  targetHost: string | null;
  /** 工作目录（取扩展根，避免相对路径受宿主 cwd 影响） */
  cwd: string;
}): MountProxyShell {
  return {
    targetHost: options.targetHost,
    run: (command, runOptions) =>
      new Promise<MountProxyExecResult>((resolve) => {
        // Windows 上没有装代理的场景（宿主会在更上层拒绝），这里仍给出明确失败而不是抛错
        const child = spawn('sh', ['-c', command], {
          cwd: options.cwd,
          // 明确不分配 pty：普通 pipe，密码不回显（FR-004 第 3 条）
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (result: MountProxyExecResult): void => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        const timer = setTimeout(() => {
          // 超时：杀掉整棵树，避免 sudo 提示符挂住
          child.kill('SIGKILL');
          finish({ code: null, stdout, stderr: stderr || '安装命令超时' });
        }, runOptions.timeoutMs ?? EXEC_TIMEOUT_MS);
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.on('error', (error: Error) => {
          clearTimeout(timer);
          finish({ code: null, stdout, stderr: `${stderr}${error.message}` });
        });
        child.on('close', (code: number | null) => {
          clearTimeout(timer);
          finish({ code, stdout, stderr });
        });
        if (runOptions.stdin) {
          // 写完立刻关闭：`sudo -S` 读到一行密码即开始认证，多余输入会被它当成重试
          child.stdin.end(Buffer.from(runOptions.stdin));
        } else {
          child.stdin.end();
        }
      }),
  };
}
