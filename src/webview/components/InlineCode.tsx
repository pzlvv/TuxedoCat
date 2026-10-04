import React, { useRef, useState, useLayoutEffect, memo } from 'react';
import type { Colors } from '../types';
import { AnsiText, hasAnsi } from '../ansi';

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
    // 判断是否折行：行内元素换行后会产生多个行盒，getClientRects() 每个行片段
    // 返回一个矩形，因此长度 > 1 即表示已经换行。
    //
    // 原实现是「写 style(padding=0) → 读 offsetHeight → 还原 style」：每次写样式都会
    // 把布局标脏，紧接着的读又强制整棵树同步重排。一个会话里有 300+ 个行内代码，
    // 实测 312 次 / 20ms；更严重的是这些写操作插在其它组件读取 scrollHeight 的中间，
    // 让后续每一次读取都变成一次完整的强制重排（放大到 190ms 量级）。
    // 这里全程只读不写，连续读取时布局保持干净，整批只触发一次重排。
    setMultiline(el.getClientRects().length > 1);
  }, [children]);

  return (
    <code
      ref={ref}
      className="ui-fs-12"
      style={{
        backgroundColor: colors.bgSecondary,
        color: colors.textPrimary,
        ...(multiline
          ? { padding: 0, borderRadius: 0 }
          : { padding: '1px 4px', borderRadius: '3px' }),
      }}
    >
      {typeof children === 'string' && hasAnsi(children) ? <AnsiText text={children} /> : children}
    </code>
  );
});

export default InlineCode;
