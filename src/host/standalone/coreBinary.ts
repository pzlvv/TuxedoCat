/**
 * Standalone Core 产物的定位（见 docs/core/standalone-core.md 第 3.1 节）。
 *
 * 产物目录命名与 `resources/ripgrep/` 一致：`<arch>-<platform>`。
 * 平台矩阵里的每个组合都有一个目录；当前只有 Windows x64 有实际产物。
 *
 * 定位基准是应用 / 扩展根目录，不用会话工作目录：
 * 优先 `dist/resources`（打包产物），其次 `resources`（开发期未 build）。
 * Electron 打包后根目录在 `app.asar` 内：spawn 不能从 asar 里启动可执行文件，
 * 所以每条候选都先取 `app.asar.unpacked` 下的解包副本（见 `asarUnpackedVariant`）。
 *
 * 目录名与可执行文件名取自 `src/config/project.json`（`core.resourceDir` /
 * `core.binaryName`），本模块不写死产品名。
 *
 * 同一个产物目录里还有 Core **自带**的 `ripgrep/`（Grep / Glob 用的 `rg`）：Core 以
 * 自己的可执行文件目录为基准定位它，Host 只负责把整份产物搬到位（本地直接起进程、
 * 远端 SSH 引导上传），见 `docs/core/standalone-core.md` 第 4 节。
 */

import * as fs from 'fs';
import * as path from 'path';
import { CORE_BINARY_NAME, CORE_DEPLOY_PREFIX, CORE_RESOURCE_DIR } from '../../config/project.js';

/** 产物目录名；平台 / 架构不在矩阵内时返回 null */
export function corePlatformDir(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const archName = arch === 'x64' || arch === 'arm64' ? arch : null;
  if (!archName) return null;
  if (platform === 'win32' || platform === 'linux') {
    return `${archName}-${platform}`;
  }
  return null;
}

/** 可执行文件名；Windows 带 `.exe` */
export function coreBinaryFileName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${CORE_BINARY_NAME}.exe` : CORE_BINARY_NAME;
}

/**
 * 一件随 Core 分发的内置工具（与 `core-rs/src/bundled_tools.rs` 的 `BUNDLED_TOOLS` 同源登记表）。
 *
 * 目录名只在两处登记表里出现：这份 TS 侧（宿主定位、SSH 上传、打包校验消费）与 Rust 侧
 * （Core 自己解析 Grep / Glob 的 `rg` 与工具 shell 前置的 `rg` / `fd`）。派生路径一律经
 * `bundledToolPath` / `coreDeployToolPath`，不散落目录名字符串。
 */
export interface BundledTool {
  /** 产物目录名：`resources/<dir>/<arch>-<platform>/`、`<Core exe 目录>/<dir>/`、`share/<产品名>/<dir>/` */
  dir: string;
  /** 可执行名（不含平台扩展名） */
  stem: string;
}

/** 全部内置工具，顺序即 Core 侧 PATH 前置顺序（`rg` 在前，它是 Grep / Glob 的运行时依赖） */
export const BUNDLED_TOOLS: readonly BundledTool[] = [
  { dir: 'ripgrep', stem: 'rg' },
  { dir: 'fd', stem: 'fd' },
];

/** 按目录名取登记项；未登记的名字直接抛错（不猜） */
function requireTool(dir: string): BundledTool {
  const tool = BUNDLED_TOOLS.find((item) => item.dir === dir);
  if (!tool) throw new Error(`bundled tool "${dir}" is not registered in BUNDLED_TOOLS`);
  return tool;
}

/**
 * Core 自带工具的目录名（与 Core 可执行文件同级）。
 *
 * Core 以**自己的可执行文件所在目录**为基准定位自带资源（`core-rs/src/bundled_tools.rs` 的
 * `tool_candidates`，见 `docs/core/standalone-core.md` 第 3.1 节）：Grep / Glob 用的 `rg` 与
 * 工具 shell 前置的 `fd` 都放在这个目录里，本地由 `npm run build:core` 落位，远端由 SSH 引导原样上传。
 */
export const CORE_RIPGREP_DIR = requireTool('ripgrep').dir;

/** Core 自带 `fd` 的目录名 */
export const CORE_FD_DIR = requireTool('fd').dir;

/**
 * 构建指纹文件名（与可执行文件同级，`build-core.mjs` 落位）。
 *
 * 指纹只由源码内容与编译器身份决定（docs/core/standalone-core.md 第 3.4 节）：部署按它
 * 落位 `share/<产品名>/<指纹>/` 槽位（见 `coreDeployDirPath`），多版本 Core 在同一台
 * 机器上各占一个槽位互不干扰；Electron / vsix 打包把它与产物一起携带，宿主运行时读取。
 */
export const CORE_FINGERPRINT_FILE_NAME = 'fingerprint';

/**
 * 部署产品目录（相对部署根 `~/.local`）：`share/<core.deployPrefix>`（纯函数）。
 *
 * 部署布局是全产品共享的一份，TUI 安装器（installer-rs）与 SSH 引导同一口径：产品
 * 目录下按指纹分槽放 Core 二进制，自带 ripgrep 是全部槽位共享的一份（见
 * `coreDeployRipgrepPath`）。产品名取自 `src/config/project.json`（`core.deployPrefix`），
 * 把不同产品的部署槽位在共享机器上分开。
 */
export function coreDeployShareDirName(): string {
  return ['share', CORE_DEPLOY_PREFIX].join('/');
}

/**
 * 部署目录（相对部署根 `~/.local`）：`share/<产品名>/<完整指纹>`（纯函数，
 * 派生逻辑只有这一份）。
 *
 * 槽位名用完整 64 位指纹，与按指纹命名的 daemon 状态 / 日志文件（`daemonProtocol.ts`）
 * 同口径，一个指纹一个目录、各跑各的 daemon 互不干扰。入参是 `readCoreFingerprint`
 * 读出的 64 位指纹。
 */
export function coreDeployDirPath(fingerprint: string): string {
  return `${coreDeployShareDirName()}/${fingerprint}`;
}

/**
 * 共享内置工具的部署路径（相对部署前缀）：`share/<产品名>/<tool.dir>`。
 *
 * 内置工具与指纹无关（`rg` 的搜索行为、`fd` 的遍历行为都不随 Core 版本变），全部指纹槽位
 * 共享同一份；Core 侧按「自己所在槽位的上一级目录里的 `<tool.dir>`」定位它
 * （`core-rs/src/bundled_tools.rs` 的 `tool_candidates`）。远端只支持 Linux，文件名不带 `.exe`。
 */
export function coreDeployToolPath(dir: string): string {
  return `${coreDeployShareDirName()}/${requireTool(dir).dir}`;
}

/** 共享 ripgrep 的部署路径（相对部署前缀）：`share/<产品名>/ripgrep` */
export function coreDeployRipgrepPath(): string {
  return coreDeployToolPath(CORE_RIPGREP_DIR);
}

/** 共享 fd 的部署路径（相对部署前缀）：`share/<产品名>/fd` */
export function coreDeployFdPath(): string {
  return coreDeployToolPath(CORE_FD_DIR);
}

/** 内置工具的可执行文件名；Windows 带 `.exe` */
export function bundledToolFileName(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const stem = requireTool(dir).stem;
  return platform === 'win32' ? `${stem}.exe` : stem;
}

/** 自带 ripgrep 的文件名；Windows 带 `.exe` */
export function bundledRipgrepFileName(platform: NodeJS.Platform = process.platform): string {
  return bundledToolFileName(CORE_RIPGREP_DIR, platform);
}

/** 自带 fd 的文件名；Windows 带 `.exe` */
export function bundledFdFileName(platform: NodeJS.Platform = process.platform): string {
  return bundledToolFileName(CORE_FD_DIR, platform);
}

/** 内置工具的本地路径（给定 Core 可执行文件路径）：`<dir>/<tool>/<exe>` */
export function bundledToolPath(
  coreBinary: string,
  dir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return path.join(path.dirname(coreBinary), requireTool(dir).dir, bundledToolFileName(dir, platform));
}

/** 自带 ripgrep 的本地路径（给定 Core 可执行文件路径） */
export function bundledRipgrepPath(
  coreBinary: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return bundledToolPath(coreBinary, CORE_RIPGREP_DIR, platform);
}

/** 自带 fd 的本地路径（给定 Core 可执行文件路径） */
export function bundledFdPath(
  coreBinary: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return bundledToolPath(coreBinary, CORE_FD_DIR, platform);
}

/**
 * 把 asar 内路径改写到解包目录。
 *
 * Electron 的 fs 补丁让 `fs.existsSync`「看得到」asar 内的文件，但
 * `child_process.spawn` 不做这层重定向，直接 spawn asar 内路径必然 ENOENT；
 * 可执行文件必须落在磁盘上（`electron-builder.config.js` 的 `asarUnpack` 把
 * `dist/resources/**` 解包到 `app.asar.unpacked/`），因此候选路径要显式指向解包目录。
 * 路径不含 `app.asar`（开发期 / VS Code 扩展）时改写结果与原路径相同。
 */
function asarUnpackedVariant(candidate: string): string {
  return candidate.replace(/app\.asar(?=$|[\\/])/, 'app.asar.unpacked');
}

/** 候选路径（按优先级）；目录不在矩阵内时返回空数组 */
export function coreBinaryCandidates(
  extensionPath: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string[] {
  const dir = corePlatformDir(platform, arch);
  if (!dir) return [];
  const name = coreBinaryFileName(platform);
  const bases = [
    path.join(extensionPath, 'dist', 'resources', CORE_RESOURCE_DIR, dir, name),
    path.join(extensionPath, 'resources', CORE_RESOURCE_DIR, dir, name),
  ];
  // 解包目录排在 asar 内路径之前：后者即使存在也 spawn 不了
  const candidates: string[] = [];
  for (const base of bases) {
    const unpacked = asarUnpackedVariant(base);
    if (unpacked !== base) candidates.push(unpacked);
    candidates.push(base);
  }
  return candidates;
}

/**
 * 解析 Standalone Core 可执行文件路径。
 *
 * 未找到时抛错：Standalone 装配缺产物属于启动期错误，不回退到 PATH。
 */
export function resolveCoreBinary(
  extensionPath: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const dir = corePlatformDir(platform, arch);
  if (!dir) {
    throw new Error(
      `Standalone Core has no product for platform=${platform} arch=${arch}. ` +
      'See docs/core/standalone-core.md section 4.1 for the target matrix.',
    );
  }
  const candidates = coreBinaryCandidates(extensionPath, platform, arch);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Standalone Core binary not found. Looked in: ${candidates.join(', ')}. ` +
    'Run "npm run build:core" first.',
  );
}

/**
 * 读取 Standalone Core 的构建指纹（可执行文件同级的 `fingerprint` 文件）。
 *
 * 指纹是部署的槽位标识：宿主据此确定部署目录 `~/.local/share/<产品名>/<指纹>/`
 * （`coreDeployDirPath`）与该指纹专属的 daemon 状态文件（`docs/core/core-remote.md` 第 2.3 节）。
 * 文件缺失 / 内容不是 64 位小写 hex 都抛错：产物不完整属于构建期错误，静默猜一个
 * 指纹会部署到错误的槽位（``docs/architecture/principles.md`）。
 */
export function readCoreFingerprint(
  extensionPath: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const fingerprintPath = path.join(
    path.dirname(resolveCoreBinary(extensionPath, platform, arch)),
    CORE_FINGERPRINT_FILE_NAME,
  );
  let text: string;
  try {
    text = fs.readFileSync(fingerprintPath, 'utf8').trim();
  } catch {
    throw new Error(
      `Standalone Core fingerprint file not found: ${fingerprintPath}. ` +
      'Run "npm run build:core" first.',
    );
  }
  if (!/^[0-9a-f]{64}$/.test(text)) {
    throw new Error(
      `Standalone Core fingerprint is malformed: ${fingerprintPath} does not hold ` +
      'a 64-hex-character fingerprint. Run "npm run build:core" first.',
    );
  }
  return text;
}
