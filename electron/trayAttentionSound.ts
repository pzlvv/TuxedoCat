/**
 * 托盘提醒音的播放编排（`electron/main.ts` 的 startAttention 消费）。
 *
 * 「任务结束提醒」触发托盘图标闪烁时（`electron/trayAttention.ts` 差分出的完成 / 转等待，
 * 且窗口在后台），除闪烁外再播一次提示音，见 `docs/hosts/host-matrix.md` 第 6 节的
 * 托盘提醒段落。
 *
 * 本模块只管**什么时候播、播失败怎么办**，不管怎么播（载体是 `electron/traySoundWindow.ts`
 * 的隐藏窗口 + Web Audio）：播放载体懒取一次后缓存，播放失败（文件缺失 / 解码失败 /
 * 载体已销毁）翻译成一条日志，**不向外抛**——调用点在 `setStatusListener` 的回调里，
 * 同一条回调上还有托盘状态点与睡眠阻断（`electron/powerSaveBlocker.ts`），抛错会连带
 * 影响它们（架构铁律 1：不静默降级，但也不让附加通道打翻主流程）。
 *
 * 除提醒外还提供 `preview()`：偏好设置里开提示音 / 拖完音量滑条时试听一次，走同一个
 * 载体（试听先建好，之后第一次提醒直接复用）与同一份音量（载体的 `getVolume()`）。
 *
 * 保持纯逻辑（不 import electron），可被 `src/test/trayAttentionSound.test.ts` 单测。
 */

/** 播放载体：一次播放 = 从头播一次音频 */
export interface AttentionSoundPlayer {
  /** 从头播放一次；播放不了（载体不可用 / 解码失败）时 reject */
  play(): Promise<void>;
  /** 释放载体资源（幂等）；释放后再次播放由调用方重新取载体 */
  dispose(): void;
}

/**
 * 关闭提醒音的环境变量（宿主级启动开关，命名沿用 core 侧 `DISABLE_AUTO_COMPACT` 的口径）。
 *
 * e2e 的整应用用例在开发机上跑完整链路，会话结束同样会触发提醒——提示音会和开发机上
 * 真实运行的应用撞在一起，所以 e2e 启动器置 `1` 关掉它（`e2e/README.md` 的隔离策略）。
 * 名字导出成常量：启动器与宿主共用一处，改名字不会两边漂。
 */
export const TRAY_SOUND_DISABLE_ENV = 'DISABLE_TRAY_SOUND';

/** 提醒音是否启用（该环境变量为 `1` / `true` 时关闭）；`env` 可注入，便于单测 */
export function traySoundEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[TRAY_SOUND_DISABLE_ENV];
  return raw !== '1' && raw !== 'true';
}

export interface AttentionSoundDeps {
  /**
   * 取播放载体（首次播放时创建，成功后缓存）。
   *
   * 返回 `null` 表示此刻**不该**播放，两种情形都是设计允许的 no-op（不落日志——
   * 铁律 1 的例外：只有设计允许的瞬时状态才允许静默 no-op；真正的失败走 `play()`
   * 的 reject）：应用正在退出（不值得再建播放窗口）、提醒音被启动开关关掉
   * （`traySoundEnabled()`，e2e 用）。
   */
  acquirePlayer(): AttentionSoundPlayer | null;
  /** 播放失败留痕（宿主日志出口；静默无声的症状无从排查） */
  warn(message: string): void;
}

export interface AttentionSound {
  /** 提醒触发时调用：播放一次提示音（重播语义由载体保证：从头、单路） */
  play(): void;
  /**
   * 用户试听：偏好设置里开提示音 / 拖音量滑条后预览播放一次。
   *
   * 与提醒走**同一个载体、同一份音量**：载体的窗口是懒建缓存的，试听先建好，
   * 之后第一次提醒直接复用，不会为试听另起一路输出。音量由载体的
   * `getVolume()` 每次播放前取，改动后无需重建载体。
   */
  preview(): void;
  /**
   * 释放播放载体（幂等）：主窗口关闭 / 应用退出时调用，避免隐藏的播放窗口留着
   * 影响 `window-all-closed` 与 `activate` 的窗口计数。之后再次 `play()` 会重新取载体。
   */
  dispose(): void;
}

export function createAttentionSound(deps: AttentionSoundDeps): AttentionSound {
  let player: AttentionSoundPlayer | null = null;

  function playOnce(): void {
    try {
      player ??= deps.acquirePlayer();
      if (!player) return;
      void player.play().catch((err: unknown) => {
        deps.warn(`play failed: ${String(err)}`);
      });
    } catch (err) {
      // 取载体本身抛错（建窗失败等）与播放失败同形处理：留痕、不外抛
      deps.warn(`play threw: ${String(err)}`);
    }
  }

  return {
    play: playOnce,
    preview: playOnce,
    dispose(): void {
      const current = player;
      player = null;
      current?.dispose();
    },
  };
}
