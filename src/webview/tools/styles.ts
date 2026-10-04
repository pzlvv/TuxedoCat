/**
 * 工具 UI 公共样式配置
 */

import { uiFontSizePx } from '../fontSize';

export const toolStyles = {
  /**
   * 工具名样式
   */
  toolName: {
    fontWeight: 700,
    fontSize: uiFontSizePx(12.5),
  } as const,

  /**
   * 工具描述文本样式
   */
  toolDescription: {
    fontSize: uiFontSizePx(12.5),
  } as const,
};
