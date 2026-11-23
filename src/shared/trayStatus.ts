/**
 * 托盘状态点的聚合口径（`docs/hosts/host-matrix.md` 第 4 节的托盘状态点一节）。
 *
 * 为什么在 `src/shared/` 而不是 `electron/`：这是**纯派生**（给定一组会话状态，算出
 * 一个聚合状态），不含任何 Electron API。放在 `electron/` 里时，单测哪怕只想验证这张
 * 真值表，也得 `import` 整个 `electron/trayStatusIcon.ts`——而那个模块顶层的
 * `import { nativeImage } from 'electron'` 会在首次加载时同步 spawn `install.js`
 * 现下约 100MB 二进制（`node_modules/electron` 没有 postinstall），一条 20ms 的纯函数
 * 用例因此要付 9s 的下载账。分层上也不该让 `src/` 的用例依赖 `electron/` 实现。
 *
 * 忙碌判定复用 core 的 `sessionBusyLevel`，与标签页流水灯、关闭前二次确认同一份派生
 * （`docs/architecture/principles.md` 第 5 节：派生逻辑只有一份纯函数）。这里只做聚合：
 * 任一会话 waiting 即 waiting，否则任一非 idle 即 running，其余 idle。
 */

import { sessionBusyLevel } from './sessionRuntime.js';

export type TrayStatus = 'idle' | 'running' | 'waiting';

/**
 * 从会话状态流聚合托盘状态：waiting > running > idle。
 *
 * 缺省字段按空闲处理：快照只带部分字段时（旧宿主 / 恢复路径）不误报红点。
 * 托盘吃 `SessionRuntimeState[]` 全量推送，不从对话列表（磁盘元数据）推导
 * （`docs/architecture/contracts.md` 第 4 节规则 8）。
 */
export function deriveTrayStatusFromStates(
  states: ReadonlyArray<{ idle?: boolean; waiting?: boolean }>,
): TrayStatus {
  let running = false;
  for (const item of states) {
    const level = sessionBusyLevel({ idle: item.idle ?? true, waiting: item.waiting ?? false });
    if (level === 'waiting') return 'waiting';
    if (level === 'running') running = true;
  }
  return running ? 'running' : 'idle';
}
