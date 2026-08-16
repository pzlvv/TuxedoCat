import React, { useState, useEffect, useRef, useMemo, memo } from 'react';
import { t, getLocale } from './i18n';

interface ThinkingAnimationProps {
  isVisible: boolean;
  isDark: boolean;
  mode?: 'thinking' | 'compacting';
}

interface AnimationState {
  shuffledWords: string[];
  sourceText: string;
  targetText: string;
  cursorIndex: number;
  textIndex: number;
  phase: 'idle' | 'scanning' | 'completed';
  cycleId: number;
}

/**
 * 获取当前 locale 下的动画文案列表（组件内求值，语言切换后重新计算）。
 */
function getWords(mode: 'thinking' | 'compacting'): string[] {
  if (mode === 'compacting') {
    return [
      t('thinkingAnim.compact1'),
      t('thinkingAnim.compact2'),
      t('thinkingAnim.compact3'),
      t('thinkingAnim.compact4'),
      t('thinkingAnim.compact5'),
    ];
  }
  return [
    t('thinkingAnim.think1'),
    t('thinkingAnim.think2'),
    t('thinkingAnim.think3'),
    t('thinkingAnim.think4'),
    t('thinkingAnim.think5'),
    t('thinkingAnim.think6'),
  ];
}

/**
 * 全角字符（中日韩）等宽格子：每个全角字符占位固定 1em。
 * 仅用于全角字符本身，避免中文行里的半角英文标点被强行拉宽。
 */
const CHAR_CELL_STYLE: React.CSSProperties = {
  display: 'inline-block',
  width: '1em',
  textAlign: 'center',
  whiteSpace: 'pre',
};

/**
 * 半角字符（英文/数字/半角标点）使用自然宽度，不做 1em 撑开。
 * 这样“思考中(发呆中)...”里的括号和句点在光标扫过时不会被拉长。
 */
const CHAR_NATURAL_STYLE: React.CSSProperties = {
  display: 'inline-block',
  whiteSpace: 'pre',
};

/** 文本中是否含中日韩全角字符（含全角标点、假名、谚文） */
function containsCjk(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\u3000-\u303f\uff00-\uffef]/.test(text);
}

/**
 * 根据字符类型返回渲染样式：
 * - 全角字符用 1em 格子，保证中文字符宽度稳定；
 * - 半角字符用自然宽度，避免英文标点被拉长；
 * - 已扫过但目标文本没有的源字符使用隐藏占位保留原宽度，
 *   让长文本切换到短文本时光标能继续“空扫”过去，而不是让剩余文本反向塌缩。
 */
function getCharStyle(ch: string | undefined, useCjkCells: boolean): React.CSSProperties | undefined {
  if (!ch) return undefined;
  if (!useCjkCells) return undefined;
  return containsCjk(ch) ? CHAR_CELL_STYLE : CHAR_NATURAL_STYLE;
}

/**
 * 从 shuffled 列表中选取一对不同的文本作为 source 和 target
 */
function pickNextPair(
  shuffledWords: string[],
  sourceIndex: number,
  targetIndex: number,
): { sourceIndex: number; targetIndex: number } {
  let src = sourceIndex;
  let tgt = targetIndex;

  const maxAttempts = shuffledWords.length;
  let attempts = 0;
  while (shuffledWords[src] === shuffledWords[tgt]) {
    tgt = (tgt + 1) % shuffledWords.length;
    attempts++;
    if (attempts >= maxAttempts) {
      shuffledWords.sort(() => Math.random() - 0.5);
      src = 0;
      tgt = 1;
      break;
    }
  }

  return { sourceIndex: src, targetIndex: tgt };
}

/**
 * 自定义比较器：仅当 isVisible / isDark / mode 变化时才重新渲染组件。
 * 每次都重新渲染 ThinkingAnimation 会导致昂贵的 re-reconcile 开销。
 */
function arePropsEqual(prevProps: ThinkingAnimationProps, nextProps: ThinkingAnimationProps): boolean {
  return (
    prevProps.isVisible === nextProps.isVisible &&
    prevProps.isDark === nextProps.isDark &&
    prevProps.mode === nextProps.mode
  );
}

export const ThinkingAnimation: React.FC<ThinkingAnimationProps> = memo(({ isVisible, isDark, mode = 'thinking' }) => {
  // ── 核心状态用 ref 存储，不触发 React 渲染 ──────────────────────────
  const stateRef = useRef<AnimationState | null>(null);

  // 仅用于渲染的 UI state — 由 ref 同步触发更新
  const [renderTick, setRenderTick] = useState(0);

  const animationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const idleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // mode 决定了文字列表（组件内求值，locale 变化后随重挂载刷新）
  const words = useMemo(() => getWords(mode), [mode]);

  // 英文模式下字符替换速度 *2.5（英文文本更长，加快逐字符扫描）
  // 不同文本之间切换的停顿时间保持不变
  const speedMultiplier = getLocale() === 'en' ? 2.5 : 1;
  const CHAR_INTERVAL_MS = Math.round(60 / speedMultiplier); // 60ms -> 24ms
  const PAUSE_MS = 2000; // 文本间切换停顿固定 2000ms

  // ── 启动/停止动画（仅当 isVisible 或 words 变化时） ────────────────
  useEffect(() => {
    if (!isVisible) {
      stateRef.current = null;
      setRenderTick(0);
      return;
    }

    // Shuffle 所有文本
    const shuffled = [...words].sort(() => Math.random() - 0.51);

    // 选取第一对不同的文本
    const { sourceIndex: srcIdx, targetIndex: tgtIdx } = pickNextPair(shuffled, 0, 1);

    stateRef.current = {
      shuffledWords: shuffled,
      sourceText: shuffled[srcIdx],
      targetText: shuffled[tgtIdx],
      cursorIndex: 0,
      textIndex: tgtIdx,
      phase: 'idle',
      cycleId: 0,
    };

    // 触发一次渲染
    setRenderTick(n => n + 1);
  }, [isVisible, words]);

  // ── idle 状态2秒后自动转到 scanning ─────────────────────────────────
  useEffect(() => {
    if (!stateRef.current) {
      clearTimeout(idleTimeoutRef.current!);
      idleTimeoutRef.current = null;
      return;
    }

    if (stateRef.current.phase === 'idle') {
      clearTimeout(idleTimeoutRef.current!);

      idleTimeoutRef.current = setTimeout(() => {
        if (stateRef.current && stateRef.current.phase === 'idle') {
          stateRef.current = { ...stateRef.current, phase: 'scanning' };
          setRenderTick(n => n + 1);
        }
      }, PAUSE_MS);
    }

    return () => {
      clearTimeout(idleTimeoutRef.current!);
    };
  }, [stateRef.current?.phase, renderTick]);

  // ── 逐字符替换动画 ──────────────────────────────────────────────────
  useEffect(() => {
    if (!stateRef.current || stateRef.current.phase !== 'scanning') {
      return;
    }

    clearInterval(animationIntervalRef.current!);

    animationIntervalRef.current = setInterval(() => {
      const prev = stateRef.current;
      if (!prev) return;
      if (prev.phase !== 'scanning') return;

      const newCursorIndex = prev.cursorIndex + 1;
      const maxLen = Math.max(prev.sourceText.length, prev.targetText.length);

      // 扫描完成，进入 completed 状态
      if (newCursorIndex > maxLen) {
        clearInterval(animationIntervalRef.current!);
        animationIntervalRef.current = null;

        stateRef.current = { ...prev, phase: 'completed' };
        setRenderTick(n => n + 1);

        // 停顿后切换到下一对文本
        setTimeout(() => {
          const cur = stateRef.current;
          if (!cur) return;

          const { shuffledWords, targetText, textIndex: currentTextIndex } = cur;
          const nextIdx = (currentTextIndex + 1) % shuffledWords.length;
          const { targetIndex: nextTargetIdx } = pickNextPair(shuffledWords, currentTextIndex, nextIdx);

          stateRef.current = {
            shuffledWords,
            sourceText: targetText,
            targetText: shuffledWords[nextTargetIdx],
            cursorIndex: 0,
            textIndex: nextTargetIdx,
            phase: 'idle',
            cycleId: currentTextIndex + 1,
          };
          setRenderTick(n => n + 1);
        }, PAUSE_MS);

        return;
      }

      stateRef.current = { ...prev, cursorIndex: newCursorIndex };
      setRenderTick(n => n + 1);
    }, CHAR_INTERVAL_MS);

    return () => {
      clearInterval(animationIntervalRef.current!);
    };
  }, [stateRef.current?.textIndex, stateRef.current?.phase, stateRef.current?.cycleId, renderTick]);

  // ── 不渲染任何 DOM ──────────────────────────────────────────────────
  if (!stateRef.current) {
    return null;
  }

  const animation = stateRef.current;

  // 行内含 CJK 时，全角字符使用 1em 格子、半角标点使用自然宽度；
  // 纯拉丁文行不强制格子，改用等宽字体（Consolas 等）天然等宽。
  const useCjkCells = containsCjk(animation.sourceText) || containsCjk(animation.targetText);
  const charStyleFor = (ch: string | undefined) => getCharStyle(ch, useCjkCells);

  // 含 CJK 的行强制使用中文字体渲染整行（包括 ASCII 括号/句点等英文标点），
  // 避免这些半角标点被优先命中 Consolas 等英文字体，导致扫描动画中字体/字形跳变。
  const fontFamily = useCjkCells
    ? '"Microsoft YaHei", "微软雅黑", "PingFang SC", "Noto Sans CJK SC", sans-serif'
    : 'Consolas, "Courier New", "Microsoft YaHei", "微软雅黑", monospace, sans-serif';

  return (
    <div
      className="thinking-cursor-wrapper"
      style={{ fontFamily }}
    >
      <span style={{ color: 'inherit' }}>
        {animation.phase === 'idle' ? (
          animation.sourceText
        ) : animation.phase === 'completed' ? (
          animation.targetText
        ) : (
          <>
            {Array.from({ length: Math.max(animation.sourceText.length, animation.targetText.length) }).map((_, i) => {
              const isInSource = i < animation.sourceText.length;
              const isInTarget = i < animation.targetText.length;

              if (i < animation.cursorIndex) {
                if (isInTarget) {
                  return <span key={i} style={charStyleFor(animation.targetText[i])}>{animation.targetText[i]}</span>;
                }
                // 目标文本已结束，但源文本还有字符：用隐藏的源字符占住原宽度，
                // 让光标继续向右空扫，而不是让剩余长文本在光标左侧反向塌缩。
                if (isInSource) {
                  return (
                    <span
                      key={i}
                      style={{ ...(charStyleFor(animation.sourceText[i]) || {}), visibility: 'hidden' }}
                    >
                      {animation.sourceText[i]}
                    </span>
                  );
                }
                return <span key={i} />;
              }

              if (i === animation.cursorIndex) {
                const charAfterCursor = isInSource ? animation.sourceText[i] : '';
                return (
                  <React.Fragment key={i}>
                    <span
                      className="thinking-cursor-block"
                      style={{
                        backgroundColor: isDark ? '#fff' : '#000',
                        border: `1px solid ${isDark ? '#fff' : '#000'}`,
                      }}
                    />
                    <span style={charStyleFor(charAfterCursor)}>{charAfterCursor}</span>
                  </React.Fragment>
                );
              }

              return isInSource
                ? <span key={i} style={charStyleFor(animation.sourceText[i])}>{animation.sourceText[i]}</span>
                : <span key={i} />;
            })}
          </>
        )}
      </span>
    </div>
  );
}, arePropsEqual);
