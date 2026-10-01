/**
 * 全局 `settings.json` 的宿主侧入口。
 *
 * 读写都归宿主（`docs/core-ui-separation.md` 第 4 节）：本模块是宿主侧的唯一入口，
 * 实现委托给 `SettingsStore`——串行化「读-改-写」、保留未知字段、写后重新解析快照。
 * Core 侧不感知这个文件的路径，只消费经 `hostEnvironmentProvided` 下发的配置快照。
 *
 * 项目清单（`<conversations>/<project>/workspace.meta.json`）归 Core 自己写
 * （第 4.1 节），宿主侧不存在对应的写入口。
 */

import { getSettingsStore, type SettingsJsonMutator } from './SettingsStore.js';

export type { SettingsJsonMutator };
export { getSettingsStore, resetSettingsStore } from './SettingsStore.js';

/**
 * 串行化执行对 `settings.json` 的读-改-写。
 * 写盘后由 `SettingsStore` 清掉 core 的读缓存（只清内存，不写盘），
 * 下次读取拿到新值。
 */
export async function writeSettingsJson(mutator: SettingsJsonMutator): Promise<void> {
  await getSettingsStore().updateSettings(mutator);
}
