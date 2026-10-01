/**
 * 单测：Electron IPC 频道注册与调用一致（`electron/**`）。
 *
 * 锁住一类**静默失效**：渲染进程用 `ipcRenderer.send` / `invoke` 发的频道，主进程必须用
 * 对应的 `ipcMain.on` / `ipcMain.handle` 接。
 *
 * - `send` 配 `handle`（或 `invoke` 配 `on`）→ 谁都不接，页面「点了没反应」，
 *   日志里也什么都没有（`remote-workspace:open` 曾经就是这个错法：页面停在忙态、
 *   所有按钮变灰，看起来像卡死）；
 * - `invoke` 没有 `handle` → 渲染进程拿到 "No handler registered" 的 rejection。
 *
 * 反向（注册了没人用）只作为提示打印，不断言：那是死代码，不是故障。
 *
 * 运行方式：npm run test:all -- ipc-channels
 */

import * as fs from 'fs';
import * as path from 'path';
import { createChecker, runTests } from './helpers/harness';

const repoRoot = path.resolve(__dirname, '../../..');
const electronDir = path.join(repoRoot, 'electron');

/** 递归列出目录下的 .ts 文件（跳过 node_modules 与产物目录） */
function listTsFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listTsFiles(full));
      continue;
    }
    if (entry.name.endsWith('.ts')) found.push(full);
  }
  return found;
}

/** 在给定文件里收集正则第一个捕获组命中的频道名 */
function collectChannels(pattern: RegExp, files: readonly string[]): Set<string> {
  const channels = new Set<string>();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf-8');
    for (const match of text.matchAll(pattern)) {
      const channel = match[1];
      if (channel) channels.add(channel);
    }
  }
  return channels;
}

runTests('ipcChannels', () => {
  const { check, finish } = createChecker();
  const files = listTsFiles(electronDir);

  const invokes = collectChannels(/ipcRenderer\.invoke\(\s*'([^']+)'/g, files);
  const sends = collectChannels(/ipcRenderer\.send\(\s*'([^']+)'/g, files);
  const handles = collectChannels(/ipcMain\.handle\(\s*'([^']+)'/g, files);
  const ons = collectChannels(/ipcMain\.on\(\s*'([^']+)'/g, files);

  // 遍历本身跑偏（改目录结构 / 改写法）时先失败，免得下面的断言变成空跑
  check('扫到 invoke 频道', invokes.size > 0);
  check('扫到 send 频道', sends.size > 0);
  check('扫到 handle 频道', handles.size > 0);
  check('扫到 on 频道', ons.size > 0);

  for (const channel of [...invokes].sort()) {
    check(`invoke 的频道有 handle: ${channel}`, handles.has(channel));
  }
  for (const channel of [...sends].sort()) {
    check(`send 的频道有 on: ${channel}`, ons.has(channel));
  }

  const unusedHandles = [...handles].filter((channel) => !invokes.has(channel)).sort();
  const unusedOns = [...ons].filter((channel) => !sends.has(channel)).sort();
  if (unusedHandles.length > 0) console.log(`    提示：handle 无对应 invoke（死代码）：${unusedHandles.join(', ')}`);
  if (unusedOns.length > 0) console.log(`    提示：on 无对应 send（死代码）：${unusedOns.join(', ')}`);

  finish();
});
