/**
 * 提示音偏好的规范化（宿主本地偏好：`userData/workspace-state.json` 的
 * `soundEnabled` / `soundVolume` 字段）。
 *
 * 保持纯函数（不 import electron），可被 `src/test/soundSettings.test.ts` 单测。
 * 状态文件可能被手改、或来自没有这两个字段的旧版本，这里把字段收敛成播放路径能
 * 直接用的形态：是否播放取布尔（缺失按关闭——默认不打扰，specs/016 FR-006），音量
 * 收敛到 [0, 1] 的有限数（缺失 / 非法按默认音量 0.5）——不把 NaN / 超范围值拼进
 * 播放脚本。
 *
 * 音量与开关是宿主本地偏好，core 不读不写（与 `theme` / `shortcut` 同一口径）。
 */

/** 默认音量（50%）：提示音作为可选项存在，默认音量不炸耳（specs/016 FR-006） */
export const DEFAULT_SOUND_VOLUME = 0.5;

/** 把音量收敛到 [0, 1]；缺失 / 非数 / 非有限数按默认音量 */
export function clampSoundVolume(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SOUND_VOLUME;
  return Math.min(1, Math.max(0, value));
}

export interface SoundSettings {
  /** 是否播放任务结束提醒音 */
  enabled: boolean;
  /** 音量（0–1 线性增益） */
  volume: number;
}

/** 从宿主本地状态字段读出提示音偏好（缺失 / 非法按默认：关闭、50% 音量） */
export function readSoundSettings(state: {
  soundEnabled?: boolean;
  soundVolume?: number;
}): SoundSettings {
  return {
    // 只有显式 true 才算开启：缺失（旧版本 / 新装）按关闭（默认不打扰）
    enabled: state.soundEnabled === true,
    volume: clampSoundVolume(state.soundVolume),
  };
}
