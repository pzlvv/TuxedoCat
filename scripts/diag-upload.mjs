/**
 * 一次性诊断：实测 SFTP 上传 34.3MB Core 的稳定性（用完即删）。
 *
 * 为什么需要：`e2e-ssh（remoteSshExecution）` 的冷部署用例要在远端留下完整 Core，
 * 实测远端残留 8 个半成品 `.new`（98KB–31MB，完整 34.3MB），说明上传反复中断。
 * 本机 5/5 成功（~6.5MB/s），差异只可能在 runner 的网络路径上——这份脚本在 runner
 * 里跑同一段上传，把「是不是 runner 侧网络」变成可读的数字。
 *
 * 只读远端：上传到 `/tmp` 下并立即删除，不碰部署槽位、不碰状态文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'ssh2';

const envFile = 'e2e/environments.json';
if (!fs.existsSync(envFile)) {
  console.error(`缺少 ${envFile}（先跑 scripts/write-e2e-environments.mjs）`);
  process.exit(1);
}
const ssh = JSON.parse(fs.readFileSync(envFile, 'utf8')).ssh;

const LOCAL = 'dist/resources/core/x64-linux/tuxedo-cat-core';
if (!fs.existsSync(LOCAL)) {
  console.error(`缺少本地 Core 产物 ${LOCAL}（先跑 npm run build:core:linux-x64）`);
  process.exit(1);
}
const size = fs.statSync(LOCAL).size;
const mb = (n) => (n / 1024 / 1024).toFixed(1);
console.log(`产物 ${LOCAL}  ${mb(size)}MB`);
console.log(`远端 ${ssh.user}@${ssh.host}:${ssh.port}\n`);

/** 单次上传：返回耗时、是否成功、远端实际大小 */
function uploadOnce(idx) {
  return new Promise((resolve) => {
    const started = Date.now();
    const client = new Client();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { client.end(); } catch { /* 连接可能已断，忽略 */ }
      resolve({ idx, ms: Date.now() - started, ...result });
    };
    const timer = setTimeout(() => finish({ ok: false, why: 'timeout 180s' }), 180_000);
    client.on('ready', () => {
      client.sftp((sftpErr, sftp) => {
        if (sftpErr) { clearTimeout(timer); return finish({ ok: false, why: `sftp: ${sftpErr.message}` }); }
        const remote = `/tmp/diag-upload-${process.pid}-${idx}.bin`;
        sftp.fastPut(LOCAL, remote, { mode: 0o755 }, (putErr) => {
          if (putErr) { clearTimeout(timer); return finish({ ok: false, why: `put: ${putErr.message}` }); }
          client.exec(`stat -c %s ${remote}; rm -f ${remote}`, (execErr, stream) => {
            if (execErr) { clearTimeout(timer); return finish({ ok: false, why: `exec: ${execErr.message}` }); }
            let out = '';
            stream.on('data', (d) => { out += d.toString(); });
            stream.on('close', () => {
              clearTimeout(timer);
              const remoteSize = Number(out.trim().split('\n')[0]);
              finish({ ok: remoteSize === size, remoteSize, why: remoteSize === size ? undefined : `远端 ${remoteSize} != 本地 ${size}` });
            });
          });
        });
      });
    });
    client.on('error', (e) => { clearTimeout(timer); finish({ ok: false, why: `conn: ${e.message}` }); });
    client.connect({ host: ssh.host, port: ssh.port, username: ssh.user, password: ssh.password, readyTimeout: 30_000 });
  });
}

const ROUNDS = 5;
let ok = 0;
const durations = [];
for (let i = 1; i <= ROUNDS; i += 1) {
  const r = await uploadOnce(i);
  if (r.ok) { ok += 1; durations.push(r.ms); }
  const speed = r.ok ? `${((size / 1024 / 1024) / (r.ms / 1000)).toFixed(2)}MB/s` : '-';
  console.log(`#${r.idx} ${r.ok ? 'OK  ' : 'FAIL'} ${String(r.ms).padStart(6)}ms  ${speed}  ${r.why ?? ''}`);
}

console.log(`\n成功 ${ok}/${ROUNDS}`);
if (durations.length > 0) {
  const avg = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
  console.log(`平均耗时 ${avg}ms（${((size / 1024 / 1024) / (avg / 1000)).toFixed(2)}MB/s）`);
  console.log(`最慢 ${Math.max(...durations)}ms / 最快 ${Math.min(...durations)}ms`);
}
// 只要有失败就让 job 红：这份诊断的目的就是判定 runner 侧上传是否稳定
process.exit(ok === ROUNDS ? 0 : 1);
