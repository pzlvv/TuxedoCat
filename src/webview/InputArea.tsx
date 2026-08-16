import React, { useState, useCallback, memo, forwardRef, useImperativeHandle, useRef, useMemo, useEffect } from 'react';
import { Send, Square, File, EyeOff, Clock, Menu } from 'lucide-react';
import TextareaAutosize from 'react-textarea-autosize';
import { ConfigProvider, Dropdown } from 'antd';
import type { Colors, ThinkingMode, PromptMode } from './types';
import { postMessage, getWindowSessionId } from './webviewEnv';
import { t } from './i18n';

export interface InputAreaRef {
  getValue: () => string;
  setValue: (value: string) => void;
  clear: () => void;
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
  agentMode: 'manual' | 'risk' | 'auto';
  setAgentMode: (mode: 'manual' | 'risk' | 'auto') => void;
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
  queuedMessage: string | null;
  skills: SkillItem[];
  commandHistory: string[];
  serverLoadWarning?: string | null;
  onDismissServerLoad?: () => void;
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
  isProviderConfigured: boolean;
}

const ContextProgressBar = React.memo(({ totalContextTokens, isDark, maxContextTokens, onClick, colors }: { totalContextTokens: number; isDark: boolean; maxContextTokens?: number | null; onClick?: () => void; colors: Colors }) => {
  if (maxContextTokens == null) {
    return null;
  }
  const maxContext = maxContextTokens;
  const pct = Math.min((totalContextTokens / maxContext) * 100, 100);
  const barColor = pct < 50 ? '#22c55e' : pct < 80 ? '#f97316' : '#ef4444';
  const contextK = Math.floor(maxContext / 1000);
  const displayText = `${Math.floor(totalContextTokens / 1000)}/${contextK}`;

  return (
    <span
      className="flex flex-col gap-0 text-[11px] whitespace-nowrap"
      style={{ color: colors.textSystem, width: '56px', flexShrink: 0 }}
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
          backgroundColor: isDark ? colors.harness + '80' : colors.harness + '80',
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

const AgentModeSelector = memo(({
  agentMode,
  onModeChange,
  colors,
  isDark,
}: {
  agentMode: 'manual' | 'risk' | 'auto';
  onModeChange: (mode: 'manual' | 'risk' | 'auto') => void;
  colors: Colors;
  isDark: boolean;
}) => (
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
      items: [
        {
          key: 'manual',
          label: <span style={{ fontSize: '12px' }}>{t('inputArea.agentModeManual')}</span>,
          onClick: () => onModeChange('manual'),
        },
        {
          key: 'risk',
          label: <span style={{ fontSize: '12px' }}>{t('inputArea.agentModeRisk')}</span>,
          onClick: () => onModeChange('risk'),
        },
        {
          key: 'auto',
          label: <span style={{ fontSize: '12px' }}>{t('inputArea.agentModeAuto')}</span>,
          onClick: () => onModeChange('auto'),
        },
      ],
      selectedKeys: [agentMode],
      className: 'agent-mode-menu',
    }}
    trigger={['click']}
    placement="topRight"
  >
    <button
      className="px-2 h-7 rounded-md flex items-center justify-center hover:brightness-110"
      style={{
        backgroundColor: 'transparent',
        color: colors.textSystem,
        border: `1px solid ${colors.border}`,
        fontSize: '12px',
        padding: '4px 8px',
        whiteSpace: 'nowrap',
        minWidth: '54px',
      }}
      title={
        agentMode === 'auto' ? t('inputArea.agentModeAutoTitle') :
        agentMode === 'risk' ? t('inputArea.agentModeRiskTitle') :
        t('inputArea.agentModeManualTitle')
      }
    >
      {agentMode === 'auto' ? t('inputArea.agentModeAuto') : agentMode === 'risk' ? t('inputArea.agentModeRisk') : t('inputArea.agentModeManual')}
    </button>
  </Dropdown>
  </ConfigProvider>
));

const ThinkingSegmentControl = ({
  value,
  onChange,
  colors,
}: {
  value: ThinkingMode;
  onChange: (mode: ThinkingMode) => void;
  colors: Colors;
}) => {
  const segments: { key: ThinkingMode; label: string }[] = [
    { key: 'off', label: t('inputArea.thinkingOff') },
    { key: 'low', label: t('inputArea.thinkingLow') },
    { key: 'high', label: t('inputArea.thinkingHigh') },
    { key: 'max', label: t('inputArea.thinkingMax') },
  ];

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
};

const PromptModeSegmentControl = ({
  value,
  onChange,
  colors,
}: {
  value: PromptMode;
  onChange: (mode: PromptMode) => void;
  colors: Colors;
}) => {
  const segments: { key: PromptMode; label: string }[] = [
    { key: 'normal', label: t('inputArea.promptModeNormal') },
    { key: 'minimal', label: t('inputArea.promptModeMinimal') },
    { key: 'mixed', label: t('inputArea.promptModeMixed') },
  ];

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
            title={seg.key === 'normal'
              ? t('inputArea.promptModeNormalTitle')
              : seg.key === 'minimal'
                ? t('inputArea.promptModeMinimalTitle')
                : t('inputArea.promptModeMixedTitle')}
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
};

const ToggleMenu = memo(({
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
  colors,
  isDark,
}: {
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
  colors: Colors;
  isDark: boolean;
}) => {
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
    onClick: () => onOpenSettings(),
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
          <span
            style={{
              display: 'inline-block',
              width: 12,
              height: 12,
              borderRadius: 3,
              border: `1px solid ${webSearchChecked ? colors.harness : colors.border}`,
              backgroundColor: webSearchChecked ? colors.harness : 'transparent',
              verticalAlign: '-2px',
              transition: 'all 0.15s',
            }}
          >
            {webSearchChecked && (
              <svg width="10" height="10" viewBox="0 0 12 12" style={{ display: 'block', margin: '0 auto' }}>
                <path d="M2 6l3 3l5-6" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </span>
        </span>
        <span style={{ color: webSearchChecked ? colors.harness : colors.textPrimary, userSelect: 'none', fontSize: '12px', marginLeft: '12px' }}>
          {t('inputArea.webSearch')}
        </span>
      </div>
    ),
    // 注意：这里禁用 MenuItem 的点击关闭行为，点击事件由 label 内部的 div 自行处理。
    disabled: true,
  };

  const menuItems = [
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
      onClick: () => postMessage({ type: 'openSpinDesign' }),
      disabled: false,
    },
    makeDivider('divider-2'),
    webSearchItem,
    makeDivider('divider-3'),
    {
      key: 'modelGroup',
      label: (
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span style={{ width: '14px', flexShrink: 0 }} />
          <span style={{ fontSize: '12px', color: colors.textPrimary, userSelect: 'none', marginLeft: '12px' }}>{t('inputArea.model')}</span>
        </div>
      ),
      type: 'submenu' as const,
      children: models.map(m => ({
        key: m,
        label: (
          <span style={{
            fontSize: '12px',
            display: 'inline-flex',
            alignItems: 'center',
            color: model === m ? colors.harness : colors.textPrimary,
            fontWeight: model === m ? 600 : 400,
          }}>
            <span style={{ display: 'inline-block', width: '14px', textAlign: 'center', flexShrink: 0 }}>
              {model === m && '✓'}
            </span>
            <span style={{ marginLeft: '12px' }}>{m}</span>
          </span>
        ),
        onClick: (e: any) => { e.domEvent.stopPropagation(); onModelChange(m); },
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
    // 注意: Thinking Effort 永远保持在菜单最后一项
    {
      key: 'thinkingEffort',
      label: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '5px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {/* checkbox 占位符，保持文字对齐 */}
            <span style={{ width: '14px', flexShrink: 0 }} />
            <span style={{ fontSize: '12px', color: colors.textPrimary, userSelect: 'none', fontWeight: 500, marginLeft: '12px' }}>
              Thinking Effort
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
  ];

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
      }}
      trigger={['click']}
      placement="topRight"
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
        <Menu size={14} />
      </button>
    </Dropdown>
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
  serverLoadWarning,
  onDismissServerLoad,
  balance,
  balanceCurrency,
  isUnlimited,
  totalCacheReadInputTokens,
  totalCacheCreationInputTokens,
  totalInputTokens,
  onOpenSettings,
  isProviderConfigured,
}, ref) {
  const [input, setInput] = useState('');

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

  useImperativeHandle(ref, () => ({
    getValue: () => input,
    setValue: (value: string) => setInput(value),
    clear: () => { setInput(''); setHistoryIndex(-1); setSavedInput(''); },
  }), [input, historyIndex, savedInput]);

  const isInputDisabled = !isProviderConfigured;

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

    // Normal Enter to send
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }, [showSlash, filteredSkills, slashIndex, commitSlash, onSend, commandHistory, input, savedInput]);

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

  const handleModeChange = useCallback((mode: 'manual' | 'risk' | 'auto') => {
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

  const hasContent = input.trim().length > 0;

  return (
    <div
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
          className="px-3 py-1.5 flex items-center gap-2 text-[12px] border-b"
          style={{
            backgroundColor: isDark ? 'rgba(99, 102, 241, 0.12)' : 'rgba(99, 102, 241, 0.08)',
            borderColor: colors.border,
            color: colors.textSystem,
          }}
        >
          <Clock size={14} style={{ flexShrink: 0, color: colors.harness }} />
          <span className="truncate flex-1">
            <span style={{ color: colors.harness, fontWeight: 600 }}>{t('inputArea.waiting')}</span>
            {queuedMessage}
          </span>
          <span className="text-[11px] whitespace-nowrap" style={{ color: colors.placeholder }}>
            {t('inputArea.resubmitToEdit')}
          </span>
        </div>
      )}
      {/* Server Load Warning Banner */}
      {serverLoadWarning && (
        <div
          className="px-3 py-1.5 flex items-start gap-2 text-[12px] border-b"
          style={{
            backgroundColor: 'rgba(239, 68, 68, 0.12)',
            borderColor: 'rgba(239, 68, 68, 0.3)',
            color: '#ef4444',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, marginTop: '1px' }}>
            <circle cx="8" cy="8" r="7" stroke="#ef4444" strokeWidth="1.5"/>
            <line x1="8" y1="4.5" x2="8" y2="9.5" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round"/>
            <circle cx="8" cy="11.5" r="0.8" fill="#ef4444"/>
          </svg>
          <span className="truncate flex-1 leading-relaxed">{serverLoadWarning}</span>
          <button
            onClick={onDismissServerLoad}
            className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-red-500/20 transition-colors"
            title={t('inputArea.dismiss')}
          >
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
              <path d="M9 3L3 9M3 3L9 9" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      )}
      {/* Row 1: Textarea with slash popup */}
      <div className="px-3 pt-2 pb-0.5 relative">
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
          <ContextProgressBar totalContextTokens={totalContextTokens} isDark={isDark} maxContextTokens={maxContextTokens} onClick={onCompress} colors={colors} />

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
                {fileHidden ? <EyeOff size={12} /> : <File size={12} />}
                {currentFile.split(/[/\\]/).pop()}
                {selectedLines && `:${selectedLines.start}${selectedLines.start !== selectedLines.end ? `~${selectedLines.end}` : ''}`}
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <ToggleMenu
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
            colors={colors}
            isDark={isDark}
          />
          <AgentModeSelector
            agentMode={agentMode}
            onModeChange={handleModeChange}
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
            <Square size={12} className="text-white" />
          </button>
          <button
            onClick={onSend}
            disabled={!hasContent || isInputDisabled}
            className={`w-7 h-7 rounded-lg flex items-center justify-center transition-all ${hasContent && !isInputDisabled ? 'hover:brightness-110' : ''}`}
            style={{
              backgroundColor: hasContent && !isInputDisabled ? colors.harness : colors.border,
              opacity: hasContent && !isInputDisabled ? 1 : 0.5,
            }}
          >
            <Send size={14} className="text-white" />
          </button>
        </div>
      </div>
    </div>
  );
});

export default memo(InputArea);
