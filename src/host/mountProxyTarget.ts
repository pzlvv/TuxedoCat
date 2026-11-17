/**
 * 部署目标的构造（specs/051 FR-004 / FR-009）。
 *
 * 编排（提权顺序、密码只走 stdin、次数上限）在 `mountProxyInstall.ts`；本模块负责
 * **把「这次部署打到哪台机器」变成具体目标**：
 *
 * | 会话工作区 | 执行面 | 代理字节来源 | 零密码命令里的路径 |
 * | --- | --- | --- | --- |
 * | 本地（`endpoint === null`） | 本地 `sh -c` | 宿主上的随包产物 | 宿主上的随包产物路径 |
 * | SSH 远端 | 远端 `sh -c`（经 SSH） | 先上传、再从远端暂存路径读 | 远端暂存路径 |
 *
 * ## 为什么不按宿主平台判断
 *
 * 宿主跑在 Windows、会话工作区在远端 Linux 时目标就是远端。曾经按 `process.platform`
 * 判断，直接判成「不支持部署」，把远端部署整条路堵死
 * （`specs/defects/mount-proxy-local-host-platform-gated.md`）。
 *
 * ## 远端不落用户可写的暂存文件（FR-009）
 *
 * 上传走「内容经管道进 root 侧标准输入」：代理字节经 SSH 通道送进远端 `sh` 的 stdin，
 * 由远端 `sudo` 直接喂给 `--install`。暂存路径只用于**零密码通道**（用户要自己跑命令，
 * 必须有个能读的源），且放在远端 `$HOME` 下的隐藏目录，安装完成后清掉。
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  MOUNT_PROXY_INSTALL_PATH,
  manualInstallCommand,
  type MountProxyTarget,
} from './mountProxyInstall.js';
import { createLocalMountProxyShell } from './mountProxyShellLocal.js';
import { CORE_MOUNT_PROXY_NAME } from '../config/project.js';
import { SSH_WORKSPACE_SCHEME, type WorkspaceEndpoint, type WorkspaceRef } from './workspaceRef.js';

/** 远端执行一条命令的能力（`SshClient` 的实现子集，便于单测注入） */
export interface RemoteExecPort {
  /** 执行命令；`stdin` 写完后立即关闭（密码与代理字节都只经这里） */
  execWithStdin(
    command: string,
    stdin: Uint8Array,
    timeoutMs: number,
  ): Promise<{ code: number | null; stdout: string; stderr: string }>;
  /** 远端主目录（暂存路径的基准） */
  homeDir(): Promise<string>;
}

/** 目标构造的进参 */
export interface MountProxyTargetDeps {
  /** 会话所属工作区引用（`endpoint === null` 即本地） */
  workspaceRef: WorkspaceRef;
  /** 扩展 / 应用根目录：随包产物定位基准 */
  extensionPath: string;
  /**
   * 按**目标平台**定位随包代理产物。
   *
   * 不能只给一个「宿主机上的路径」：远端是 Linux、宿主是 Windows 时，代理只在
   * `resources/core/<arch>-linux/` 里，宿主平台目录下根本没有这个文件
   * （实测 ENOENT：`...rm64-win32	uxedo-cat-mount-proxy`）。
   *
   * 入参是远端平台 / 架构（本地目标传宿主自己的）；返回 null 表示产物缺失。
   */
  resolveBundledProxy(platform: NodeJS.Platform, arch: string): string | null;
  /** 读随包代理字节（路径由 `resolveBundledProxy` 按目标平台给出） */
  readBundledBytes(bundledPath: string): Promise<Uint8Array>;
  /** 本地落点是否已有可用代理 */
  isInstalledLocally(): Promise<boolean>;
  /**
   * 取该 endpoint 的远端执行面；`null` 表示取不到（连接失败 / 宿主不支持）。
   *
   * 由宿主注入：Electron 走共享 SSH 客户端池，VS Code 侧没有远端工作区、恒给 `null`。
   */
  remoteExec(endpoint: WorkspaceEndpoint): Promise<RemoteExecPort | null>;
  /** 探测远端平台 / 架构（远端部署要按它挑随包产物） */
  detectRemoteTarget(remote: RemoteExecPort): Promise<{ platform: NodeJS.Platform; arch: string }>;
  /**
   * 远端 Core 所在的槽位目录（相对 `$HOME/.local`）：`share/<core.deployPrefix>/<指纹>`。
   *
   * 代理与 Core **同槽位**（`specs/051` FR-009 的「随 Core 一起上传」）：一个指纹
   * 一个目录，多版本并存的机器上不会互相覆盖，代理版本天然跟着 Core 版本走。
   *
   * 入参是**目标**平台 / 架构，且返回的槽位必须与「这份 Core 二进制实际会被上传到的
   * 槽位」一致——判据是 Core 二进制路径旁的 `fingerprint` 文件，不是另算一份。
   * 实测过的坑：`resources/` 与 `dist/` 各有一份 Core，指纹不同；按错的平台读会拿到
   * 另一份指纹，代理就传到别的槽位，Core 旁边永远看不见它。
   */
  remoteCoreDeployDir(platform: NodeJS.Platform, arch: string): string;
}

/** 本地目标：执行面是本机进程，字节来自随包产物 */
export function localTarget(deps: MountProxyTargetDeps): MountProxyTarget {
  // 本地工作区：目标平台就是宿主平台
  const bundled = deps.resolveBundledProxy(process.platform, process.arch);
  if (!bundled) throw new Error('随包挂载代理产物缺失（本地目标）');
  return {
    shell: createLocalMountProxyShell({ targetHost: null, cwd: deps.extensionPath }),
    host: null,
    readProxyBytes: () => deps.readBundledBytes(bundled),
    // 本地直接执行宿主上的随包产物
    installSourcePath: bundled,
    isInstalled: deps.isInstalledLocally,
    manualCommand: () => manualInstallCommand(bundled),
  };
}

/**
 * 远端目标：执行面经 SSH，字节先上传到远端暂存位再进 root 侧。
 *
 * 所有路径都是**远端路径**：`manualCommand()` 给用户的是能在远端终端直接跑的那条，
 * 不能让本地路径漏进去（`C:\...` 在远端根本不存在）。
 */
export async function remoteTarget(
  deps: MountProxyTargetDeps,
  remote: RemoteExecPort,
  /** 远端平台 / 架构：决定用哪一份随包产物（不是宿主平台） */
  remoteTargetPlatform: { platform: NodeJS.Platform; arch: string },
): Promise<MountProxyTarget> {
  const endpoint = deps.workspaceRef.endpoint;
  if (!endpoint) throw new Error('remoteTarget 需要带 endpoint 的工作区引用');
  const host = endpoint.user ? `${endpoint.user}@${endpoint.host}` : endpoint.host;
  // 字节来源按**远端**平台定位：宿主是 Windows、远端是 Linux 时，只有 linux 目录里有产物
  const bundled = deps.resolveBundledProxy(remoteTargetPlatform.platform, remoteTargetPlatform.arch);
  if (!bundled) {
    throw new Error(
      `随包挂载代理产物缺失：${remoteTargetPlatform.arch}-${remoteTargetPlatform.platform}（` +
        '远端部署要求本机携带对应平台的代理，先跑 npm run build:core）',
    );
  }
  const home = await remote.homeDir();
  // 与 Core 同槽位（`~/.local/share/<产品>/<指纹>/`）：FR-009 要求代理随 Core 一起
  // 上传，而**不是**另找一个用户可写的暂存目录——那样既偏离部署布局，也在共享机器上
  // 留下一份不属于任何 Core 版本的孤字节。
  const slotDir = `${home}/.local/${deps.remoteCoreDeployDir(
    remoteTargetPlatform.platform,
    remoteTargetPlatform.arch,
  )}`;
  const stagingPath = `${slotDir}/${CORE_MOUNT_PROXY_NAME}`;
  const bytes = await deps.readBundledBytes(bundled);
  const digest = createHash('sha256').update(bytes).digest('hex');

  // 先上传：远端 `sudo` 要读的是远端路径上的字节（本地路径远端不存在）
  await uploadToStaging(remote, stagingPath, bytes, digest);

  return {
    shell: {
      targetHost: host,
      run: (command, options) =>
        remote.execWithStdin(command, options.stdin ?? new Uint8Array(), options.timeoutMs ?? 60_000),
    },
    host,
    // 上传已就绪：后续每次安装都复用这份远端字节（内容一致，幂等）
    readProxyBytes: async () => bytes,
    // 被执行的是远端暂存位上的那份：落点此时还不存在
    installSourcePath: stagingPath,
    isInstalled: async () => {
      const result = await remote.execWithStdin(
        `stat -c '%U %G %a' "${MOUNT_PROXY_INSTALL_PATH}" 2>/dev/null || echo ABSENT`,
        new Uint8Array(),
        15_000,
      );
      // 落点判据与本地同口径：root root + 04755（FR-005b）
      return /\broot root 4755\b/.test(result.stdout);
    },
    manualCommand: () => `sudo "${stagingPath}" --install < "${stagingPath}"`,
  };
}

/**
 * 把代理字节传到远端槽位（FR-009：内容经管道，不经 argv、不落本地临时文件）。
 *
 * 槽位目录 `~/.local/share/<产品>/<指纹>/` 与 Core 二进制同一个：一个指纹一个目录，
 * 多版本并存互不覆盖，代理版本天然跟着 Core 版本走。
 *
 * 权限 `0700` 而不是 `0600`：这份字节要**被执行**（`sudo <槽位>/<mountProxyName>
 * --install`），没有 `x` 位装不上。`0700` 仍只允许本人执行，其他用户进不去这个目录。
 * 写入后立刻核对 sha256——上传被截断会在这里暴露。
 */
async function uploadToStaging(
  remote: RemoteExecPort,
  stagingPath: string,
  bytes: Uint8Array,
  digest: string,
): Promise<void> {
  const dir = path.posix.dirname(stagingPath);
  // 目录与文件都是 0700：只有本人能进、能执行（安装由 sudo 提升）
  await remote.execWithStdin(`mkdir -p "${dir}" && chmod 700 "${dir}"`, new Uint8Array(), 15_000);
  const upload = await remote.execWithStdin(
    `cat > "${stagingPath}" && chmod 700 "${stagingPath}" && sha256sum "${stagingPath}"`,
    bytes,
    60_000,
  );
  if (upload.code !== 0) {
    throw new Error(`上传挂载代理失败：${upload.stderr.trim() || `退出码 ${upload.code}`}`);
  }
  if (!upload.stdout.includes(digest)) {
    throw new Error('上传后的 sha256 与本地产物不一致（传输被截断或改写）');
  }
}

/**
 * 按会话工作区选目标（唯一的分流点，FR-009）。
 *
 * 本地 → 本地目标；SSH → 远端目标。远端取不到执行面时返回 `null`，由调用方按
 * FR-010 报错而不是退回本地——退回本地会把代理装到错误的机器上。
 */
export async function resolveTarget(deps: MountProxyTargetDeps): Promise<MountProxyTarget | null> {
  const endpoint = deps.workspaceRef.endpoint;
  if (endpoint === null) {
    // 本地工作区：宿主进程必须能起 `sh`。Windows 上没有 `sh`、也没有 overlayfs 语义，
    // 这时 Core 本就不会报 `deployable`（非 Linux 的 `capabilities()` 恒不可用），
    // 走到这里说明接线不一致——返回 null 让上层报错。
    if (process.platform !== 'linux') return null;
    return localTarget(deps);
  }
  if (deps.workspaceRef.scheme !== SSH_WORKSPACE_SCHEME) return null;
  const remote = await deps.remoteExec(endpoint);
  if (!remote) return null;
  // 平台先探：随包产物按**远端**平台挑，不按宿主平台（宿主 Windows + 远端 Linux 是常态）
  const targetPlatform = await deps.detectRemoteTarget(remote);
  return remoteTarget(deps, remote, targetPlatform);
}

/**
 * 供宿主复用的「本机随包代理路径」：与 Core 产物同目录、文件名用落点名。
 *
 * 两者同名是 FR-005 的约定（`core.mountProxyName` 唯一给出），因此这里只取 basename
 * 就能拼出随包路径——不另写一份文件名常量。
 */
export function bundledProxyPathFor(coreBinaryPath: string): string {
  return path.join(path.dirname(coreBinaryPath), path.basename(MOUNT_PROXY_INSTALL_PATH));
}

/** 本地落点判据（`root:root 04755`）；非 root / 非 unix 平台上恒 false */
export async function isLocalMountProxyInstalled(): Promise<boolean> {
  try {
    const stats = await fs.promises.stat(MOUNT_PROXY_INSTALL_PATH);
    return stats.uid === 0 && stats.gid === 0 && (stats.mode & 0o777) === 0o755;
  } catch {
    return false;
  }
}
