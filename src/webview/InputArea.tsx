import React, { useState, useCallback, memo, forwardRef, useImperativeHandle, useRef, useMemo, useEffect, useLayoutEffect } from 'react';
import { Icon } from './Icon';
import TextareaAutosize from 'react-textarea-autosize';
import { ConfigProvider, Dropdown } from 'antd';
import type { Colors, QueuedMessagePayload, ThinkingMode, PromptMode, AgentMode, IdleSuspendedMessage } from './types';
import type { McpServerInfo, ProviderModels } from '../shared/webviewTypes';
import type { ModelRef } from '../shared/llm/modelRef';
import { postMessage, getWindowSessionId } from './webviewEnv';
import type { AbortButtonState } from '../host/abortButtonState';
import type { TodoProgress } from '../host/todoProgress';
import { resolveInputDisabledReason, resolveInputPlaceholderText, resolvePromptModeLocked, resolveSessionOptionsLocked } from './inputAreaState';
import { isAgentCreator, type SessionCreator } from '../shared/sessionCreator';
import { SegmentControl, CheckboxGlyph } from './components/SegmentControl';
import { dropdownMenuTheme, menuPanelShellStyle } from './components/dropdownMenuTheme';
import { t } from './i18n';
import { useUiFontOffset, uiFontSizePx } from './fontSize';
import {
  filterWorkspaces,
  insertMention,
  resolveMentionRange,
  type WorkspaceMentionItem,
} from './mentionState';

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

/**
 * 技能描述：内置命令的 `description` 是 core 产出的**文案键**（`src/core/coreText.ts`），
 * 在这里翻译；文件技能的描述是原文，原样展示。
 */
function skillDescription(skill: SkillItem): string {
  return skill.isBuiltin ? t(skill.description) : skill.description;
}

/**
 * 余额货币符号：DeepSeek 余额接口（`api.deepseek.com/user/balance`）按充值渠道返回
 * `CNY` 或 `USD`。未识别的币种不给符号，只显示数字。
 */
function currencySymbol(currency?: string): string {
  if (currency === 'USD') return '$';
  if (currency === 'CNY') return '￥';
  return '';
}

/** abort 悬停明细浮层的显示延迟（specs/019 FR-002）：native title 延迟不可控，必须自计时 */
const ABORT_TIP_DELAY_MS = 1000;

/** 任务进度浮层的悬停显示延迟（docs/features/todo-list.md FR-003） */
const TODO_TIP_DELAY_MS = 100;

interface InputAreaProps {
  inputFocused: boolean;
  setInputFocused: (focused: boolean) => void;
  currentFile: string;
  selectedLines: { start: number; end: number } | null;
  fileHidden: boolean;
  onToggleFileHidden: () => void;
  totalContextTokens: number;
  maxContextTokens?: number | null;
  /**
   * 待压缩：手动压缩已排队、尚未开始。为真时用量文本显示「准备压缩」且不可点击
   * （docs/features/compaction.md FR-002）。
   */
  compactPending: boolean;
  /**
   * abort 按钮三态：`query`（红，前台查询运行中）/ `background`（黄，spin 模式或
   * 只剩后台与子代理）/ `none`（灰，空闲不可点）。由 core 的 sessionRuntime 根事实经
   * `resolveAbortButtonState` 推导（docs/features/abort-button.md FR-001）。
   */
  abortButtonState: AbortButtonState;
  /**
   * 当前会话的任务进度（`docs/features/todo-list.md` FR-002）：清单由 core 持有，
   * App 用 `countTodoProgress` 折成 done / total。`null` = 没有 Todo → 不渲染按钮。
   */
  todoProgress: TodoProgress | null;
  /** 当前会话 id（specs/019 FR-003；null = 无当前会话）：切换会话时复位悬停明细浮层 */
  sessionId: string | null;
  /**
   * abort 悬停明细（specs/019 FR-001 / FR-002）：当前会话运行中的后台任务与子代理
   * 清单，App 从 sessionRuntime 快照推导；两组皆空时黄色态悬停不弹浮层
   * （恢复态 spin）。浮层只读：点击无任何上行，中止范围仍由 abort 点击整体判定。
   */
  abortHoverDetail: {
    tasks: { taskId: string; description: string; command: string }[];
    subAgents: { sessionId: string; description: string | null }[];
  };
  /**
   * 会话关联的询问模式。
   * `undefined` = 尚未从宿主获取到：菜单只显示等待项，不显示具体选项。
   */
  agentMode?: AgentMode;
  setAgentMode: (mode: AgentMode) => void;
  /** 会话关联的提示词模式（普通/极简/混合，持久化到 meta.json）；未获取到前为 undefined */
  promptMode?: PromptMode;
  setPromptMode: (mode: PromptMode | undefined) => void;
  /** 会话关联的思考强度；未获取到前为 undefined */
  thinkingMode?: ThinkingMode;
  setThinkingMode: (mode: ThinkingMode | undefined) => void;
  /** 会话关联的 Web Search 开关；undefined = 尚未从宿主获取到 */
  webSearch?: boolean;
  setWebSearch: (webSearch: boolean) => void;
  /** 当前选择的模型身份（provider + model）；undefined = 尚未选择 / 未配置 */
  modelRef?: ModelRef;
  setModelRef: (ref: ModelRef | undefined) => void;
  /**
   * 全部 provider 及其模型列表（菜单按 provider 建立三级子菜单）。
   * `undefined` = 尚未收到宿主应答（菜单显示等待项）；空数组 = 宿主答了「没有配置模型」。
   */
  providerModels?: ProviderModels[];
  onSend: () => void;
  /** 空闲发送（US-46）：下拉第二项——提交时机推迟到会话空闲 */
  onSendIdle: () => void;
  onAbort: () => void;
  onCompress: () => void;
  /** 排队项「编辑」：把排队消息撤回到输入框（与 abort 的 queryEnd 回填同一实现） */
  onEditQueuedMessage: () => void;
  /** 排队项「删除」：丢弃排队消息，不回填输入框 */
  onDeleteQueuedMessage: () => void;
  /** 当前会话的空闲挂起项（webview 本地状态，docs/features/user-message-pipeline.md FR-003）；null = 无 */
  idleSuspendedMessage: IdleSuspendedMessage | null;
  /** 空闲挂起项「编辑」：撤回到输入框（与排队项撤回同一实现，纯本地动作） */
  onEditIdleSuspended: () => void;
  /** 空闲挂起项「删除」：直接丢弃（纯本地动作） */
  onDeleteIdleSuspended: () => void;
  mainInputRef: React.RefObject<HTMLTextAreaElement | null>;
  colors: Colors;
  isDark: boolean;
  queuedMessage: QueuedMessagePayload | null;
  skills: SkillItem[];
  /** `@` 工作区候选（宿主下发，已排除本工作区；specs/023 FR-007） */
  workspaces: WorkspaceMentionItem[];
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
  /**
   * 会话创建者（specs/025 FR-002）：agent 形态的对话禁用输入（specs/025 FR-004）；
   * 跨工作区派发的对话（workspaceId 非空）同时豁免 020 的角色选项锁定。
   */
  creator?: SessionCreator | null;
  /**
   * 当前会话的子代理角色（`conversationLoaded.metadata.role`，specs/020 FR-005）；
   * 普通会话 / 旧数据为 null。非 Master 子代理会话锁定选项菜单的提示词模式 /
   * 联网搜索 / MCP 三项（判定走 `resolveSessionOptionsLocked`）。
   */
  subAgentRole?: string | null;
  /**
   * 会话工作模式（core 事实投影，specs/016 FR-004）：spin 时禁用输入与发送，
   * placeholder 提示「Spin 模式下不响应用户输入」；单向不退出，停止按钮只用于
   * 中止当前 SpinLoop。
   */
  workMode: 'normal' | 'spin';
  /** MCP 服务器列表（含启用状态），在菜单「模型」上方以 checkbox 形式列出 */
  mcpServers?: McpServerInfo[];
  /** 勾选/取消某个 MCP */
  onMcpToggle?: (name: string, enabled: boolean) => void;
  /** 当前会话是否有 MCP 正在连接中；为 true 时禁用发送按钮 */
  mcpConnecting?: boolean;
  /**
   * 会话配置（模型 / 思考强度 / 提示词模式等）是否仍在加载中。
   * 为 true 时禁用发送按钮并显示转圈（复用 MCP 连接中的效果），
   * 避免在尚未获取到真实配置时用空/兜底值发起请求。
   */
  configLoading?: boolean;
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

const ContextProgressBar = React.memo(({ totalContextTokens, maxContextTokens, compactPending, onClick, colors }: { totalContextTokens: number; maxContextTokens?: number | null; compactPending: boolean; onClick?: () => void; colors: Colors }) => {
  if (maxContextTokens == null) {
    return null;
  }
  // 进度条填充与文字分母都以完整 context window 为基准，
  // 颜色按百分比从绿→黄→橙→红渐变（约 95% 的压缩点接近红色）。
  const ratio = maxContextTokens > 0 ? totalContextTokens / maxContextTokens : 0;
  const pct = Math.min(ratio * 100, 100);
  const barColor = contextGradientColor(ratio);
  const contextK = Math.floor(maxContextTokens / 1024);
  const displayText = compactPending
    ? t('inputArea.compactPending')
    : `${Math.floor(totalContextTokens / 1024)}/${contextK}`;

  return (
    <span
      className="flex flex-col gap-0 ui-fs-11 whitespace-nowrap"
      // 宽度取「文本宽度」与「进度条宽度」的较大值（max-content），
      // 这样上方文本过长时不会越过右侧的分割线和命中率信息；
      // 分割线、命中率信息的位置都同时受文本与进度条两者约束。
      style={{ color: colors.textSystem, width: 'max-content', minWidth: '48px', flexShrink: 0 }}
      title={compactPending ? t('inputArea.compactPending') : t('inputArea.clickToCompact')}
    >
      {compactPending ? (
        // 待压缩期间不可点击：不渲染 button，避免重复触发 requestCompress
        <span
          className="text-left"
          style={{ color: colors.textSystem, lineHeight: '1.2', letterSpacing: '-0.3px' }}
        >
          {displayText}
        </span>
      ) : (
        <button
          onClick={onClick}
          className="text-left hover:underline"
          style={{ color: colors.textSystem, lineHeight: '1.2', letterSpacing: '-0.3px' }}
        >
          {displayText} <span style={{ opacity: 0.6 }}>(K)</span>
        </button>
      )}
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
  value: ThinkingMode | undefined;
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
  value: PromptMode | undefined;
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
 * provider 名 / 模型名的兜底估算宽度：只在「首次打开菜单、还没实测到名字宽度」
 * 时用于判断是否切内联（见 computeInlineMode）。正常路径用隐藏测量层的实测值。
 */
const MENU_NAME_WIDTH_FALLBACK = 120;

/** 选中圆点槽宽（provider / model 行共用，保证「点到文本」间距一致） */
const MENU_DOT_SLOT_PX = 12;
/** 圆点槽与文本之间的固定间距（provider / model 行共用） */
const MENU_DOT_GAP_PX = 8;
/** 选中圆点直径 */
const MENU_DOT_SIZE_PX = 7;

/**
 * 弹层宽度的固定附加部分（用于判断内联展开，见 computeInlineMode）。
 *
 * 实测口径（`e2e/webview/inputMenu.spec.ts` 锁定的几何）：
 * 弹层宽度 = 菜单项左右内边距 + `ul` 左右内边距 + 圆点槽 + 圆点间距 + （provider 行的）
 * 子菜单箭头。名字宽度由隐藏测量层给出，这里的常量只补这些固定部分。
 */
/** 菜单项左右内边距（antd `.ant-dropdown-menu-item` 的 `padding: 5px 12px`） */
const MENU_ITEM_PADDING_X = 24;
/** 弹层 `ul` 左右内边距（antd `.ant-dropdown-menu` 的 `padding: 4px`） */
const MENU_LIST_PADDING_X = 8;
/** 二级（provider）行右侧的子菜单箭头占位（含与文本的间距） */
const MENU_ARROW_SLOT_PX = 12;
/** provider 面板（二级）附加宽度：菜单项 + ul + 圆点槽 + 圆点间距 + 箭头 */
const PROVIDER_PANEL_CHROME = MENU_ITEM_PADDING_X + MENU_LIST_PADDING_X + MENU_DOT_SLOT_PX + MENU_DOT_GAP_PX + MENU_ARROW_SLOT_PX;
/** 模型面板（三级）附加宽度：菜单项 + ul + 圆点槽 + 圆点间距（无箭头） */
const MODEL_PANEL_CHROME = MENU_ITEM_PADDING_X + MENU_LIST_PADDING_X + MENU_DOT_SLOT_PX + MENU_DOT_GAP_PX;
/** 弹层与 webview 边缘之间保留的最小间距（antd 的溢出调整本身不留边距） */
const MENU_EDGE_MARGIN_PX = 0;
/**
 * 首次打开时主面板宽度还没实测到，按 0 处理（把「左翻放得下」算得更宽松，
 * 宁可先不内联，再由 layout effect 用实测宽度重新判定，见 ToggleMenu 的测量 effect）。
 */
const MENU_MAIN_PANEL_FALLBACK_WIDTH = 0;

/**
 * 层级背景色：**仅内联模式使用**（内联只发生在模型分组）；非内联（飞出弹层）模式
 * 只用圆点表示选中，不加底色。
 * - 一级（「模型」分组标题）：只有展开时才显示，青绿 rgba(20,184,166,0.22)；
 * - 二级（provider 行）：只要一级展开就一直显示，靛蓝 rgba(99,102,241,0.16)；
 * - 三级（具体模型行）：不加背景（仅圆点）。
 */
const MENU_EXPANDED_BG = 'rgba(20, 184, 166, 0.22)';
const MENU_SUBLEVEL_BG = 'rgba(99, 102, 241, 0.16)';

/**
 * 菜单项的选中圆点：槽宽固定，选中与否都占位，行高与文本位置不抖动。
 * provider / model 两处共用同一组件，避免「点到文本」间距不一致。
 */
const SelectionDot = memo(({ selected, color }: { selected: boolean; color: string }) => (
  <span
    style={{
      width: MENU_DOT_SLOT_PX,
      flexShrink: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}
  >
    {selected && (
      <span
        style={{
          display: 'block',
          width: MENU_DOT_SIZE_PX,
          height: MENU_DOT_SIZE_PX,
          borderRadius: '50%',
          backgroundColor: color,
        }}
      />
    )}
  </span>
));

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
  agentMode,
  onAgentModeChange,
  modelRef,
  onModelChange,
  providerModels,
  promptMode,
  onPromptModeChange,
  thinkingMode,
  onThinkingModeChange,
  webSearch,
  onWebSearchChange,
  onOpenSettings,
  mcpServers,
  onMcpToggle,
  subAgentRole,
  creator,
  colors,
  isDark,
}: {
  /** 会话关联的询问模式；undefined = 尚未从宿主获取到（菜单显示等待项） */
  agentMode?: AgentMode;
  onAgentModeChange: (mode: AgentMode) => void;
  /** 当前选择的模型身份（provider + model）；undefined = 尚未选择 */
  modelRef?: ModelRef;
  /** 选择某个 provider 下的模型：整体上报模型身份 */
  onModelChange: (ref: ModelRef) => void;
  /** undefined = 尚未收到宿主应答；空数组 = 宿主答了「没有配置模型」 */
  providerModels?: ProviderModels[];
  promptMode?: PromptMode;
  onPromptModeChange: (mode: PromptMode) => void;
  thinkingMode?: ThinkingMode;
  onThinkingModeChange: (mode: ThinkingMode) => void;
  /** undefined = 尚未从宿主获取到 */
  webSearch?: boolean;
  onWebSearchChange: (webSearch: boolean) => void;
  onOpenSettings: () => void;
  mcpServers?: McpServerInfo[];
  onMcpToggle?: (name: string, enabled: boolean) => void;
  /** 当前会话的子代理角色（meta.json 的 role 事实）；非 Master 本地子代理锁定三项选项（specs/020 FR-005） */
  subAgentRole?: string | null;
  /** 会话创建者（specs/025 FR-002）：跨工作区派发的对话（workspaceId 非空）不锁定选项 */
  creator?: SessionCreator | null;
  colors: Colors;
  isDark: boolean;
}) => {
  // 菜单项字号随界面字号档位缩放：antd 的 fontSize 是 JS token，必须订阅档位变化重渲染。
  const fontOffset = useUiFontOffset();
  // Dropdown / 二级菜单的展开状态改为受控：Ant 在 submenu 子项被点击后会自动收起弹层，
  // 受控后才能把「勾选 MCP」这一次收起请求忽略掉（见 suppressCloseUntilRef）。
  const [menuOpen, setMenuOpen] = useState(false);
  const [submenuOpenKeys, setSubmenuOpenKeys] = useState<string[]>([]);
  /** 在该时间戳之前到达的「收起/关闭」请求会被忽略，用于让勾选 MCP 后菜单保持展开 */
  const suppressCloseUntilRef = useRef(0);

  // specs/020 FR-005（specs/025 FR-005 收窄）：非 Master 的本地子代理会话锁定三项
  // 选项——core 侧已固定 normal 预设 / 不联网 / 无 MCP，UI 不提供入口；跨工作区派发
  // 的对话继承创建者配置、不按角色固定，三项锁定不适用。判定在 inputAreaState 纯函数里。
  const sessionOptionsLocked = resolveSessionOptionsLocked({ subAgentRole, creator });
  // 提示词模式的锁定口径更宽（specs/025 FR-005）：跨工作区派发的对话恒 normal
  // （minimal / mixed 的首轮工具白名单会剥夺 Reply），不提供切换入口。
  const promptModeLocked = resolvePromptModeLocked({ subAgentRole, creator });

  /**
   * webview 过窄时（不足以并排放下二级 + 三级弹出菜单）改用「内联展开」：
   * 子菜单直接在菜单面板内展开，而不是向右/左飞出。
   *
   * 只有模型分组切内联（三级级联最宽、最容易被裁）；MCP 分组恒为飞出弹层，
   * 不随宽度切换结构。
   *
   * 该决定在「点击弹出菜单」的那一刻做出并冻结（见 onOpenChange），
   * 展开期间窗口缩放不重算，避免菜单结构抖动。
   */
  const [inlineMode, setInlineMode] = useState(false);
  /** 内联模式下模型分组是否展开（手风琴内只有它一个一级分组） */
  const [inlineModelOpen, setInlineModelOpen] = useState(false);
  /** 内联模式下当前展开的 provider（手风琴：同时只允许一个） */
  const [inlineProvider, setInlineProvider] = useState<string | null>(null);

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
    setInlineModelOpen(false);
    setInlineProvider(null);
  }, []);

  // 兜底：只要主菜单处于关闭状态，就确保二级菜单展开状态被清空。
  // 覆盖 onOpenChange 之外的关闭路径（点击外部、再次点按钮、程序化关闭等），
  // 避免子菜单浮层残留（移动端尤其明显）。
  useEffect(() => {
    if (menuOpen) return;
    // 只在确有展开项时更新，避免空数组触发无意义的重渲染
    setSubmenuOpenKeys((keys) => (keys.length > 0 ? [] : keys));
    setInlineModelOpen((open) => (open ? false : open));
    setInlineProvider((p) => (p === null ? p : null));
  }, [menuOpen]);

  // 宽度测量（三套，用隐藏层实测像素宽度，而不是按字符数估算 ——
  // 比例字体下字符数与实际宽度不成正比）：
  //
  // 1) 模型列表：按「最长模型名」（600 粗体，覆盖选中态）测量，让所有模型名都能
  //    完整显示（列表项不滚动、不截断），且切换选中项不会改变该列表宽度。
  // 2) provider 列表（二级菜单）：按「最长 provider 名」（600 粗体，覆盖选中态）测量，
  //    选中态只用背景色表达、不再改字重/字色，菜单宽度不随选中的 provider 变化。
  // 3) 「当前模型」行：打开菜单时按当前模型实测一次并冻结，主菜单宽度取决于当前模型
  //    而不是最长的模型名；展开期间切换模型不重测，超长名字省略号截断 + 悬停滚动。
  // 4) 打开菜单时用 provider 名（2）的测量值判断并排放下「主面板 + 二级弹出菜单」
  //    所需的宽度，放不下才切到内联展开（见 inlineMode；三级不计入，见 computeInlineMode）。
  //
  // 主面板宽度不写死：由内容（一级菜单项 / 当前模型行）自然撑开，与上一版本一致。
  // 内联展开时二级 / 三级内容用 contain: inline-size 排除在宽度计算之外，
  // 保证展开后宽度不随二 / 三级内容变化。
  const modelNameMeasureRef = useRef<HTMLDivElement>(null);
  const providerNameMeasureRef = useRef<HTMLDivElement>(null);
  const currentModelMeasureRef = useRef<HTMLSpanElement>(null);
  /** 菜单触发按钮：主面板右缘与它对齐（placement=topRight），用它算右侧剩余空间 */
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  /** 主面板根节点：实测内容自适应后的面板宽度，供二级弹层左翻落位使用 */
  const menuPanelRef = useRef<HTMLDivElement>(null);
  /** 上一次实际渲染出的主面板宽度（内容自适应），null 表示还没量到 */
  const mainPanelWidthRef = useRef<number | null>(null);
  const [modelNameWidth, setModelNameWidth] = useState<number | null>(null);
  const [providerNameWidth, setProviderNameWidth] = useState<number | null>(null);
  const [currentModelWidth, setCurrentModelWidth] = useState<number | null>(null);

  // 全部 provider 的模型名扁平列表：用于测量最长模型名宽度（隐藏测量层）。
  // 菜单按 provider 分组展示，但宽度需覆盖所有分组里的模型名。
  // 尚未收到宿主应答时按空列表测量（菜单此时显示等待项）。
  const allModels = useMemo(
    () => (providerModels ?? []).flatMap((p) => p.models),
    [providerModels],
  );

  // 全部 provider 名：用于测量最长 provider 名宽度（隐藏测量层）。
  // provider 项选中时会加粗（600），用最粗字重量测，保证选中/未选中宽度一致。
  const allProviderNames = useMemo(
    () => (providerModels ?? []).map((p) => p.key),
    [providerModels],
  );

  useLayoutEffect(() => {
    const container = modelNameMeasureRef.current;
    if (!container) return;
    let max = 0;
    for (const child of Array.from(container.children)) {
      max = Math.max(max, (child as HTMLElement).getBoundingClientRect().width);
    }
    setModelNameWidth(max > 0 ? Math.ceil(max) : null);
  }, [allModels]);

  useLayoutEffect(() => {
    const container = providerNameMeasureRef.current;
    if (!container) return;
    let max = 0;
    for (const child of Array.from(container.children)) {
      max = Math.max(max, (child as HTMLElement).getBoundingClientRect().width);
    }
    setProviderNameWidth(max > 0 ? Math.ceil(max) : null);
  }, [allProviderNames]);

  useLayoutEffect(() => {
    // 只在打开菜单的那一刻测量并冻结；open 变为 true 后切换模型不会触发重测
    if (!menuOpen) return;
    const el = currentModelMeasureRef.current;
    const w = el ? el.getBoundingClientRect().width : 0;
    setCurrentModelWidth(w > 0 ? Math.ceil(w) : null);
  }, [menuOpen]);

  /**
   * 非内联（飞出弹层）模式下，模型列表展开时把当前选中的模型滚动到列表中间。
   *
   * 模型可能很多（如 opencode 有几十个），列表限高滚动（见 .model-list-submenu），
   * 选中项若落在可视区外，用户展开列表后看不到自己当前用的是哪个。
   *
   * 弹层是异步挂载的（portal + 动画），首帧可能还拿不到可见节点，用 rAF 重试几次；
   * 只有列表真正可见（clientHeight > 0）时才滚动——命中的可能是上一次展开后
   * 收起的旧弹层（rc-menu 保留 DOM 只加 hidden 类）。
   */
  useEffect(() => {
    if (!menuOpen || inlineMode) return;
    let raf = 0;
    let tries = 0;
    const scrollSelectedIntoCenter = (): boolean => {
      const label = document.querySelector<HTMLElement>('.model-list-submenu [data-selected-model="true"]');
      if (!label) return false;
      const list = label.closest('.ant-dropdown-menu') as HTMLElement | null;
      const item = label.closest('li') as HTMLElement | null;
      if (!list || !item || list.clientHeight === 0) return false;
      const listRect = list.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      // 当前滚动位置 + 选中项相对可视区顶部的偏移 - 居中所需偏移
      const centered =
        list.scrollTop + (itemRect.top - listRect.top) - (list.clientHeight - itemRect.height) / 2;
      const max = list.scrollHeight - list.clientHeight;
      list.scrollTop = Math.max(0, Math.min(centered, max));
      return true;
    };
    const run = () => {
      if (scrollSelectedIntoCenter()) return;
      if (tries++ < 12) raf = requestAnimationFrame(run);
    };
    raf = requestAnimationFrame(run);
    return () => cancelAnimationFrame(raf);
  }, [menuOpen, inlineMode, submenuOpenKeys]);

  /**
   * 打开菜单时判断是否切内联展开。
   *
   * 菜单按 `placement=topRight` 与触发按钮右缘对齐；二 / 三级弹层优先向右级联，
   * 右侧放不下时 antd 会把**该层**翻到父级左侧（不是把整条级联一起左移）。
   * 注意：只有左翻后的可见面积更大时它才会翻——**两侧都放不下时它会留在右侧并被
   * webview 右缘裁掉**（用户看到的「显示不全」）。所以「右边放不下」不是内联的理由，
   * 但也只有「左翻后落在 webview 内」才不内联；两侧都放不下时必须内联。
   *
   * 逐层模拟实际落位（与 `e2e/webview/inputMenu.spec.ts` 的几何断言一致）：
   * - provider 面板：右侧放得下 → 左缘 = 按钮右缘；否则翻到主面板左侧；
   * - 模型面板：provider 面板右侧放得下 → 左缘 = provider 面板右缘；否则翻到它左侧。
   * 两层左缘都 >= 0 才不内联；任一层左缘 < 0 说明该层两侧都放不下、会被裁掉。
   *
   * 名字宽度用隐藏测量层的实测值（最长 provider 名 / 最长模型名）；主面板宽度用实测值，
   * 首次打开先按 0 估（倾向不内联），由测量 effect 用实测宽度在绘制前重新判定。
   */
  const computeInlineMode = useCallback(() => {
    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : MENU_MAIN_PANEL_FALLBACK_WIDTH;
    const anchorRight = menuTriggerRef.current?.getBoundingClientRect().right ?? viewportWidth;
    const mainPanel = mainPanelWidthRef.current ?? MENU_MAIN_PANEL_FALLBACK_WIDTH;
    const providerPanel = (providerNameWidth ?? MENU_NAME_WIDTH_FALLBACK) + PROVIDER_PANEL_CHROME;
    const modelPanel = (modelNameWidth ?? MENU_NAME_WIDTH_FALLBACK) + MODEL_PANEL_CHROME;
    const rightLimit = viewportWidth - MENU_EDGE_MARGIN_PX;
    // provider 面板：右侧放得下就向右级联，否则翻到主面板左侧
    const providerLeft = anchorRight + providerPanel <= rightLimit
      ? anchorRight
      : anchorRight - mainPanel - providerPanel;
    // 模型面板：provider 面板右侧放得下就向右，否则翻到 provider 面板左侧
    const providerRight = providerLeft + providerPanel;
    const modelLeft = providerRight + modelPanel <= rightLimit ? providerRight : providerLeft - modelPanel;
    return Math.min(providerLeft, modelLeft) < MENU_EDGE_MARGIN_PX;
  }, [providerNameWidth, modelNameWidth]);

  // 菜单渲染出来后实测主面板宽度（内容自适应），存起来供下次判断二级弹层左翻落位。
  // 首次打开 computeInlineMode 用的是兜底估算值，可能判错：这里用实测宽度在**绘制前**
  // 重新判定一次，需要内联就补切（layout effect 内 setState 会在浏览器绘制前重渲染，
  // 用户看不到中间态）。内联态的面板宽度与非内联不同，所以只在非内联时测量。
  // 弹层是异步挂载的（portal），首帧拿不到节点时用 rAF 重试。
  useLayoutEffect(() => {
    if (!menuOpen || inlineMode) return;
    let raf = 0;
    let tries = 0;
    const measure = () => {
      const el = menuPanelRef.current;
      if (el) {
        const w = el.getBoundingClientRect().width;
        if (w > 0) {
          mainPanelWidthRef.current = Math.ceil(w);
          if (computeInlineMode()) setInlineMode(true);
        }
        return;
      }
      if (tries++ < 10) raf = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(raf);
  }, [menuOpen, inlineMode, computeInlineMode]);

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

  /**
   * provider 级菜单项标签：当前使用的 provider 显示选中圆点。
   *
   * 选中态只用背景色表达，**不再改字体颜色 / 字重**；圆点槽 + 圆点间距与模型项
   * 共用同一套常量与 `SelectionDot`，保证「点到文本」间距完全一致。
   * 名字放不下时与模型名一样悬停滚动。
   */
  const renderProviderLabel = (
    p: ProviderModels,
    opts?: { inline?: boolean; expanded?: boolean; onToggle?: (e: React.MouseEvent) => void },
  ) => {
    const selected = modelRef?.provider === p.key;
    const inline = opts?.inline === true;
    return (
      <span
        className={inline ? 'hover-scroll-scope' : undefined}
        onClick={inline ? opts?.onToggle : undefined}
        style={{
          fontSize: uiFontSizePx(12),
          display: 'flex',
          alignItems: 'center',
          // 二级：内联模式下只要一级展开就一直有底色（选中与否都显示），
          // 选中态由左侧圆点表达，不再改字体颜色 / 字重。
          color: colors.textPrimary,
          userSelect: 'none',
          cursor: inline ? 'pointer' : undefined,
          backgroundColor: inline ? MENU_SUBLEVEL_BG : undefined,
          borderRadius: inline ? '4px' : undefined,
          padding: inline ? '4px 6px' : undefined,
        }}
      >
        <SelectionDot selected={selected} color={colors.harness} />
        <HoverScrollText
          prefix=""
          text={p.key}
          width={inline ? null : (providerNameWidth ?? undefined)}
          style={{
            marginLeft: MENU_DOT_GAP_PX,
            flex: inline ? '1 1 0' : undefined,
            minWidth: inline ? 0 : undefined,
          }}
        />
        {inline && (
          <Icon
            name={opts?.expanded ? 'chevron-down' : 'chevron-right'}
            size={14}
            style={{ marginLeft: 4, flexShrink: 0, color: colors.textSystem }}
          />
        )}
      </span>
    );
  };

  /** 模型级菜单项标签：选中态同样只用背景色表达，圆点槽 / 间距与 provider 项共用。 */
  const renderModelLabel = (
    p: ProviderModels,
    m: string,
    opts?: { inline?: boolean },
  ) => {
    const selected = modelRef?.model === m && modelRef?.provider === p.key;
    const inline = opts?.inline === true;
    return (
      <span
        // 非内联模式：给选中模型打标记，模型列表弹出时据此把选中项滚动到列表中间
        // （见 scrollSelectedModelIntoCenter）。内联模式没有飞出弹层，标记不起作用。
        data-selected-model={!inline && selected ? 'true' : undefined}
        className={inline ? 'hover-scroll-scope' : undefined}
        style={{
          fontSize: uiFontSizePx(12),
          display: 'flex',
          alignItems: 'center',
          // 选中态只改字体颜色之外的表现（三级模型行不加背景，仅圆点）
          color: colors.textPrimary,
          userSelect: 'none',
          borderRadius: inline ? '4px' : undefined,
          padding: inline ? '4px 6px' : undefined,
        }}
      >
        <SelectionDot selected={selected} color={colors.harness} />
        <HoverScrollText
          prefix=""
          text={m}
          width={inline ? null : (modelNameWidth ?? undefined)}
          style={{
            marginLeft: MENU_DOT_GAP_PX,
            flex: inline ? '1 1 0' : undefined,
            minWidth: inline ? 0 : undefined,
          }}
        />
      </span>
    );
  };

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
        <span style={{ color: colors.textPrimary, userSelect: 'none', fontSize: uiFontSizePx(12), marginLeft: '12px' }}>
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
  // 非 Master 子代理会话同样置灰（specs/020 FR-005：core 固定不联网，UI 不提供入口）。
  const webSearchDisabled = promptMode === 'minimal' || sessionOptionsLocked;
  // webSearch 未到达时为 undefined：checkbox 按未勾选渲染，且菜单整体处于等待态
  // （agentMode 未到达时只显示等待项，见 menuItems）。
  const webSearchChecked = !!webSearch && !webSearchDisabled;
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
        title={webSearchDisabled
          ? (sessionOptionsLocked
            ? t('inputArea.subagentOptionsLockedHint')
            : t('inputArea.webSearchMinimalHint'))
          : t('inputArea.webSearchHint')}
      >
        <span style={{ width: '14px', flexShrink: 0, textAlign: 'center' }}>
          <CheckboxGlyph checked={webSearchChecked} colors={colors} />
        </span>
        {/* 勾选只改变 checkbox 自身，文字颜色保持不变，避免整行变色 */}
        <span style={{ color: colors.textPrimary, userSelect: 'none', fontSize: uiFontSizePx(12), marginLeft: '12px' }}>
          {t('inputArea.webSearch')}
        </span>
      </div>
    ),
    // 注意：这里禁用 MenuItem 的点击关闭行为，点击事件由 label 内部的 div 自行处理。
    disabled: true,
  };

  /**
   * 等待项：事实尚未从宿主到达时的统一表现（`docs/hosts/webview-facts.md` 第 4 节）。
   * 转圈 + 文案，不显示任何猜测值。
   */
  const waitingRow = (text: string) => (
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
      <span style={{ fontSize: uiFontSizePx(12) }}>{text}</span>
    </div>
  );

  const loadingMenuItem = {
    key: 'menuLoading',
    disabled: true,
    label: waitingRow(t('inputArea.askModeLoading')),
  };

  // MCP 服务器子菜单：checkbox 形式列出 mcp.json 中声明的全部服务器。
  // 勾选状态写入 settings.json 的 mcp.enabled，未勾选即 disable（默认全部 disable）。
  //
  // Ant 的 submenu 在子项被点击后会收起弹层，导致勾选一个就要重新展开。
  // 这里把 Dropdown / Menu 的展开状态改为受控，并在勾选瞬间打一个 suppress 时间窗
  // （见 suppressCloseUntilRef），把紧随其后的「收起二级菜单 / 关闭 Dropdown」请求忽略掉。
  /** MCP 服务器行（飞出弹层）：名字超长用省略号截断 */
  const renderMcpChildLabel = (server: McpServerInfo) => {
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

    return (
      <div
        onClick={(e) => {
          // 阻止冒泡到 MenuItem，避免菜单因点击该项而关闭（可连续勾选多个）
          e.stopPropagation();
          // 非 Master 子代理会话锁定（specs/020 FR-005）：点击不产生任何变更、不上报
          if (sessionOptionsLocked) return;
          // 让紧随其后的「收起二级菜单 / 关闭 Dropdown」请求被忽略
          suppressCloseUntilRef.current = Date.now() + 300;
          onMcpToggle?.(server.name, !server.enabled);
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          cursor: sessionOptionsLocked ? 'default' : 'pointer',
          // 垂直内边距收紧，抵消第二行小字带来的高度
          padding: '3px 0',
          minWidth: 0,
          opacity: sessionOptionsLocked ? 0.45 : 1,
        }}
        title={sessionOptionsLocked ? t('inputArea.subagentOptionsLockedHint') : tooltip}
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
              fontSize: uiFontSizePx(12),
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
            <span style={{ fontSize: uiFontSizePx(10), color: server.error ? '#ef4444' : colors.textSystem }}>
              {statusText}
            </span>
          )}
        </span>
      </div>
    );
  };

  /** MCP 为空时的占位行 */
  const renderMcpEmptyLabel = () => (
    <div style={{ padding: '3px 0', fontSize: uiFontSizePx(12), color: colors.textSystem }}>
      {t('inputArea.mcpEmpty')}
    </div>
  );

  // MCP 子菜单项（飞出弹层；窄 webview 下也不切内联，见 inlineMode 注释）
  const mcpChildren = mcpServers && mcpServers.length > 0
    ? mcpServers.map((server) => ({
        key: `mcp:${server.name}`,
        label: renderMcpChildLabel(server),
        // 禁用 MenuItem 自身点击，交互完全交给 label 内部 div 处理
        disabled: true,
      }))
    : [{
        key: 'mcpEmpty',
        label: renderMcpEmptyLabel(),
        disabled: true,
      }];

  /** 内联展开时右侧的展开箭头（收起 = chevron-right，展开 = chevron-down） */
  const inlineChevron = (open: boolean) => (
    <Icon
      name={open ? 'chevron-down' : 'chevron-right'}
      size={14}
      style={{ marginLeft: 4, flexShrink: 0, color: colors.textSystem }}
    />
  );

  /** 内联模式：模型分组（provider 手风琴展开，展开的 provider 内再列出模型） */
  const modelGroupInline = {
    key: 'modelGroup',
    label: (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div
          // 只在标题行触发「当前模型」长名字滚动，避免悬停子项时联动所有滚动
          className="hover-scroll-scope"
          onClick={(e) => {
            e.stopPropagation();
            setInlineModelOpen((open) => !open);
            setInlineProvider(null);
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            cursor: 'pointer',
            // 一级（内联）：只有展开时才显示青绿底色，与是否已选模型无关。
            // 水平内边距与其它菜单项的文本缩进一致（12px）：其它行的文字都从
            // 「12px 缩进」起步，这里若用小内边距，「模型」两个字会整体偏左。
            backgroundColor: inlineModelOpen ? MENU_EXPANDED_BG : undefined,
            borderRadius: '4px',
            padding: '4px 12px',
          }}
        >
          <span style={{ width: '14px', flexShrink: 0 }} />
          <span
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
              lineHeight: 1.35,
              userSelect: 'none',
              minWidth: 0,
              flex: '1 1 0',
            }}
          >
            <span style={{ fontSize: uiFontSizePx(12), color: colors.textPrimary, marginLeft: '12px' }}>
              {t('inputArea.model')}
            </span>
            {modelRef?.model && (
              <HoverScrollText
                prefix={t('inputArea.modelCurrent')}
                text={modelRef.model}
                width={null}
                style={{ display: 'flex', fontSize: uiFontSizePx(10), color: colors.textSystem, maxWidth: '100%' }}
              />
            )}
          </span>
          {inlineChevron(inlineModelOpen)}
        </div>
        {inlineModelOpen && (
          <div style={{ display: 'flex', flexDirection: 'column', paddingLeft: '14px', marginTop: 2, minWidth: 0, overflow: 'hidden', contain: 'inline-size' }}>
            {providerModels === undefined ? waitingRow(t('inputArea.modelLoading')) : providerModels.length > 0 ? providerModels.map((p) => (
              <div key={p.key} style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <div
                  style={{ minWidth: 0 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setInlineProvider((cur) => (cur === p.key ? null : p.key));
                  }}
                >
                  {renderProviderLabel(p, { inline: true, expanded: inlineProvider === p.key })}
                </div>
                {inlineProvider === p.key && (
                  <div style={{ display: 'flex', flexDirection: 'column', paddingLeft: '16px', minWidth: 0, overflow: 'hidden', contain: 'inline-size' }}>
                    {p.models.length > 0 ? p.models.map((m) => (
                      <div
                        key={m}
                        style={{ minWidth: 0 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          // 选择模型后保持菜单展开（与勾选 MCP 的行为一致）
                          suppressCloseUntilRef.current = Date.now() + 300;
                          onModelChange({ provider: p.key, model: m });
                        }}
                      >
                        {renderModelLabel(p, m, { inline: true })}
                      </div>
                    )) : (
                      <span style={{ fontSize: uiFontSizePx(12), color: colors.textSystem, padding: '4px 6px' }}>
                        {t('inputArea.modelEmpty')}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )) : (
              <span style={{ fontSize: uiFontSizePx(12), color: colors.textSystem, padding: '4px 6px' }}>
                {t('inputArea.modelEmpty')}
              </span>
            )}
          </div>
        )}
      </div>
    ),
    disabled: true,
  };

  /** 弹出（非内联）模式：provider → 模型 两级子菜单 */
  const providerSubmenuItems = providerModels === undefined
    // 尚未收到宿主应答：显示等待项，而不是「（无模型）」
    ? [{ key: 'modelsLoading', disabled: true, label: waitingRow(t('inputArea.modelLoading')) }]
    : providerModels.length > 0
    ? providerModels.map((p) => ({
        key: `provider:${p.key}`,
        // hover-scroll-scope 挂在 li 上：整行悬停都能触发长名字滚动。
        // 非内联模式不加选中底色（只用圆点），故这里不再挂 menu-item-selected-* 类。
        className: 'hover-scroll-scope',
        label: renderProviderLabel(p),
        type: 'submenu' as const,
        // provider 下的模型可能很多，复用同一套限高滚动样式
        popupClassName: 'model-list-submenu',
        children: p.models.length > 0
          ? p.models.map((m) => ({
              key: `${p.key}::${m}`,
              // 具体模型（三级）选中不加背景，仅由圆点表示
              className: 'hover-scroll-scope',
              label: renderModelLabel(p, m),
              onClick: (e: any) => {
                e.domEvent.stopPropagation();
                // 选择模型后保持菜单与各级子菜单都展开，与勾选 MCP 的行为一致
                suppressCloseUntilRef.current = Date.now() + 300;
                onModelChange({ provider: p.key, model: m });
              },
            }))
          : [{
              key: `${p.key}::__empty`,
              label: (
                <span style={{ fontSize: uiFontSizePx(12), color: colors.textSystem }}>
                  {t('inputArea.modelEmpty')}
                </span>
              ),
              disabled: true,
            }],
      }))
    : [{
        key: 'modelEmpty',
        label: (
          <span style={{ fontSize: uiFontSizePx(12), color: colors.textSystem }}>
            {t('inputArea.modelEmpty')}
          </span>
        ),
        disabled: true,
      }];

  // MCP 分组：恒为飞出弹层（不随 webview 宽度切内联，见 inlineMode 注释）
  const mcpGroupItem = {
    key: 'mcpGroup',
    label: (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          // 非 Master 子代理会话置灰（specs/020 FR-005）：core 固定无 MCP，子项同样锁定
          opacity: sessionOptionsLocked ? 0.45 : 1,
        }}
        title={sessionOptionsLocked ? t('inputArea.subagentOptionsLockedHint') : undefined}
      >
        <span style={{ width: '14px', flexShrink: 0 }} />
        <span style={{ fontSize: uiFontSizePx(12), color: colors.textPrimary, userSelect: 'none', marginLeft: '12px' }}>{t('inputArea.mcp')}</span>
      </div>
    ),
    type: 'submenu' as const,
    children: mcpChildren,
  };

  // 模型分组：窄 webview 用内联展开，宽 webview 用弹出子菜单（只有它切内联）
  const modelGroupItem = inlineMode
    ? modelGroupInline
    : {
        key: 'modelGroup',
        // hover-scroll-scope 挂在子菜单的 li 上（Ant 会把 item 的 className 应用到整行），
        // 这样鼠标放在「模型」这一整行任意位置都能触发当前模型名的滚动，而不只是名字上。
        // 非内联模式不加一级底色（选中/展开都不加），故这里不再挂 menu-item-selected-* 类。
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
              <span style={{ fontSize: uiFontSizePx(12), color: colors.textPrimary, marginLeft: '12px' }}>{t('inputArea.model')}</span>
              {modelRef?.model && (
                // 宽度为打开菜单时冻结的「当前: + 当前模型」宽度（与上一版本一致）；
                // 展开期间选中更长的模型时这里会溢出，靠悬停单向循环滚动查看全名，
                // 下次重新打开菜单再按新的当前模型重测。
                // 文案自带尾随空格（"当前: "），作为 prefix 单独渲染，避免与模型名粘连。
                <HoverScrollText
                  prefix={t('inputArea.modelCurrent')}
                  text={modelRef.model}
                  width={currentModelWidth}
                  style={{ fontSize: uiFontSizePx(10), color: colors.textSystem }}
                />
              )}
            </span>
          </div>
        ),
        type: 'submenu' as const,
        children: providerSubmenuItems,
      };

  // agentMode 未到达：整个菜单只显示等待项，不展示任何配置选项（不猜默认值）
  const menuItems = agentMode !== undefined ? [
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
          <span style={{ color: colors.textPrimary, userSelect: 'none', fontSize: uiFontSizePx(12), marginLeft: '12px' }}>
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
    // MCP：位于「模型」上方，二级菜单内以 checkbox 列出所有 MCP（恒为飞出弹层）
    mcpGroupItem,
    makeDivider('divider-3b'),
    modelGroupItem,
    makeDivider('divider-4'),
    {
      key: 'promptMode',
      label: (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            padding: '5px 12px',
            // 非 Master 本地子代理置灰（specs/020 FR-005：core 固定 normal 预设）；
            // 跨工作区派发的对话恒 normal（specs/025 FR-005），同样置灰
            opacity: promptModeLocked ? 0.45 : 1,
          }}
          title={promptModeLocked
            ? (sessionOptionsLocked
              ? t('inputArea.subagentOptionsLockedHint')
              : t('inputArea.remotePromptModeLockedHint'))
            : undefined}
        >
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {/* checkbox 占位符，保持文字对齐 */}
            <span style={{ width: '14px', flexShrink: 0 }} />
            <span style={{ fontSize: uiFontSizePx(12), color: colors.textPrimary, userSelect: 'none', fontWeight: 500, marginLeft: '12px' }}>
              {t('inputArea.promptMode')}
            </span>
          </div>
          <PromptModeSegmentControl
            value={promptMode}
            onChange={(mode) => {
              // 锁定时点击不产生任何状态变更、不上报（specs/020 FR-005 / specs/025 FR-005）
              if (promptModeLocked) return;
              onPromptModeChange(mode);
            }}
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
            <span style={{ fontSize: uiFontSizePx(12), color: colors.textPrimary, userSelect: 'none', fontWeight: 500, marginLeft: '12px' }}>
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
            <span style={{ fontSize: uiFontSizePx(12), color: colors.textPrimary, userSelect: 'none', fontWeight: 500, marginLeft: '12px' }}>
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
    <ConfigProvider theme={dropdownMenuTheme(colors, isDark, 12 + fontOffset)}>
    <Dropdown
      menu={{
        items: menuItems,
        className: 'agent-mode-menu',
        openKeys: submenuOpenKeys,
        // 子菜单（MCP / 模型）悬停展开延迟：rc-menu 默认 0.1s，压到 0.01s 让二 / 三级跟手；
        // 浮层动画时长由 Main.tsx 的全局 motionDurationMid 控制
        subMenuOpenDelay: 0.01,
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
        if (next) {
          // 在「点击弹出菜单」的这一刻决定内联还是飞出，展开期间不再重算
          setInlineMode(computeInlineMode());
          setMenuOpen(true);
        } else {
          // 主菜单关闭时一并收起二级菜单，否则子菜单浮层会残留
          closeMenu();
        }
      }}
      dropdownRender={(menu) => (
        <div
          ref={menuPanelRef}
          className="agent-mode-menu"
          style={menuPanelShellStyle(colors)}
        >
          {menu}
        </div>
      )}
    >
      <button
        ref={menuTriggerRef}
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
        - 第一层渲染全部模型名（与列表项同样的 400 字重与字号），量出最长模型名的宽度，
          供模型列表项与内联判定使用；
        - 第二层渲染全部 provider 名（同样 400 字重），量出最长 provider 名的宽度；
        - 第三层只渲染当前模型，菜单打开时读取并冻结，供「当前:」行使用，
          使菜单宽度取决于当前模型而不是最长的模型名。
        字重必须与真实列表项一致（选中态用圆点表达、不加粗），否则宽度被高估，
        内联判定会偏保守。 */}
    <div ref={modelNameMeasureRef} aria-hidden="true" style={HIDDEN_MEASURE_STYLE}>
      {allModels.map((m, i) => (
        <span key={`${i}::${m}`} style={{ display: 'inline-block', fontSize: uiFontSizePx(12), fontWeight: 400 }}>{m}</span>
      ))}
    </div>
    <div ref={providerNameMeasureRef} aria-hidden="true" style={HIDDEN_MEASURE_STYLE}>
      {allProviderNames.map((name, i) => (
        <span key={`${i}::${name}`} style={{ display: 'inline-block', fontSize: uiFontSizePx(12), fontWeight: 400 }}>{name}</span>
      ))}
    </div>
    <div aria-hidden="true" style={HIDDEN_MEASURE_STYLE}>
      <span ref={currentModelMeasureRef} style={{ display: 'inline-block', fontSize: uiFontSizePx(10) }}>
        {t('inputArea.modelCurrent')}{modelRef?.model ?? ''}
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
          className="flex items-center gap-2 px-3 py-2 cursor-pointer ui-fs-13 transition-colors"
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
                fontSize: uiFontSizePx(10),
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
              fontSize: uiFontSizePx(12),
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {skillDescription(skill)}
          </span>
        </div>
      ))}
    </div>
  );
});


// ─── Workspace Mention Popup（specs/023 FR-007）─────────────────────────────

const WorkspacePopup = memo(({
  filtered,
  selectedIndex,
  onSelect,
  colors,
  isDark,
}: {
  filtered: WorkspaceMentionItem[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  colors: Colors;
  isDark: boolean;
}) => {
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    if (selectedIndex >= 0 && selectedIndex < itemRefs.current.length) {
      itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

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
      {filtered.map((workspace, i) => (
        <div
          key={`${workspace.id}-${i}`}
          ref={(el) => { itemRefs.current[i] = el; }}
          className="flex items-center gap-2 px-3 py-2 cursor-pointer ui-fs-13 transition-colors"
          style={{
            backgroundColor: i === selectedIndex ? (isDark ? 'rgba(99,102,241,0.15)' : 'rgba(99,102,241,0.08)') : 'transparent',
            color: colors.textPrimary,
          }}
          onMouseDown={(e) => { e.preventDefault(); onSelect(i); }}
        >
          <span style={{ fontWeight: 600, flexShrink: 0 }}>{workspace.displayName}</span>
          <span
            style={{
              color: colors.textSystem,
              fontSize: uiFontSizePx(12),
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={workspace.id}
          >
            {workspace.id}
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
  compactPending,
  abortButtonState,
  todoProgress,
  sessionId,
  abortHoverDetail,
  agentMode,
  setAgentMode,
  promptMode,
  setPromptMode,
  thinkingMode,
  setThinkingMode,
  webSearch,
  setWebSearch,
  modelRef,
  setModelRef,
  providerModels,
  onSend,
  onSendIdle,
  onAbort,
  onCompress,
  onEditQueuedMessage,
  onDeleteQueuedMessage,
  idleSuspendedMessage,
  onEditIdleSuspended,
  onDeleteIdleSuspended,
  mainInputRef,
  colors,
  isDark,
  queuedMessage,
  skills,
  workspaces,
  commandHistory,
  balance,
  balanceCurrency,
  isUnlimited,
  totalCacheReadInputTokens,
  totalCacheCreationInputTokens,
  totalInputTokens,
  onOpenSettings,
  isProviderConfigured,
  workMode,
  creator,
  subAgentRole,
  mcpServers,
  onMcpToggle,
  mcpConnecting,
  configLoading,
}, ref) {
  const [input, setInput] = useState('');
  const [pastedImages, setPastedImages] = useState<PastedImage[]>([]);
  // 发送模式菜单的主题 token 用到字号档位（与主配置菜单同一来源，随设置缩放）
  const fontOffset = useUiFontOffset();

  // ==================== abort 悬停明细浮层（specs/019 FR-002） ====================

  // 仅黄色态（background）起 1s 计时；移出取消 / 立即隐藏；内容随快照刷新，
  // 两组皆空时不渲染（恢复态 spin）。浮层 pointer-events-none：只读投影，
  // 指针事件穿透（点击不产生任何上行），也避免移入浮层误触按钮 mouseleave。
  const [abortTipVisible, setAbortTipVisible] = useState(false);
  const abortTipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeAbortTip = useCallback(() => {
    if (abortTipTimerRef.current !== null) {
      clearTimeout(abortTipTimerRef.current);
      abortTipTimerRef.current = null;
    }
    setAbortTipVisible(false);
  }, []);
  useEffect(() => {
    // 离开黄色态（转红 / 转灰）或切换会话：取消计时并立即隐藏（specs/019 FR-003）
    if (abortButtonState !== 'background') closeAbortTip();
  }, [abortButtonState, closeAbortTip]);
  useEffect(() => {
    closeAbortTip();
  }, [sessionId, closeAbortTip]);
  useEffect(() => () => {
    if (abortTipTimerRef.current !== null) clearTimeout(abortTipTimerRef.current);
  }, []);

  // ==================== 任务进度按钮与浮层（docs/features/todo-list.md FR-003） ====================

  // 悬停 100ms 出浮层；点击固定（指针移出不隐藏）、再点恢复悬停规则；切换会话复位。
  // 浮层 pointer-events-none：只读投影，点击不产生任何上行，也不改变固定状态。
  const [todoTipVisible, setTodoTipVisible] = useState(false);
  const [todoTipPinned, setTodoTipPinned] = useState(false);
  const todoHoveredRef = useRef(false);
  const todoTipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTodoTipTimer = useCallback(() => {
    if (todoTipTimerRef.current !== null) {
      clearTimeout(todoTipTimerRef.current);
      todoTipTimerRef.current = null;
    }
  }, []);
  const hideTodoTip = useCallback(() => {
    clearTodoTipTimer();
    setTodoTipVisible(false);
  }, [clearTodoTipTimer]);
  // 切换会话：取消计时、复位固定态与可见态（新对话按悬停规则）
  useEffect(() => {
    todoHoveredRef.current = false;
    setTodoTipPinned(false);
    hideTodoTip();
  }, [sessionId, hideTodoTip]);
  useEffect(() => () => {
    if (todoTipTimerRef.current !== null) clearTimeout(todoTipTimerRef.current);
  }, []);

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

  // @ 工作区补全状态（specs/023 FR-007）
  const [showMention, setShowMention] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionTokenEnd, setMentionTokenEnd] = useState(0);
  const mentionActiveRef = useRef(false);

  useImperativeHandle(ref, () => ({
    getValue: () => input,
    setValue: (value: string) => setInput(value),
    setPastedImages: (images: PastedImage[]) => setPastedImages(images),
    getPastedImages: () => pastedImages,
    clear: () => { setInput(''); setPastedImages([]); setHistoryIndex(-1); setSavedInput(''); slashActiveRef.current = false; },
  }), [input, pastedImages, historyIndex, savedInput]);

  // 三个禁用来源（specs/016 FR-004；specs/025 FR-004）：provider 未配置（引导去设置）、
  // spin 模式（会话不受理输入）与非用户创建（对话由创建方 Agent 驱动）。覆盖层只属于
  // provider 分支；spin 与非用户创建只禁用 + 换 placeholder。判定在 inputAreaState
  // 纯函数里，与测试共用一份实现。
  const disableFacts = {
    providerConfigured: isProviderConfigured,
    workMode,
    notUserCreated: isAgentCreator(creator ?? { kind: 'user' }),
  };
  const disabledReason = resolveInputDisabledReason(disableFacts);
  const isInputDisabled = disabledReason !== null;
  const inputPlaceholder = resolveInputPlaceholderText(disabledReason, {
    default: t('inputArea.placeholder'),
    spin: t('inputArea.placeholderSpinMode'),
    notUserCreated: t('inputArea.placeholderNotUserCreated'),
  });

  // Filter skills based on query after "/"
  // 优先按命令名匹配，其次才按描述匹配，保证命令名匹配项排在前面
  const filteredSkills = useMemo(() => {
    if (!showSlash) return [];
    const q = slashQuery.toLowerCase();
    const nameMatches: SkillItem[] = [];
    const descMatches: SkillItem[] = [];
    for (const s of skills) {
      const description = skillDescription(s).toLowerCase();
      if (s.name.toLowerCase().includes(q)) {
        nameMatches.push(s);
      } else if (description.includes(q)) {
        descMatches.push(s);
      }
    }
    return [...nameMatches, ...descMatches];
  }, [skills, slashQuery, showSlash]);

  // Reset selection index when filtered list changes
  useEffect(() => {
    setSlashIndex(0);
  }, [filteredSkills.length]);

  const filteredWorkspaces = useMemo(() => {
    if (!showMention) return [];
    return filterWorkspaces(workspaces, mentionQuery);
  }, [workspaces, mentionQuery, showMention]);

  useEffect(() => {
    setMentionIndex(0);
  }, [filteredWorkspaces.length]);

  const commitMention = useCallback((item: WorkspaceMentionItem) => {
    const caret = mainInputRef.current?.selectionStart ?? input.length;
    const inserted = insertMention(input, caret, item, mentionTokenEnd);
    setInput(inserted.next);
    setShowMention(false);
    setMentionQuery('');
    mentionActiveRef.current = false;
    setTimeout(() => {
      mainInputRef.current?.focus();
      mainInputRef.current?.setSelectionRange(inserted.caret, inserted.caret);
    }, 0);
  }, [input, mentionTokenEnd, mainInputRef]);

  const commitSlash = useCallback((skillName: string) => {
    const inserted = `/${skillName} `;
    // 只替换用户实际敲出来的 "/<query>" 前缀，保留输入框里原有的其余内容：
    // 例如原本已有「修复登录问题」，在开头补 "/" 后选中 commit，
    // 结果是 "/commit 修复登录问题"，而不是把已有内容整段清掉。
    const prefixLen = 1 + slashQuery.length;
    const next = inserted + input.slice(prefixLen);
    setInput(next);
    setShowSlash(false);
    setSlashQuery('');
    slashActiveRef.current = false;
    // Focus the textarea and move cursor to end
    setTimeout(() => {
      mainInputRef.current?.focus();
      const len = next.length;
      mainInputRef.current?.setSelectionRange(len, len);
    }, 0);
  }, [input, slashQuery, mainInputRef]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);

    // When user types manually, exit history navigation mode
    if (historyIndexRef.current >= 0) {
      historyIndexRef.current = -1;
      setHistoryIndex(-1);
      setSavedInput('');
    }

    // Detect workspace mention mode（specs/023 FR-007）：与 "/" 同口径只看首字符
    if (value.startsWith('@')) {
      if (!mentionActiveRef.current) {
        mentionActiveRef.current = true;
        postMessage({ type: 'requestWorkspaces' });
      }
      const caret = e.target.selectionStart ?? value.length;
      const range = resolveMentionRange(value, caret);
      setShowMention(range.active);
      setMentionQuery(range.query);
      setMentionTokenEnd(range.tokenEnd);
      if (range.active) return;
    } else {
      mentionActiveRef.current = false;
      setShowMention(false);
      setMentionQuery('');
    }

    // Detect slash-command mode
    if (value.startsWith('/')) {
      // 用户刚进入 "/" 输入状态时刷新一次 Skill 列表，确保斜杠菜单是最新的
      if (!slashActiveRef.current) {
        slashActiveRef.current = true;
        postMessage({ type: 'requestSkills' });
      }

      // 技能名区间 = "/" 之后到第一个空白（空格 / 制表 / 换行）为止。
      // 用「光标是否已越过该空白」判断用户是否还在输入技能名：
      // 只看整串里有没有空格是不行的 —— 输入框原本已有内容时（例如在
      // 「修复登录问题」前补一个 "/"），那个空格属于已有正文，会被误判成
      // 「已经进入参数区」从而不弹补全。
      const wsIdx = value.slice(1).search(/\s/);
      const tokenEnd = wsIdx === -1 ? value.length : 1 + wsIdx;
      const caret = e.target.selectionStart ?? value.length;
      if (caret >= 1 && caret <= tokenEnd) {
        setShowSlash(true);
        setSlashQuery(value.slice(1, caret));
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
    // @ 工作区补全与 "/" 同口径的键盘操作（specs/023 FR-007）
    if (showMention && filteredWorkspaces.length > 0) {
      if (e.key === 'ArrowDown' || (e.ctrlKey && (e.key === 'n' || e.key === 'N'))) {
        e.preventDefault();
        setMentionIndex(i => (i + 1) % filteredWorkspaces.length);
        return;
      }
      if (e.key === 'ArrowUp' || (e.ctrlKey && (e.key === 'p' || e.key === 'P'))) {
        e.preventDefault();
        setMentionIndex(i => (i - 1 + filteredWorkspaces.length) % filteredWorkspaces.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        commitMention(filteredWorkspaces[mentionIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowMention(false);
        setMentionQuery('');
        mentionActiveRef.current = false;
        return;
      }
    }
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
    // 依赖必须含 mention 四件套：漏掉 mentionIndex 时闭包停留在旧值，
    // ArrowDown 后 Enter 仍按第 0 项插入（specs/023 FR-007 的键盘导航，
    // 由 e2e/webview/workspaceMention.spec.ts 锁定）
  }, [showMention, filteredWorkspaces, mentionIndex, commitMention, showSlash, filteredSkills, slashIndex, commitSlash, onSend, commandHistory, input, savedInput, mcpConnecting]);

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
    // 通知 extension：更新引擎 modelConfig.webSearch 并持久化到会话 meta.json。
    // 会话尚未建立时没有落点：不下发（该值仍会随第一条消息的 webSearch 字段一起生效）。
    const sessionId = getWindowSessionId();
    if (!sessionId) return;
    postMessage({ type: 'setWebSearch', webSearch: value, sessionId });
  }, [setWebSearch, promptMode]);

  // 选择模型：整体更新模型身份（provider + model；同名模型可能属于不同 provider）
  const handleModelChange = useCallback((ref: ModelRef) => {
    setModelRef(ref);
  }, [setModelRef]);

  const hasContent = input.trim().length > 0 || pastedImages.length > 0;
  // MCP 连接中 / 会话配置（模型、思考强度、提示词模式等）尚未获取到：禁止发送，
  // 但用旋转动画代替纯置灰，提示「正在连接 / 加载配置」。
  const mcpBusy = !!mcpConnecting;
  const configBusy = !!configLoading;
  const busy = mcpBusy || configBusy;
  // 已有待处理消息时禁止再次发送：忙碌排队项与空闲挂起项同为「一次只有一条」，
  // 改主意走横幅上的编辑 / 删除（docs/features/user-message-pipeline.md FR-003），不靠继续提交覆盖。
  const sendDisabled = !hasContent || isInputDisabled || busy || !!queuedMessage || !!idleSuspendedMessage;
  return (
    <div
      data-input-area="true"
      className="max-w-[680px] mx-auto rounded-lg border-2 transition-colors"
      style={{
        backgroundColor: 'transparent',
        borderColor: inputFocused ? colors.borderFocus : colors.border,
        position: 'relative',
      }}
    >
      <style>{`
        .input-textarea::placeholder {
          color: ${colors.placeholder} !important;
          opacity: 1;
        }
      `}</style>
      {/* Queued Message Banner */}
      {queuedMessage && (
        <div
          className="px-3 py-1.5 flex items-center gap-2 ui-fs-12 border-b"
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
          {/* 编辑 = 撤回到输入框；删除 = 丢弃。两者都先清排队项，再由宿主撤回引擎队列里的消息 */}
          <button
            type="button"
            onClick={onEditQueuedMessage}
            title={t('inputArea.editQueuedMessage')}
            className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0 transition-all hover:brightness-125"
            style={{ color: colors.harness }}
          >
            <Icon name="pencil" size={12} />
          </button>
          <button
            type="button"
            onClick={onDeleteQueuedMessage}
            title={t('inputArea.deleteQueuedMessage')}
            className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0 transition-all hover:brightness-125"
            style={{ color: colors.placeholder }}
          >
            <Icon name="trash" size={12} />
          </button>
        </div>
      )}
      {/* Idle-Suspended Banner：空闲发送的本地挂起项（docs/features/user-message-pipeline.md FR-003）。与忙碌排队横幅
          同形态，标签区分等待条件——「空闲后发送」= 等会话空闲；「等待中」= 等下一轮。 */}
      {idleSuspendedMessage && (
        <div
          className="px-3 py-1.5 flex items-center gap-2 ui-fs-12 border-b"
          style={{
            backgroundColor: isDark ? 'rgba(99, 102, 241, 0.12)' : 'rgba(99, 102, 241, 0.08)',
            borderColor: colors.border,
            color: colors.textSystem,
          }}
          data-idle-suspended="true"
        >
          <Icon name="clock" size={14} style={{ flexShrink: 0, color: colors.harness }} />
          <span className="truncate flex-1">
            <span style={{ color: colors.harness, fontWeight: 600 }}>{t('inputArea.idleWaiting')}</span>
            {idleSuspendedMessage.wire.content}
            {idleSuspendedMessage.wire.images && idleSuspendedMessage.wire.images.length > 0 && (
              <span style={{ opacity: 0.7 }}>{t('inputArea.waitingImages', { count: idleSuspendedMessage.wire.images.length })}</span>
            )}
          </span>
          {/* 编辑 = 撤回到输入框；删除 = 丢弃。挂起项不经宿主，两者都是纯本地动作 */}
          <button
            type="button"
            onClick={onEditIdleSuspended}
            title={t('inputArea.editQueuedMessage')}
            className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0 transition-all hover:brightness-125"
            style={{ color: colors.harness }}
          >
            <Icon name="pencil" size={12} />
          </button>
          <button
            type="button"
            onClick={onDeleteIdleSuspended}
            title={t('inputArea.deleteQueuedMessage')}
            className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0 transition-all hover:brightness-125"
            style={{ color: colors.placeholder }}
          >
            <Icon name="trash" size={12} />
          </button>
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
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full flex items-center justify-center ui-fs-10 leading-none opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{ backgroundColor: '#ef4444', color: '#fff' }}
                  title={t('inputArea.removeImage')}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {showMention && (
          <WorkspacePopup
            filtered={filteredWorkspaces}
            selectedIndex={mentionIndex}
            onSelect={(i) => commitMention(filteredWorkspaces[i])}
            colors={colors}
            isDark={isDark}
          />
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
          placeholder={inputPlaceholder}
          // 高度上限只有一处来源：`maxRows`。不要再挂 `max-h-[...]` ——
          // TextareaAutosize 写入的 inline height 会被 CSS max-height 悄悄截短，
          // 库按 maxRows 算出的高度（12 行 ≈ 234px）一旦超过该像素值，内容还没到
          // 上限就先冒出框内滚动条（粘贴多行时最明显）。
          className="w-full resize-none focus:outline-none ui-fs-13 input-textarea"
          style={{
            backgroundColor: 'transparent',
            color: isInputDisabled ? colors.placeholder : colors.textPrimary,
            padding: '0',
          }}
          minRows={1}
          maxRows={12}
          disabled={isInputDisabled}
        />
        {isProviderConfigured === false && (
          <div
            role="button"
            className="absolute left-3 right-3 top-2 bottom-0.5 flex items-center cursor-pointer select-none"
            style={{ color: colors.placeholder }}
            onClick={() => onOpenSettings?.()}
            title={t('inputArea.placeholderNeedConfigTitle')}
          >
            <span className="ui-fs-13 pointer-events-none">
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
      {/* Row 2: Context Progress Bar + Balance/Cache + File Info + Abort + Send Button
          relative：任务进度浮层以本行右边缘为锚点，宽度上限即输入区宽度（FR-003） */}
      <div className="relative px-3 py-1.5 flex justify-between items-center gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {/* Context Usage Progress Bar */}
          <ContextProgressBar totalContextTokens={totalContextTokens} maxContextTokens={maxContextTokens} compactPending={compactPending} onClick={onCompress} colors={colors} />

          {/* Balance & Cache Hit (combined) */}
          {(balance !== undefined || isUnlimited || (totalCacheReadInputTokens !== undefined && totalCacheReadInputTokens > 0)) && (
            <>
              {(balance !== undefined || isUnlimited) && (
                <span className="ui-fs-11" style={{ color: colors.border }}>|</span>
              )}
              <span
                className="flex flex-col gap-0 ui-fs-11 leading-[1.3] whitespace-nowrap"
                style={{ color: colors.textSystem }}
              >
                {(balance !== undefined || isUnlimited) && (
                  <span title={isUnlimited
                    ? t('inputArea.unlimitedBalanceTitle')
                    : balanceCurrency
                      ? t('inputArea.balanceTitle', { amount: Number(balance ?? 0), currency: balanceCurrency })
                      : t('inputArea.balanceTitleNoCurrency', { amount: Number(balance ?? 0) })}>
                    {isUnlimited ? t('inputArea.unlimitedBalance') : t('inputArea.balanceAmount', { amount: (balance ?? 0).toFixed(2), symbol: currencySymbol(balanceCurrency) })}
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
              <span className="ui-fs-11" style={{ color: colors.border }}>|</span>
              <span
                className="flex items-center gap-1 ui-fs-11 truncate cursor-pointer hover:opacity-80 transition-all"
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
          {/* 任务进度按钮（docs/features/todo-list.md FR-002 / FR-003）：紧挨菜单按钮左侧。
              没有 Todo 时整个节点不渲染（不出现 0/0，也不留占位热区）。 */}
          {todoProgress && (
            <div className="relative flex-shrink-0">
              <button
                data-todo-progress={`${todoProgress.done}/${todoProgress.total}`}
                data-todo-progress-pinned={todoTipPinned ? 'true' : 'false'}
                className="px-1.5 h-7 rounded-lg ui-fs-11 whitespace-nowrap transition-all"
                style={{
                  color: todoTipPinned ? colors.textPrimary : colors.textSystem,
                  backgroundColor: todoTipPinned ? colors.bgSecondary : 'transparent',
                }}
                onMouseEnter={() => {
                  todoHoveredRef.current = true;
                  clearTodoTipTimer();
                  todoTipTimerRef.current = setTimeout(() => setTodoTipVisible(true), TODO_TIP_DELAY_MS);
                }}
                onMouseLeave={() => {
                  todoHoveredRef.current = false;
                  clearTodoTipTimer();
                  // 未固定：移出立即隐藏（固定的浮层要留着让人读完）
                  if (!todoTipPinned) setTodoTipVisible(false);
                }}
                onClick={() => {
                  const next = !todoTipPinned;
                  setTodoTipPinned(next);
                  if (next) setTodoTipVisible(true);
                  else if (!todoHoveredRef.current) setTodoTipVisible(false);
                }}
              >
                {t('inputArea.todoProgress', { done: todoProgress.done, total: todoProgress.total })}
              </button>
            </div>
          )}
          <ToggleMenu
            agentMode={agentMode}
            onAgentModeChange={handleModeChange}
            modelRef={modelRef}
            onModelChange={handleModelChange}
            providerModels={providerModels}
            promptMode={promptMode}
            onPromptModeChange={handlePromptModeChange}
            thinkingMode={thinkingMode}
            onThinkingModeChange={handleThinkingModeChange}
            webSearch={webSearch}
            onWebSearchChange={handleWebSearchChange}
            onOpenSettings={onOpenSettings || (() => {})}
            mcpServers={mcpServers}
            onMcpToggle={onMcpToggle}
            subAgentRole={subAgentRole}
            creator={creator}
            colors={colors}
            isDark={isDark}
          />
          {/* abort 按钮 + 悬停明细浮层（specs/019 FR-002 / FR-003）：relative 容器
              供浮层 absolute 定位；浮层只读、pointer-events 穿透 */}
          <div className="relative flex-shrink-0">
            <button
              onClick={onAbort}
              disabled={abortButtonState === 'none'}
              data-abort-state={abortButtonState}
              className={`w-7 h-7 rounded-lg flex items-center justify-center transition-all ${abortButtonState === 'none' ? '' : 'hover:brightness-110'}`}
              style={{
                // 红 = 前台查询运行中；黄 = spin 模式或只剩后台任务 / 子代理（docs/features/abort-button.md FR-001）
                backgroundColor:
                  abortButtonState === 'query'
                    ? '#ef4444'
                    : abortButtonState === 'background'
                      ? '#f59e0b'
                      : colors.border,
                opacity: abortButtonState === 'none' ? 0.5 : 1,
              }}
              onMouseEnter={() => {
                // 仅黄色态起 1s 计时；红色 / 灰色态无浮层（specs/019 FR-002）
                if (abortButtonState !== 'background') return;
                abortTipTimerRef.current = setTimeout(() => setAbortTipVisible(true), ABORT_TIP_DELAY_MS);
              }}
              onMouseLeave={closeAbortTip}
              title={abortButtonState === 'background' ? undefined : t('inputArea.abort')}
            >
              <Icon name="square" size={12} className="text-white" />
            </button>
            {abortTipVisible && (abortHoverDetail.tasks.length > 0 || abortHoverDetail.subAgents.length > 0) && (
              <div
                data-abort-tip
                className="absolute bottom-full right-0 mb-2 rounded-lg border shadow-lg px-3 py-2 pointer-events-none z-50"
                style={{ backgroundColor: colors.bgSecondary, borderColor: colors.border, maxWidth: 320 }}
              >
                {abortHoverDetail.tasks.length > 0 && (
                  <div className={abortHoverDetail.subAgents.length > 0 ? 'mb-2' : ''}>
                    <div className="ui-fs-10 font-semibold mb-1" style={{ color: colors.textSecondary }}>
                      {t('inputArea.abortHoverTasks')}
                    </div>
                    {abortHoverDetail.tasks.map((task) => (
                      <div key={task.taskId} className="ui-fs-11 mb-1" style={{ color: colors.textSystem }}>
                        <div className="truncate">{task.description}</div>
                        {task.command !== task.description && (
                          <div className="ui-fs-10 opacity-70 break-all font-mono">{task.command}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {abortHoverDetail.subAgents.length > 0 && (
                  <div>
                    <div className="ui-fs-10 font-semibold mb-1" style={{ color: colors.textSecondary }}>
                      {t('inputArea.abortHoverSubAgents')}
                    </div>
                    {abortHoverDetail.subAgents.map((agent) => (
                      <div key={agent.sessionId} className="ui-fs-11 truncate mb-0.5" style={{ color: colors.textSystem }}>
                        {agent.description ?? t('inputArea.abortHoverSubAgentFallback')}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          {/* 发送 split button：主按钮恒为立即发送（US-46）；小三角下拉是
              当次动作（立即发送 / 空闲发送），不记住选择、不改变主按钮语义。
              小三角贴按钮底部（不垂直居中）；下拉菜单与主配置菜单共用同一套主题
              token（src/webview/components/dropdownMenuTheme.ts），随 light / dark
              切换——不挂 .agent-mode-menu 类，其 CSS 禁用项重置对这里的纯文本
              禁用项是误伤（见该文件注释）。 */}
          <div className="flex items-center rounded-lg overflow-hidden flex-shrink-0">
            <button
              onClick={onSend}
              disabled={sendDisabled}
              className={`w-7 h-7 flex items-center justify-center transition-all ${!sendDisabled ? 'hover:brightness-110' : ''}`}
              style={{
                // MCP 连接中 / 配置加载中：保持置灰的禁用样式，仅把图标换成 loading 动画
                backgroundColor: !sendDisabled ? colors.harness : colors.border,
                opacity: !sendDisabled ? 1 : 0.5,
              }}
              title={busy ? t('inputArea.mcpConnecting') : undefined}
            >
              {busy ? (
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
            <ConfigProvider theme={dropdownMenuTheme(colors, isDark, 12 + fontOffset)}>
              <Dropdown
                menu={{
                  items: [
                    { key: 'send-immediate', label: t('inputArea.sendImmediately'), disabled: sendDisabled, onClick: onSend },
                    { key: 'send-idle', label: t('inputArea.sendOnIdle'), disabled: sendDisabled, onClick: onSendIdle },
                  ],
                }}
                trigger={['click']}
                placement="topRight"
                destroyOnHidden
                dropdownRender={(menu) => (
                  <div style={menuPanelShellStyle(colors)}>
                    {menu}
                  </div>
                )}
              >
                <button
                  disabled={sendDisabled}
                  data-send-mode-caret="true"
                  className="h-7 w-4 flex items-end justify-center transition-all"
                  style={{
                    backgroundColor: !sendDisabled ? colors.harness : colors.border,
                    opacity: !sendDisabled ? 1 : 0.5,
                    borderLeft: '1px solid rgba(255, 255, 255, 0.3)',
                    // 小三角贴底：只留一点不顶到按钮边缘的呼吸距离
                    paddingBottom: 4,
                  }}
                  title={t('inputArea.sendModeMenu')}
                  aria-label={t('inputArea.sendModeMenu')}
                >
                  <Icon name="chevron-down" size={11} className="text-white" />
                </button>
              </Dropdown>
            </ConfigProvider>
          </div>
        </div>
        {/* 任务进度浮层（docs/features/todo-list.md FR-003）：锚在底栏右边缘，宽度随内容自适应，
          上限为输入区宽度；pointer-events-none：只读投影，点击不产生任何上行。 */}
        {todoTipVisible && todoProgress && (
          <div
            data-todo-progress-tip="true"
            className="absolute bottom-full right-0 mb-2 rounded-lg border shadow-lg px-3 py-2 pointer-events-none z-50"
            style={{
              backgroundColor: colors.bgSecondary,
              borderColor: colors.border,
              maxWidth: '100%',
            }}
          >
            <div className="flex flex-col gap-1" style={{ maxHeight: 240, overflowY: 'auto' }}>
              {todoProgress.items.map((todo, index) => (
                <div key={index} className="flex items-start gap-2 ui-fs-11">
                  <span
                    className="flex-shrink-0 mt-0.5"
                    style={{
                      color: todo.status === 'in_progress'
                        ? colors.harness
                        : todo.status === 'completed'
                          ? colors.timelineStatusSuccess
                          : colors.textSystem,
                    }}
                  >
                    <Icon
                      name={todo.status === 'completed'
                        ? 'check-square'
                        : todo.status === 'in_progress'
                          ? 'circle-dot'
                          : 'square'}
                      size={12}
                    />
                  </span>
                  <span
                    style={{
                      color: todo.status === 'completed' ? colors.textSystem : colors.textPrimary,
                      textDecoration: todo.status === 'completed' ? 'line-through' : 'none',
                      wordBreak: 'break-word',
                    }}
                  >
                    {todo.content}
                    {todo.status === 'in_progress' && todo.activeForm && (
                      <span
                        className="block ui-fs-11 italic mt-0.5"
                        style={{ color: colors.harness }}
                      >
                        {todo.activeForm}
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

export default memo(InputArea);
