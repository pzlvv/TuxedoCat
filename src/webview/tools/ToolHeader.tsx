import React from 'react';
import { ToolCallProps } from './Types';
import { toolStyles } from './styles';
import * as lucideIcons from 'lucide-react';

export interface ToolHeaderProps {
  icon: keyof typeof lucideIcons;
  name: string;
  colors: ToolCallProps['colors'];
  children?: React.ReactNode;
  /** 右侧额外图标（如回滚按钮），在行末右对齐 */
  rightExtra?: React.ReactNode;
}

export const ToolHeader: React.FC<ToolHeaderProps> = ({ icon, name, colors, children, rightExtra }) => {
  // 支持两种写法：
  // - 字符串键：icon="Zap"（大多数工具）
  // - 组件引用：icon={Zap}（少数工具如 Skill / AskUserQuestion）
  // lucideIcons[icon] 只接受字符串键，组件引用直接使用，否则图标不会渲染。
  const IconComponent = (typeof icon === 'string' ? lucideIcons[icon] : icon) as
    | React.ComponentType<{ size?: number; style?: React.CSSProperties }>
    | undefined;

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
      {/* 图标 */}
      {IconComponent && <IconComponent size={12} style={{ color: colors.textSystem, flexShrink: 0 }} />}
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
