import React from 'react';

/**
 * 空态背景图与加载动画里的装饰性 logo。
 *
 * 用 CSS 背景而不是 `<img>`：装饰图不参与任何交互，而 `<img>` 在浏览器里是天然的
 * 拖拽源——原生图片拖拽只受 `draggable` 属性与 `-webkit-user-drag` 管辖，任何一层
 * 没生效就会拖出系统拖影（图片本身不动，只有一个半透明副本跟着光标）。背景图不是
 * 内容节点：命中测试、框选、原生拖拽都落不到它上面，这是「完全不可操作」的结构性
 * 保证，不依赖任何属性或 CSS 支持（见 `src/webview/styles/index.css` 的
 * `.placeholder-logo`）。
 *
 * 装饰图统一为 1024×1024 正方形（logo1.png … logo8.png），因此按正方形布局。
 */
export type DecorativeLogoVariant = 'empty' | 'loading';

interface DecorativeLogoProps {
  src: string;
  /** `empty`：空态背景图（360px）；`loading`：切换对话的加载动画（56px）。 */
  variant: DecorativeLogoVariant;
  opacity: number;
}

export const DecorativeLogo: React.FC<DecorativeLogoProps> = ({ src, variant, opacity }) => (
  <div
    role="img"
    aria-label="logo"
    className={`placeholder-logo placeholder-logo--${variant}`}
    style={{ backgroundImage: `url("${src}")`, opacity }}
  />
);
