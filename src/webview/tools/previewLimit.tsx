import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { t } from '../i18n';

/**
 * 代码预览的按需渲染 + 精确限高。
 *
 * 背景：EditFile diff 与 WriteFile 内容预览此前会把**全部**行一次性渲染进一个
 * `maxHeight: 300px` 的滚动框，且逐 token 的 Shiki span 一并生成。
 * 实测（177 个会话 / 1989 次 Edit 调用 / 8 个大对话的 DOM 剖析）：
 *   - Edit diff 行数 p50=8、p90=35、p99=110、最大 542，渲染层完全没有截断；
 *   - Write 预览单条平均 1269 个 DOM 节点、最大 7243；
 *   - 代码预览合计占大对话 DOM 节点的 41%~63%。
 *
 * 方案：预览框默认只渲染前 PREVIEW_LINES 行，点击预览框再渲染全部内容 ——
 * 保留"默认展开"的观感，同时把 DOM 规模与高亮开销压到与窗口大小相称的量级。
 *
 * 现状：Edit / Write 现在**始终**完整展开（所有模式、历史加载都一样），
 * 即调用方始终传 forceExpand = true；下面的缩略（truncate）能力仍保留在
 * hook 里，供需要按需渲染的预览复用。
 *
 * ⚠️ 关键修正（换行）：预览框宽度随 webview 宽度变化，代码长行会被 `pre-wrap`
 * 自动折行，于是一个"逻辑行"可能占多个视觉行。此前用「固定 16 行 = 288px」
 * 的算法只在「每行都不折行」时成立；一旦有长行折行，16 个逻辑行就会超过
 * 288px，缩略态照样冒出滚动条。
 * 现在改为**实测**：把每行渲染成独立块级元素，用 getBoundingClientRect 累加
 * 真实高度，只保留在 PREVIEW_CONTENT_HEIGHT 内放得下的整行；窗口宽度变化时
 * 用 ResizeObserver 重新测量。
 */

/** 预览行的基准高度（px）：字号 12px，行高 1.5。 */
export const PREVIEW_LINE_HEIGHT = 18;

/**
 * 预览框一次渲染/测量的最大行数。
 *
 * 依据：内容区上限 PREVIEW_CONTENT_HEIGHT = 288px，最小行高 18px，
 * 288 / 18 = 16，因此任何情况下最多只有 16 个逻辑行能放得下，
 * 渲染超过 16 行没有任何意义。
 */
export const PREVIEW_LINES = 16;

/** 预览内容区最大高度（px，不含 1px 上下边框）。 */
export const PREVIEW_CONTENT_HEIGHT = PREVIEW_LINES * PREVIEW_LINE_HEIGHT;

/** 预览框最大外框高度（px，含 1px 上下边框），即展开态高度。 */
export const PREVIEW_BOX_HEIGHT = PREVIEW_CONTENT_HEIGHT + 2;

export interface PreviewLimitOptions {
  /** 内容/主题变化时用于触发重新测量（例如高亮 HTML 更新） */
  revision?: unknown;
  /** 用户展开预览时回调（用于暂停消息列表自动滚动） */
  onExpand?: () => void;
  /**
   * 内容区限高（px）。缺省 PREVIEW_CONTENT_HEIGHT（Edit/Write 预览框）。
   * Bash 输出传 115：输出框与流式滚动容器同高，缩略/展开卡片总高度都不变。
   */
  contentHeight?: number;
}

export interface PreviewLimit {
  /** 挂到「逐行元素」的容器上，用于测量折行后的真实高度 */
  contentRef: React.RefObject<HTMLDivElement>;
  /** 需要渲染的行数：缩略态为候选行数，展开态为全部行 */
  visibleLines: number;
  /** 在 PREVIEW_CONTENT_HEIGHT 内完整放得下的行数（按真实高度累加） */
  fittedLines: number;
  /** fittedLines 对应的真实像素高度 */
  fittedHeight: number;
  expanded: boolean;
  /** 缩略态且内容未全部显示 */
  truncated: boolean;
  /** 是否还有内容没显示（需要「显示全部」提示条） */
  hasMore: boolean;
  expand: () => void;
  handleBoxClick: (e: React.MouseEvent) => void;
}

/**
 * 预览行数限制状态（含折行感知的高度测量）。
 *
 * @param totalLines  预览内容的实际总行数
 * @param forceExpand 强制完整展开（不再截断）。用于**手动模式下等待用户授权**的
 *   Edit/Write 卡片：用户需要看到被写入/修改的完整内容才能确认，
 *   此时必须渲染全部；用户确认后 status 变为 running/success，
 *   forceExpand 回到 false，卡片自动恢复缩略。
 *   注意这是**行级**展开，与「工具行箭头收起整块预览」是两回事。
 * @param options     revision（触发重测）与 onExpand（展开回调）
 */
export function usePreviewLimit(
  totalLines: number,
  forceExpand = false,
  options: PreviewLimitOptions = {},
): PreviewLimit {
  const { revision, onExpand, contentHeight = PREVIEW_CONTENT_HEIGHT } = options;
  // 用 ref 持有回调，避免其身份变化导致 expand 每次重建、进而让依赖它的
  // handleBoxClick 变化，最终触发不必要的重渲染。
  const onExpandRef = useRef(onExpand);
  onExpandRef.current = onExpand;

  const [showAll, setShowAll] = useState(false);
  // 用户在授权阶段点过"显示全部"后，即使确认完成也应保持展开
  const expanded = showAll || forceExpand;

  const contentRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(() => ({
    lines: Math.min(totalLines, PREVIEW_LINES),
    height: contentHeight,
    // 初始按"逻辑行超过上限"判断，测量后再用真实高度修正
    overflow: totalLines > PREVIEW_LINES,
  }));

  // 逐行累加真实高度，找出能完整放进内容区的行数。
  // 只读前 PREVIEW_LINES 个孩子：更靠后的行无论如何都放不下，避免长内容
  // 展开时对成千上万个节点逐个 getBoundingClientRect。
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const measure = () => {
      const children = el.children;
      const limit = Math.min(children.length, PREVIEW_LINES);
      let used = 0;
      let lines = 0;
      let overflow = false;

      // 快速路径：已渲染的行整体都没超过内容区高度（scrollHeight 只读一次，
      // 不触发逐行 getBoundingClientRect）。绝大多数短预览都走这条分支。
      if (el.scrollHeight <= contentHeight + 0.5) {
        lines = limit;
        used = el.scrollHeight;
      } else {
        // 慢路径：存在折行导致内容超高，逐行累加找出能完整放下的整行数。
        for (let i = 0; i < limit; i++) {
          const h = (children[i] as HTMLElement).getBoundingClientRect().height;
          if (used + h > contentHeight + 0.5) {
            // 这一行放不下 → 后面连续的行同样不能显示（不能跳过中间行）
            overflow = true;
            break;
          }
          used += h;
          lines += 1;
        }
        // 极端情况：单行折行后本身已超过内容区高度，也至少保留一行，
        // 否则预览框会塌成 0 高度。
        if (lines === 0 && children.length > 0) {
          overflow = true;
          lines = 1;
          used = Math.min(
            (children[0] as HTMLElement).getBoundingClientRect().height,
            contentHeight,
          );
        }
      }

      setFit((prev) =>
        prev.lines === lines && Math.abs(prev.height - used) < 0.5 && prev.overflow === overflow
          ? prev
          : { lines, height: used, overflow },
      );
    };

    measure();
    // webview / 侧边栏宽度变化会让同一逻辑行的折行数改变，需要重新测量。
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [totalLines, expanded, revision, contentHeight]);

  // 是否还有内容没显示：
  //   - 逻辑行数超过上限（无论怎么折行都不可能全放下）；
  //   - 或前 PREVIEW_LINES 行按真实高度已经放不下。
  const hasMore = fit.overflow || totalLines > PREVIEW_LINES;
  const truncated = !expanded && hasMore;
  const visibleLines = expanded ? totalLines : Math.min(totalLines, PREVIEW_LINES);

  const expand = useCallback(() => {
    setShowAll(true);
    onExpandRef.current?.();
  }, []);

  // 点击预览框渲染全部内容。两种情况不触发展开：
  //   - 用户正在拖选文本（getSelection 非空）；
  //   - 点击目标是框内的按钮/链接，应保留其自身行为。
  const handleBoxClick = useCallback(
    (e: React.MouseEvent) => {
      if (!truncated) return;
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('button, a')) return;
      expand();
    },
    [truncated, expand],
  );

  return {
    contentRef,
    visibleLines,
    fittedLines: fit.lines,
    fittedHeight: fit.height,
    expanded,
    truncated,
    hasMore,
    expand,
    handleBoxClick,
  };
}

/**
 * 预览底部的状态条（位于滚动框下方）。
 *
 * 展开后**保留**这条提示（只把文案换成行数说明），原因是：
 * 它与预览框共同构成一个面板。提示条若在展开时消失，面板会净变矮，
 * 产生明显的布局跳动。保留后展开前后的提示条高度一致。
 *
 * 说明：本 bundle 中带 onClick 的元素会各自注册一个原生 click 监听器
 * （与 Bash 输出 div、summary 的既有行为一致），因此展开态不再挂 onClick。
 *
 * 变体：
 * - 默认（Edit / Write）：与上方预览框拼成一个带边框的面板，提示条自绘
 *   「左 / 右 / 下」三边边框并倒圆下角，chevron 朝下（更多内容在下方）。
 * - tail（Bash）：缩略态显示的是**末尾**行而非开头行（与流式期间「最新输出
 *   在底部」的阅读位置一致），提示条放在输出框**上方**、chevron 朝上——
 *   更多内容在上方，点击向上展开（提示条让出的高度由输出框接管，卡片总高不变）。
 *   外框与默认变体镜像：自绘「左 / 右 / 上 / 下」四边边框并倒圆上角，下边那一条
 *   即与输出框之间的分割线（默认变体的分割线来自上方预览框的下边框）。
 */

/**
 * tail 变体提示条的固定高度（px，含上下各 1px 边框）。
 *
 * 展开时提示条不再渲染、其高度让给输出框（`Bash.tsx` 用
 * `OUTPUT_BOX_HEIGHT + TAIL_HINT_HEIGHT` 撑开），因此这个高度必须与提示条实际占位
 * 一致——固定高度 + `box-sizing: border-box` 让「总高度不变」不依赖逐帧实测。
 */
export const TAIL_HINT_HEIGHT = 22;

export const PreviewMoreHint: React.FC<{
  shown: number;
  total: number;
  expanded: boolean;
  colors: any;
  onClick?: () => void;
  tail?: boolean;
}> = ({ shown, total, expanded, colors, onClick, tail }) => (
  <div
    onClick={expanded ? undefined : onClick}
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      padding: '3px 8px',
      fontSize: 11,
      cursor: expanded ? 'default' : 'pointer',
      color: colors.textSystem,
      // 自绘外框按变体：默认变体只画「左 / 右 / 下」三边（上边由预览框的下边框
      // 充当分割线）；tail 变体是它的镜像，画满四边、倒圆上角，下边那一条即与
      // 输出框之间的分割线。
      ...(tail
        ? { border: '1px solid', borderColor: colors.textSystem, borderRadius: '4px 4px 0 0' }
        : { border: '1px solid', borderColor: colors.textSystem, borderTop: 'none', borderRadius: '0 0 4px 4px' }),
      // tail（Bash）：固定高度让「展开让位」精确；上下边框占掉 2px，纵向内边距
      // 交给 flex 居中（写死 padding 会让文字被边框压住）。
      ...(tail
        ? {
            height: TAIL_HINT_HEIGHT,
            boxSizing: 'border-box' as const,
            padding: '0 8px',
          }
        : {}),
      userSelect: 'none',
    }}
  >
    {/* chevron 方向随变体：默认提示「更多在下方」（朝下）；tail 提示条在
        输出框上方、向上展开（朝上）。写成两个字面量以便 gen-icons 扫描。 */}
    {!expanded && (tail
      ? <Icon name="chevron-up" size={12} />
      : <Icon name="chevron-down" size={12} />)}
    <span>
      {expanded
        ? t('tool.preview.allLinesShown', { total })
        : t(tail ? 'tool.preview.showTailLines' : 'tool.preview.showAllLines', { shown, total })}
    </span>
  </div>
);
