import type { CSSProperties } from 'react';
import type { ThemeConfig } from 'antd';
import type { Colors } from '../types';

/**
 * 输入区两处 antd 下拉菜单（主配置菜单 / 发送模式菜单）共用的主题 token。
 *
 * 两处菜单必须同源，否则会出现「发送模式下拉永远是 antd 默认浅色」的风格分裂；
 * 弹层背景 / 文字取主题色板，悬停 / 选中底色与禁用文字按 light / dark 分档。
 * 主配置菜单在此之上叠加 `.agent-mode-menu` 的 CSS 覆盖
 * （`src/webview/styles/index.css`，服务其自绘的复杂菜单项）；发送模式菜单
 * 是纯文本项，只吃这里的 token——CSS 那套禁用项重置（去内边距、恢复不透明）
 * 对它是误伤，不能挂该类。
 */
export function dropdownMenuTheme(colors: Colors, isDark: boolean, fontSize: number): ThemeConfig {
  return {
    components: {
      Dropdown: {
        colorBgElevated: colors.primaryFrame,
        colorText: colors.textSystem,
        colorTextDisabled: isDark ? 'rgba(255, 255, 255, 0.35)' : 'rgba(0, 0, 0, 0.35)',
        controlItemBgHover: isDark ? 'rgba(99, 102, 241, 0.12)' : 'rgba(99, 102, 241, 0.06)',
        controlItemBgActive: isDark ? 'rgba(99, 102, 241, 0.2)' : 'rgba(99, 102, 241, 0.12)',
        fontSize,
      },
    },
  };
}

/** 菜单弹层外壳：主题边框 + 圆角裁切，两处菜单共用同一形态 */
export function menuPanelShellStyle(colors: Colors): CSSProperties {
  return {
    border: `1px solid var(--border-color, ${colors.border})`,
    borderRadius: '6px',
    overflow: 'hidden',
  };
}
