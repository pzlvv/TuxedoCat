#!/usr/bin/env node
/**
 * 挂载代理的真机验证脚手架（specs/051 阶段一）。
 *
 * 本机（Windows）无法执行 Linux 二进制（`cargo test --target *-linux-musl` 报
 * 「不是有效的 Win32 应用程序」，WSL 也没装发行版），因此代理的**行为面**只能在
 * 真实 Linux 机器上验证。这个脚本负责：
 *
 *   1. 把 `resources/<core.resourceDir>/<dir>/<core.mountProxyName>` 经 SFTP 传到远端
 *      的家目录暂存区（不进 `/usr/libexec`——安装由代理自己的 `--install` 做）；
 *   2. 用 `--protocol-version` 核验产物能在远端执行；
 *   3. 依次跑 `--self-check`、`--install`（经 sudo）、装机后再跑一次 `--self-check`；
 *   4. 打印每一步的 stdout / stderr / exit code，收尾还原远端（卸载 + 清暂存）。
 *
 * 刻意不做的事：
 * - **不修环境**。缺 sudo、`/usr/libexec` 不存在、`nosuid` 之类一律如实报错并退出，
 *   由使用者恢复（与 `e2e/helpers/testEnvironment.ts` 同一口径）。
 * - **不留状态**。装了就在 `finally` 里卸掉：远端是共享机器，不能留 setuid root 文件。
 *
 * 用法（环境取自 `e2e/environments.json` 的 ssh 段，不入库）：
 *   node scripts/verify-mount-proxy-remote.mjs
 *   node scripts/verify-mount-proxy-remote.mjs --arch x64        # 显式指定产物架构
 *   node scripts/verify-mount-proxy-remote.mjs --keep-installed # 保留装机（排查用）
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'ssh2';
import project from '../project.config.cjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const keepInstalled = args.includes('--keep-installed');
const archIndex = args.indexOf('--arch');
const arch = archIndex >= 0 ? args[archIndex + 1] : 'x64';
if (!['x64', 'arm64'].includes(arch)) {
  console.error(`--arch 只能是 x64 或 arm64（当前：${arch}）`);
  process.exit(2);
}

/** 远端产物名与落点（唯一来源是 `src/config/project.json`） */
const PROXY_NAME = project.core.mountProxyName;
const PROXY_DIR = project.core.mountProxyDir;
const INSTALLED_PATH = `${PROXY_DIR}/${PROXY_NAME}`;
const UID_LIST_PATH = `${PROXY_DIR}/${PROXY_NAME}.uids`;

/**
 * 常驻形态的客户端桩（在远端用 python3 跑，经 stdin 传源码）。
 *
 * 按 `mount-proxy-rs/src/protocol.rs` 的帧格式（8 位十六进制长度 + `\n` + JSON）收发，
 * 目的是**在不接 Core 的情况下**验证 `--serve` 那半边：拉起、握手、挂载、卸载、EOF 退出。
 *
 * 为什么不用 shell 发帧：帧里带 JSON 与二进制长度前缀，shell 拼不出来且不可读。
 */
const SERVE_PROBE_PY = String.raw`import json, os, socket, subprocess, sys, tempfile, time

PROXY = sys.argv[1]

def encode(obj):
    payload = json.dumps(obj, ensure_ascii=False, separators=(',', ':')).encode()
    return ('%08x\n' % len(payload)).encode() + payload

def read_frame(f):
    header = f.read(9)
    if len(header) < 9:
        return None
    n = int(header[:8].decode(), 16)
    payload = f.read(n)
    if len(payload) < n:
        return None
    return json.loads(payload.decode())

# socketpair：父端给代理当通信 fd（--fd），子端留在桩里
parent_sock, child_sock = socket.socketpair()

# 清掉继承来的 fd 之外的干扰：代理只认 argv 里的 fd 号
fd = child_sock.fileno()
proc = subprocess.Popen(
    [PROXY, '--serve', '--fd', str(fd)],
    pass_fds=(fd,),
    stdin=subprocess.DEVNULL,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.PIPE,
)
child_sock.close()

reader = parent_sock.makefile('rb')
writer = parent_sock.makefile('wb')

def rpc(obj, timeout=60):
    writer.write(encode(obj))
    writer.flush()
    parent_sock.settimeout(timeout)
    return read_frame(reader)

try:
    rep = rpc({'op': 'ping'})
    print('PING_OK' if rep and rep.get('op') == 'pong' else 'PING_FAIL %r' % (rep,))

    rep = rpc({'op': 'version'})
    print('VERSION_OK' if rep and rep.get('op') == 'version' and rep.get('ipcVersion') else
          'VERSION_FAIL %r' % (rep,))

    rep = rpc({'op': 'probeOverlay'}, timeout=120)
    print('PROBE_OK' if rep and rep.get('op') == 'ok' else 'PROBE_FAIL %r' % (rep,))

    base = tempfile.mkdtemp(prefix='tc-view-', dir='/tmp')
    lower = os.path.join(base, 'lower'); os.makedirs(lower, exist_ok=True)
    with open(os.path.join(lower, 'marker.txt'), 'w') as f:
        f.write('served\n')

    rep = rpc({
        'op': 'mountOverlay',
        'lower': lower,
        'upper': os.path.join(base, 'upper'),
        'work': os.path.join(base, 'work'),
        'merged': os.path.join(base, 'mount'),
    }, timeout=120)
    mounted = rep.get('merged') if rep and rep.get('op') == 'ok' else None
    # **不能**用宿主路径判断叠加内容（os.path.exists(merged/marker.txt)）：
    #   Core 进程在宿主命名空间里，**看不见**代理命名空间内的挂载（specs/051
    #   「不采用 setns」一节）。叠加视图只能由代理代执行来读。
    # 因此这里的判据是：
    #   1) 应答 ok 且带上 merged（挂载动作成功）
    #   2) 宿主侧看 merged 是**空目录** —— 反证挂载确实隔离在代理命名空间内
    #      （若宿主能看见 marker.txt，说明挂载泄漏到了宿主，那是更严重的问题）
    host_sees = sorted(os.listdir(mounted)) if mounted and os.path.isdir(mounted) else None
    if mounted and host_sees == []:
        print('MOUNT_OK')
    elif mounted and host_sees is None:
        print('MOUNT_FAIL 挂载点不存在 %r (merged=%r)' % (rep, mounted))
    else:
        print('MOUNT_FAIL 挂载泄漏到宿主命名空间：宿主看到 %r' % (host_sees,))

    if mounted:
        rep = rpc({'op': 'unmountOverlay', 'merged': mounted}, timeout=120)
        print('UMOUNT_OK' if rep and rep.get('op') == 'ok' else 'UMOUNT_FAIL %r' % (rep,))

    # 阶段二的操作必须明确回「未实现」，不能静默成功
    rep = rpc({'op': 'spawn', 'argv': ['/bin/true']})
    print('STAGE2_REFUSED_OK' if rep and rep.get('op') == 'error' and '阶段二' in rep.get('message', '') else
          'STAGE2_REFUSED_FAIL %r' % (rep,))
finally:
    # 关连接 = EOF：代理应当自行退出（FR-007b 的回收主路径）
    try:
        writer.close(); reader.close(); parent_sock.close()
    except Exception:
        pass
    try:
        code = proc.wait(timeout=10)
        print('EOF_EXIT_OK' if code == 0 else 'EOF_EXIT_BAD code=%d' % code)
    except subprocess.TimeoutExpired:
        proc.kill()
        print('EOF_EXIT_TIMEOUT')
    err = proc.stderr.read().decode(errors='replace').strip()
    if err:
        print('PROXY_STDERR: ' + err.replace('\n', ' | '))
`;

/** 本机产物（构建脚本按 `<arch>-<platform>` 落位） */
const artifactPath = join(
  repoRoot,
  'resources',
  project.core.resourceDir,
  `${arch}-linux`,
  PROXY_NAME,
);

if (!existsSync(artifactPath)) {
  console.error(
    `缺少挂载代理产物：${artifactPath}\n请先执行：npm run build:core:linux-${arch === 'x64' ? 'x64' : 'arm64'}`,
  );
  process.exit(2);
}

/** SSH 环境（`e2e/environments.json` 的 ssh 段；缺失 / 非法直接报错） */
function loadSshEnvironment() {
  const file = join(repoRoot, 'e2e', 'environments.json');
  if (!existsSync(file)) {
    console.error(
      `E2E 环境配置缺失：${file}\n请复制 e2e/environments.example.json 为同目录的 environments.json 并填写。`,
    );
    process.exit(2);
  }
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const ssh = parsed?.ssh;
  if (!ssh || typeof ssh !== 'object') {
    console.error(`E2E 环境配置缺 ssh 段：${file}`);
    process.exit(2);
  }
  for (const key of ['host', 'port', 'user', 'password']) {
    if (ssh[key] === undefined || ssh[key] === '') {
      console.error(`E2E 环境配置的 ssh.${key} 缺失或为空：${file}`);
      process.exit(2);
    }
  }
  return ssh;
}

const SSH = loadSshEnvironment();

function connect() {
  return new Promise((resolveConnect, rejectConnect) => {
    const client = new Client();
    client
      .on('ready', () => resolveConnect(client))
      .on('error', (error) => rejectConnect(error))
      .connect({
        host: SSH.host,
        port: SSH.port,
        username: SSH.user,
        password: SSH.password,
        readyTimeout: 20_000,
      });
  });
}

/**
 * 在远端执行一条命令；`stdin` 非空时写进标准输入后立即关闭。
 *
 * 密码只走标准输入（`sudo -S`），不进 argv——与 FR-004 第 3 条同一口径；这里的"密码"
 * 是 SSH 登录口令，同样不该出现在进程列表里。
 */
async function exec(client, command, { stdin, timeoutMs = 120_000 } = {}) {
  return new Promise((resolveExec, rejectExec) => {
    client.exec(command, (error, stream) => {
      if (error) return rejectExec(error);
      let stdout = '';
      let stderr = '';
      stream.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      stream.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      stream.on('close', (code) => resolveExec({ stdout, stderr, code }));
      if (stdin !== undefined) stream.end(stdin);
    });
    setTimeout(() => rejectExec(new Error(`ssh exec 超时：${command}`)), timeoutMs);
  });
}

/** 一条验证步骤：跑命令并打印结果，返回是否成功 */
async function step(client, title, command, options = {}) {
  console.log(`\n── ${title} ──`);
  console.log(`$ ${command.length > 120 ? `${command.slice(0, 120)}…` : command}`);
  const result = await exec(client, command, options);
  if (result.stdout.trim()) console.log(result.stdout.trimEnd());
  if (result.stderr.trim()) console.log(`[stderr] ${result.stderr.trimEnd()}`);
  console.log(`exit=${result.code}`);
  return result;
}

/** sudo 包装：口令经标准输入，不进 argv */
function sudo(command) {
  return { command: `sudo -S -p '' ${command}`, stdin: `${SSH.password}\n` };
}

let remoteStage = '';

async function main() {
  console.log(`远端：${SSH.user}@${SSH.host}:${SSH.port}`);
  console.log(`产物：${artifactPath}`);

  const client = await connect();
  const failures = [];
  const record = async (title, command, options) => {
    const result = await step(client, title, command, options);
    if (result.code !== 0) failures.push(title);
    return result;
  };

  try {
    // ── 0. 环境探测：只报告，不修复 ──
    await record('远端平台', 'uname -sm');
    await record('远端内核 overlayfs', 'grep -c overlay /proc/filesystems || true');
    await record('安装落点目录', `stat -c '%U %G %a %n' ${PROXY_DIR}`);
    await record('落点文件系统挂载选项', `findmnt -no OPTIONS -T ${PROXY_DIR}`);
    await record('免密 sudo 是否可用', 'sudo -n true 2>&1; echo "rc=$?"');
    // 上一次可能留下装机（共享机器上别人也可能装过），先如实报告
    await record('当前是否已装机', `stat -c '%U %G %a' ${INSTALLED_PATH} 2>&1 || echo ABSENT`);

    // ── 1. 上传到暂存区（不进 /usr/libexec：安装由 --install 做） ──
    remoteStage = `/tmp/${PROXY_NAME}-verify-${process.pid}`;
    const upload = await uploadFile(client, artifactPath, remoteStage);
    if (!upload.ok) {
      failures.push('上传产物');
      console.error(`上传失败：${upload.error}`);
      return;
    }
    console.log(`\n── 上传产物 ──\n${artifactPath} → ${remoteStage}（${upload.bytes} 字节）`);
    // 上传后核大小：SFTP 写流若被提前关闭，远端会留 0 字节文件而本地报成功
    const uploaded = await exec(client, `stat -c '%s' ${remoteStage} 2>&1`);
    const remoteBytes = Number(uploaded.stdout.trim());
    if (!Number.isFinite(remoteBytes) || remoteBytes !== upload.bytes) {
      failures.push(
        `上传产物：本地 ${upload.bytes} 字节，远端 ${uploaded.stdout.trim()} 字节（上传不完整）`,
      );
      return;
    }

    // ── 2. 一次性形态：协议版本（不建命名空间、不装任何东西） ──
    await record('协议版本（产物能在远端执行）', `chmod +x ${remoteStage} && ${remoteStage} --protocol-version`);

    // ── 3. 装机前的自检：应当被入口闸门拒绝 ──
    // 期望的拒绝理由是**第一条**判据（euid != 0，因为暂存区里的是普通文件、没有 setuid
    // 位），而不是允许列表——断言只要求「非零退出且点名了一个入口判据」，把顺序留给
    // 实现（FR-006 的入口自检有多个判据，先后由它自己定）。
    const beforeInstall = await step(
      client,
      '装机前的入口闸门（期望拒绝：暂存产物没有 setuid 位）',
      `${remoteStage} --self-check 2>&1; echo "rc=$?"`,
    );
    const beforeText = beforeInstall.stdout + beforeInstall.stderr;
    if (!/rc=[1-9]/.test(beforeText)) {
      failures.push('入口闸门：未装机的产物应被拒绝（实际成功退出）');
    } else if (!/euid|允许列表|真实 uid/.test(beforeText)) {
      failures.push(`入口闸门：拒绝理由未点名入口判据（实际：${beforeText.trim()}）`);
    }

    // ── 4. 安装（内容经标准输入，不经路径） ──
    // `--install` 从 stdin 读内容；这里把本地产物经一条 shell 管道喂进去：
    // `cat <暂存产物> | sudo --install`。真实链路里是 SSH exec 的 stdin（见 FR-009），
    // 这条脚手架用暂存文件代替，只为把「安装不变量」验出来。
    const install = await record(
      '安装（内容经标准输入进 root 侧）',
      `${sudo(`sh -c 'cat ${remoteStage} | ${remoteStage} --install'`).command}`,
      { stdin: `${SSH.password}\n` },
    );
    const digest = install.stdout.trim().split('\n').pop() ?? '';
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      failures.push('安装回显 sha256');
    } else {
      console.log(`安装回显 sha256=${digest}`);
    }

    // ── 5. 安装形态断言 ──
    const stat = await record('安装形态（要求 root root 4755）', `stat -c '%U %G %a' ${INSTALLED_PATH}`);
    if (stat.stdout.trim() !== 'root root 4755') {
      failures.push(`安装形态：期望 "root root 4755"，实际 "${stat.stdout.trim()}"`);
    }
    await record('允许列表（要求 root root 600）', `stat -c '%U %G %a' ${UID_LIST_PATH}`);
    // 允许列表是 0600 root:root：普通用户读不到是**正确形态**（可写它就能给自己加白
    // 名单）。这里用 sudo 读内容，既验内容是真实 uid，也验权限确实拦住了普通用户。
    const uidList = await record('允许列表内容（经 sudo，0600 普通用户读不到）',
      sudo(`cat ${UID_LIST_PATH}`).command, { stdin: `${SSH.password}\n` });
    if (!/^#/.test(uidList.stdout) || !/\b1001\b/.test(uidList.stdout)) {
      failures.push(`允许列表内容：应含安装者的真实 uid 1001，实际 "${uidList.stdout.trim()}"`);
    }

    // ── 6. 装机后的自检：四项断言 ──
    await record('自检（命名空间 + overlay 实测 + 四项断言）', `${INSTALLED_PATH} --self-check 2>&1`);

    // ── 7. 常驻形态的帧协议（不经 Core：用一个 python 桩当客户端喂帧） ──
    //
    // 这是**阶段一最关键的一步**：前面各步只验一次性形态，而真正被 Core 使用的是
    // `--serve`。这里用 socketpair 拉起代理、发 `version` / `ping` / `probeOverlay` /
    // `mountOverlay` / `unmountOverlay`，最后关连接（EOF）确认代理自行退出。
    const serveCheck = await step(
      client,
      '常驻形态：拉起 --serve 并走完整帧往返',
      `python3 - ${INSTALLED_PATH} <<'PYEOF'\n${SERVE_PROBE_PY}\nPYEOF`,
      { timeoutMs: 180_000 },
    );
    if (serveCheck.code !== 0) {
      failures.push('常驻形态：帧往返失败');
    } else {
      for (const marker of [
        'PING_OK', 'VERSION_OK', 'PROBE_OK', 'MOUNT_OK', 'UMOUNT_OK',
        'STAGE2_REFUSED_OK', 'EOF_EXIT_OK',
      ]) {
        if (!serveCheck.stdout.includes(marker)) failures.push(`常驻形态：缺 ${marker}`);
      }
    }

    // ── 8. 审计与卸载 ──
    await record('卸载前确认位点存在', `test -e ${INSTALLED_PATH} && echo present`);
    if (!keepInstalled) {
      const removed = await record(
        '卸载（幂等命令）',
        sudo(`rm -f ${INSTALLED_PATH} ${UID_LIST_PATH}`).command,
        { stdin: `${SSH.password}\n` },
      );
      void removed;
      const after = await record('卸载后位点不存在', `test -e ${INSTALLED_PATH} && echo STILL_THERE || echo ABSENT`);
      if (!after.stdout.includes('ABSENT')) failures.push('卸载：位点仍存在');
    } else {
      console.log('\n（--keep-installed：保留装机，请自行用下面的命令卸载）');
      console.log(`  sudo rm -f ${INSTALLED_PATH} ${UID_LIST_PATH}`);
    }
  } finally {
    // 暂存区一定要清（即使中途失败）
    if (remoteStage) {
      await exec(client, `rm -f ${remoteStage}`).catch(() => undefined);
    }
    client.end();
  }

  console.log('\n════════════════════════════════════');
  if (failures.length === 0) {
    console.log('全部步骤通过');
    process.exitCode = 0;
  } else {
    console.log(`失败 ${failures.length} 项：`);
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exitCode = 1;
  }
}

/** 经 SFTP 上传一个文件 */
function uploadFile(client, localPath, remotePath) {
  return new Promise((resolveUpload) => {
    client.sftp((error, sftp) => {
      if (error) return resolveUpload({ ok: false, error: error.message });
      const content = readFileSync(localPath);
      const stream = sftp.createWriteStream(remotePath);
      // 监听必须先于写入注册：`end(content)` 会立刻推进整个写链路，晚注册的 'close'
      // 有可能已经错过（实测症状：远端落 0 字节文件而本地报成功）
      stream.on('close', () => {
        sftp.end();
        resolveUpload({ ok: true, bytes: content.length });
      });
      stream.on('error', (streamError) => {
        sftp.end();
        resolveUpload({ ok: false, error: streamError.message });
      });
      stream.end(content);
    });
  });
}

main().catch((error) => {
  console.error(`验证脚本异常：${error.message}`);
  process.exitCode = 1;
});
