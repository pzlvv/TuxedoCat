import React from 'react';
import type { Colors } from '../types';

/**
 * 泛型分段选择控件：AskMode / Thinking / PromptMode 三个分段选择器的容器样式、
 * 渲染循环与按钮样式完全相同，统一收敛到这里。
 *
 * - segments：选项列表（key / label，可选 title）；
 * - 选中项使用 harness 背景白字加粗，未选中项透明背景次级文字色。
 */
export function SegmentControl<T extends string>({
  value,
  onChange,
  segments,
  colors,
}: {
  value: T;
  onChange: (value: T) => void;
  segments: Array<{ key: T; label: string; title?: string }>;
  colors: Colors;
}): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        borderRadius: '6px',
        border: `1px solid ${colors.border}`,
        overflow: 'hidden',
        width: '100%',
      }}
    >
      {segments.map((seg, idx) => {
        const isSelected = value === seg.key;
        return (
          <button
            key={seg.key}
            title={seg.title}
            onClick={(e) => { e.stopPropagation(); onChange(seg.key); }}
            style={{
              flex: 1,
              fontSize: '11px',
              padding: '3px 6px',
              border: 'none',
              borderLeft: idx > 0 ? `1px solid ${colors.border}` : 'none',
              backgroundColor: isSelected ? colors.harness : 'transparent',
              color: isSelected ? '#fff' : colors.textSystem,
              cursor: 'pointer',
              transition: 'all 0.15s',
              fontWeight: isSelected ? 600 : 400,
              whiteSpace: 'nowrap',
            }}
          >
            {seg.label}
          </button>
        );
      })}
    </div>
  );
}

/** 菜单里的 checkbox 小方块（勾选时渲染白色对勾 SVG），webSearchItem 与 MCP 列表共用 */
export function CheckboxGlyph({ checked, colors }: { checked: boolean; colors: Colors }): React.JSX.Element {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 12,
        height: 12,
        borderRadius: 3,
        border: `1px solid ${checked ? colors.harness : colors.border}`,
        backgroundColor: checked ? colors.harness : 'transparent',
        verticalAlign: '-2px',
        transition: 'all 0.15s',
      }}
    >
      {checked && (
        <svg width="10" height="10" viewBox="0 0 12 12" style={{ display: 'block', margin: '0 auto' }}>
          <path d="M2 6l3 3l5-6" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}
