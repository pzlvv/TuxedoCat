import React, { useState } from 'react';
import type { Colors } from './types';
import { getPlaceholderLogoUri, rotatePlaceholderLogo } from './placeholderLogo';
import { t } from './i18n';

interface ConversationLoadingProps {
  colors: Colors;
  isDark: boolean;
}

/**
 * 切换对话时显示的 Loading 动画（Electron App / VS Code 插件通用）。
 *
 * 场景：侧栏点击对话 → webview 上报 loadConversation →
 * 主进程返回 conversationLoaded。在 conversationLoaded 到达（消息渲染完成）前，
 * 消息区为空，此时显示本组件代替默认的静态 Logo；
 * 加载完成后由 MessagesView 以遮罩形式保留并淡出，避免新内容首帧布局跳动暴露给用户。
 *
 * Logo 与空状态背景图共用 placeholderLogo 的洗牌袋：每次出现 loading 动画都轮换
 * 一张（一轮覆盖全部、相邻不重复），因此 loading 期间与随后露出的背景图是同一张，
 * 且不会连续两次相同。
 */
export const ConversationLoading: React.FC<ConversationLoadingProps> = ({ colors, isDark }) => {
  const accent = isDark ? 'rgba(167, 139, 250, 0.9)' : 'rgba(99, 102, 241, 0.8)';
  // 每个挂载周期只轮换一次：用惰性初始化避免重渲染反复换图。
  const [logoSrc] = useState(() => {
    rotatePlaceholderLogo();
    return getPlaceholderLogoUri();
  });
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 select-none">
      {/* Logo + 扩散波纹 */}
      <div className="conversation-loading-ripple">
        <div className="conversation-loading-ring" style={{ borderColor: accent }} />
        <div className="conversation-loading-ring" style={{ borderColor: accent }} />
        <img
          src={logoSrc}
          alt="logo"
          className="conversation-loading-logo"
          style={{ opacity: isDark ? 0.9 : 0.8 }}
        />
      </div>

      {/* 弹跳圆点 */}
      <div className="flex items-center gap-1.5">
        <span className="conversation-loading-dot" style={{ backgroundColor: colors.harness }} />
        <span className="conversation-loading-dot" style={{ backgroundColor: colors.harness }} />
        <span className="conversation-loading-dot" style={{ backgroundColor: colors.harness }} />
      </div>

      <div className="ui-fs-13" style={{ color: colors.textSystem }}>
        {t('app.loadingConversation')}
      </div>
    </div>
  );
};
