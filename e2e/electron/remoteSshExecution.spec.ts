import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'ssh2';
import { startMockLlm, lastUserText } from '../helpers/mockLlmServer';
import { launchApp, waitForMessageBox, clickMessageBoxButton, messageBoxText } from '../helpers/electronApp';
import type { AppHandle } from '../helpers/electronApp';
import type { MockLlm, RecordedRequest } from '../helpers/mockLlmServer';
import type { SerializedWorkspaceRef } from '../../src/host/workspaceState';
import { CONFIG_DIR_NAME, CORE_BINARY_NAME, CORE_DEPLOY_PREFIX } from '../../src/config/project';

/** 远端部署目录 / 状态目录 / 进程匹配模式（产品身份唯一来源 `src/config/project.json`，
 *  用例里不落字面量；pgrep / pkill 模式首字符加 [] 不匹配执行它的远端 shell 自身） */
const REMOTE_DEPLOY_DIR = `~/.local/share/${CORE_DEPLOY_PREFIX}`;
const REMOTE_RUN_DIR = `~/${CONFIG_DIR_NAME}/run`;
const CORE_PROCESS_PATTERN = `[${CORE_BINARY_NAME[0]}]${CORE_BINARY_NAME.slice(1)}`;

/**
 * 【临时用例】真实 SSH 远程工作区的工具执行链路（US-37/US-42 之外补的执行面）。
 *
 * 与 `remoteWorkspace.spec.ts`（连接表单 / 历史，假 SSH）不同：这里连**真实 SSH 服务器**，
 * 走完整链路——SSH 建链 → 远端 daemon 引导（上传 Core / ripgrep、`start --idle-exit 30`）
 * → `openWorkspace` → 远端 Core 就绪 → LLM 轮次里的 Bash / Write / Grep / Read 在
 * **远端机器**上执行。mock LLM 对外监听（远端 Core 从目标机器回连本机），断言三分：
 * UI 可见终轮、第二轮 LLM 上下文里的 tool_result、经 SSH/SFTP 直接在远端核实的副作用。
 *
 * 环境：从 `e2e/environments.json` 的 ssh 段读取（该文件不入库，从
 * `e2e/environments.example.json` 复制填写，见 e2e/README.md「测试环境配置」）。
 * 环境有效性判断分两层，**无效直接报错、不做任何修复**（不换凭证重试、不清远端状态）：
 * - 配置层（模块加载期）：文件缺失 / ssh 段形状非法 → 本文件用例在收集期即失败；
 * - 连通层（每个用例开头的 beforeEach）：SSH 可达且远端是 Linux → 无效该用例立即失败。
 * 前置：`npm run build:core:linux-x64`（远端是 Linux 时本机必须携带对应产物）。
 * 运行：
 *   npm run test:e2e:electron -- remoteSshExecution
 */

import { requireSshEnvironment, detectLlmAdvertiseHost } from '../helpers/testEnvironment';

const SSH = requireSshEnvironment();
const ADVERTISE_HOST = SSH.llmAdvertiseHost ?? detectLlmAdvertiseHost();

test.setTimeout(300_000);

function sshConnect(): Client {
  const client = new Client();
  client.connect({ host: SSH.host, port: SSH.port, username: SSH.user, password: SSH.password, readyTimeout: 20_000 });
  return client;
}

/** 在远端执行一条命令（一次性连接，测试脚手架用） */
function sshExec(command: string, timeoutMs = 30_000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const client = sshConnect();
    const fail = (error: Error): void => { client.end(); reject(error); };
    client.on('error', fail);
    client.on('ready', () => {
      client.exec(command, (err, stream) => {
        if (err) return fail(err);
        let stdout = '';
        let stderr = '';
        stream.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
        stream.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
        stream.on('close', (code: number | null) => {
          client.end();
          resolve({ stdout, stderr, code });
        });
      });
    });
    setTimeout(() => fail(new Error(`ssh exec 超时: ${command}`)), timeoutMs);
  });
}

/** 经 SFTP 读远端文件；不存在返回 null */
function sshReadFile(remotePath: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const client = sshConnect();
    const fail = (error: Error): void => { client.end(); reject(error); };
    client.on('error', fail);
    client.on('ready', () => {
      client.sftp((err, sftp) => {
        if (err) return fail(err);
        sftp.readFile(remotePath, 'utf8', (readErr, data) => {
          client.end();
          if (readErr) {
            // sftp 状态码 2 = NO_SUCH_FILE（不存在按 null 返回，配合 expect.poll 重试）
            const code = (readErr as { code?: unknown }).code;
            if (String(code) === '2' || /No such file/i.test(String(readErr.message))) resolve(null);
            else reject(readErr);
          } else {
            resolve(String(data));
          }
        });
      });
    });
    setTimeout(() => fail(new Error(`sftp read 超时: ${remotePath}`)), 30_000);
  });
}

let remoteHome = '';
let remoteWs = '';
let remoteRef: SerializedWorkspaceRef;
let mockLlm: MockLlm | null = null;
let app: AppHandle | null = null;

test.beforeAll(async () => {
  // 远端工作区目录：本轮唯一，结束整目录清理
  const home = await sshExec('pwd');
  if (home.code !== 0) throw new Error(`远端 pwd 失败: ${home.stderr}`);
  remoteHome = home.stdout.trim();
  remoteWs = `${remoteHome}/tuxedo-e2e-ssh-${process.pid}`;
  await sshExec(`mkdir -p ${remoteWs}/notes && rm -rf ${remoteWs}/notes/*`);
  await sshExec(
    `printf 'e2e-remote-marker-42\\nremote grep target line\\n' > ${remoteWs}/notes/hello.txt`
      + ` && printf 'nothing to see here\\n' > ${remoteWs}/notes/other.txt`,
  );
  remoteRef = {
    scheme: 'ssh',
    path: remoteWs,
    endpoint: { host: SSH.host, port: SSH.port, user: SSH.user, auth: { kind: 'sshPassword', password: SSH.password } },
  };
});

test.beforeEach(async () => {
  // 环境有效性判断（每个用例开头）：SSH 可达且远端是携带产物支持的平台。
  // 无效直接报错——不换凭证重试、不清远端状态、不做任何修复；恢复环境是使用者的事
  //（检查 e2e/environments.json 或目标机器）。
  const probe = await sshExec('uname -sm');
  if (probe.code !== 0) {
    throw new Error(
      `SSH 测试环境无效（${SSH.user}@${SSH.host}:${SSH.port}）：uname 失败（exit=${probe.code}）：`
      + `${probe.stderr.trim() || 'no output'}。不做修复，请先恢复环境或修正 e2e/environments.json。`,
    );
  }
  const [system] = probe.stdout.trim().split(/\s+/);
  if (system !== 'Linux') {
    throw new Error(
      `SSH 测试环境无效：远端平台 "${system ?? 'unknown'}" 不被支持（本机携带的 Core 产物只覆盖 Linux）。`
      + '不做修复，请换 Linux 远端或在 e2e/environments.json 改指其它环境。',
    );
  }
});

test.afterAll(async () => {
  if (remoteWs) await sshExec(`rm -rf ${remoteWs}`).catch(() => undefined);
});

test.afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  mockLlm?.close();
  mockLlm = null;
});

/** 启动应用并恢复预置的远程工作区；返回绑定该工作区的聊天视图 */
async function launchWithRemoteWorkspace(remotePath = remoteWs): Promise<Awaited<ReturnType<AppHandle['chatPage']>>> {
  const ref = remotePath === remoteWs ? remoteRef : { ...remoteRef, path: remotePath };
  mockLlm = await startMockLlm({ workspaceDir: remotePath, listenHost: '0.0.0.0', advertiseHost: ADVERTISE_HOST });
  app = await launchApp({
    repoRoot: process.cwd().replace(/[\\/]e2e$/, ''),
    mockLlm,
    workspaceDir: remotePath,
    openWorkspaces: [ref],
    agentMode: 'auto',
  });
  const chatPage = await app.chatPage({ workspaceIncludes: 'tuxedo-e2e-ssh' }, 180_000);
  await chatPage.waitForSelector('textarea.input-textarea', { timeout: 30_000 });
  return chatPage;
}

/** 取第二轮（工具结果回传后）请求里最后一条 tool 消息的内容 */
function lastToolResult(req: RecordedRequest | undefined): string {
  expect(req, '应发生第二次 LLM 请求（工具结果回传）').toBeTruthy();
  const toolMessage = [...(req?.body.messages ?? [])].reverse().find((m) => m.role === 'tool');
  expect(toolMessage, '第二轮上下文应包含 tool_result').toBeTruthy();
  return JSON.stringify(toolMessage?.content ?? '');
}

test('远程工作区启动恢复：SSH 建链 → daemon 引导 → Core 就绪可输入', async () => {
  const chatPage = await launchWithRemoteWorkspace();
  // 输入框可用即就绪；顺手发一条纯文本确认 LLM 往返（远端 Core → 本机 mock）
  mockLlm!.setHandler(() => ({ kind: 'text', text: 'PLAIN-ROUND-OK' }));
  await chatPage.fill('textarea.input-textarea', '远程链路握手');
  await chatPage.press('textarea.input-textarea', 'Enter');
  await expect(chatPage.getByText('PLAIN-ROUND-OK').first()).toBeVisible({ timeout: 60_000 });
  expect(mockLlm!.requests.length).toBe(1);
});

test('Bash 在远端执行：输出来自目标机器（uname=Linux、pwd=远端工作区）', async () => {
  const chatPage = await launchWithRemoteWorkspace();
  mockLlm!.setHandler((req) => {
    if (req.body.messages[req.body.messages.length - 1]?.role === 'tool') {
      return { kind: 'text', text: 'BASH-ROUND-DONE' };
    }
    const text = lastUserText(req.body.messages);
    if (text.includes('远端探针')) {
      return {
        kind: 'tool',
        name: 'Bash',
        args: { command: "printf 'hello-remote-ssh\\n'; uname -s; pwd", description: 'remote probe' },
      };
    }
    return { kind: 'text', text: 'OK' };
  });

  await chatPage.fill('textarea.input-textarea', '远端探针');
  await chatPage.press('textarea.input-textarea', 'Enter');
  await expect(chatPage.getByText('BASH-ROUND-DONE').first()).toBeVisible({ timeout: 90_000 });

  const result = lastToolResult(mockLlm!.requests[1]);
  // 宿主是 Windows：uname 输出 Linux、pwd 是远端路径，才能证明命令真的在远端执行
  expect(result).toContain('hello-remote-ssh');
  expect(result).toContain('Linux');
  expect(result).toContain(remoteWs);
});

test('Write 写进远端工作区：SFTP 直读核实内容', async () => {
  const chatPage = await launchWithRemoteWorkspace();
  const target = `${remoteWs}/e2e-write.txt`;
  mockLlm!.setHandler((req) => {
    if (req.body.messages[req.body.messages.length - 1]?.role === 'tool') {
      return { kind: 'text', text: 'WRITE-ROUND-DONE' };
    }
    const text = lastUserText(req.body.messages);
    if (text.includes('写远端文件')) {
      return {
        kind: 'tool',
        name: 'Write',
        args: { file_path: target, content: '# e2e 远程写入\nwritten-over-ssh\n' },
      };
    }
    return { kind: 'text', text: 'OK' };
  });

  await chatPage.fill('textarea.input-textarea', '写远端文件');
  await chatPage.press('textarea.input-textarea', 'Enter');
  await expect(chatPage.getByText('WRITE-ROUND-DONE').first()).toBeVisible({ timeout: 90_000 });

  const result = lastToolResult(mockLlm!.requests[1]);
  expect(result, `Write 的 tool_result 不应是错误：${result}`).not.toContain('error');

  // 经 SSH 直接核实文件真的落在远端机器上
  await expect
    .poll(() => sshReadFile(target), { timeout: 15_000 })
    .toContain('written-over-ssh');
});

test('Grep 用自带 ripgrep 在远端搜索：命中 seed 文件', async () => {
  const chatPage = await launchWithRemoteWorkspace();
  mockLlm!.setHandler((req) => {
    if (req.body.messages[req.body.messages.length - 1]?.role === 'tool') {
      return { kind: 'text', text: 'GREP-ROUND-DONE' };
    }
    const text = lastUserText(req.body.messages);
    if (text.includes('远端搜索')) {
      return {
        kind: 'tool',
        name: 'Grep',
        args: { pattern: 'e2e-remote-marker-42', path: remoteWs, output_mode: 'content' },
      };
    }
    return { kind: 'text', text: 'OK' };
  });

  await chatPage.fill('textarea.input-textarea', '远端搜索');
  await chatPage.press('textarea.input-textarea', 'Enter');
  await expect(chatPage.getByText('GREP-ROUND-DONE').first()).toBeVisible({ timeout: 90_000 });

  const result = lastToolResult(mockLlm!.requests[1]);
  expect(result).toContain('hello.txt');
  expect(result).toContain('e2e-remote-marker-42');
});

test('Read 读远端文件：内容来自目标机器', async () => {
  const chatPage = await launchWithRemoteWorkspace();
  mockLlm!.setHandler((req) => {
    if (req.body.messages[req.body.messages.length - 1]?.role === 'tool') {
      return { kind: 'text', text: 'READ-ROUND-DONE' };
    }
    const text = lastUserText(req.body.messages);
    if (text.includes('读远端文件')) {
      return {
        kind: 'tool',
        name: 'Read',
        args: { file_path: `${remoteWs}/notes/hello.txt` },
      };
    }
    return { kind: 'text', text: 'OK' };
  });

  await chatPage.fill('textarea.input-textarea', '读远端文件');
  await chatPage.press('textarea.input-textarea', 'Enter');
  await expect(chatPage.getByText('READ-ROUND-DONE').first()).toBeVisible({ timeout: 90_000 });

  const result = lastToolResult(mockLlm!.requests[1]);
  expect(result).toContain('remote grep target line');
});

// ==================== 冷启动 / 生命周期 ====================

/** 远端还活着的 Core 进程（daemon 与 workspace Core 都算） */
function remoteCoreProcesses(): Promise<Array<{ pid: string; cmd: string }>> {
  return sshExec(`pgrep -af '${CORE_PROCESS_PATTERN}' || true`).then(({ stdout }) =>
    stdout.trim().split('\n').filter((line) => line.length > 0).map((line) => {
      const space = line.indexOf(' ');
      return { pid: line.slice(0, space), cmd: line.slice(space + 1) };
    }),
  );
}

/** 轮询远端直到条件满足（每 2s 一次 SSH 连接） */
async function pollRemote(
  probe: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (await probe()) return;
    if (Date.now() - startedAt > timeoutMs) {
      const procs = await remoteCoreProcesses();
      throw new Error(`等待远端条件超时（${label}）。远端残留进程：${JSON.stringify(procs)}`);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

/** 本机携带产物的指纹（与远端部署槽位同名） */
function localFingerprint(): string {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  return fs.readFileSync(
    path.join(repoRoot, 'dist', 'resources', 'core', 'x64-linux', 'fingerprint'),
    'utf8',
  ).trim();
}

test('冷部署：槽位与共享 ripgrep 全部缺失时首次连接完成部署并可用', async () => {
  const fingerprint = localFingerprint();
  // 清场：杀残留 daemon / 删本指纹槽位与共享 ripgrep / 删状态文件——模拟「第一次连这台机器」
  // pkill 模式带 []：不匹配执行这条命令的远端 shell 自身（否则 pkill 杀掉自己的父 shell，清场半途而废）
  await sshExec(
    `pkill -f '${CORE_PROCESS_PATTERN}' || true; sleep 1`
      + ` && rm -rf ${REMOTE_DEPLOY_DIR}/${fingerprint} ${REMOTE_DEPLOY_DIR}/ripgrep`
      + ` ${REMOTE_RUN_DIR}/core-daemon-${fingerprint}.json`,
  );

  const chatPage = await launchWithRemoteWorkspace();
  // 冷部署后照旧就绪（deploy 走 chatPage 180s 预算）
  mockLlm!.setHandler((req) => {
    if (req.body.messages[req.body.messages.length - 1]?.role === 'tool') {
      return { kind: 'text', text: 'COLD-DEPLOY-DONE' };
    }
    return {
      kind: 'tool',
      name: 'Bash',
      args: { command: "printf 'cold-deploy-ok\\n'; uname -s", description: 'cold deploy probe' },
    };
  });
  await chatPage.fill('textarea.input-textarea', '冷部署探针');
  await chatPage.press('textarea.input-textarea', 'Enter');
  await expect(chatPage.getByText('COLD-DEPLOY-DONE').first()).toBeVisible({ timeout: 120_000 });
  const result = lastToolResult(mockLlm!.requests[1]);
  expect(result).toContain('cold-deploy-ok');
  expect(result).toContain('Linux');

  // 部署副作用：槽位与共享 ripgrep 都回来了
  const state = await sshExec(
    `ls ${REMOTE_DEPLOY_DIR}/${fingerprint}/${CORE_BINARY_NAME} ${REMOTE_DEPLOY_DIR}/ripgrep/rg`,
  );
  expect(state.code, `冷部署应落产物: ${state.stderr}`).toBe(0);
});

test('客户端强杀后远端清理：workspace Core 秒级退出、daemon 30s 空闲退出且清状态文件', async () => {
  const fingerprint = localFingerprint();
  const chatPage = await launchWithRemoteWorkspace();
  await chatPage.waitForSelector('textarea.input-textarea', { timeout: 30_000 });
  // 此刻远端应有 workspace Core 在跑（连接持有）
  const during = await remoteCoreProcesses();
  expect(during.some((p) => p.cmd.includes(' start-daemon')), 'daemon 应在跑').toBeTruthy();

  // 强杀宿主（taskkill /F）：远端只能靠 EOF / 心跳超时发现
  await app!.close();
  app = null;
  mockLlm!.close();
  mockLlm = null;

  // workspace Core（stdio）应在 EOF 后立即被关（这里给 25s 上限）
  await pollRemote(
    async () => !(await remoteCoreProcesses()).some((p) => p.cmd.includes(' stdio')),
    25_000,
    'workspace Core 退出',
  );
  // daemon 应在最后一条连接断开 30s 后自行退出并清掉状态文件（给 60s 上限）
  await pollRemote(
    async () => (await remoteCoreProcesses()).length === 0,
    60_000,
    'daemon idle-exit',
  );
  const stateFile = await sshExec(`ls ${REMOTE_RUN_DIR}/core-daemon-${fingerprint}.json 2>/dev/null; true`);
  expect(stateFile.stdout.trim(), 'daemon 退出应清掉状态文件').toBe('');
});

test('陈旧状态文件：daemon 被强杀后按「没有 daemon」重新引导', async () => {
  const fingerprint = localFingerprint();
  await sshExec(`pkill -f '${CORE_PROCESS_PATTERN}' || true; sleep 1`);
  // 手工拉起 daemon 再 kill -9：留下指向死端口的状态文件
  const started = await sshExec(
    `${REMOTE_DEPLOY_DIR}/${fingerprint}/${CORE_BINARY_NAME} start --idle-exit 30 >/dev/null 2>&1; true`,
    60_000,
  );
  expect(started.code ?? 0, `手工 start 失败: ${started.stderr}`).toBe(0);
  await sshExec('pkill -9 -f "start-daemo[n]" || true; sleep 1');

  const chatPage = await launchWithRemoteWorkspace();
  mockLlm!.setHandler((req) => {
    if (req.body.messages[req.body.messages.length - 1]?.role === 'tool') {
      return { kind: 'text', text: 'STALE-STATE-DONE' };
    }
    return {
      kind: 'tool',
      name: 'Bash',
      args: { command: "printf 'stale-state-ok\\n'", description: 'stale state probe' },
    };
  });
  await chatPage.fill('textarea.input-textarea', '陈旧状态探针');
  await chatPage.press('textarea.input-textarea', 'Enter');
  await expect(chatPage.getByText('STALE-STATE-DONE').first()).toBeVisible({ timeout: 120_000 });
  const result = lastToolResult(mockLlm!.requests[1]);
  expect(result).toContain('stale-state-ok');
});

test('manual 权限模式：远程 Bash 弹确认、允许后在远端执行', async () => {
  mockLlm = await startMockLlm({ workspaceDir: remoteWs, listenHost: '0.0.0.0', advertiseHost: ADVERTISE_HOST });
  app = await launchApp({
    repoRoot: process.cwd().replace(/[\\/]e2e$/, ''),
    mockLlm,
    workspaceDir: remoteWs,
    openWorkspaces: [remoteRef],
    agentMode: 'manual',
  });
  const chatPage = await app.chatPage({ workspaceIncludes: 'tuxedo-e2e-ssh' }, 120_000);
  await chatPage.waitForSelector('textarea.input-textarea', { timeout: 30_000 });

  mockLlm.setHandler((req) => {
    if (req.body.messages[req.body.messages.length - 1]?.role === 'tool') {
      return { kind: 'text', text: 'MANUAL-PERM-DONE' };
    }
    return {
      kind: 'tool',
      name: 'Bash',
      // sleep 不在只读白名单（core-rs/src/permission.rs 的 READONLY_COMMANDS）：
      // manual 模式必须弹确认；printf/uname/pwd 这类只读命令按设计自动放行，测不出 ask 路径
      args: { command: "sleep 2; printf 'manual-perm-ok\\n'; uname -s", description: 'manual perm probe' },
    };
  });
  await chatPage.fill('textarea.input-textarea', '手动确认探针');
  await chatPage.press('textarea.input-textarea', 'Enter');

  const overlay = chatPage.locator('.user-choice-overlay');
  await expect(overlay).toBeVisible({ timeout: 60_000 });
  await overlay.getByRole('button', { name: /允许/ }).first().click();

  await expect(chatPage.getByText('MANUAL-PERM-DONE').first()).toBeVisible({ timeout: 90_000 });
  const result = lastToolResult(mockLlm.requests[1]);
  expect(result).toContain('manual-perm-ok');
  expect(result).toContain('Linux');
});

test('US-42 远程（SSH）文件浏览：树来自远端、悬停显示修改时间、删除经 SFTP 落到远端', async () => {
  await launchWithRemoteWorkspace();
  const sb = await app!.sidebarPage();
  await sb.locator('#filesHeader').click();

  // 根层来自远端 SFTP 读盘：notes 目录在
  const notesDir = sb.locator('#filesTree .file-row[data-path="notes"]');
  await expect(notesDir).toBeVisible({ timeout: 90_000 });
  await notesDir.click();

  // 懒加载下一层：远端文件行
  const hello = sb.locator('#filesTree .file-row[data-path="notes/hello.txt"]');
  await expect(hello).toBeVisible({ timeout: 60_000 });

  // US-62 远程口径：悬停提示带修改时间（同一绝对时刻的同一呈现）
  await expect(hello).toHaveAttribute('title', /修改时间：\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/);

  // 远端新建文件 → 刷新按钮重新读远端，新条目出现
  const addedPath = `${remoteWs}/notes/added-later.txt`;
  await sshExec(`printf 'added later\n' > ${addedPath}`);
  await sb.locator('#filesRefresh').click();
  const added = sb.locator('#filesTree .file-row[data-path="notes/added-later.txt"]');
  await expect(added).toBeVisible({ timeout: 60_000 });

  // 右键删除：确认框 → 远端真删（SFTP 直读核实），树自动刷新后条目消失
  await added.click({ button: 'right' });
  await sb.locator('[data-menu="delete"]').click();
  const box = await waitForMessageBox(app!);
  const call = await messageBoxText(box);
  // 远端没有回收站：确认按钮是「永久删除」，与本地「移入回收站」区分
  expect(call.buttons).toEqual(['永久删除', '取消']);
  await clickMessageBoxButton(box, 0);
  await expect(added).toHaveCount(0, { timeout: 60_000 });
  expect(await sshReadFile(addedPath)).toBeNull();
  // 同目录的既有文件不受影响
  expect(await sshReadFile(`${remoteWs}/notes/hello.txt`)).toContain('e2e-remote-marker-42');
});

/** 桩住 Menu.buildFromTemplate：记录弹出的菜单（点击条目用），popup 不真弹 */
async function stubTabMenus(): Promise<void> {
  const result = await app!.evaluateInMain(`(function(){try{
    const e = process.mainModule ? process.mainModule.require('electron') : require('electron');
    if (!globalThis.__origBuildFromTemplate) {
      globalThis.__origBuildFromTemplate = e.Menu.buildFromTemplate.bind(e.Menu);
    }
    globalThis.__menus = [];
    e.Menu.buildFromTemplate = function(template){
      const menu = globalThis.__origBuildFromTemplate(template);
      menu.popup = function(){
        globalThis.__menus.push({
          items: template.map(function(t){ return { label: t.label === undefined ? null : t.label, enabled: t.enabled !== false }; }),
          clicks: template.map(function(t){ return typeof t.click === 'function' ? t.click : null; }),
        });
      };
      return menu;
    };
    return 'ok';
  } catch (err) { return 'ERR ' + err.message; }})()`);
  const value = (result as { result?: { result?: { value?: string } } })?.result?.result?.value;
  if (value !== 'ok') throw new Error(`菜单桩注入失败：${value}`);
}

async function clickLastMenuItem(index: number): Promise<void> {
  const result = await app!.evaluateInMain(`(function(){try{
    const m = globalThis.__menus[globalThis.__menus.length - 1];
    const fn = m && m.clicks[${index}];
    if (typeof fn !== 'function') return 'no-click';
    fn();
    return 'ok';
  } catch (err) { return 'ERR ' + err.message; }})()`);
  const value = (result as { result?: { result?: { value?: string } } })?.result?.result?.value;
  if (value !== 'ok') throw new Error(`菜单条目 ${index} 点击失败：${value}`);
}

/** 打开当前（远程）工作区标签页的终端窗口，返回其页面 */
async function openRemoteTerminal(): Promise<import('@playwright/test').Page> {
  await stubTabMenus();
  const titlebar = await app!.titlebarPage();
  const tab = titlebar.locator('#workspaceTabs [role="tab"]').first();
  await expect(tab).toBeVisible({ timeout: 90_000 });
  await tab.click({ button: 'right' });
  await expect.poll(async () => {
    const raw = await app!.evaluateInMain('(function(){return String(globalThis.__menus.length);})()');
    return Number((raw as { result?: { result?: { value?: string } } })?.result?.result?.value ?? 0);
  }, { timeout: 15_000 }).toBe(1);
  // 条目顺序：关闭 / 关闭所有空闲会话 / 关闭其它所有工作区 / 分隔线 / 打开终端
  await clickLastMenuItem(4);
  return app!.waitForPage('/terminal/', 60_000);
}

test('US-54 真实 SSH 终端：右键打开终端连上远端 shell、标题含 ssh://、退出后窗口关闭', async () => {
  await launchWithRemoteWorkspace();
  const termPage = await openRemoteTerminal();

  // 首标签自动建立并连上远端 shell
  await expect(termPage.locator('.tab')).toHaveCount(1, { timeout: 90_000 });
  await expect(termPage.locator('#pane-1 .xterm')).toBeVisible({ timeout: 60_000 });

  // 窗口标题 = ssh://user@host + 远端工作区路径
  const expectedTitle = `ssh://${SSH.user}@${SSH.host}${remoteWs}`;
  await expect.poll(async () => {
    const raw = await app!.evaluateInMain(`(function(){try{
      const e = process.mainModule ? process.mainModule.require('electron') : require('electron');
      const w = e.BrowserWindow.getAllWindows().find(function(win){
        try { return !win.isDestroyed() && win.webContents.getURL().indexOf('/terminal/') >= 0; } catch (err) { return false; }
      });
      return w ? w.getTitle() : 'no-window';
    } catch (err) { return 'ERR ' + err.message; }})()`);
    return (raw as { result?: { result?: { value?: string } } })?.result?.result?.value;
  }, { timeout: 30_000 }).toBe(expectedTitle);

  // 命令真的在远端执行：uname 输出 Linux
  await termPage.locator('.xterm-helper-textarea').click();
  await termPage.keyboard.type('uname -s');
  await termPage.keyboard.press('Enter');
  await expect.poll(() => termPage.locator('#pane-1 .xterm-rows').textContent(), { timeout: 60_000 })
    .toContain('Linux');

  // 远端 shell 退出 → 最后一个标签自动关闭 → 终端窗口随之销毁（AC-1 / AC-4）
  await termPage.keyboard.type('exit');
  await termPage.keyboard.press('Enter');
  await expect.poll(async () => {
    const raw = await app!.evaluateInMain(`(function(){try{
      const e = process.mainModule ? process.mainModule.require('electron') : require('electron');
      return String(e.BrowserWindow.getAllWindows().filter(function(win){
        try { return !win.isDestroyed() && win.webContents.getURL().indexOf('/terminal/') >= 0; } catch (err) { return false; }
      }).length);
    } catch (err) { return 'ERR ' + err.message; }})()`);
    return (raw as { result?: { result?: { value?: string } } })?.result?.result?.value;
  }, { timeout: 60_000 }).toBe('0');
});

test('US-63 远程文档视图：远端 git 口径列出变更 md 与增删行数，远端 commit 后哨兵自动刷新', async () => {
  // 远端建仓：一次基线提交，然后制造「未暂存改动 + 未跟踪新文档 + 非 md 改动」
  const repo = `${remoteWs}/docrepo`;
  await sshExec(`rm -rf ${repo} && mkdir -p ${repo} && cd ${repo}`
    + ' && git init -q && git config user.email e2e@example.com && git config user.name e2e'
    + " && printf '# A\nline1\nline2\n' > a.md && printf '# B\n' > b.md"
    + " && printf 'plain\n' > notes.txt && git add . && git commit -qm init");
  await sshExec(`cd ${repo}`
    + " && printf '# A\nline1\nline2\nnew1\nnew2\n' > a.md"
    + " && printf '# C\n' > c.md"
    + " && printf 'changed\n' > notes.txt");

  await launchWithRemoteWorkspace(repo);
  const sb = await app!.sidebarPage();
  await sb.locator('#filesHeader').click();
  await expect(sb.locator('#filesTree .file-row[data-path="a.md"]')).toBeVisible({ timeout: 90_000 });

  // 切到文档视图：git 判定与行数统计在远端执行（ssh exec），记录经 SFTP 读
  await sb.locator('#filesDocToggle').click();
  const aRow = sb.locator('#filesTree .file-row[data-path="a.md"]');
  await expect(aRow).toBeVisible({ timeout: 60_000 });
  await expect(aRow.locator('.doc-plus')).toHaveText('+2');
  await expect(aRow.locator('.doc-minus')).toHaveText('-0');
  // 未跟踪新文档按全文计新增；非 md 不列
  const cRow = sb.locator('#filesTree .file-row[data-path="c.md"]');
  await expect(cRow).toBeVisible({ timeout: 30_000 });
  await expect(cRow.locator('.doc-plus')).toHaveText('+1');
  await expect(sb.locator('#filesTree .file-row[data-path="notes.txt"]')).toHaveCount(0);

  // 远端哨兵：在会话外 commit（不经 UI、不点刷新）后文档视图自动重取，变更集清空
  //（specs/030 FR-003 / US-63 验收 4：远端复用 specs/018 的 watch 通道，目录目标由
  // core 的 FileWatchRegistry 支持）。
  await sshExec(`cd ${repo} && git add -A && git commit -qm all-done`);
  await expect(sb.locator('#filesTree .file-row[data-path="a.md"]')).toHaveCount(0, { timeout: 60_000 });
  await expect(sb.getByText('没有变更的 Markdown 文档')).toBeVisible({ timeout: 30_000 });

  await sshExec(`rm -rf ${repo}`).catch(() => undefined);
});

// ==================== SSH 断连 → 标红 → 重连后发送对话无反应（RT 落点） ====================
// SIGSTOP 远端 daemon 制造链路沉默（Host 沉默判死 ≤10s 内 fatal）→ 标红 → SIGCONT
// 复活 daemon 并点「重新连接」→ 断言孤儿视图清零、恢复后立即与就绪后的发送都正常
// 往返。specs/defects/workspace-unavailable-teardown-strands-orphan-views（RT-1 / RT-2）
// 与 specs/defects/ssh-reconnect-send-dropped-before-connection-ready（RT-1）共用本用例。

test('SSH 断连标红重连：孤儿视图清零、恢复后发送正常往返', async () => {
  test.setTimeout(600_000);
  // 三工作区（远程活动 + 两个本地）：远程死亡标红时其余两个 Connection 仍在
  // （Client 无「唯一连接」退路），旧会话释放路由必抛——孤儿视图滞留 + 恢复后
  // 旧会话的每次发送都持续抛「No Connection owns session」，对应真实用户
  // 「必须关闭对话重新打开」的形态（specs/defects/ 两份缺陷规格共用本场景）
  const fs = await import('node:fs');
  const os = await import('node:os');
  const pathMod = await import('node:path');
  const localDirA = await fs.promises.mkdtemp(pathMod.join(os.tmpdir(), 'e2e-ws-local-a-'));
  const localDirB = await fs.promises.mkdtemp(pathMod.join(os.tmpdir(), 'e2e-ws-local-b-'));
  // 清场：杀残留 daemon / 删状态文件——上一轮用例的 daemon 可能还在空闲退出倒计时里，
  // 复用半死的 daemon 会让本轮建链挂起（对齐冷部署用例的清场做法）
  await sshExec(`pkill -f '${CORE_PROCESS_PATTERN}' || true; sleep 1`);
  const fingerprint = localFingerprint();
  await sshExec(`rm -f ${REMOTE_RUN_DIR}/core-daemon-${fingerprint}.json`);
  mockLlm = await startMockLlm({ workspaceDir: remoteWs, listenHost: '0.0.0.0', advertiseHost: ADVERTISE_HOST });
  app = await launchApp({
    repoRoot: process.cwd().replace(/[\\/]e2e$/, ''),
    mockLlm,
    workspaceDir: remoteWs,
    openWorkspaces: [remoteRef, localDirA, localDirB],
    agentMode: 'auto',
  });
  const chatPage = await app.chatPage({ workspaceIncludes: 'tuxedo-e2e-ssh' }, 180_000);
  await chatPage.waitForSelector('textarea.input-textarea', { timeout: 30_000 });

  // 1) 链路健康基线：一轮纯文本往返
  mockLlm!.setHandler(() => ({ kind: 'text', text: 'LINK-OK' }));
  await chatPage.fill('textarea.input-textarea', '链路握手');
  await chatPage.press('textarea.input-textarea', 'Enter');
  await expect(chatPage.getByText('LINK-OK').first()).toBeVisible({ timeout: 90_000 });

  // 2) 长轮次：远端 Bash sleep 保持查询进行中（贴近真实断连场景：查询中链路死亡）
  mockLlm!.setHandler((req) => {
    if (req.body.messages[req.body.messages.length - 1]?.role === 'tool') {
      return { kind: 'text', text: 'LONG-ROUND-DONE' };
    }
    return {
      kind: 'tool',
      name: 'Bash',
      args: { command: 'sleep 45', description: 'keep-round-busy' },
    };
  });
  await chatPage.fill('textarea.input-textarea', '长查询探针');
  await chatPage.press('textarea.input-textarea', 'Enter');
  // 第二个 LLM 请求（tool_result 回传前）已发出 = 查询在途
  await expect
    .poll(() => mockLlm!.requests.length, { timeout: 30_000, intervals: [500, 1_000] })
    .toBeGreaterThan(1);

  // 3) SIGSTOP 远端 daemon → Host 沉默判死（≤10s）→ 远程标签标红
  await sshExec(`pkill -STOP -f 'start-daemo[n]' || true`);
  const titlebar0 = await app!.titlebarPage();
  const remoteTab0 = titlebar0.locator('#workspaceTabs [role="tab"]').filter({ hasText: 'tuxedo-e2e-ssh' });
  await expect(remoteTab0.locator('.ws-tab-dot')).toBeVisible({ timeout: 60_000 });

  // 4) SIGCONT 复活 daemon（避免 30s 空闲退出）；点红标签激活 → 占位页「重新连接」
  await sshExec(`pkill -CONT -f 'start-daemo[n]' || true`);
  await remoteTab0.click();
  const placeholder = await app!.waitForPage('data:text/html', 60_000);
  await expect(placeholder.locator('#reconnectBtn')).toBeVisible({ timeout: 30_000 });
  await placeholder.locator('#reconnectBtn').click();

  // 5) 等真实用户的恢复时点：建链中黄点（呼吸点）收掉 = 聊天区同批恢复可交互
  //（Playwright 能隔着占位页对被遮挡视图输入，必须显式等恢复，不能复用旧的聊天页对象）
  const titlebar = await app!.titlebarPage();
  const remoteTab = titlebar.locator('#workspaceTabs [role="tab"]').filter({ hasText: 'tuxedo-e2e-ssh' });
  await expect(remoteTab).toBeVisible({ timeout: 60_000 });
  await expect(remoteTab.locator('.ws-tab-loading')).toHaveCount(0, { timeout: 120_000 });

  // 6) 现状（缺陷）下孤儿视图被复用：旧对话内容还在、恢复后立即发送（真实用户的第一反应）
  const restored = await app!.chatPage({ workspaceIncludes: 'tuxedo-e2e-ssh' }, 60_000);
  await restored.waitForSelector('textarea.input-textarea', { timeout: 60_000 });
  const oldContentVisible = await restored
    .getByText('LINK-OK')
    .first()
    .isVisible()
    .catch(() => false);
  console.log(`[复现] 重连后旧对话内容可见（孤儿视图被复用）: ${oldContentVisible}`);
  console.log(`[复现] 重连前 LLM 请求数: ${mockLlm!.requests.length}`);

  // 7) 发送 #1（紧接恢复）：现状（孤儿 + 无唯一连接退路）预期路由抛错丢弃（无响应）
  mockLlm!.setHandler(() => ({ kind: 'text', text: 'RECONNECT-OK-1' }));
  await restored.fill('textarea.input-textarea', '重连后握手1');
  await restored.press('textarea.input-textarea', 'Enter');
  const earlyOutcome = await restored
    .getByText('RECONNECT-OK-1')
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => '响应到达')
    .catch(() => '无响应（死信）');
  console.log(`[复现] 紧接发送的结果: ${earlyOutcome}，LLM 请求数: ${mockLlm!.requests.length}`);

  // 8) 发送 #2（20s 后，Connection 必已就绪）：现状预期仍无响应（持续死信，
  // 对应「必须关开对话」）；修复后两次都正常往返
  await new Promise((r) => setTimeout(r, 20_000));
  mockLlm!.setHandler(() => ({ kind: 'text', text: 'RECONNECT-OK-2' }));
  await restored.fill('textarea.input-textarea', '重连后握手2');
  await restored.press('textarea.input-textarea', 'Enter');
  const lateOutcome = await restored
    .getByText('RECONNECT-OK-2')
    .first()
    .waitFor({ state: 'visible', timeout: 60_000 })
    .then(() => '响应到达')
    .catch(() => '无响应（死信）');
  console.log(`[复现] 就绪后发送的结果: ${lateOutcome}，LLM 请求数: ${mockLlm!.requests.length}`);

  // 正式断言（RT）：现状红（孤儿复活旧对话 + 持续死信）；修复后绿
  expect(oldContentVisible, '重连后不得复活旧对话视图（孤儿清理，orphan-views RT-1）').toBe(false);
  expect(earlyOutcome, '恢复后立即发送的对话必须正常往返（reconnect RT-1）').toBe('响应到达');
  expect(lateOutcome, '就绪后发送的对话必须正常往返（reconnect RT-1）').toBe('响应到达');
  await fs.promises.rm(localDirA, { recursive: true, force: true }).catch(() => undefined);
  await fs.promises.rm(localDirB, { recursive: true, force: true }).catch(() => undefined);
});
