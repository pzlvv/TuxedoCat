/**
 * Electron 启动包装
 * 清除 ELECTRON_RUN_AS_NODE（部分环境全局设置导致 electron 以纯 Node 模式运行），
 * 然后以 Electron 应用模式启动 dist-electron/main.cjs
 */
const { spawn } = require('child_process');
const path = require('path');

const electronPath = require('electron'); // 返回 electron 可执行文件路径
const entry = path.join(__dirname, '..', 'dist-electron', 'main.cjs');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// 提取 --inspect[=port]（Node inspector 需放在入口文件之前）
const inspectArg = process.argv.find((a) => a.startsWith('--inspect'));
const rest = process.argv.slice(2).filter((a) => a !== inspectArg);
const args = [...(inspectArg ? [inspectArg] : []), entry, '--no-sandbox', ...rest];
const child = spawn(electronPath, args, { stdio: 'inherit', env });

child.on('error', (err) => {
  console.error('[electron-launch] Failed to start electron:', err);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
