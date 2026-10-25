/**
 * `workspace.meta.json` 的宿主侧只读库（specs/030 FR-004）。
 *
 * 写入归 Core 独占（`core-rs/src/config.rs`：`workspacePath` 由目录创建时写一次、
 * `modifiedDocs` 由工具修改 md 后更新）；本模块只读、不写盘。目录推导复用
 * `history/Config.ts` 的同一份编码逻辑（落盘格式双侧一致：两侧测试用同一组路径
 * 样本断言编码结果，`core-rs/src/config_tests.rs` ↔ `src/test/workspaceMeta.test.ts`）。
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { getProjectConversationDir, projectDirCandidates, WORKSPACE_META_FILE } from './history/Config.js';

/**
 * 解析 `workspace.meta.json` 文本中的 `modifiedDocs`。
 * `text === null`（文件不存在）与字段缺失都返回空数组；读得出但损坏
 * （非法 JSON / 非对象 / 字段形态不对）抛错——调用方转错误态，不静默当空。
 */
export function parseModifiedDocs(text: string | null, metaPath: string): string[] {
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${metaPath} 不是合法 JSON（记录损坏）`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${metaPath} 内容不是 JSON 对象`);
  }
  const docs = (parsed as Record<string, unknown>)['modifiedDocs'];
  if (docs === undefined) return [];
  if (!Array.isArray(docs) || docs.some((item) => typeof item !== 'string')) {
    throw new Error(`${metaPath} 的 modifiedDocs 字段形态不对（应为字符串数组）`);
  }
  return [...(docs as string[])];
}

/** 读取本地工作区的 md 修改记录（`modifiedDocs`，相对路径数组） */
export async function readModifiedDocs(projectPath: string): Promise<string[]> {
  const metaPath = join(getProjectConversationDir(projectPath), WORKSPACE_META_FILE);
  let text: string | null;
  try {
    text = await readFile(metaPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') text = null;
    else throw new Error(`读取 ${metaPath} 失败: ${code ?? String(err)}`);
  }
  return parseModifiedDocs(text, metaPath);
}

/** 远端只读访问口（Electron 侧用 SFTP 组装注入；本模块保持可单测） */
export interface RemoteMetaAccess {
  /** 远端用户主目录（SFTP realpath('.')） */
  homeDir(): Promise<string>;
  /** 读远端文本文件；不存在返回 null；其它失败抛错 */
  readFile(remotePath: string): Promise<string | null>;
  /** 远端路径存在性（文件或目录） */
  stat(remotePath: string): Promise<boolean>;
}

const posixJoin = (...parts: string[]): string => parts.join('/').replace(/\/+/g, '/');

/**
 * 读取远程工作区的 md 修改记录：远端 Core 数据目录（`<home>/<configDirName>/
 * conversations/<编码目录>/workspace.meta.json`）按候选顺序探测，第一个存在的
 * 目录里读清单。没有任何候选目录（该工作区从未被 Core 建过对话空间）返回空数组。
 */
export async function readRemoteModifiedDocs(
  access: RemoteMetaAccess,
  configDirName: string,
  projectPath: string,
): Promise<string[]> {
  const root = posixJoin(await access.homeDir(), configDirName, 'conversations');
  // 远端路径按远端 POSIX 语义编码（宿主是 Windows 时也不做 win32 归一）
  for (const encoded of projectDirCandidates(projectPath, { posix: true })) {
    const dir = posixJoin(root, encoded);
    if (!(await access.stat(dir))) continue;
    let text: string | null;
    try {
      text = await access.readFile(posixJoin(dir, WORKSPACE_META_FILE));
    } catch (err) {
      throw new Error(`读取 ${dir}/${WORKSPACE_META_FILE} 失败: ${String(err)}`);
    }
    return parseModifiedDocs(text, posixJoin(dir, WORKSPACE_META_FILE));
  }
  return [];
}
