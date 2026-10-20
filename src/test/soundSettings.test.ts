/**
 * 提示音偏好的规范化（`electron/soundSettings.ts`）。
 *
 * 覆盖点：
 * - 字段缺失（旧版本状态文件 / 新装）按默认：关闭 + 50% 音量（specs/016 FR-006）；
 * - `soundEnabled` 只有显式 `true` 才算开启，其余值按关闭；
 * - 音量越界（负数 / >1）收敛到 [0, 1]，非数 / 非有限数按默认音量。
 *
 * 运行方式：npm run test:all -- soundSettings
 */

import {
  clampSoundVolume,
  readSoundSettings,
  DEFAULT_SOUND_VOLUME,
} from '../../electron/soundSettings';
import { createChecker, runTests } from './helpers/harness';

runTests('soundSettings', () => {
  const { check, finish } = createChecker();

  // ── 默认值 ──
  {
    const defaults = readSoundSettings({});
    check('缺失字段按默认：关闭', defaults.enabled === false);
    check('缺失字段按默认：50% 音量', defaults.volume === DEFAULT_SOUND_VOLUME);
    check('默认音量常量为 0.5', DEFAULT_SOUND_VOLUME === 0.5);
  }

  // ── 开关 ──
  {
    check('soundEnabled=true 才算开启', readSoundSettings({ soundEnabled: true }).enabled === true);
    check('soundEnabled=false 保持关闭', readSoundSettings({ soundEnabled: false }).enabled === false);
    // 状态文件异常形态：非 true 一律按关闭（默认不打扰）
    check(
      '非布尔的开关值按关闭',
      readSoundSettings({ soundEnabled: undefined }).enabled === false,
    );
  }

  // ── 音量 ──
  {
    check('合法音量原样返回', clampSoundVolume(0.4) === 0.4);
    check('音量下界 0 保留', clampSoundVolume(0) === 0);
    check('音量上界 1 保留', clampSoundVolume(1) === 1);
    check('负数收敛到 0', clampSoundVolume(-0.5) === 0);
    check('超上界收敛到 1', clampSoundVolume(2.5) === 1);
    check('NaN 按默认音量', clampSoundVolume(Number.NaN) === DEFAULT_SOUND_VOLUME);
    check('Infinity 按默认音量', clampSoundVolume(Number.POSITIVE_INFINITY) === DEFAULT_SOUND_VOLUME);
    check('非数按默认音量', clampSoundVolume('0.5') === DEFAULT_SOUND_VOLUME);
    check('音量同样过 clamp（readSoundSettings 走同一条纯函数）', readSoundSettings({ soundVolume: 5 }).volume === 1);
  }

  finish();
});
