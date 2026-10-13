import {
  createAttentionSound,
  traySoundEnabled,
  TRAY_SOUND_DISABLE_ENV,
  type AttentionSoundPlayer,
} from '../../electron/trayAttentionSound';
import { createChecker, runTests } from './helpers/harness';

/**
 * 托盘提醒音的播放编排（`electron/trayAttentionSound.ts`）。
 *
 * 覆盖点（`docs/hosts/host-matrix.md` 第 12 节的托盘提醒段落）：
 * - 每次提醒触发播一次：`play()` 调用次数与提醒次数一致（重播语义由载体保证）；
 * - 载体只取一次：懒取 + 缓存，不在每次提醒时重建窗口；
 * - 应用退出中（`acquirePlayer()` 返回 `null`）静默 no-op：不落日志、不抛错；
 * - 播放失败（reject / 同步抛错）与取载体失败都翻译成一条日志，**不向外抛**——
 *   调用点在 `setStatusListener` 回调里，抛错会连带打断托盘状态点与睡眠阻断；
 * - `dispose()` 转发给载体并清缓存，之后再次提醒重新取载体（主窗口关闭后重建）。
 *
 * 运行方式：npm run test:all -- trayAttentionSound
 */

/** 假载体：按模式返回成功 / reject / 同步抛错，并记录调用次数 */
function fakePlayer(mode: 'ok' | 'reject' | 'throw' = 'ok') {
  const calls = { play: 0, dispose: 0 };
  const player: AttentionSoundPlayer = {
    play(): Promise<void> {
      calls.play++;
      if (mode === 'throw') throw new Error('sync boom');
      if (mode === 'reject') return Promise.reject(new Error('async boom'));
      return Promise.resolve();
    },
    dispose(): void {
      calls.dispose++;
    },
  };
  return { player, calls };
}

/** 等一轮微任务 + 宏任务：让 `void player.play().catch(...)` 的 catch 落地 */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

runTests('trayAttentionSound', async () => {
  const { check, finish } = createChecker();

  // ── 每次提醒播一次 ──
  {
    const { player, calls } = fakePlayer();
    let acquired = 0;
    const sound = createAttentionSound({
      acquirePlayer: () => { acquired++; return player; },
      warn: () => { throw new Error('不该有日志'); },
    });
    sound.play();
    sound.play();
    sound.play();
    await flush();
    check('每次提醒触发播一次（三次提醒 → 三次播放）', calls.play === 3);
    check('载体只取一次（懒取后缓存，不每次重建）', acquired === 1);
  }

  // ── 退出中：acquirePlayer 返回 null ──
  {
    const warns: string[] = [];
    const sound = createAttentionSound({
      acquirePlayer: () => null,
      warn: (message) => warns.push(message),
    });
    let threw = false;
    try {
      sound.play();
      await flush();
    } catch {
      threw = true;
    }
    check('应用退出中（载体为 null）不播放、不落日志、不抛错', !threw && warns.length === 0);
    check('载体为 null 时不缓存失败结果：下次提醒仍会重新取', (() => {
      let acquired = 0;
      const { player } = fakePlayer();
      const retry = createAttentionSound({
        acquirePlayer: () => { acquired++; return acquired === 1 ? null : player; },
        warn: () => {},
      });
      retry.play();
      retry.play();
      return acquired === 2;
    })());
  }

  // ── 播放失败：reject ──
  {
    const warns: string[] = [];
    const { player } = fakePlayer('reject');
    const sound = createAttentionSound({ acquirePlayer: () => player, warn: (m) => warns.push(m) });
    let threw = false;
    try {
      sound.play();
      await flush();
    } catch {
      threw = true;
    }
    check('载体 reject → 落一条日志且不向外抛', !threw && warns.length === 1 && warns[0]!.includes('async boom'));
  }

  // ── 播放失败：同步抛错 ──
  {
    const warns: string[] = [];
    const { player } = fakePlayer('throw');
    const sound = createAttentionSound({ acquirePlayer: () => player, warn: (m) => warns.push(m) });
    let threw = false;
    try {
      sound.play();
      await flush();
    } catch {
      threw = true;
    }
    check('载体同步抛错 → 落一条日志且不向外抛', !threw && warns.length === 1 && warns[0]!.includes('sync boom'));
  }

  // ── 取载体失败（建窗失败） ──
  {
    const warns: string[] = [];
    const sound = createAttentionSound({
      acquirePlayer: () => { throw new Error('window boom'); },
      warn: (m) => warns.push(m),
    });
    let threw = false;
    try {
      sound.play();
      await flush();
    } catch {
      threw = true;
    }
    check('取载体抛错（建窗失败）→ 落一条日志且不向外抛', !threw && warns.length === 1 && warns[0]!.includes('window boom'));
  }

  // ── dispose ──
  {
    const warns: string[] = [];
    const first = fakePlayer();
    const second = fakePlayer();
    let acquired = 0;
    const sound = createAttentionSound({
      acquirePlayer: () => { acquired++; return acquired === 1 ? first.player : second.player; },
      warn: (m) => warns.push(m),
    });
    sound.play();
    await flush();
    sound.dispose();
    check('dispose 转发给载体', first.calls.dispose === 1);
    sound.play();
    await flush();
    check('dispose 后再次提醒重新取载体（主窗口关闭后重建）', acquired === 2 && second.calls.play === 1);
    check('dispose 路径不产生失败日志', warns.length === 0);
  }

  // ── e2e 静音开关 ──
  {
    check('默认启用提醒音（环境变量未设 / 空 / 其它取值）', (
      traySoundEnabled({})
      && traySoundEnabled({ [TRAY_SOUND_DISABLE_ENV]: '' })
      && traySoundEnabled({ [TRAY_SOUND_DISABLE_ENV]: '0' })
      && traySoundEnabled({ [TRAY_SOUND_DISABLE_ENV]: 'false' })
    ));
    check('e2e 启动器置的取值关闭提醒音（1 / true）', (
      !traySoundEnabled({ [TRAY_SOUND_DISABLE_ENV]: '1' })
      && !traySoundEnabled({ [TRAY_SOUND_DISABLE_ENV]: 'true' })
    ));
  }

  finish();
});
