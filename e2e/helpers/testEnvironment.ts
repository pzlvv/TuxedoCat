import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * E2E 测试环境配置的加载与校验（`e2e/environments.json`）。
 *
 * 约定（见 e2e/README.md「测试环境配置」）：
 * - 真实环境信息不入库：`e2e/environments.json` 被 gitignore，由使用者从
 *   `e2e/environments.example.json` 复制并填写（含 SSH 凭证等敏感信息）。
 * - **无效直接报错，不做修复**：文件缺失、JSON 非法、字段缺失 / 形状不对都抛错，
 *   不补默认值、不从 example 兜底、不重试其它凭证、不清远端状态——与产品代码
 *   同一原则（docs/architecture/principles.md 第 1 节「不过度 fallback」）。
 * - 依赖某类环境的用例在文件开头（模块加载期）调用对应的 `require*` 拿环境：
 *   拿不到就是该文件的用例在收集期即失败，错误信息指明缺什么、怎么补。
 */

/** 真实 SSH 服务器（remoteSshExecution.spec.ts 等真实远程用例的远端） */
export interface SshTestEnvironment {
  host: string;
  port: number;
  user: string;
  password: string;
  /**
   * mock LLM 对外广播的主机（可选）：远端 Core 要回连本机的 mock LLM，baseURL 用它。
   * 缺省自动探测本机对外 IPv4（优先 192.168.*）。
   */
  llmAdvertiseHost?: string;
}

/** 本机 PyCharm 安装（pycharm-plugin 车道，specs/035）：沙箱拉起与 CDP 驱动的宿主 IDE */
export interface PycharmTestEnvironment {
  /** IDE 可执行文件路径（Windows 下形如 ...\bin\pycharm64.exe） */
  idePath: string;
  /**
   * mock LLM 对外广播的主机（可选）：语义同 ssh 段的 llmAdvertiseHost，
   * 插件面板里的 Core 回连本机 mock LLM 时 baseURL 用它。
   */
  llmAdvertiseHost?: string;
}

const ENV_FILE_NAME = 'environments.json';

function environmentFilePath(): string {
  return path.join(__dirname, '..', ENV_FILE_NAME);
}

/** 读取环境文件并校验顶层形状；缺失 / 非法 JSON 直接抛错（不创建、不修复） */
function loadEnvironmentFile(): Record<string, unknown> {
  const file = environmentFilePath();
  if (!fs.existsSync(file)) {
    throw new Error(
      `E2E 环境配置缺失：${file} 不存在。`
      + `请复制 e2e/environments.example.json 为同目录的 ${ENV_FILE_NAME} 并填入本机可用的测试环境`
      + `（该文件被 gitignore，不会入库）。`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`E2E 环境配置不是合法 JSON：${file}（${(error as Error).message}）`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`E2E 环境配置顶层必须是对象：${file}`);
  }
  return parsed as Record<string, unknown>;
}

/** 字段校验：非空字符串；不合格进 problems 列表（一次报出全部问题） */
function requireNonEmptyString(
  section: Record<string, unknown>,
  key: string,
  label: string,
  problems: string[],
): void {
  const value = section[key];
  if (typeof value !== 'string' || value.length === 0) {
    problems.push(`${label} 必须是非空字符串（当前：${JSON.stringify(value ?? null)}）`);
  }
}

/**
 * 取真实 SSH 测试环境；文件缺失 / ssh 段形状非法时抛错，错误信息列出全部问题。
 *
 * 报错即失败：不回退到环境变量、不补默认端口、不做连通性探测——连通性是用例自己
 * 的「环境有效性判断」（remoteSshExecution.spec.ts 的 beforeEach）。
 */
export function requireSshEnvironment(): SshTestEnvironment {
  const root = loadEnvironmentFile();
  const section = root.ssh;
  if (!section || typeof section !== 'object' || Array.isArray(section)) {
    throw new Error(
      `E2E 环境配置缺少可用的 ssh 段：${environmentFilePath()}。`
      + `请参照 e2e/environments.example.json 补充 host / port / user / password。`,
    );
  }
  const ssh = section as Record<string, unknown>;
  const problems: string[] = [];
  requireNonEmptyString(ssh, 'host', 'ssh.host', problems);
  requireNonEmptyString(ssh, 'user', 'ssh.user', problems);
  requireNonEmptyString(ssh, 'password', 'ssh.password', problems);
  const port = ssh.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) {
    problems.push(`ssh.port 必须是 1–65535 的整数（当前：${JSON.stringify(port ?? null)}）`);
  }
  if (ssh.llmAdvertiseHost !== undefined) {
    requireNonEmptyString(ssh, 'llmAdvertiseHost', 'ssh.llmAdvertiseHost', problems);
  }
  if (problems.length > 0) {
    throw new Error(
      `E2E 环境配置的 ssh 段不合法（${environmentFilePath()}）：\n  - ${problems.join('\n  - ')}\n`
      + `请修正后重跑；不做修复、不使用部分可用的字段。`,
    );
  }
  return {
    host: ssh.host as string,
    port: port as number,
    user: ssh.user as string,
    password: ssh.password as string,
    ...(ssh.llmAdvertiseHost !== undefined
      ? { llmAdvertiseHost: ssh.llmAdvertiseHost as string }
      : {}),
  };
}

/**
 * 取本机 PyCharm 测试环境；文件缺失 / pycharm 段形状非法时抛错，错误信息列出全部问题。
 *
 * 口径同 requireSshEnvironment：报错即失败（pycharm-plugin 是本地车道，见 e2e/README.md
 * 的 CI 车道表），不回退 PATH 探测、不补默认安装路径、不做连通性探测——IDE 能否拉起
 * 是用例自己的「环境有效性判断」（pycharmIde.ts 的启动前置）。
 */
export function requirePycharmEnvironment(): PycharmTestEnvironment {
  const root = loadEnvironmentFile();
  const section = root.pycharm;
  if (!section || typeof section !== 'object' || Array.isArray(section)) {
    throw new Error(
      `E2E 环境配置缺少可用的 pycharm 段：${environmentFilePath()}。`
      + `请参照 e2e/environments.example.json 补充 idePath（本机 PyCharm 可执行文件路径）。`,
    );
  }
  const pycharm = section as Record<string, unknown>;
  const problems: string[] = [];
  requireNonEmptyString(pycharm, 'idePath', 'pycharm.idePath', problems);
  if (pycharm.idePath !== undefined && typeof pycharm.idePath === 'string' && pycharm.idePath.length > 0) {
    if (!fs.existsSync(pycharm.idePath)) {
      problems.push(`pycharm.idePath 指向的文件不存在（当前：${pycharm.idePath}）`);
    }
  }
  if (pycharm.llmAdvertiseHost !== undefined) {
    requireNonEmptyString(pycharm, 'llmAdvertiseHost', 'pycharm.llmAdvertiseHost', problems);
  }
  if (problems.length > 0) {
    throw new Error(
      `E2E 环境配置的 pycharm 段不合法（${environmentFilePath()}）：\n  - ${problems.join('\n  - ')}\n`
      + `请修正后重跑；不做修复、不使用部分可用的字段。`,
    );
  }
  return {
    idePath: pycharm.idePath as string,
    ...(pycharm.llmAdvertiseHost !== undefined
      ? { llmAdvertiseHost: pycharm.llmAdvertiseHost as string }
      : {}),
  };
}

/**
 * 环境文件存在但形状非法（非 JSON / 顶层不是对象）时抛错；不存在则放行。
 *
 * 挂在 playwright.config.ts 的加载期：配置坏了不该等用到它的用例才发现——
 * 但文件缺失不算错，大多数用例不依赖外部环境。
 */
export function assertEnvironmentFileIfPresent(): void {
  if (!fs.existsSync(environmentFilePath())) return;
  loadEnvironmentFile();
}

/** 本机对外（LAN）IPv4：优先 192.168.*（物理网卡常见段；172.x 虚拟网关远端未必可达） */
export function detectLlmAdvertiseHost(): string {
  const fallbacks: string[] = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const info of interfaces ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (info.address.startsWith('192.168.')) return info.address;
      fallbacks.push(info.address);
    }
  }
  if (fallbacks.length > 0) return fallbacks[0];
  throw new Error(
    '找不到本机对外 IPv4 地址：请在 e2e/environments.json 的 ssh.llmAdvertiseHost '
    + '显式指定 mock LLM 对外广播的主机。',
  );
}
