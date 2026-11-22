/**
 * 一次性诊断：从 runner 实测 SFTP 上传 Core 产物的吞吐与稳定性（用完即删）。
 *
 * 背景：`e2e-ssh` 车道的每次冷部署都要把本机携带的 Core（release 构建、带行号表，
 * 约 36.5MB）传到远端部署槽位。上一版诊断整份 `fastPut` 5/5 在 180s 内不结束，
 * 但开发机（Windows）同一份文件 5–6 秒传完（≈6MB/s）。要区分两件事：
 * - **带宽不足**：分段大小与耗时成线性 → 压缩（实测 gzip -9 后 10.7MB）能救；
 * - **连接被掐 / 传输层挂起**：小文件也挂，或进度长时间不前进 → 压缩救不了，
 *   只能改传输形态（分块 + 续传）或让车道在 CI 上不跑。
 *
 * 每个分段都报「实际发送字节 / 耗时 / MB/s / 最后一次进度距今多久」，不做重试
 * （诊断不掩盖现象）。远端只写 /tmp 且立即删除，不碰部署槽位与状态文件。
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Client } from 'ssh2';

const envFile = 'e2e/environments.json';
if (!fs.existsSync(envFile)) {
  console.error(`缺少 ${envFile}（先跑 scripts/write-e2e-environments.mjs）`);
  process.exit(1);
}
const ssh = JSON.parse(fs.readFileSync(envFile, 'utf8')).ssh;

// 产物名从 `src/config/project.json` 派生，不写字面量（`docs/hosts/product-identity.md`）
const project = JSON.parse(fs.readFileSync('src/config/project.json', 'utf8'));
const CORE_BINARY = project.core.binaryName;

// 构建脚本的产物落在 `resources/core/<dir>/`（`scripts/build-core.mjs` 的 `outDir`）；
// `dist/resources/core/` 只有本机打包后才有，CI 上不存在。
const CANDIDATES = [
  `resources/core/x64-linux/${CORE_BINARY}`,
  `dist/resources/core/x64-linux/${CORE_BINARY}`,
];
const LOCAL = CANDIDATES.find((p) => fs.existsSync(p));
if (!LOCAL) {
  console.error(`缺少本地 Core 产物，试过：\n  ${CANDIDATES.join('\n  ')}\n先跑 npm run build:core:linux-x64`);
  process.exit(1);
}
const SIZE = fs.statSync(LOCAL).size;
const mb = (n) => (n / 1024 / 1024).toFixed(1);
const rate = (bytes, ms) => (ms > 0 ? (bytes / 1024 / 1024 / (ms / 1000)).toFixed(2) : '0');
console.log(`产物 ${LOCAL}  ${mb(SIZE)}MB`);
console.log(`远端 ${ssh.user}@${ssh.host}:${ssh.port}\n`);

function connect() {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.on('ready', () => resolve(client));
    client.on('error', reject);
    client.connect({
      host: ssh.host,
      port: ssh.port,
      username: ssh.user,
      password: ssh.password,
      readyTimeout: 30_000,
      keepaliveInterval: 10_000,
    });
  });
}

function exec(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('data', (d) => { stdout += d.toString(); });
      stream.stderr.on('data', (d) => { stderr += d.toString(); });
      stream.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  });
}

/** 建链墙钟（TCP + SSH 握手 + 认证），再测一次 exec 的追加开销 */
async function measureConnect() {
  const t0 = Date.now();
  const client = await connect();
  const handshake = Date.now() - t0;
  await exec(client, 'true');
  const execMs = Date.now() - t0 - handshake;
  client.end();
  console.log(`建链 ${handshake}ms（exec 追加 ${execMs}ms）`);
}

/**
 * 传前 `bytes` 字节：进度回调记账，超过 `budgetMs` 或 `idleMs` 无进展即收尾。
 *
 * 用 `fastPut` 的 `step` 回调而不是自己分块，是为了保持与产品（`SshClient.upload`）
 * 完全同一条代码路径——诊断要量的是产品的上传形态，不是另一个实现。
 */
function uploadSlice(bytes, budgetMs, idleMs) {
  return new Promise((resolve) => {
    const slice = `/tmp/diag-slice-src-${process.pid}.bin`;
    execFileSync(process.execPath, [
      '-e',
      `const {openSync,readSync,writeFileSync}=require('fs');const b=Buffer.alloc(${bytes});`
      + `const fd=openSync(${JSON.stringify(LOCAL)},'r');let off=0;`
      + `while(off<b.length){const n=readSync(fd,b,off,b.length-off,off);if(n<=0)break;off+=n;}`
      + `writeFileSync(${JSON.stringify(slice)},b.subarray(0,off));`,
    ]);
    const t0 = Date.now();
    let sent = 0;
    let lastProgressAt = Date.now();
    let settled = false;
    const client = new Client();
    const remote = `/tmp/diag-slice-${process.pid}.bin`;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      client.end();
      resolve({ bytes, ms: Date.now() - t0, sent, stallMs: Date.now() - lastProgressAt, ...result });
    };
    const watchdog = setInterval(() => {
      if (Date.now() - t0 > budgetMs) return finish({ ok: false, why: `超过预算 ${budgetMs}ms` });
      if (Date.now() - lastProgressAt > idleMs) {
        finish({ ok: false, why: `进度停滞 ${idleMs}ms（已发 ${mb(sent)}MB）` });
      }
    }, 500);
    client.on('ready', () => {
      client.sftp((sftpErr, sftp) => {
        if (sftpErr) return finish({ ok: false, why: `sftp: ${sftpErr.message}` });
        sftp.fastPut(slice, remote, {
          mode: 0o755,
          step: (total) => { sent = total; lastProgressAt = Date.now(); },
        }, (putErr) => {
          if (putErr) return finish({ ok: false, why: `put: ${putErr.message}` });
          exec(client, `stat -c %s ${remote}; rm -f ${remote}`).then(({ stdout }) => {
            const remoteBytes = stdout.trim();
            finish({ ok: remoteBytes === String(bytes), remoteBytes });
          }, (error) => finish({ ok: false, why: `stat: ${error.message}` }));
        });
      });
    });
    client.on('error', (error) => finish({ ok: false, why: `conn: ${error.message}` }));
    client.connect({
      host: ssh.host,
      port: ssh.port,
      username: ssh.user,
      password: ssh.password,
      readyTimeout: 30_000,
    });
  });
}

/**
 * 压缩上传：`gzip -9`（本机）→ SSH stdin → 远端 `gzip -dc` 落槽位。
 *
 * 这是「带宽不足」假设的验证面：若压缩后成功而等量原始字节失败，说明限的是流量；
 * 若同样停滞，说明链路上根本推不动字节。
 */
function uploadGzipped(budgetMs, idleMs) {
  return new Promise((resolve) => {
    const gz = execFileSync('gzip', ['-9', '-c', LOCAL], { maxBuffer: 256 * 1024 * 1024 });
    const t0 = Date.now();
    let sent = 0;
    let lastProgressAt = Date.now();
    let settled = false;
    const client = new Client();
    const remote = `/tmp/diag-gz-${process.pid}.bin`;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      client.end();
      resolve({ bytes: gz.length, ms: Date.now() - t0, sent, stallMs: Date.now() - lastProgressAt, ...result });
    };
    const watchdog = setInterval(() => {
      if (Date.now() - t0 > budgetMs) return finish({ ok: false, why: `超过预算 ${budgetMs}ms` });
      if (Date.now() - lastProgressAt > idleMs) {
        finish({ ok: false, why: `进度停滞 ${idleMs}ms（已发 ${mb(sent)}MB）` });
      }
    }, 500);
    client.on('ready', () => {
      client.exec(`gzip -dc > ${remote} && stat -c %s ${remote} && rm -f ${remote}`, (err, stream) => {
        if (err) return finish({ ok: false, why: `exec: ${err.message}` });
        let stdout = '';
        stream.on('data', (d) => { stdout += d.toString(); });
        stream.on('close', () => {
          const remoteBytes = stdout.trim().split('\n')[0];
          finish({ ok: remoteBytes === String(SIZE), remoteBytes });
        });
        // 256KB 一块写：一次写整段就看不出「有没有在前进」
        let offset = 0;
        const pump = () => {
          if (offset >= gz.length) {
            stream.end();
            return;
          }
          const end = Math.min(offset + 256 * 1024, gz.length);
          const chunk = gz.subarray(offset, end);
          offset = end;
          stream.write(chunk, () => {
            sent = offset;
            lastProgressAt = Date.now();
            pump();
          });
        };
        pump();
      });
    });
    client.on('error', (error) => finish({ ok: false, why: `conn: ${error.message}` }));
    client.connect({
      host: ssh.host,
      port: ssh.port,
      username: ssh.user,
      password: ssh.password,
      readyTimeout: 30_000,
    });
  });
}

function report(label, r) {
  console.log(
    `${label}: ${r.ok ? 'OK  ' : 'FAIL'} ${String(r.ms).padStart(6)}ms  `
      + `发 ${mb(r.sent ?? 0)}MB / 共 ${mb(r.bytes)}MB  ${rate(r.sent ?? 0, r.ms)}MB/s  `
      + `末次进度距今 ${(r.stallMs / 1000).toFixed(1)}s  ${r.why ?? ''}`,
  );
}

await measureConnect();
// 分段递增，**每段独立计时且互不重试**：1MB 能不能过决定「是链路不通还是大文件挂」。
// 每段同时报「进度停滞多久」——带宽不足时字节数仍在小步前进，连接被掐时它一路涨到上限。
for (const bytes of [1, 4, 12]) {
  report(`SFTP ${bytes}MB`, await uploadSlice(bytes * 1024 * 1024, 120_000, 45_000));
}
report('SFTP 整份', await uploadSlice(SIZE, 180_000, 45_000));
report('gzip 整份', await uploadGzipped(180_000, 45_000));
