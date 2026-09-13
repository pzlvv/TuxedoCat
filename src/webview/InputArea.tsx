import React, { useState, useCallback, memo, forwardRef, useImperativeHandle, useRef, useMemo, useEffect, useLayoutEffect } from 'react';
import { Icon } from './Icon';
import TextareaAutosize from 'react-textarea-autosize';
import { ConfigProvider, Dropdown } from 'antd';
import type { Colors, QueuedMessagePayload, ThinkingMode, PromptMode, AgentMode } from './types';
import type { McpServerInfo } from '../core/webviewTypes';
import { postMessage, getWindowSessionId } from './webviewEnv';
import { SegmentControl, CheckboxGlyph } from './components/SegmentControl';
import { t } from './i18n';

export interface PastedImage {
  dataUrl: string;
  mediaType?: string;
  /** 图片实际像素宽度（用于图片消息标题） */
  width?: number;
  /** 图片实际像素高度（用于图片消息标题） */
  height?: number;
}

export interface InputAreaRef {
  getValue: () => string;
  setValue: (value: string) => void;
  clear: () => void;
  getPastedImages: () => PastedImage[];
  setPastedImages: (images: PastedImage[]) => void;
}

export interface SkillItem {
  name: string;
  description: string;
  isBuiltin?: boolean;
}

interface InputAreaProps {
  inputFocused: boolean;
  setInputFocused: (focused: boolean) => void;
  currentFile: string;
  selectedLines: { start: number; end: number } | null;
  fileHidden: boolean;
  onToggleFileHidden: () => void;
  totalContextTokens: number;
  maxContextTokens?: number | null;
  hasActiveQuery: boolean;
  agentMode: AgentMode;
  /** 是否已收到当前会话/默认的 agentMode；false 时仅显示 loading，不显示具体选项 */
  agentModeReady: boolean;
  setAgentMode: (mode: AgentMode) => void;
  /** 会话关联的提示词模式（普通/极简/混合，持久化到 meta.json） */
  promptMode: PromptMode;
  setPromptMode: (mode: PromptMode) => void;
  thinkingMode: ThinkingMode;
  setThinkingMode: (mode: ThinkingMode) => void;
  /** 会话关联的 Web Search 开关 */
  webSearch: boolean;
  setWebSearch: (webSearch: boolean) => void;
  model: string;
  setModel: (model: string) => void;
  models: string[];
  onSend: () => void;
  onAbort: () => void;
  onCompress: () => void;
  mainInputRef: React.RefObject<HTMLTextAreaElement | null>;
  colors: Colors;
  isDark: boolean;
  queuedMessage: QueuedMessagePayload | null;
  skills: SkillItem[];
  commandHistory: string[];
  /** 账户余额 */
  balance?: number;
  /** 余额货币类型 */
  balanceCurrency?: string;
  /** 是否无限额度 */
  isUnlimited?: boolean;
  /** 累计缓存读取 token 数 */
  totalCacheReadInputTokens?: number;
  /** 累计缓存创建 token 数 */
  totalCacheCreationInputTokens?: number;
  /** 累计原始 input_tokens（不含缓存部分，用于计算命中率） */
  totalInputTokens?: number;
  /** 打开设置（LLM 配置）页面 */
  onOpenSettings?: () => void;
  /** 服务商配置是否已完成；未完成时禁用输入框并引导点击打开设置 */
  isProviderConfigured: boolean | null;
  /** 当前对话是否为 sub-agent（子代理） */
  isSubAgent?: boolean;
  /** MCP 服务器列表（含启用状态），在菜单「模型」上方以 checkbox 形式列出 */
  mcpServers?: McpServerInfo[];
  /** 勾选/取消某个 MCP */
  onMcpToggle?: (name: string, enabled: boolean) => void;
  /** 当前会话是否有 MCP 正在连接中；为 true 时禁用发送按钮 */
  mcpConnecting?: boolean;
}

/**
 * 进度条颜色渐变锚点（按百分比）：
 * 0~30% 绿 → 50% 黄 → 70% 橙 → 100% 红
 */
const CONTEXT_GRADIENT_STOPS: Array<{ at: number; rgb: [number, number, number] }> = [
  { at: 0, rgb: [34, 197, 94] },    // #22c55e 绿
  { at: 0.3, rgb: [34, 197, 94] },  // 30% 之前保持绿
  { at: 0.5, rgb: [234, 179, 8] },  // #eab308 黄
  { at: 0.7, rgb: [249, 115, 22] }, // #f97316 橙
  { at: 1, rgb: [239, 68, 68] },    // #ef4444 红
];

/** 按百分比（0~1）在 绿→黄→橙→红 之间线性插值 */
function contextGradientColor(ratio: number): string {
  const r = Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0), 1) : 0;
  for (let i = 0; i < CONTEXT_GRADIENT_STOPS.length - 1; i++) {
    const a = CONTEXT_GRADIENT_STOPS[i];
    const b = CONTEXT_GRADIENT_STOPS[i + 1];
    if (r <= b.at) {
      const t = b.at === a.at ? 0 : (r - a.at) / (b.at - a.at);
      const ch = (idx: number) => Math.round(a.rgb[idx] + (b.rgb[idx] - a.rgb[idx]) * t);
      return `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`;
    }
  }
  const last = CONTEXT_GRADIENT_STOPS[CONTEXT_GRADIENT_STOPS.length - 1];
  return `rgb(${last.rgb[0]}, ${last.rgb[1]}, ${last.rgb[2]})`;
}

const ContextProgressBar = React.memo(({ totalContextTokens, maxContextTokens, onClick, colors }: { totalContextTokens: number; maxContextTokens?: number | null; onClick?: () => void; colors: Colors }) => {
  if (maxContextTokens == null) {
    return null;
  }
  // 进度条填充与文字分母都以完整 context window 为基准，
  // 颜色按百分比从绿→黄→橙→红渐变（约 95% 的压缩点接近红色）。
  const ratio = maxContextTokens > 0 ? totalContextTokens / maxContextTokens : 0;
  const pct = Math.min(ratio * 100, 100);
  const barColor = contextGradientColor(ratio);
  const contextK = Math.floor(maxContextTokens / 1024);
  const displayText = `${Math.floor(totalContextTokens / 1024)}/${contextK}`;

  return (
    <span
      className="flex flex-col gap-0 text-[11px] whitespace-nowrap"
      // 宽度取「文本宽度」与「进度条宽度」的较大值（max-content），
      // 这样上方文本过长时不会越过右侧的分割线和命中率信息；
      // 分割线、命中率信息的位置都同时受文本与进度条两者约束。
      style={{ color: colors.textSystem, width: 'max-content', minWidth: '48px', flexShrink: 0 }}
      title={t('inputArea.clickToCompact')}
    >
      <button
        onClick={onClick}
        className="text-left hover:underline"
        style={{ color: colors.textSystem, lineHeight: '1.2', letterSpacing: '-0.3px' }}
      >
        {displayText} <span style={{ opacity: 0.6 }}>(K)</span>
      </button>
      <span
        className="rounded-sm"
        style={{
          display: 'inline-block',
          width: '48px',
          height: '4px',
          backgroundColor: colors.harness + '80',
          borderRadius: '2px',
          overflow: 'hidden',
          flexShrink: 0,
          marginTop: '3px',
        }}
      >
        <span
          style={{
            display: 'block',
            width: `${pct}%`,
            height: '100%',
            backgroundColor: barColor,
            borderRadius: '2px',
            transition: 'width 0.3s ease, background-color 0.3s ease',
          }}
        />
      </span>
    </span>
  );
});

const AskModeSegmentControl = ({
  value,
  onChange,
  colors,
}: {
  value: AgentMode;
  onChange: (mode: AgentMode) => void;
  colors: Colors;
}) => (
  <SegmentControl
    value={value}
    onChange={onChange}
    colors={colors}
    segments={[
      { key: 'manual', label: t('inputArea.askModeAlways'), title: t('inputArea.askModeAlwaysTitle') },
      { key: 'risk', label: t('inputArea.askModeCritical'), title: t('inputArea.askModeCriticalTitle') },
      { key: 'auto', label: t('inputArea.askModeNever'), title: t('inputArea.askModeNeverTitle') },
    ]}
  />
);

const ThinkingSegmentControl = ({
  value,
  onChange,
  colors,
}: {
  value: ThinkingMode;
  onChange: (mode: ThinkingMode) => void;
  colors: Colors;
}) => (
  <SegmentControl
    value={value}
    onChange={onChange}
    colors={colors}
    segments={[
      { key: 'off', label: t('inputArea.thinkingOff') },
      { key: 'low', label: t('inputArea.thinkingLow') },
      { key: 'high', label: t('inputArea.thinkingHigh') },
      { key: 'max', label: t('inputArea.thinkingMax') },
    ]}
  />
);

const PromptModeSegmentControl = ({
  value,
  onChange,
  colors,
}: {
  value: PromptMode;
  onChange: (mode: PromptMode) => void;
  colors: Colors;
}) => (
  <SegmentControl
    value={value}
    onChange={onChange}
    colors={colors}
    segments={[
      { key: 'normal', label: t('inputArea.promptModeNormal'), title: t('inputArea.promptModeNormalTitle') },
      { key: 'minimal', label: t('inputArea.promptModeMinimal'), title: t('inputArea.promptModeMinimalTitle') },
      { key: 'mixed', label: t('inputArea.promptModeMixed'), title: t('inputArea.promptModeMixedTitle') },
    ]}
  />
);

/**
 * 隐藏测量层的样式：移出视口 + visibility:hidden，既不可见也不参与布局，
 * 但仍会被浏览器正常排版，因此可以量到真实像素宽度。
 */
const HIDDEN_MEASURE_STYLE: React.CSSProperties = {
  position: 'fixed',
  left: -99999,
  top: 0,
  width: 'max-content',
  visibility: 'hidden',
  pointerEvents: 'none',
  whiteSpace: 'nowrap',
};

/** 循环滚动时首尾两份文本之间的间隔（px） */
const MARQUEE_GAP_PX = 28;

/**
 * 固定宽度的「当前模型」文本：prefix 固定不滚动，模型名可悬停滚动。
 *
 * - prefix（如 "当前: "）位置固定，不参与滚动；
 * - 模型名默认用省略号截断；
 * - 仅当模型名超出冻结宽度时，鼠标悬停才单向循环滚动，移开即恢复截断。
 *
 * 菜单宽度在打开瞬间按当前模型冻结（见 ToggleMenu 的测量逻辑），
 * 展开期间选中更长的模型时这里会溢出，靠悬停滚动查看全名，菜单宽度保持不变；
 * 下次重新打开菜单会按新的当前模型重新冻结宽度，此时不再溢出、也就不需要滚动。
 */
const HoverScrollText = memo(({
  prefix,
  text,
  width,
  style,
}: {
  prefix: string;
  text: string;
  width?: number | null;
  style?: React.CSSProperties;
}) => {
  const ellipsisRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);
  const [contentWidth, setContentWidth] = useState(0);

  // 省略号截断时 scrollWidth 仍是完整文本宽度，用它判断是否被截断
  useLayoutEffect(() => {
    const el = ellipsisRef.current;
    if (!el) return;
    const full = el.scrollWidth;
    const visible = el.clientWidth;
    setContentWidth(full);
    setOverflow(full > visible + 1 ? full - visible : 0);
  }, [text, width, prefix]);

  // 单向循环滚动：内部放两份文本（各带一份间隔），滚动「一份文本 + 间隔」后无缝衔接。
  // 速度约 30px/s，短名字给一个最短时长，避免滚动过快。
  const duration = overflow > 0 ? Math.max(1.5, (contentWidth + MARQUEE_GAP_PX) / 30) : 0;

  return (
    <span
      // is-overflowing：只有真正被截断时才允许悬停隐藏截断文本，
      // 否则名字能完整显示时悬停会变成空白
      className={`hover-scroll-text${overflow > 0 ? ' is-overflowing' : ''}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        width: width ?? undefined,
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {/* 固定不滚动的前缀；whiteSpace:pre 保留文案自带的尾随空格，避免与模型名粘连 */}
      <span style={{ flexShrink: 0, whiteSpace: 'pre' }}>{prefix}</span>
      <span
        style={{
          position: 'relative',
          flex: '1 1 0',
          minWidth: 0,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
        }}
      >
        {/* 默认：省略号截断 */}
        <span
          ref={ellipsisRef}
          className="hover-scroll-text__ellipsis"
          style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {text}
        </span>
        {/* 悬停：单向循环滚动（复制一份文本实现无缝衔接） */}
        {overflow > 0 && (
          <span
            className="hover-scroll-text__marquee"
            aria-hidden="true"
            style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}
          >
            <span
              className="hover-scroll-text__marquee-inner"
              style={{ animation: `tuxedo-marquee-loop ${duration}s linear infinite` }}
            >
              {/* 两份文本各带右侧间隔（padding 计入盒子宽度，保证 -50% 的位移精确）：
                  位移 -50%（一份文本 + 间隔）后无缝衔接，首尾之间始终留出间隔，不会粘连 */}
              <span className="hover-scroll-text__copy" style={{ paddingRight: MARQUEE_GAP_PX }}>{text}</span>
              <span className="hover-scroll-text__copy" aria-hidden="true" style={{ paddingRight: MARQUEE_GAP_PX }}>{text}</span>
            </span>
          </span>
        )}
      </span>
    </span>
  );
});

const ToggleMenu = memo(({
  agentModeReady,
  agentMode,
  onAgentModeChange,
  model,
  onModelChange,
  models,
  promptMode,
  onPromptModeChange,
  thinkingMode,
  onThinkingModeChange,
  webSearch,
  onWebSearchChange,
  onOpenSettings,
  mcpServers,
  onMcpToggle,
  colors,
  isDark,
}: {
  agentModeReady: boolean;
  agentMode: AgentMode;
  onAgentModeChange: (mode: AgentMode) => void;
  model: string;
  onModelChange: (model: string) => void;
  models: string[];
  promptMode: PromptMode;
  onPromptModeChange: (mode: PromptMode) => void;
  thinkingMode: ThinkingMode;
  onThinkingModeChange: (mode: ThinkingMode) => void;
  webSearch: boolean;
  onWebSearchChange: (webSearch: boolean) => void;
  onOpenSettings: () => void;
  mcpServers?: McpServerInfo[];
  onMcpToggle?: (name: string, enabled: boolean) => void;
  colors: Colors;
  isDark: boolean;
}) => {
  // Dropdown / 二级菜单的展开状态改为受控：Ant 在 submenu 子项被点击后会自动收起弹层，
  // 受控后才能把「勾选 MCP」这一次收起请求忽略掉（见 suppressCloseUntilRef）。
  const [menuOpen, setMenuOpen] = useState(false);
  const [submenuOpenKeys, setSubmenuOpenKeys] = useState<string[]>([]);
  /** 在该时间戳之前到达的「收起/关闭」请求会被忽略，用于让勾选 MCP 后菜单保持展开 */
  const suppressCloseUntilRef = useRef(0);

  /**
   * 关闭整个菜单：主菜单与二级菜单一起收起。
   *
   * rc-menu 的二级菜单弹层（MCP / 模型）是独立挂载的浮层，且移动端没有 mouseleave
   * 这类「移出即收起」的交互，只关主菜单容易留下悬空的子菜单浮层。
   * 因此所有关闭路径统一走这里。
   */
  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    setSubmenuOpenKeys([]);
  }, []);

  // 兜底：只要主菜单处于关闭状态，就确保二级菜单展开状态被清空。
  // 覆盖 onOpenChange 之外的关闭路径（点击外部、再次点按钮、程序化关闭等），
  // 避免子菜单浮层残留（移动端尤其明显）。
  useEffect(() => {
    if (menuOpen) return;
    // 只在确有展开项时更新，避免空数组触发无意义的重渲染
    setSubmenuOpenKeys((keys) => (keys.length > 0 ? [] : keys));
  }, [menuOpen]);

  // 宽度测量（两套，用隐藏层实测像素宽度，而不是按字符数估算 ——
  // 比例字体下字符数与实际宽度不成正比）：
  //
  // 1) 模型列表：按「最长模型名」（600 粗体，覆盖选中态）测量，让所有模型名都能
  //    完整显示（列表项不滚动、不截断），且切换选中项不会改变二级菜单宽度。
  // 2) 「当前模型」行：打开菜单时按当前模型实测一次并冻结，菜单宽度取决于当前模型
  //    而不是最长的模型名；展开期间切换模型不重测，超长名字默认省略号截断、
  //    鼠标悬停时单向循环滚动查看全名；下次重新打开菜单再按新的当前模型重测。
  const modelNameMeasureRef = useRef<HTMLDivElement>(null);
  const currentModelMeasureRef = useRef<HTMLSpanElement>(null);
  const [modelNameWidth, setModelNameWidth] = useState<number | null>(null);
  const [currentModelWidth, setCurrentModelWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const container = modelNameMeasureRef.current;
    if (!container) return;
    let max = 0;
    for (const child of Array.from(container.children)) {
      max = Math.max(max, (child as HTMLElement).getBoundingClientRect().width);
    }
    setModelNameWidth(max > 0 ? Math.ceil(max) : null);
  }, [models]);

  useLayoutEffect(() => {
    // 只在打开菜单的那一刻测量并冻结；open 变为 true 后切换模型不会触发重测
    if (!menuOpen) return;
    const el = currentModelMeasureRef.current;
    const w = el ? el.getBoundingClientRect().width : 0;
    setCurrentModelWidth(w > 0 ? Math.ceil(w) : null);
  }, [menuOpen]);

  // 构建菜单项（每项之间用分割线隔开）
  const makeDivider = (key: string) => ({
    key,
    label: (
      <div
        style={{
          height: '1px',
          backgroundColor: colors.border,
          opacity: 0.3,
          margin: '2px 12px',
        }}
      />
    ),
    disabled: true,
  });

  // 菜单最上面：设置按钮（点击进入 API Key 配置页）
  const settingsItem = {
    key: 'settings',
    label: (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          cursor: 'pointer',
        }}
      >
        <span style={{ width: '14px', flexShrink: 0 }} />
        <span style={{ color: colors.textPrimary, userSelect: 'none', fontSize: '12px', marginLeft: '12px' }}>
          {t('inputArea.settings')}
        </span>
      </div>
    ),
    onClick: () => {
      closeMenu();
      onOpenSettings();
    },
    disabled: false,
  };

  // 联网搜索开关（会话关联，位于 Spin 设计之后、模型上方；settings.json 中的 llm.webSearch 只是新对话默认值）
  // 极简模式不使用联网搜索：无论会话/设置中的开关如何，菜单项都置灰禁用。
  const webSearchDisabled = promptMode === 'minimal';
  const webSearchChecked = webSearch && !webSearchDisabled;
  const webSearchItem = {
    key: 'webSearch',
    label: (
      <div
        onClick={(e) => {
          // 阻止冒泡到 MenuItem，避免 Dropdown 因点击该项而关闭。
          e.stopPropagation();
          if (webSearchDisabled) return;
          onWebSearchChange(!webSearch);
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          cursor: webSearchDisabled ? 'default' : 'pointer',
          opacity: webSearchDisabled ? 0.45 : 1,
          padding: '5px 12px',
        }}
        title={webSearchDisabled ? t('inputArea.webSearchMinimalHint') : t('inputArea.webSearchHint')}
      >
        <span style={{ width: '14px', flexShrink: 0, textAlign: 'center' }}>
          <CheckboxGlyph checked={webSearchChecked} colors={colors} />
        </span>
        {/* 勾选只改变 checkbox 自身，文字颜色保持不变，避免整行变色 */}
        <span style={{ color: colors.textPrimary, userSelect: 'none', fontSize: '12px', marginLeft: '12px' }}>
          {t('inputArea.webSearch')}
        </span>
      </div>
    ),
    // 注意：这里禁用 MenuItem 的点击关闭行为，点击事件由 label 内部的 div 自行处理。
    disabled: true,
  };

  const loadingMenuItem = {
    key: 'menuLoading',
    disabled: true,
    label: (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px', color: colors.textSystem }}>
        <span
          className="animate-spin"
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            border: '2px solid transparent',
            borderTopColor: colors.harness,
            borderRightColor: colors.harness,
            display: 'inline-block',
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: '12px' }}>{t('inputArea.askModeLoading')}</span>
      </div>
    ),
  };

  // MCP 服务器子菜单：checkbox 形式列出 mcp.json 中声明的全部服务器。
  // 勾选状态写入 settings.json 的 mcp.enabled，未勾选即 disable（默认全部 disable）。
  //
  // Ant 的 submenu 在子项被点击后会收起弹层，导致勾选一个就要重新展开。
  // 这里把 Dropdown / Menu 的展开状态改为受控，并在勾选瞬间打一个 suppress 时间窗
  // （见 suppressCloseUntilRef），把紧随其后的「收起二级菜单 / 关闭 Dropdown」请求忽略掉。
  const mcpChildren = mcpServers && mcpServers.length > 0
    ? mcpServers.map((server) => {
        // 启用后的运行时状态：连接中 / 工具数 / 连接失败
        const statusText = !server.enabled
          ? ''
          : server.error
            ? t('inputArea.mcpError')
            : server.running
              ? t('inputArea.mcpToolCount', { count: String(server.toolCount ?? 0) })
              : t('inputArea.mcpConnecting');
        // 本地显示启动命令，远程显示端点地址，都没有时退回传输类型
        const target = server.command.length > 0
          ? server.command.join(' ')
          : (server.url || server.type);
        const tooltip = server.error
          ? `${server.name}: ${server.error}`
          : target;

        return {
          key: `mcp:${server.name}`,
          label: (
            <div
              onClick={(e) => {
                // 阻止冒泡到 MenuItem，避免菜单因点击该项而关闭（可连续勾选多个）
                e.stopPropagation();
                // 让紧随其后的「收起二级菜单 / 关闭 Dropdown」请求被忽略
                suppressCloseUntilRef.current = Date.now() + 300;
                onMcpToggle?.(server.name, !server.enabled);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                cursor: 'pointer',
                // 垂直内边距收紧，抵消第二行小字带来的高度；
                // 水平方向不加额外内边距，避免 checkbox 被推得过于靠右
                padding: '3px 0',
              }}
              title={tooltip}
            >
              <span style={{ width: '14px', flexShrink: 0, textAlign: 'center' }}>
                <CheckboxGlyph checked={server.enabled} colors={colors} />
              </span>
              {/* 名称 + 状态两行：状态字号更小，整体行高与其它菜单项保持一致 */}
              <span
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  marginLeft: '12px',
                  lineHeight: 1.15,
                  userSelect: 'none',
                  minWidth: 0,
                }}
              >
                <span
                  style={{
                    fontSize: '12px',
                    color: server.enabled ? colors.harness : colors.textPrimary,
                    maxWidth: '220px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {server.name}
                </span>
                {statusText && (
                  <span style={{ fontSize: '10px', color: server.error ? '#ef4444' : colors.textSystem }}>
                    {statusText}
                  </span>
                )}
              </span>
            </div>
          ),
          // 禁用 MenuItem 自身点击，交互完全交给 label 内部 div 处理
          disabled: true,
        };
      })
    : [{
        key: 'mcpEmpty',
        label: (
          <div style={{ padding: '3px 0', fontSize: '12px', color: colors.textSystem }}>
            {t('inputArea.mcpEmpty')}
          </div>
        ),
        disabled: true,
      }];

  const menuItems = agentModeReady ? [
    settingsItem,
    makeDivider('divider-1'),
    {
      key: 'spinDesign',
      label: (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            cursor: 'pointer',
          }}
        >
          {/* checkbox 占位符，保持文字对齐 */}
          <span style={{ width: '14px', flexShrink: 0 }} />
          <span style={{ color: colors.textPrimary, userSelect: 'none', fontSize: '12px', marginLeft: '12px' }}>
            {t('inputArea.spinDesign')}
          </span>
        </div>
      ),
      onClick: () => {
        closeMenu();
        postMessage({ type: 'openSpinDesign' });
      },
      disabled: false,
    },
    makeDivider('divider-2'),
    webSearchItem,
    makeDivider('divider-3'),
    // MCP：位于「模型」上方，二级菜单内以 checkbox 列出所有 MCP
    {
      key: 'mcpGroup',
      label: (
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span style={{ width: '14px', flexShrink: 0 }} />
          <span style={{ fontSize: '12px', color: colors.textPrimary, userSelect: 'none', marginLeft: '12px' }}>{t('inputArea.mcp')}</span>
        </div>
      ),
      type: 'submenu' as const,
      children: mcpChildren,
    },
    makeDivider('divider-3b'),
    {
      key: 'modelGroup',
      // hover-scroll-scope 挂在子菜单的 li 上（Ant 会把 item 的 className 应用到整行），
      // 这样鼠标放在「模型」这一整行任意位置都能触发当前模型名的滚动，而不只是名字上
      className: 'hover-scroll-scope',
      // 子菜单弹层容器的 class（rc-menu 把 popupClassName 加到弹层根节点上）。
      // 模型列表可能很长（如 opencode 有 37 个），需要限制高度并滚动，见 index.css
      popupClassName: 'model-list-submenu',
      label: (
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span style={{ width: '14px', flexShrink: 0 }} />
          {/* 「模型」+ 当前模型两行：当前模型字号更小、且单独往前移（不跟随「模型」的缩进）。
              缩进放在第一行而非容器上，第二行才能单独左移。 */}
          <span
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
              lineHeight: 1.35,
              userSelect: 'none',
              minWidth: 0,
            }}
          >
            <span style={{ fontSize: '12px', color: colors.textPrimary, marginLeft: '12px' }}>{t('inputArea.model')}</span>
            {model && (
              // 宽度为打开菜单时冻结的「当前: + 当前模型」宽度；
              // prefix 固定不滚动，模型名默认省略号截断、悬停才单向循环滚动。
              // 文案自带尾随空格（"当前: "），作为 prefix 单独渲染，避免与模型名粘连。
              <HoverScrollText
                prefix={t('inputArea.modelCurrent')}
                text={model}
                width={currentModelWidth}
                style={{ fontSize: '10px', color: colors.textSystem }}
              />
            )}
          </span>
        </div>
      ),
      type: 'submenu' as const,
      children: models.map(m => ({
        key: m,
        label: (
          // 用块级 flex 而不是 inline-flex：inline-flex 会作为行内盒参与父级行盒的
          // 基线对齐，选中时出现的实心圆点会改变基线，使菜单项高度在 36.5px / 33px 之间
          // 抖动。块级 flex 的高度只由内容决定，选中与否都保持 32px（与其它菜单项一致）。
          <span style={{
            fontSize: '12px',
            display: 'flex',
            alignItems: 'center',
            color: model === m ? colors.harness : colors.textPrimary,
            fontWeight: model === m ? 600 : 400,
          }}>
            {/* 选中标记：用 CSS 画实心圆点，尺寸精确可控（不受字体/行高影响），
                槽宽收窄到 12px 让模型名更靠左，整体更紧凑 */}
            <span
              style={{
                width: '12px',
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {model === m && (
                <span
                  style={{
                    display: 'block',
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    backgroundColor: colors.harness,
                  }}
                />
              )}
            </span>
            {/* 宽度按最长模型名（600 粗体）固定：列表里名字完整显示、不滚动不截断，
                切换选中项也不会改变二级菜单宽度（ellipsis 仅作兜底） */}
            <span
              style={{
                marginLeft: '8px',
                width: modelNameWidth ?? undefined,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {m}
            </span>
          </span>
        ),
        onClick: (e: any) => {
          e.domEvent.stopPropagation();
          // 选择模型后保持菜单与二级菜单都展开，与勾选 MCP 的行为一致
          suppressCloseUntilRef.current = Date.now() + 300;
          onModelChange(m);
        },
      })),
    },
    makeDivider('divider-4'),
    {
      key: 'promptMode',
      label: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '5px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {/* checkbox 占位符，保持文字对齐 */}
            <span style={{ width: '14px', flexShrink: 0 }} />
            <span style={{ fontSize: '12px', color: colors.textPrimary, userSelect: 'none', fontWeight: 500, marginLeft: '12px' }}>
              {t('inputArea.promptMode')}
            </span>
          </div>
          <PromptModeSegmentControl
            value={promptMode}
            onChange={onPromptModeChange}
            colors={colors}
          />
        </div>
      ),
      disabled: true,
    },
    makeDivider('divider-5'),
    // 询问模式：位于 Thinking Effort 上方
    {
      key: 'askMode',
      label: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '5px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {/* checkbox 占位符，保持文字对齐 */}
            <span style={{ width: '14px', flexShrink: 0 }} />
            <span style={{ fontSize: '12px', color: colors.textPrimary, userSelect: 'none', fontWeight: 500, marginLeft: '12px' }}>
              {t('inputArea.askMode')}
            </span>
          </div>
          <AskModeSegmentControl
            value={agentMode}
            onChange={onAgentModeChange}
            colors={colors}
          />
        </div>
      ),
      disabled: true,
    },
    makeDivider('divider-6'),
    // 注意: Thinking Effort 永远保持在菜单最后一项
    {
      key: 'thinkingEffort',
      label: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '5px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {/* checkbox 占位符，保持文字对齐 */}
            <span style={{ width: '14px', flexShrink: 0 }} />
            <span style={{ fontSize: '12px', color: colors.textPrimary, userSelect: 'none', fontWeight: 500, marginLeft: '12px' }}>
              {t('inputArea.thinkingEffort')}
            </span>
          </div>
          <ThinkingSegmentControl
            value={thinkingMode}
            onChange={onThinkingModeChange}
            colors={colors}
          />
        </div>
      ),
      disabled: true,
    },
  ] : [loadingMenuItem];

  return (
    <ConfigProvider
      theme={{
        components: {
          Dropdown: {
            colorBgElevated: colors.primaryFrame,
            colorText: colors.textSystem,
            controlItemBgHover: isDark ? 'rgba(99, 102, 241, 0.12)' : 'rgba(99, 102, 241, 0.06)',
            controlItemBgActive: isDark ? 'rgba(99, 102, 241, 0.2)' : 'rgba(99, 102, 241, 0.12)',
            fontSize: 12,
          },
        },
      }}
    >
    <Dropdown
      menu={{
        items: menuItems,
        className: 'agent-mode-menu',
        openKeys: submenuOpenKeys,
        onOpenChange: (keys) => {
          // 勾选 MCP 触发的自动收起：忽略，保持二级菜单展开
          if (Date.now() < suppressCloseUntilRef.current) return;
          setSubmenuOpenKeys(keys as string[]);
        },
      }}
      trigger={['click']}
      placement="topRight"
      open={menuOpen}
      // 关闭时彻底销毁弹层 DOM，避免二级菜单浮层残留（移动端点击外部关闭时尤其明显）
      destroyOnHidden
      onOpenChange={(next) => {
        // 勾选 MCP / 选择模型触发的自动关闭：忽略，保持整个菜单展开
        if (!next && Date.now() < suppressCloseUntilRef.current) return;
        if (next) setMenuOpen(true);
        // 主菜单关闭时一并收起二级菜单，否则子菜单浮层会残留
        else closeMenu();
      }}
      dropdownRender={(menu) => (
        <div
          className="agent-mode-menu"
          style={{
            border: `1px solid var(--border-color, ${colors.border})`,
            borderRadius: '6px',
            overflow: 'hidden',
          }}
        >
          {menu}
        </div>
      )}
    >
      <button
        className="w-7 h-7 rounded-lg flex items-center justify-center hover:brightness-110 transition-colors"
        style={{
          backgroundColor: 'transparent',
          color: colors.textSystem,
          border: `1px solid ${colors.border}`,
        }}
        title={t('inputArea.toggleMenu')}
      >
        <Icon name="menu" size={14} />
      </button>
    </Dropdown>
    {/* 隐藏测量层，必须始终挂载（不能放进 dropdownRender，否则菜单未展开时量不到）：
        - 第一层渲染全部模型名（600 粗体），量出最长模型名的宽度，供模型列表项使用，
          保证列表里每个名字都能完整显示、且切换选中项不改变二级菜单宽度；
        - 第二层只渲染当前模型，菜单打开时读取并冻结，供「当前:」行使用，
          使菜单宽度取决于当前模型而不是最长的模型名。 */}
    <div ref={modelNameMeasureRef} aria-hidden="true" style={HIDDEN_MEASURE_STYLE}>
      {models.map((m) => (
        <span key={m} style={{ display: 'inline-block', fontSize: '12px', fontWeight: 600 }}>{m}</span>
      ))}
    </div>
    <div aria-hidden="true" style={HIDDEN_MEASURE_STYLE}>
      <span ref={currentModelMeasureRef} style={{ display: 'inline-block', fontSize: '10px' }}>
        {t('inputArea.modelCurrent')}{model}
      </span>
    </div>
    </ConfigProvider>
  );
});

// ─── Slash Command Popup ────────────────────────────────────────────────────

const SlashPopup = memo(({
  filtered,
  selectedIndex,
  onSelect,
  colors,
  isDark,
}: {
  filtered: SkillItem[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  colors: Colors;
  isDark: boolean;
}) => {
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Scroll selected item into view
  useEffect(() => {
    if (selectedIndex >= 0 && selectedIndex < itemRefs.current.length) {
      const el = itemRefs.current[selectedIndex];
      if (el) {
        el.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [selectedIndex]);

  // Reset refs array when filtered list changes
  useEffect(() => {
    itemRefs.current = itemRefs.current.slice(0, filtered.length);
  }, [filtered.length]);

  if (filtered.length === 0) return null;

  return (
    <div
      className="absolute bottom-full left-0 right-0 mb-1 rounded-lg border overflow-hidden shadow-lg"
      style={{
        backgroundColor: colors.bgSecondary,
        borderColor: colors.border,
        zIndex: 100,
        maxHeight: '240px',
        overflowY: 'auto',
      }}
    >
      {filtered.map((skill, i) => (
        <div
          key={skill.name}
          ref={(el) => { itemRefs.current[i] = el; }}
          className="flex items-center gap-2 px-3 py-2 cursor-pointer text-[13px] transition-colors"
          style={{
            backgroundColor: i === selectedIndex ? (isDark ? 'rgba(99,102,241,0.15)' : 'rgba(99,102,241,0.08)') : 'transparent',
            color: colors.textPrimary,
          }}
          onMouseDown={(e) => { e.preventDefault(); onSelect(i); }}
        >
          <span style={{ fontWeight: 600, flexShrink: 0, color: colors.textPrimary }}>{skill.name}</span>
          {skill.isBuiltin && (
            <span
              style={{
                color: colors.harness,
                fontSize: '10px',
                flexShrink: 0,
                marginLeft: '2px',
                opacity: 0.7,
              }}
            >
              cmd
            </span>
          )}
          <span
            style={{
              color: colors.textSystem,
              fontSize: '12px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {skill.description}
          </span>
        </div>
      ))}
    </div>
  );
});

const InputArea = forwardRef<InputAreaRef, InputAreaProps>(function InputArea({
  inputFocused,
  setInputFocused,
  currentFile,
  selectedLines,
  fileHidden,
  onToggleFileHidden,
  totalContextTokens,
  maxContextTokens,
  hasActiveQuery,
  agentMode,
  agentModeReady,
  setAgentMode,
  promptMode,
  setPromptMode,
  thinkingMode,
  setThinkingMode,
  webSearch,
  setWebSearch,
  model,
  setModel,
  models,
  onSend,
  onAbort,
  onCompress,
  mainInputRef,
  colors,
  isDark,
  queuedMessage,
  skills,
  commandHistory,
  balance,
  balanceCurrency,
  isUnlimited,
  totalCacheReadInputTokens,
  totalCacheCreationInputTokens,
  totalInputTokens,
  onOpenSettings,
  isProviderConfigured,
  isSubAgent,
  mcpServers,
  onMcpToggle,
  mcpConnecting,
}, ref) {
  const [input, setInput] = useState('');
  const [pastedImages, setPastedImages] = useState<PastedImage[]>([]);

  // Command history navigation state
  const [historyIndex, setHistoryIndex] = useState(-1);
  const historyIndexRef = useRef(-1);
  const cursorAtEntryRef = useRef(0); // Cursor position when entering history mode
  // Sync ref with state for use in event handlers
  useEffect(() => {
    historyIndexRef.current = historyIndex;
  }, [historyIndex]);
  const [savedInput, setSavedInput] = useState('');

  // Slash-command state
  const [showSlash, setShowSlash] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [slashIndex, setSlashIndex] = useState(0);
  // 标记当前是否已处于 "/" 输入状态，避免每次按键都重复刷新 Skill
  const slashActiveRef = useRef(false);

  useImperativeHandle(ref, () => ({
    getValue: () => input,
    setValue: (value: string) => setInput(value),
    setPastedImages: (images: PastedImage[]) => setPastedImages(images),
    getPastedImages: () => pastedImages,
    clear: () => { setInput(''); setPastedImages([]); setHistoryIndex(-1); setSavedInput(''); slashActiveRef.current = false; },
  }), [input, pastedImages, historyIndex, savedInput]);

  const isInputDisabled = isProviderConfigured === false;

  // Filter skills based on query after "/"
  // 优先按命令名匹配，其次才按描述匹配，保证命令名匹配项排在前面
  const filteredSkills = useMemo(() => {
    if (!showSlash) return [];
    const q = slashQuery.toLowerCase();
    const nameMatches: SkillItem[] = [];
    const descMatches: SkillItem[] = [];
    for (const s of skills) {
      if (s.name.toLowerCase().includes(q)) {
        nameMatches.push(s);
      } else if (s.description.toLowerCase().includes(q)) {
        descMatches.push(s);
      }
    }
    return [...nameMatches, ...descMatches];
  }, [skills, slashQuery, showSlash]);

  // Reset selection index when filtered list changes
  useEffect(() => {
    setSlashIndex(0);
  }, [filteredSkills.length]);

  const commitSlash = useCallback((skillName: string) => {
    setInput(`/${skillName} `);
    setShowSlash(false);
    setSlashQuery('');
    slashActiveRef.current = false;
    // Focus the textarea and move cursor to end
    setTimeout(() => {
      mainInputRef.current?.focus();
      const len = `/${skillName} `.length;
      mainInputRef.current?.setSelectionRange(len, len);
    }, 0);
  }, [skills, mainInputRef]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);

    // When user types manually, exit history navigation mode
    if (historyIndexRef.current >= 0) {
      historyIndexRef.current = -1;
      setHistoryIndex(-1);
      setSavedInput('');
    }

    // Detect slash-command mode
    if (value.startsWith('/')) {
      // 用户刚进入 "/" 输入状态时刷新一次 Skill 列表，确保斜杠菜单是最新的
      if (!slashActiveRef.current) {
        slashActiveRef.current = true;
        postMessage({ type: 'requestSkills' });
      }

      // Extract the query after / (before first space)
      const spaceIdx = value.indexOf(' ');
      if (spaceIdx === -1) {
        // Still typing the skill name
        const query = value.slice(1);
        setShowSlash(true);
        setSlashQuery(query);
      } else {
        setShowSlash(false);
        setSlashQuery('');
      }
      return;
    }

    // Close slash popup if not starting with /
    slashActiveRef.current = false;
    setShowSlash(false);
    setSlashQuery('');
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (showSlash && filteredSkills.length > 0) {
      // Navigate popup
      if (e.key === 'ArrowDown' || (e.ctrlKey && (e.key === 'n' || e.key === 'N'))) {
        e.preventDefault();
        setSlashIndex(i => (i + 1) % filteredSkills.length);
        return;
      }
      if (e.key === 'ArrowUp' || (e.ctrlKey && (e.key === 'p' || e.key === 'P'))) {
        e.preventDefault();
        setSlashIndex(i => (i - 1 + filteredSkills.length) % filteredSkills.length);
        return;
      }
      // Enter or Tab to confirm
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        commitSlash(filteredSkills[slashIndex].name);
        return;
      }
      // Escape to close
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowSlash(false);
        setSlashQuery('');
        return;
      }
    }

    // If in history mode, any key other than ArrowUp/ArrowDown exits history mode
    if (historyIndexRef.current >= 0 && e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'Enter') {
      historyIndexRef.current = -1;
      setHistoryIndex(-1);
      setSavedInput('');
    }

    // Command history navigation: only when input is empty or already in history mode
    if (e.key === 'ArrowUp') {
      if (historyIndexRef.current < 0 && input.trim()) {
        // Input is non-empty and not yet in history mode, do not navigate
        return;
      }
      e.preventDefault();
      if (commandHistory.length > 0) {
        const nextIndex = historyIndexRef.current < 0 ? 0 : Math.min(commandHistory.length - 1, historyIndexRef.current + 1);
        // Save current input when first navigating up
        if (historyIndexRef.current < 0) {
          setSavedInput(input);
        }
        setHistoryIndex(nextIndex);
        setInput(commandHistory[nextIndex]);
        // Update cursor reference to end of new text
        cursorAtEntryRef.current = commandHistory[nextIndex].length;
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      if (historyIndexRef.current < 0) {
        // Not in history mode, ignore ArrowDown
        return;
      }
      e.preventDefault();
      const nextIndex = historyIndexRef.current - 1;
      if (nextIndex < 0) {
        // Exit history mode, restore saved input
        setHistoryIndex(-1);
        setInput(savedInput);
      } else {
        setHistoryIndex(nextIndex);
        setInput(commandHistory[nextIndex]);
        // Update cursor reference to end of this history entry
        cursorAtEntryRef.current = commandHistory[nextIndex].length;
      }
      return;
    }

    // Normal Enter to send（MCP 连接中时禁用发送）。
    // 输入法（IME）合成期间按 Enter 是「确认候选词」，不应触发发送：
    // keydown 的 isComposing 为 true / keyCode 为 229，此时直接忽略。
    if (e.key === 'Enter' && !e.shiftKey) {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      if (mcpConnecting) return;
      onSend();
    }
  }, [showSlash, filteredSkills, slashIndex, commitSlash, onSend, commandHistory, input, savedInput, mcpConnecting]);

  // 记录主输入框当前是否聚焦 + 最后一次获得焦点的时间戳，
  // 用于在 blur 的延迟回调中判断是否存在更晚的 focus 事件
  const isFocusedRef = useRef(false);
  const lastFocusTimeRef = useRef(0);

  const handleFocus = useCallback(() => {
    isFocusedRef.current = true;
    lastFocusTimeRef.current = Date.now();
    setInputFocused(true);
  }, [setInputFocused]);

  const handleMouseUp = useCallback((e: React.MouseEvent<HTMLTextAreaElement>) => {
    if (historyIndexRef.current >= 0) {
      const cursorPos = e.currentTarget.selectionStart;
      if (cursorPos !== cursorAtEntryRef.current) {
        // Cursor moved by mouse, exit history mode
        historyIndexRef.current = -1;
        setHistoryIndex(-1);
        setSavedInput('');
      }
    }
  }, []);

  const handleBlur = useCallback(() => {
    isFocusedRef.current = false;
    const blurTime = Date.now();
    // Delay to allow click on popup items
    setTimeout(() => {
      // 以下任一情况说明该 blur 已过期（焦点重新回到了主输入框），
      // 应丢弃，避免输入框高亮被错误清除：
      // 1. 延迟窗口内已重新聚焦（例如点击"新对话"后自动聚焦）
      if (isFocusedRef.current) return;
      // 2. blur 之后又发生过 focus 事件
      if (lastFocusTimeRef.current >= blurTime) return;
      // 3. DOM 实际焦点仍在主输入框
      if (document.activeElement === mainInputRef.current) return;
      setInputFocused(false);
    }, 150);
  }, [setInputFocused, mainInputRef]);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const clipboardItems = Array.from(e.clipboardData?.items ?? []);
    const imageFiles = clipboardItems
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);

    if (imageFiles.length === 0) return;

    e.preventDefault();

    // 保留剪贴板中的文本，并插入到光标处
    const target = e.currentTarget;
    const start = target.selectionStart ?? input.length;
    const end = target.selectionEnd ?? input.length;
    const pastedText = e.clipboardData.getData('text');
    if (pastedText) {
      const nextValue = input.slice(0, start) + pastedText + input.slice(end);
      setInput(nextValue);
      requestAnimationFrame(() => {
        const pos = start + pastedText.length;
        target.setSelectionRange(pos, pos);
      });
    }

    for (const file of imageFiles) {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result !== 'string') return;
        const dataUrl = reader.result;
        const mediaType = file.type || (dataUrl.match(/^data:([^;,]+)/)?.[1]) || 'image/png';
        setPastedImages((prev) => [...prev, { dataUrl, mediaType }]);
      };
      reader.readAsDataURL(file);
    }
  }, [input]);

  const handleModeChange = useCallback((mode: AgentMode) => {
    setAgentMode(mode);
  }, [setAgentMode]);

  const handlePromptModeChange = useCallback((mode: PromptMode) => {
    setPromptMode(mode);
  }, [setPromptMode]);

  const handleThinkingModeChange = useCallback((mode: ThinkingMode) => {
    setThinkingMode(mode);
  }, [setThinkingMode]);

  const handleWebSearchChange = useCallback((value: boolean) => {
    // 极简模式不使用联网搜索，菜单已置灰；此处兜底拦截，避免任何路径误触发。
    if (promptMode === 'minimal') return;
    setWebSearch(value);
    // 通知 extension：更新引擎 modelConfig.webSearch 并持久化到会话 meta.json
    postMessage({ type: 'setWebSearch', webSearch: value, sessionId: getWindowSessionId() ?? undefined });
  }, [setWebSearch, promptMode]);

  const handleModelChange = useCallback((newModel: string) => {
    setModel(newModel);
  }, [setModel]);

  const hasContent = input.trim().length > 0 || pastedImages.length > 0;
  // MCP 连接中：禁止发送，但用旋转动画代替置灰，提示「正在连接」
  const mcpBusy = !!mcpConnecting;
  const sendDisabled = !hasContent || isInputDisabled || mcpBusy;

  return (
    <div
      className="max-w-[680px] mx-auto rounded-lg border-2 transition-colors"
      style={{
        backgroundColor: 'transparent',
        borderColor: isSubAgent ? '#ef4444' : inputFocused ? colors.borderFocus : colors.border,
        position: 'relative',
      }}
    >
      <style>{`
        .input-textarea::placeholder {
          color: ${colors.placeholder} !important;
          opacity: 1;
        }
      `}</style>
      {/* Sub-agent Warning Banner */}
      {isSubAgent && (
        <div
          className="px-3 py-1.5 flex items-center gap-2 text-[12px] border-b"
          style={{
            backgroundColor: 'rgba(239, 68, 68, 0.12)',
            borderColor: 'rgba(239, 68, 68, 0.3)',
            color: '#ef4444',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
            <circle cx="8" cy="8" r="7" stroke="#ef4444" strokeWidth="1.5"/>
            <line x1="8" y1="4.5" x2="8" y2="9.5" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round"/>
            <circle cx="8" cy="11.5" r="0.8" fill="#ef4444"/>
          </svg>
          <span className="truncate flex-1 leading-relaxed">{t('inputArea.subAgentWarning')}</span>
        </div>
      )}
      {/* Queued Message Banner */}
      {queuedMessage && (
        <div
          className="px-3 py-1.5 flex items-center gap-2 text-[12px] border-b"
          style={{
            backgroundColor: isDark ? 'rgba(99, 102, 241, 0.12)' : 'rgba(99, 102, 241, 0.08)',
            borderColor: colors.border,
            color: colors.textSystem,
          }}
        >
          <Icon name="clock" size={14} style={{ flexShrink: 0, color: colors.harness }} />
          <span className="truncate flex-1">
            <span style={{ color: colors.harness, fontWeight: 600 }}>{t('inputArea.waiting')}</span>
            {queuedMessage.content}
            {queuedMessage.images && queuedMessage.images.length > 0 && (
              <span style={{ opacity: 0.7 }}>{t('inputArea.waitingImages', { count: queuedMessage.images.length })}</span>
            )}
          </span>
          <span className="text-[11px] whitespace-nowrap" style={{ color: colors.placeholder }}>
            {t('inputArea.resubmitToEdit')}
          </span>
        </div>
      )}
      {/* Row 1: Pasted images + Textarea with slash popup */}
      <div className="px-3 pt-2 pb-0.5 relative">
        {pastedImages.length > 0 && (
          <div className="flex flex-wrap gap-2 pb-1.5">
            {pastedImages.map((img, idx) => (
              <div key={idx} className="relative group">
                <img
                  src={img.dataUrl}
                  alt="pasted image"
                  className="rounded-md border max-w-[120px] max-h-[90px] object-contain"
                  style={{ borderColor: colors.border, backgroundColor: colors.bgSecondary }}
                />
                <button
                  type="button"
                  onClick={() => setPastedImages((prev) => prev.filter((_, i) => i !== idx))}
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full flex items-center justify-center text-[10px] leading-none opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{ backgroundColor: '#ef4444', color: '#fff' }}
                  title={t('inputArea.removeImage')}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {showSlash && (
          <SlashPopup
            filtered={filteredSkills}
            selectedIndex={slashIndex}
            onSelect={(i) => commitSlash(filteredSkills[i].name)}
            colors={colors}
            isDark={isDark}
          />
        )}
        <TextareaAutosize
          ref={mainInputRef as React.Ref<HTMLTextAreaElement>}
          value={input}
          onChange={handleInputChange}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onMouseUp={handleMouseUp}
          placeholder={isInputDisabled ? '' : t('inputArea.placeholder')}
          className="w-full resize-none focus:outline-none max-h-[200px] text-[13px] input-textarea"
          style={{
            backgroundColor: 'transparent',
            color: isInputDisabled ? colors.placeholder : colors.textPrimary,
            padding: '0',
          }}
          minRows={1}
          maxRows={12}
          disabled={isInputDisabled}
        />
        {isInputDisabled && (
          <div
            role="button"
            className="absolute left-3 right-3 top-2 bottom-0.5 flex items-center cursor-pointer select-none"
            style={{ color: colors.placeholder }}
            onClick={() => onOpenSettings?.()}
            title={t('inputArea.placeholderNeedConfigTitle')}
          >
            <span className="text-[13px] pointer-events-none">
              {t('inputArea.placeholderNeedConfigPrefix')}
              <span style={{ color: colors.harness, textDecoration: 'underline' }}>
                {t('inputArea.placeholderNeedConfigClick')}
              </span>
            </span>
          </div>
        )}
      </div>
      {/* Divider */}
      <div className="border-t" style={{ borderColor: colors.border }} />
      {/* Row 2: Context Progress Bar + Balance/Cache + File Info + Abort + Send Button */}
      <div className="px-3 py-1.5 flex justify-between items-center gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {/* Context Usage Progress Bar */}
          <ContextProgressBar totalContextTokens={totalContextTokens} maxContextTokens={maxContextTokens} onClick={onCompress} colors={colors} />

          {/* Balance & Cache Hit (combined) */}
          {(balance !== undefined || isUnlimited || (totalCacheReadInputTokens !== undefined && totalCacheReadInputTokens > 0)) && (
            <>
              {(balance !== undefined || isUnlimited) && (
                <span className="text-[11px]" style={{ color: colors.border }}>|</span>
              )}
              <span
                className="flex flex-col gap-0 text-[11px] leading-[1.3] whitespace-nowrap"
                style={{ color: colors.textSystem }}
              >
                {(balance !== undefined || isUnlimited) && (
                  <span title={isUnlimited ? t('inputArea.unlimitedBalanceTitle') : t('inputArea.balanceTitle', { amount: Number(balance ?? 0), currency: balanceCurrency || 'CNY' })}>
                    {isUnlimited ? t('inputArea.unlimitedBalance') : t('inputArea.balanceAmount', { amount: (balance ?? 0).toFixed(2) })}
                  </span>
                )}
                {(totalCacheReadInputTokens !== undefined && totalCacheReadInputTokens > 0) && (
                  <span title={t('inputArea.cacheTitle', { read: totalCacheReadInputTokens, create: totalCacheCreationInputTokens || 0, input: totalInputTokens || 0 })}>
                    {t('inputArea.cacheHit', { percent: ((Math.floor((totalCacheReadInputTokens / ((totalCacheReadInputTokens + (totalInputTokens || 0)) || 1)) * 1000) / 10).toFixed(2)) })}
                  </span>
                )}
              </span>
            </>
          )}

          {currentFile && (
            <>
              <span className="text-[11px]" style={{ color: colors.border }}>|</span>
              <span
                className="flex items-center gap-1 text-[11px] truncate cursor-pointer hover:opacity-80 transition-all"
                style={{
                  color: colors.textSystem,
                  fontWeight: 600,
                  opacity: fileHidden ? 0.5 : 1,
                }}
                onClick={onToggleFileHidden}
                title={fileHidden ? t('inputArea.fileHiddenTitle') : t('inputArea.fileShownTitle')}
              >
                {fileHidden ? <Icon name="eye-off" size={12} /> : <Icon name="file" size={12} />}
                {currentFile.split(/[/\\]/).pop()}
                {selectedLines && `:${selectedLines.start}${selectedLines.start !== selectedLines.end ? `~${selectedLines.end}` : ''}`}
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <ToggleMenu
            agentModeReady={agentModeReady}
            agentMode={agentMode}
            onAgentModeChange={handleModeChange}
            model={model}
            onModelChange={handleModelChange}
            models={models}
            promptMode={promptMode}
            onPromptModeChange={handlePromptModeChange}
            thinkingMode={thinkingMode}
            onThinkingModeChange={handleThinkingModeChange}
            webSearch={webSearch}
            onWebSearchChange={handleWebSearchChange}
            onOpenSettings={onOpenSettings || (() => {})}
            mcpServers={mcpServers}
            onMcpToggle={onMcpToggle}
            colors={colors}
            isDark={isDark}
          />
          <button
            onClick={onAbort}
            disabled={!hasActiveQuery}
            className={`w-7 h-7 rounded-lg flex items-center justify-center transition-all ${hasActiveQuery ? 'hover:brightness-110' : ''}`}
            style={{
              backgroundColor: hasActiveQuery ? '#ef4444' : colors.border,
              opacity: hasActiveQuery ? 1 : 0.5,
            }}
            title={t('inputArea.abort')}
          >
            <Icon name="square" size={12} className="text-white" />
          </button>
          <button
            onClick={onSend}
            disabled={sendDisabled}
            className={`w-7 h-7 rounded-lg flex items-center justify-center transition-all ${!sendDisabled ? 'hover:brightness-110' : ''}`}
            style={{
              // MCP 连接中：保持置灰的禁用样式，仅把图标换成 loading 动画
              backgroundColor: !sendDisabled ? colors.harness : colors.border,
              opacity: !sendDisabled ? 1 : 0.5,
            }}
            title={mcpBusy ? t('inputArea.mcpConnecting') : undefined}
          >
            {mcpBusy ? (
              <span
                className="animate-spin"
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  border: '2px solid transparent',
                  borderTopColor: '#fff',
                  borderRightColor: '#fff',
                  display: 'inline-block',
                }}
              />
            ) : (
              <Icon name="send" size={14} className="text-white" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
});

export default memo(InputArea);
