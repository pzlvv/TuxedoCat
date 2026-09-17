/**
 * settings.json 的宿主侧写入口。
 *
 * 全局配置文件（~/<CONFIG_DIR_NAME>/settings.json）的**写**是宿主能力：
 * core 只读它，不写（DEVELOPMENT.md 第 2 节规则 9）。两个宿主共用这份实现——
 * 串行化「读-改-写」，避免多个写入口并发造成文件截断或字段丢失。
 *
 * 写盘后调用 core 的 `resetSettingsCache()` 让 core 的读缓存失效
 * （只清内存缓存，不写盘），下次读取拿到新值。
 */

import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { getConfigHomeDir, resetSettingsCache } from '../core/history/Config.js';

/** settings.json 修改器：同步改 cfg；返回非 undefined 时作为新的完整配置写回 */
export type SettingsJsonMutator = (cfg: Record<string, any>) => void | Record<string, any>;

/**
 * 写操作串行队列。
 * 所有写操作按调用顺序排队（Promise 链），避免并发写同一文件造成：
 *  - 文件被截断/交错写坏（Windows 下 writeFile 非原子）
 *  - 后写者覆盖先写者的字段（丢失更新）
 */
let writeChain: Promise<void> = Promise.resolve();

/**
 * 写项目对话目录的 settings.json（记录该目录对应的 workspacePath）。
 *
 * 与全局 settings.json 一样：**写**归宿主，core 只读。目录已由 core 建好，
 * 这里只在 workspacePath 变化时重写（幂等，避免重复写盘）。
 */
export async function writeProjectSettings(projectDir: string, workspacePath: string): Promise<void> {
  const settingsPath = join(projectDir, 'settings.json');
  let settings: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(settingsPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
      if (settings.workspacePath === workspacePath) {
        return;
      }
    }
  } catch {
    // 文件不存在或解析失败，按空对象重建
  }
  settings.workspacePath = workspacePath;
  await mkdir(projectDir, { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/**
 * 串行化执行对 settings.json 的读-改-写。
 * 单个写操作失败不影响后续队列。
 */
export function writeSettingsJson(mutator: SettingsJsonMutator): Promise<void> {
  const run = async (): Promise<void> => {
    const configHomeDir = getConfigHomeDir();
    const settingsPath = join(configHomeDir, 'settings.json');
    let cfg: Record<string, any> = {};
    try {
      cfg = JSON.parse(await readFile(settingsPath, 'utf-8'));
    } catch {
      // 文件不存在或解析失败，从空对象开始
    }
    const result = mutator(cfg);
    const nextCfg = (result !== undefined ? result : cfg) as Record<string, any>;
    await mkdir(configHomeDir, { recursive: true });
    await writeFile(settingsPath, JSON.stringify(nextCfg, null, 2), 'utf-8');
    // 写盘完成：让 core 的读缓存失效，下次读取重新加载
    resetSettingsCache();
  };

  const next = writeChain.then(run, run);
  writeChain = next.catch(() => {});
  return next;
}
