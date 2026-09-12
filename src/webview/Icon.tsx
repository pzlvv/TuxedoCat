import React from 'react';
import type { IconName } from './icons.generated';

/**
 * 轻量图标组件：1 个 <span> 节点 + CSS mask 绘制。
 *
 * 取代 lucide-react 的 <svg> + N 个 <path>/<rect>/<circle>（2~6 个节点/图标）。
 * 形状定义在 styles/icons.css（由 scripts/gen-icons.mjs 从 lucide 生成），
 * 因此这里不需要引入任何图标库，bundle 里也不再包含 lucide 的图标数据。
 *
 * 颜色：.ti 用 background-color: currentColor，所以 <Icon style={{color}}/>、
 * className="text-white" 等既有写法语义完全不变。
 *
 * 尺寸：默认 14，与 lucide 默认的 24 不同 —— 调用点原本都显式传了 size，
 * 这里给一个更贴近实际用量的兜底值。
 */
export interface IconProps {
  name: IconName;
  /** 边长（px），默认 14 */
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

export const Icon: React.FC<IconProps> = ({ name, size = 14, className, style }) => (
  <span
    aria-hidden="true"
    className={className ? `ti ti-${name} ${className}` : `ti ti-${name}`}
    style={{ width: size, height: size, ...style }}
  />
);

export type { IconName };
