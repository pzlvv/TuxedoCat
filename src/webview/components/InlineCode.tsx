import React, { useRef, useState, useLayoutEffect, memo } from 'react';
import type { Colors } from '../types';

interface InlineCodeProps {
  children: React.ReactNode;
  colors: Colors;
}

/**
 * 行内代码（单个反引号包裹）。
 *
 * 单行显示时保留 padding 和圆角（视觉更美观）；
 * 当内容超长导致浏览器自动换行（多行显示）时，去掉 padding 和圆角，
 * 避免每行首尾出现错位的 pad 和突兀的圆角。
 *
 * 原理：CSS 无法判断元素是否跨行，因此在渲染后测量元素实际高度，
 * 若超过单行行高则判定为多行，动态切换样式。
 */
const InlineCode = memo(function InlineCode({ children, colors }: InlineCodeProps) {
  const ref = useRef<HTMLElement | null>(null);
  const [multiline, setMultiline] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 先以无 padding 状态测量，避免 padding 本身导致换行影响判断
    const prevPadding = el.style.padding;
    const prevRadius = el.style.borderRadius;
    el.style.padding = '0';
    el.style.borderRadius = '0';
    const height = el.offsetHeight;
    el.style.padding = prevPadding;
    el.style.borderRadius = prevRadius;
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight || '16');
    setMultiline(height > lineHeight * 1.5);
  }, [children]);

  return (
    <code
      ref={ref}
      className="text-[12px]"
      style={{
        backgroundColor: colors.bgSecondary,
        color: colors.textPrimary,
        ...(multiline
          ? { padding: 0, borderRadius: 0 }
          : { padding: '1px 4px', borderRadius: '3px' }),
      }}
    >
      {children}
    </code>
  );
});

export default InlineCode;
