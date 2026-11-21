/**
 * 挂载代理的部署编排（specs/051 FR-004 / FR-005 / FR-009）。
 *
 * 这一层只做**编排**：按固定顺序取提权、把代理内容经管道送进 root 侧标准输入、判断装上
 * 没有。真正落字节的是代理自己的 `--install`（`mount-proxy-rs/src/privilege.rs`）：入口
 * 自检、`mkstemp`、`fchown` / `fchmod` 在 `rename` 之前、`renameat` + `fsync`、允许列表
 * 写入全在 root 侧完成。宿主不自己拼字节操作，也永不自己判 ready（FR-005「自检归属唯一」）。
 *
 * ## 为什么要有这一层
 *
 * 提权顺序、密码传递约束、重试上限三条是**跨宿主同一套**的（本地 Linux 与 SSH 远端完全
 * 相同，FR-009），差异只有「命令在哪台机器上跑」。因此抽成本地 / 远端共用的纯编排，
 * 执行面经 `MountProxyShell` 注入——单测不需要真 sudo，也不需要 Linux。
 *
 * ## 硬约束（每条都来自 FR-004 第 3 条）
 *
 * - 密码只写一行进提权子进程的标准输入、随后立即关闭（留多余输入 sudo 会自己重试）；
 * - 不进 argv、不进环境变量、不进日志与诊断输出；
 * - 不为密码路径分配 pty（pty 缓冲会留下回显）；
 * - 宿主侧收到后立刻转成可清零的字节缓冲，用后清零。
 *
 * 因此本模块对外只接受 `secret: string`，内部立刻经 `SecretBytes` 转成可清零缓冲，
 * 且**任何**错误信息都不引用它。
 */

import { createHash } from 'node:crypto';

import { CORE_MOUNT_PROXY_DIR, CORE_MOUNT_PROXY_NAME } from '../config/project.js';

/** 提权来源（FR-004 的三条通道；`manual` 是零密码通道） */
export type MountProxyCredentialMethod = 'sudoPassword' | 'rootPassword' | 'manual';

/** 一条命令的执行结果（与 `SshExecResult` 同形，便于两端共用） */
export interface MountProxyExecResult {
  /** 退出码；通道未给出退出码时为 `null` */
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * 部署的执行面：本地进程与 SSH 远端都实现它。
 *
 * `stdin` 是**唯一**允许承载凭据的通道：实现必须把它写进子进程的标准输入并立即关闭，
 * 不得写进命令行参数或环境变量（FR-004 第 3 条）。
 */
export interface MountProxyShell {
  /** 目标主机名；本机为 `null`（确认框点名用，FR-003） */
  readonly targetHost: string | null;
  /** 执行一条命令；`stdin` 写完后立即关闭 */
  run(
    command: string,
    options: { stdin?: Uint8Array; timeoutMs?: number },
  ): Promise<MountProxyExecResult>;
}

/** 安装落点（`<core.mountProxyDir>/<core.mountProxyName>`，FR-005） */
export const MOUNT_PROXY_INSTALL_PATH = `${CORE_MOUNT_PROXY_DIR}/${CORE_MOUNT_PROXY_NAME}`;

/**
 * 一次部署的目标（FR-009）：本地 Core 还是某台远端 Linux。
 *
 * 这个类型的存在本身就是一条约束：**目标由会话决定，不由宿主进程决定**。宿主跑在
 * Windows 上、会话工作区在远端 Linux 时目标就是远端——按 `process.platform` 判断
 * 会直接判成「不支持部署」（`specs/defects/mount-proxy-local-host-platform-gated.md`）。
 */
export interface MountProxyTarget {
  /** 执行面：本地进程或 SSH 远端，两者对编排完全同构 */
  readonly shell: MountProxyShell;
  /** 目标主机名；本机为 `null`（确认框四要素之一，FR-003） */
  readonly host: string | null;
  /** 读随包代理字节：内容经 stdin 进 root 侧（FR-005 第 1 条） */
  readProxyBytes(): Promise<Uint8Array>;
  /** 落点处是否已有可用代理（只回答「装没装」；能不能挂载由 Core 重查能力决定） */
  isInstalled(): Promise<boolean>;
  /**
   * 安装命令里被执行的程序路径（**源**，不是落点）。
   *
   * 首次安装时落点还不存在，拿落点当被执行对象会 `command not found`——真机验证时
   * 踩到过。本地给随包产物路径，远端给上传后的暂存路径。
   */
  readonly installSourcePath: string;
  /**
   * 零密码通道展示给用户的完整命令（FR-004 第 2 条）。
   *
   * 本地与远端的**路径不同**：本地是宿主上的随包产物路径，远端是上传后的远端暂存
   * 路径。由目标自己给出，编排层不拼路径——拼错会给出根本跑不通的命令。
   */
  manualCommand(): string;
}

/**
 * 可清零的字节缓冲（FR-004 第 3 条「用后清零」）。
 *
 * 用 `Uint8Array` 而不是 string：JS 的 string 不可变、无法保证被覆盖；缓冲区在
 * `dispose()` 里显式写零。明文只在构造这一处短暂存在。
 */
class SecretBytes {
  private readonly bytes: Uint8Array;

  constructor(text: string) {
    this.bytes = new TextEncoder().encode(text);
  }

  /** 密码行：必须以 `\n` 结尾，`sudo -S` 读到换行才开始认证 */
  line(): Uint8Array {
    const out = new Uint8Array(this.bytes.length + 1);
    out.set(this.bytes, 0);
    out[this.bytes.length] = 0x0a;
    return out;
  }

  /** 清零（幂等）。调用方必须在 `run` 返回后立刻调它，不依赖 GC。 */
  dispose(): void {
    this.bytes.fill(0);
  }
}

/**
 * 把「密码行 + 载荷」拼成一条 stdin 流。
 *
 * **顺序不能交换**：`sudo -S` 从 stdin 读走**第一行**作为密码，随后它 exec 的目标
 * （代理的 `--install`）继承剩余的 stdin 作为自己的输入。所以密码行必须在前、代理
 * 内容在后——反过来 `sudo` 会把内容的第一行当密码，而代理读到空输入。
 */
function secretThenPayload(credential: Uint8Array, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(credential.length + payload.length);
  out.set(credential, 0);
  out.set(payload, credential.length);
  return out;
}

/** 一次部署的结果 */
export type MountProxyDeployOutcome =
  /**
   * 装上且探测到就位（**不**代表 overlay 可用——那是 Core 重查能力的事，FR-008）。
   * `digest` 是落盘内容的 sha256、`installerUid` 是目标机上的安装者 uid，供审计行使用
   * （FR-012）。`installerUid` 为 `null` 表示代理没有回显该行——调用方据此判失败而不是
   * 写一个占位值（`specs/defects/mount-proxy-audit-uid-from-host-process`）。
   */
  | { kind: 'installed'; digest: string; installerUid: number }
  /** 免密不可用，需要用户三选一 */
  | { kind: 'needsCredential'; manualCommand: string }
  /**
   * 本轮失败。
   *
   * 不设次数上限：认证能试几次由服务端策略（`pam_faillock` / `sudoers`）决定，宿主
   * 不替用户设闸门。失败原因点名可行动的原因，界面据此允许换一条来源再试或取消。
   */
  | { kind: 'failed'; failure: string };

/** 部署编排的进参 */
export interface MountProxyDeployOptions {
  /** 部署目标（执行面 + 字节来源 + 落点判据，见 `MountProxyTarget`） */
  target: MountProxyTarget;
}

/**
 * 首次安装的自举脚本（**固定字符串**，不含任何用户输入）。
 *
 * 为什么需要它：安装落点此时还没有代理，而源在用户可写目录里。让 `sudo` 直接执行源
 * 等于 root 执行用户可写的文件——提权漏洞；spec 的 FR-005 第 1 条也禁止源路径参与
 * 安装命令。
 *
 * 脚本做的正是「内容经管道」：把 stdin 的字节写进 root 私有的临时文件（`mktemp` 在
 * `$TMPDIR` 或 `/tmp`，名由 root 侧生成），置 `04755`，执行它的 `--install`（代理内部
 * 仍按 FR-005 的 `mkstemp` / `fchown`+`fchmod` 先于 `rename` / `renameat` 落位），
 * 最后无条件删除临时文件。
 *
 * 注意：脚本执行的是**代理自身的 `--install`**，而 `--install` 又从 stdin 读字节——
 * 所以脚本要先把字节存到临时文件、再把该文件喂回给 `--install`。两步都在 root 侧完成。
 */
const BOOTSTRAP_INSTALL_SCRIPT = [
  'tmp=$(mktemp) || exit 1',
  'trap "rm -f $tmp" EXIT',
  'chmod 700 "$tmp" || exit 1',
  'cat > "$tmp" || exit 1',
  '"$tmp" --install < "$tmp"',
].join('; ');

/**
 * 免密通道的安装命令（FR-004 第 1 条）。
 *
 * **被执行的是「源」而不是「落点」**：首次安装时落点还不存在，拿它当被执行的程序会得到
 * `command not found`（真机验证时踩到过）。源路径由目标给出——本地是随包产物路径，
 * 远端是上传后的暂存路径——见 `MountProxyTarget.installSourcePath`。
 *
 * 命令只含路径常量与目标给的源路径，不含任何用户可控字符串（FR-009 末句）。
 */
export function passwordlessInstallCommand(): string {
  return `sudo -n sh -c '${BOOTSTRAP_INSTALL_SCRIPT}'`;
}

/**
 * 零密码通道展示给用户的命令（FR-004 第 2 条）。
 *
 * 用户在自己的终端里手动执行。代理的 `--install` 从 **stdin** 读内容（FR-005 第 1 条
 * 「内容经管道」），所以命令要把随包产物喂给它自己：
 *
 * ```text
 * sudo "<随包代理>" --install < "<随包代理>"
 * ```
 *
 * 这条命令只含路径常量，不含任何用户可控字符串（FR-009 末句）；用户在自己终端里跑的
 * 就是宿主本来会跑的那一步，密码全程不经过宿主进程（AC-12）。
 */
export function manualInstallCommand(bundledProxyPath: string): string {
  return `sudo "${bundledProxyPath}" --install < "${bundledProxyPath}"`;
}

/** 失败原因里剔除可能的密码回显（防御性：即使实现有 bug 也不外泄，FR-004 第 3 条） */
function sanitizeFailure(text: string, secret: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '认证失败';
  if (secret.length > 0 && trimmed.includes(secret)) return '认证失败';
  return trimmed;
}

/** 代理 `--install` 成功时在 stdout 回显的 sha256（64 位小写 hex） */
const SHA256_LINE = /^[0-9a-f]{64}$/m;

/**
 * 代理 `--install` 回显的安装者 uid 行：**目标机上的真实安装者**（`SUDO_UID`，无则
 * 该机的 `getuid()`）。
 *
 * 为什么由代理给而不是宿主自己取：远端部署时两者不是同一个账号（宿主的
 * `process.getuid()` 是本机进程的 uid，Windows 上根本不存在）。审计行（FR-012）要记
 * 的是「哪台机器上的谁装的」（`specs/defects/mount-proxy-audit-uid-from-host-process`）。
 */
const INSTALLER_UID_LINE = /^installer-uid=(\d+)$/m;

/** 字节的 sha256（小写 hex）。宿主侧不是零依赖环境（代理那侧才要求），用 node:crypto。 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * 校验安装命令回显的 sha256 与喂进去的字节一致（FR-005「升级：按内容比对」）。
 *
 * 代理 `--install` 把落盘内容的 sha256 打在 stdout 上；宿主比一次，确认「装进去的
 * 就是发出去的那份」——中间被替换 / 截断都会在这一步暴露，而不是等到运行期。
 */
export function verifyInstalledDigest(
  stdout: string,
  payload: Uint8Array,
): { ok: boolean; digest: string } {
  const match = SHA256_LINE.exec(stdout);
  if (!match) return { ok: false, digest: '' };
  return { ok: match[0] === sha256Hex(payload), digest: match[0] };
}

/** 安装命令回显的完整报告：落盘内容的 sha256 + 目标机上的安装者 uid */
export interface InstallReport {
  /** 落盘内容的 sha256（小写 hex）；空串 = 代理没有回显，无法确认装进去的是发出去的那份 */
  digest: string;
  /** 目标机上执行安装的账号 uid；`null` = 代理没有回显这一行 */
  installerUid: number | null;
}

/**
 * 解析 `--install` 的 stdout：sha256 行 + `installer-uid=` 行。
 *
 * 两行都由代理在 root 侧算出（`mount-proxy-rs` 的 `install_from_stdin`），宿主只读不猜。
 * 顺序不参与判定：按行匹配，任何先后与夹杂的其它输出都不影响。
 */
export function parseInstallReport(stdout: string, payload: Uint8Array): InstallReport {
  const digest = verifyInstalledDigest(stdout, payload);
  const uidMatch = INSTALLER_UID_LINE.exec(stdout);
  return {
    digest: digest.digest,
    installerUid: uidMatch ? Number(uidMatch[1]) : null,
  };
}

/**
 * 审计行（FR-012）：主机名、落点、sha256、安装者 uid。
 *
 * `uid` 是**目标机上**执行安装的账号 uid（代理回显的 `installer-uid`），不是宿主进程
 * uid——远端部署时两者是不同机器上的两个账号
 * （`specs/defects/mount-proxy-audit-uid-from-host-process`）。
 *
 * 不含密码、不含代理内容的其它元数据；`targetHost` 为 `null` 时写 `localhost`。
 */
export function auditLine(options: {
  targetHost: string | null;
  installPath: string;
  digest: string;
  uid: number;
}): string {
  return (
    `[mount-proxy] installed host=${options.targetHost ?? 'localhost'} ` +
    `path=${options.installPath} sha256=${options.digest} uid=${options.uid}`
  );
}

/**
 * 尝试免密安装（FR-004 第 1 条：先试不带密码的 `sudo`）。
 *
 * 免密不可用时 `sudo -n` 立刻非零退出、stderr 说明原因，不等待输入。这一步不是一次
 * 失败的认证，只是「这条通道不可用」，因此不算失败——交给用户三选一。
 */
export async function deployWithPasswordlessSudo(
  options: MountProxyDeployOptions,
): Promise<MountProxyDeployOutcome> {
  const target = options.target;
  const proxyBytes = await target.readProxyBytes();
  const result = await target.shell.run(passwordlessInstallCommand(), { stdin: proxyBytes });
  if (result.code === 0) {
    // FR-005：按内容比对——代理回显的 sha256 必须与喂进去的字节一致。
    // FR-012：安装者 uid 也从这次回显里取（目标机上的真实安装者）。
    const report = parseInstallReport(result.stdout, proxyBytes);
    if (report.digest.length === 0) {
      return {
        kind: 'failed',
        failure: '安装命令没有回显 sha256，无法确认装进去的是发出去的那份',
      };
    }
    if (report.digest !== sha256Hex(proxyBytes)) {
      return {
        kind: 'failed',
        failure: `安装后的 sha256 与源内容不一致（落点 ${report.digest}）`,
      };
    }
    if (report.installerUid === null) {
      return {
        kind: 'failed',
        failure: '安装命令没有回显安装者 uid，审计记录无法落笔',
      };
    }
    if (await target.isInstalled()) {
      return { kind: 'installed', digest: report.digest, installerUid: report.installerUid };
    }
    // 退出码 0 却没装上：代理自称成功却没落位，属于实现不一致，不静默放过
    return {
      kind: 'failed',
      failure: '安装命令返回成功，但落点处没有可用的代理',
    };
  }
  return { kind: 'needsCredential', manualCommand: target.manualCommand() };
}

/**
 * 用一次凭据尝试安装（FR-004 第 2 / 3 / 5 条）。
 *
 * - `sudoPassword`：`sudo -S` 从 stdin 首行取密码，剩余部分转给代理读内容；
 * - `rootPassword`：`su -c` + 同样的「密码行在前」布局。`su` 在多数发行版上要求
 *   `/dev/tty`，无 tty 时会失败——此时按 FR-004 第 5 条回到三选一，**不**改用其它
 *   提权工具、也**不**为它分配 pty（那条约束更硬）。
 *
 * 密码用完立刻清零缓冲；失败原因经过回显剔除。
 */
export async function deployWithCredential(
  options: MountProxyDeployOptions,
  method: Exclude<MountProxyCredentialMethod, 'manual'>,
  secret: string,
): Promise<MountProxyDeployOutcome> {
  const target = options.target;
  const proxyBytes = await target.readProxyBytes();
  const credential = new SecretBytes(secret);
  try {
    // 首次安装时落点还不存在，而源（随包产物 / 远端暂存位）在用户可写目录里——
    // **绝不能**直接 `sudo <源> --install`：那等于让 root 执行用户可写的文件，是典型的
    // 提权漏洞。spec 的 FR-005 第 1 条也明令「内容经管道、不经路径」。
    //
    // 因此安装命令本身是固定的内联脚本：它把 stdin 里的字节写进 root 私有的临时文件、
    // 置 04755、立即执行、随后清理。字节只经 stdin，任何用户可控路径都不参与。
    const command =
      method === 'sudoPassword'
        ? `sudo -S -p "" sh -c '${BOOTSTRAP_INSTALL_SCRIPT}'`
        : `su -c "sh -c '${BOOTSTRAP_INSTALL_SCRIPT}'" root`;
    const stdin = secretThenPayload(credential.line(), proxyBytes);
    const result = await target.shell.run(command, { stdin });
    // stdin 已交给子进程；本地缓冲立刻清零（子进程那份由 OS 在 exec 后转手）
    stdin.fill(0);
    if (result.code === 0) {
      // 与免密路径同口径：回显的 sha256 必须与发出去的字节一致（FR-005），
      // 安装者 uid 也取自同一次回显（FR-012）
      const report = parseInstallReport(result.stdout, proxyBytes);
      if (report.digest.length === 0) {
        return {
          kind: 'failed',
          failure: '安装命令没有回显 sha256，无法确认装进去的是发出去的那份',
        };
      }
      if (report.digest !== sha256Hex(proxyBytes)) {
        return {
          kind: 'failed',
          failure: `安装后的 sha256 与源内容不一致（落点 ${report.digest}）`,
        };
      }
      if (report.installerUid === null) {
        return {
          kind: 'failed',
          failure: '安装命令没有回显安装者 uid，审计记录无法落笔',
        };
      }
      if (await target.isInstalled()) {
        return { kind: 'installed', digest: report.digest, installerUid: report.installerUid };
      }
    }
    return {
      kind: 'failed',
      failure: sanitizeFailure(result.stderr || result.stdout, secret),
    };
  } finally {
    credential.dispose();
  }
}

/**
 * 一次部署的起手式：先试免密 `sudo -n`（FR-004 第 1 条）。
 *
 * 免密不可用时返回 `needsCredential`，由调用方把控制权交回用户三选一；用户提交凭据后
 * 调 `deployWithCredential` 续跑。零密码通道的命令由目标自己拼（`MountProxyTarget.
 * manualCommand`）——本地与远端的路径不同，编排层不能替它拼。
 */
export async function beginDeploy(
  options: MountProxyDeployOptions,
): Promise<MountProxyDeployOutcome> {
  return deployWithPasswordlessSudo(options);
}
