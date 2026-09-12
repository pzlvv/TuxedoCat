import React from 'react';
import { ToolCallProps } from './Types';
import { toolStyles } from './styles';
import { Icon } from '../Icon';
import { ICON_ALIAS, ICON_NAMES, type IconName } from '../icons.generated';

export interface ToolHeaderProps {
  /** lucide 图标名（PascalCase），如 'Terminal' / 'FileText'；或直接给 kebab-case 名 */
  icon: string;
  name: string;
  colors: ToolCallProps['colors'];
  children?: React.ReactNode;
  /** 右侧额外图标（如回滚按钮），在行末右对齐 */
  rightExtra?: React.ReactNode;
}

/** 把调用点沿用的 lucide 名字（PascalCase）解析成 CSS mask 图标名（kebab-case） */
const resolveIcon = (icon: string): IconName | undefined => {
  const kebab = icon in ICON_ALIAS ? ICON_ALIAS[icon] : icon.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  // 未登记的图标名返回 undefined（不渲染），避免出现「有节点但无形状」的空 span
  return (ICON_NAMES as readonly string[]).includes(kebab) ? (kebab as IconName) : undefined;
};

export const ToolHeader: React.FC<ToolHeaderProps> = ({ icon, name, colors, children, rightExtra }) => {
  const iconName = resolveIcon(icon);

  return (
    <div
      className="flex items-center rounded w-full"
      style={{
        color: colors.textSystem,
        ...toolStyles.toolDescription,
        minHeight: '32px',
        marginTop: '-3.5px',
      }}
    >
      {/* 图标：1 个 span + CSS mask（原先每个图标是 svg + N 个 path） */}
      {iconName && <Icon name={iconName} size={12} style={{ color: colors.textSystem, flexShrink: 0 }} />}
      {/* 工具名：保证完整一行，不换行 */}
      <span
        style={{
          ...toolStyles.toolName,
          color: colors.toolName,
          marginLeft: '8px',
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        {name}
      </span>
      {/* 参数描述：空间不足时渐隐显示 */}
      <span
        className="overflow-hidden"
        style={{
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
          marginLeft: '8px',
          flex: 1,
        }}
      >
        {children}
      </span>
      {/* 右侧操作区域：右对齐 */}
      {rightExtra && (
        <span
          style={{
            marginLeft: 'auto',
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            paddingLeft: '8px',
          }}
        >
          {rightExtra}
        </span>
      )}
    </div>
  );
};
