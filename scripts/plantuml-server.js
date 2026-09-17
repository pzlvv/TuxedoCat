/**
 * 本地 PlantUML 服务器（PicoWeb）
 *
 * 背景：jebbs.plantuml 的 Markdown 预览走的是 markdown-it 插件这条路径，
 * 它只读 `plantuml.server`、不支持 Local 渲染；server 为空就会在预览里显示
 *   No PlantUML server, specify one with "plantuml.server".
 * 这里用扩展自带的 plantuml.jar 起一个只监听回环地址的 PicoWeb 服务，
 * 这样 DEVELOPMENT.md 里的架构图源码不必发往公网。
 *
 * 用法：
 *   node scripts/plantuml-server.js [port]
 * 环境变量：
 *   PLANTUML_PORT  监听端口（默认 8090）
 *   PLANTUML_JAR   显式指定 jar 路径（默认自动在 VS Code 扩展目录里查找）
 *
 * 注意：VS Code 内置 Markdown 预览默认处于 Strict 安全级别，会拦掉 http 图片。
 * 首次使用需在预览右上角的盾牌图标里选择「Allow insecure local content /
 * 允许加载不安全的本地内容」，该选择按工作区持久化，只需设置一次。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const TAG = 'plantuml:server';
const DEFAULT_PORT = 8090;
const BIND_ADDRESS = '127.0.0.1';

/** 扩展目录候选（不同 VS Code 发行版 / 远程场景） */
const EXTENSION_DIRS = [
  '.vscode/extensions',
  '.vscode-insiders/extensions',
  '.vscode-server/extensions',
  '.cursor/extensions',
  '.windsurf/extensions',
];

const log = (msg) => console.log(`${TAG}: ${msg}`);
const fail = (msg) => console.error(`${TAG}: error ${msg}`);

/** 把 1.2024.3 这类版本号拆成可比较的数字数组 */
function versionParts(name) {
  return name
    .split('-')
    .slice(1)
    .join('-')
    .split(/[.\-]/)
    .map((n) => parseInt(n, 10))
    .map((n) => (Number.isNaN(n) ? 0 : n));
}

function compareVersionDesc(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pb[i] || 0) - (pa[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** 在 VS Code 扩展目录里找最新的 jebbs.plantuml-* 自带的 plantuml.jar */
function findJar() {
  const explicit = process.env.PLANTUML_JAR;
  if (explicit) {
    if (fs.existsSync(explicit)) return explicit;
    fail(`PLANTUML_JAR 指向的文件不存在：${explicit}`);
  }

  for (const dir of EXTENSION_DIRS) {
    const root = path.join(os.homedir(), dir);
    let entries;
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    const candidates = entries
      .filter((n) => n.startsWith('jebbs.plantuml-'))
      .sort(compareVersionDesc);
    for (const name of candidates) {
      const jar = path.join(root, name, 'plantuml.jar');
      if (fs.existsSync(jar)) return jar;
    }
  }

  // 兜底：仓库根目录或用户主目录下手动放置的 jar
  for (const jar of [path.join(__dirname, '..', 'plantuml.jar'), path.join(os.homedir(), 'plantuml.jar')]) {
    if (fs.existsSync(jar)) return jar;
  }
  return null;
}

/** 优先用 JAVA_HOME 下的 java，否则依赖 PATH */
function findJava() {
  const javaHome = process.env.JAVA_HOME;
  if (javaHome) {
    const exe = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (fs.existsSync(exe)) return exe;
  }
  return 'java';
}

/** 探测该端口上是否已经有可用的 PlantUML 服务（/check 会返回 302） */
function probe(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: BIND_ADDRESS, port, path: '/check', timeout: 2000 },
      (res) => {
        res.resume();
        resolve(true);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const port = Number(process.env.PLANTUML_PORT || process.argv[2] || DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    fail(`端口不合法：${process.env.PLANTUML_PORT || process.argv[2]}`);
    process.exit(1);
  }

  // 已经有一个在跑就直接复用，避免重复起进程 / 端口冲突
  if (await probe(port)) {
    log(`ready (${BIND_ADDRESS}:${port} 已有服务在运行)`);
    return;
  }

  const jar = findJar();
  if (!jar) {
    fail('找不到 plantuml.jar。请安装 jebbs.plantuml 扩展，或用 PLANTUML_JAR 指定路径。');
    process.exit(1);
  }

  const java = findJava();
  const args = ['-jar', jar, '-charset', 'UTF-8', `-picoweb:${port}:${BIND_ADDRESS}`];

  log(`start (${java} -jar ${path.basename(jar)} -picoweb:${port}:${BIND_ADDRESS})`);
  log(`jar: ${jar}`);

  const child = spawn(java, args, { stdio: 'inherit' });

  let stopping = false;
  const stop = () => {
    stopping = true;
    child.kill();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  child.on('error', (err) => {
    fail(`无法启动 java：${err.message}`);
    process.exit(1);
  });

  // 轮询等待端口就绪，最多 30 秒
  let up = false;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) break;
    await sleep(500);
    if (await probe(port)) {
      up = true;
      break;
    }
  }

  if (up) {
    log(`ready (http://${BIND_ADDRESS}:${port})`);
  } else if (child.exitCode === null) {
    fail(`启动超时，${port} 端口未就绪`);
  }

  child.on('exit', (code) => {
    if (!stopping) log(`exited (code=${code})`);
    process.exit(code === null ? 0 : code);
  });
}

main().catch((err) => {
  fail(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
