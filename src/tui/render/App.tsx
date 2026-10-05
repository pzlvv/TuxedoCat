/**
 * Ink 根组件（docs/tui.md 第 7 节交互设计）。
 *
 * 职责收敛在三件事：
 * - 把 store（唯一渲染事实）经 useSyncExternalStore 投影成布局：
 *   消息流 / 状态栏 / 编辑器 / 覆盖层；
 * - 键盘路由：同一时刻只有一个交互面接键（覆盖层栈优先级见 focus 计算）；
 * - 把用户操作组装成 WebviewToHostMessage 经注入的 send() 上行——与 webview 的
 *   React 组件完全同位，不碰 AssistantEventBus。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, useInput } from 'ink';
import { randomUUID } from 'crypto';
import type { WebviewToHostMessage } from '../../host/webviewMessages.js';
import { tt } from '../../host/i18n.js';
import {
  activeSession,
  runtimeOf,
  runtimeLabel,
  type TuiStore,
} from '../store.js';
import { MessageList } from './components/MessageList.js';
import { StatusBar } from './components/StatusBar.js';
import { Composer } from './components/Composer.js';
import {
  ChoiceOverlay,
  DocumentOverlay,
  InputOverlay,
  MenuOverlay,
  type MenuItem,
} from './components/Overlays.js';

/** 渲染上限：超过后头部折叠（终端整帧重绘，超长历史会拖慢流式帧率） */
const MAX_RENDERED_MESSAGES = 150;

/** 覆盖层栈以外的菜单 / 输入框状态（本地导航事实，不进 store） */
type Menu =
  | { kind: 'sessions' }
  | { kind: 'deleteConfirm'; sessionId: string }
  | { kind: 'rename'; sessionId: string; initial: string }
  | { kind: 'providers' }
  | { kind: 'models'; provider: string }
  | { kind: 'config' }
  | { kind: 'agentMode' }
  | { kind: 'thinkingMode' }
  | { kind: 'promptMode' }
  | { kind: 'mcp' }
  | { kind: 'slash' };

export interface TuiAppProps {
  store: TuiStore;
  workspacePath: string;
  send(message: WebviewToHostMessage): void;
}

export function TuiApp(props: TuiAppProps): React.ReactElement {
  const { store, workspacePath, send } = props;
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const session = activeSession(state);
  const pendingChoice = state.pendingChoice;
  const runtime = runtimeOf(state, state.activeSessionId);

  const [menu, setMenu] = useState<Menu | null>(null);
  const [composerEmpty, setComposerEmpty] = useState(true);
  const [preset, setPreset] = useState<{ text: string; seq: number } | null>(null);
  const startedRef = useRef(false);

  // ── 启动序列（对齐 webview 挂载行为：拉取全局事实 + 建立「新对话」会话） ──
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    send({ type: 'getConversations' });
    send({ type: 'requestSessionRuntimeStates' });
    send({ type: 'requestSkills' });
    send({ type: 'requestModels' });
    send({ type: 'requestSettingsDefaults' });
    send({ type: 'requestContextLimit' });
    const sessionId = randomUUID();
    store.dispatch({ type: 'tui:activateSession', sessionId });
    send({ type: 'startNewConversation', sessionId });
  }, [send, store]);

  // ── 通知按时效消散（8s） ──
  useEffect(() => {
    if (state.notices.length === 0) return;
    const timer = setInterval(() => {
      const now = Date.now();
      for (const notice of store.getState().notices) {
        if (now - notice.at > 8000) store.dispatch({ type: 'tui:dismissNotice', id: notice.id });
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [state.notices.length, store]);

  // ── 发送消息（会话配置带上已到达的事实；未到达的字段不猜） ──
  const submitMessage = useCallback((content: string) => {
    const sessionId = store.getState().activeSessionId;
    if (!sessionId) return;
    const current = store.getState().sessions[sessionId];
    send({
      type: 'sendMessage',
      sessionId,
      content,
      ...(current?.model ? { model: current.model } : {}),
      ...(current?.model && current?.provider ? { provider: current.provider } : {}),
      ...(current?.agentMode ? { agentMode: current.agentMode } : {}),
      ...(current?.thinkingMode ? { thinkingMode: current.thinkingMode } : {}),
      ...(current?.webSearch !== null && current?.webSearch !== undefined ? { webSearch: current.webSearch } : {}),
    });
  }, [send, store]);

  // ── 会话操作 ──
  const newConversation = useCallback(() => {
    const sessionId = randomUUID();
    store.dispatch({ type: 'tui:activateSession', sessionId });
    send({ type: 'startNewConversation', sessionId });
  }, [send, store]);

  const openConversation = useCallback((sessionId: string) => {
    store.dispatch({ type: 'tui:activateSession', sessionId });
    send({ type: 'loadConversation', sessionId });
  }, [send, store]);

  // ── 键盘路由：全局快捷键只在编辑器接管时仍可用的 ctrl 组合上生效 ──
  const focus = state.overlay !== null
    ? 'overlay'
    : state.pendingChoice !== null
      ? 'choice'
      : menu !== null
        ? 'menu'
        : 'composer';
  const composerActive = focus === 'composer';
  const choiceActive = focus === 'choice';
  const menuActive = focus === 'menu';
  const overlayActive = focus === 'overlay';

  useInput((input, key) => {
    // Ctrl+L / Ctrl+M / Ctrl+K 在任何焦点下都可呼出菜单（覆盖层除外）
    if (key.ctrl && (input === 'l' || input === 'm' || input === 'k') && !overlayActive) {
      setMenu(input === 'l' ? { kind: 'sessions' } : input === 'm' ? { kind: 'providers' } : { kind: 'config' });
      return;
    }
    if (key.escape && focus === 'composer') {
      // 编辑器有内容时 Esc 清空（Composer 自理）；无内容时中止当前查询
      if (composerEmpty) {
        const sessionId = store.getState().activeSessionId;
        if (sessionId) send({ type: 'abort', sessionId });
      }
    }
  });

  // ── 菜单项构造 ──
  const sessionItems = useMemo<MenuItem[]>(() => {
    const items: MenuItem[] = [
      { key: '__new__', label: tt('＋ 新建对话', '+ New conversation') },
    ];
    const sorted = [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
    for (const conversation of sorted.slice(0, 30)) {
      const stateOf = state.runtimeStates.find((s) => s.sessionId === conversation.sessionId);
      const dot = stateOf?.queryRunning ? '● ' : stateOf?.waiting ? '◑ ' : '';
      items.push({
        key: conversation.sessionId,
        label: `${dot}${conversation.title}`,
        hint: `${new Date(conversation.updatedAt).toLocaleDateString()} · ${conversation.messageCount}`,
      });
    }
    return items;
  }, [state.conversations, state.runtimeStates]);

  const slashItems = useMemo<MenuItem[]>(() => state.skills.map((skill) => ({
    key: skill.name,
    label: `/${skill.name}`,
    hint: skill.description,
  })), [state.skills]);

  const configItems = useMemo<MenuItem[]>(() => [
    { key: 'agentMode', label: `${tt('代理模式', 'Agent mode')}: ${session?.agentMode ?? '-'}`, hint: 'manual/risk/auto' },
    { key: 'thinkingMode', label: `${tt('思考强度', 'Thinking')}: ${session?.thinkingMode ?? '-'}`, hint: 'off/low/high/max' },
    { key: 'promptMode', label: `${tt('提示词模式', 'Prompt mode')}: ${session?.promptMode ?? '-'}`, hint: 'normal/minimal/mixed' },
    { key: 'webSearch', label: `${tt('联网搜索', 'Web search')}: ${session?.webSearch === null || session?.webSearch === undefined ? '-' : session.webSearch ? 'on' : 'off'}` },
    { key: 'mcp', label: tt('MCP 服务器', 'MCP servers') },
    { key: 'compact', label: tt('压缩上下文', 'Compact context') },
  ], [session]);

  const onMenuSelect = useCallback((item: MenuItem) => {
    const sessionId = store.getState().activeSessionId;
    switch (menu?.kind) {
      case 'sessions':
        if (item.key === '__new__') newConversation();
        else openConversation(item.key);
        setMenu(null);
        return;
      case 'deleteConfirm':
        if (item.key === 'delete') {
          const target = menu.sessionId;
          send({ type: 'deleteConversation', sessionId: target });
          if (store.getState().activeSessionId === target) newConversation();
        }
        setMenu(null);
        return;
      case 'rename':
        return; // rename 走 InputOverlay，不走 MenuOverlay
      case 'providers':
        setMenu({ kind: 'models', provider: item.key });
        return;
      case 'models':
        if (sessionId) {
          send({ type: 'setModel', sessionId, model: item.key, provider: menu.provider });
        }
        setMenu(null);
        return;
      case 'config':
        if (item.key === 'compact') {
          if (sessionId) send({ type: 'requestCompress', sessionId });
          setMenu(null);
          return;
        }
        setMenu({ kind: item.key as 'agentMode' | 'thinkingMode' | 'promptMode' | 'mcp' });
        return;
      case 'agentMode':
        if (sessionId) send({ type: 'setAgentMode', sessionId, mode: item.key as 'manual' | 'risk' | 'auto' });
        setMenu(null);
        return;
      case 'thinkingMode':
        if (sessionId) send({ type: 'setThinkingMode', sessionId, mode: item.key as 'off' | 'low' | 'high' | 'max' });
        setMenu(null);
        return;
      case 'promptMode':
        if (sessionId) send({ type: 'setPromptMode', sessionId, mode: item.key as 'normal' | 'minimal' | 'mixed' });
        setMenu(null);
        return;
      case 'mcp':
        if (sessionId) send({ type: 'setMcpEnabled', sessionId, name: item.key, enabled: !item.hint?.startsWith('[✓]') });
        send({ type: 'requestMcpServers', sessionId: sessionId ?? undefined });
        return; // 保持菜单开着，连续切换
      case 'slash':
        setPreset((prev) => ({ text: `${item.key} `, seq: (prev?.seq ?? 0) + 1 }));
        setMenu(null);
        return;
      default:
        setMenu(null);
    }
  }, [menu, newConversation, openConversation, send, store]);

  const menuNode = useMemo(() => {
    if (!menu || !menuActive) return null;
    const cancel = () => setMenu(null);
    switch (menu.kind) {
      case 'sessions':
        return (
          <MenuOverlay
            title={tt('会话', 'Sessions')}
            items={[...sessionItems, { key: '__rename__', label: tt('重命名当前会话', 'Rename current session') }, { key: '__smart__', label: tt('智能命名当前会话', 'Smart-name current session') }, { key: '__delete__', label: tt('删除当前会话', 'Delete current session') }]}
            onSelect={(item) => {
              const sessionId = store.getState().activeSessionId;
              if (item.key === '__rename__' && sessionId) {
                setMenu({ kind: 'rename', sessionId, initial: store.getState().sessions[sessionId]?.title ?? '' });
                return;
              }
              if (item.key === '__smart__' && sessionId) {
                send({ type: 'requestSmartNaming', sessionId });
                setMenu(null);
                return;
              }
              if (item.key === '__delete__' && sessionId) {
                setMenu({ kind: 'deleteConfirm', sessionId });
                return;
              }
              onMenuSelect(item);
            }}
            onCancel={cancel}
          />
        );
      case 'deleteConfirm':
        return (
          <MenuOverlay
            title={tt('确认删除该会话？（不可恢复）', 'Delete this conversation? (irrecoverable)')}
            items={[{ key: 'cancel', label: tt('取消', 'Cancel') }, { key: 'delete', label: tt('删除', 'Delete') }]}
            onSelect={onMenuSelect}
            onCancel={cancel}
          />
        );
      case 'providers': {
        const providers = state.models?.providers ?? [];
        return (
          <MenuOverlay
            title={tt('选择服务商', 'Choose provider')}
            items={providers.map((p) => ({ key: p.key, label: p.key, hint: `${p.models.length}` }))}
            onSelect={onMenuSelect}
            onCancel={cancel}
          />
        );
      }
      case 'models': {
        const provider = state.models?.providers.find((p) => p.key === menu.provider);
        return (
          <MenuOverlay
            title={`${tt('模型', 'Model')} · ${menu.provider}`}
            items={(provider?.models ?? []).map((m) => ({ key: m, label: m }))}
            onSelect={onMenuSelect}
            onCancel={() => setMenu({ kind: 'providers' })}
          />
        );
      }
      case 'config':
        return <MenuOverlay title={tt('会话配置', 'Session config')} items={configItems} onSelect={onMenuSelect} onCancel={cancel} />;
      case 'agentMode':
        return <MenuOverlay title={tt('代理模式', 'Agent mode')} items={['manual', 'risk', 'auto'].map((m) => ({ key: m, label: m }))} onSelect={onMenuSelect} onCancel={() => setMenu({ kind: 'config' })} />;
      case 'thinkingMode':
        return <MenuOverlay title={tt('思考强度', 'Thinking effort')} items={['off', 'low', 'high', 'max'].map((m) => ({ key: m, label: m }))} onSelect={onMenuSelect} onCancel={() => setMenu({ kind: 'config' })} />;
      case 'promptMode':
        return <MenuOverlay title={tt('提示词模式', 'Prompt mode')} items={['normal', 'minimal', 'mixed'].map((m) => ({ key: m, label: m }))} onSelect={onMenuSelect} onCancel={() => setMenu({ kind: 'config' })} />;
      case 'mcp':
        return (
          <MenuOverlay
            title={tt('MCP 服务器', 'MCP servers')}
            items={(state.mcpServers ?? []).map((s) => ({ key: s.name, label: s.name, hint: s.enabled ? '[✓]' : '[ ]' }))}
            onSelect={onMenuSelect}
            onCancel={() => setMenu({ kind: 'config' })}
          />
        );
      case 'slash':
        return <MenuOverlay title={tt('斜杠命令 / 技能', 'Slash commands / skills')} items={slashItems} onSelect={onMenuSelect} onCancel={cancel} />;
      default:
        return null;
    }
  }, [menu, menuActive, sessionItems, configItems, slashItems, state.models, state.mcpServers, onMenuSelect, send, store]);

  // 打开 MCP 菜单时拉取一次服务器列表（按会话解析启用状态）
  useEffect(() => {
    if (menu?.kind === 'mcp') {
      send({ type: 'requestMcpServers', sessionId: store.getState().activeSessionId ?? undefined });
    }
  }, [menu, send, store]);

  const renderedSession = session;
  const hiddenCount = renderedSession && renderedSession.messages.length > MAX_RENDERED_MESSAGES
    ? renderedSession.messages.length - MAX_RENDERED_MESSAGES
    : 0;

  return (
    <Box flexDirection="column">
      {/* 通知条（最新几条，按时效消散） */}
      {state.notices.length > 0 ? (
        <Box flexDirection="column">
          {state.notices.slice(-3).map((notice) => (
            <Text key={notice.id} color={notice.level === 'error' ? 'red' : notice.level === 'warn' ? 'yellow' : 'green'}>
              {`≡ ${notice.text}`}
            </Text>
          ))}
        </Box>
      ) : null}

      {/* 消息流（等待态显式表达：无会话 / 会话未加载都是「选择或新建」空态） */}
      {renderedSession === null ? (
        <Box flexDirection="column" paddingY={1}>
          <Text dimColor>{tt('尚未打开会话。', 'No conversation open yet.')}</Text>
          <Text dimColor>{tt('Ctrl+L 选择 / 新建会话', 'Ctrl+L to pick / start a conversation')}</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {hiddenCount > 0 ? <Text dimColor>{`… (+${hiddenCount} ${tt('更早的消息', 'earlier messages')})`}</Text> : null}
          <MessageList session={renderedSession} />
        </Box>
      )}

      <StatusBar state={state} workspacePath={workspacePath} runtime={runtime} runtimeName={runtimeLabel(runtime)} />

      {/* 覆盖层（栈：文档/diff > 用户选择 > 菜单；互斥接键） */}
      {state.overlay !== null && overlayActive ? (
        <DocumentOverlay overlay={state.overlay} onClose={() => store.dispatch({ type: 'tui:closeOverlay' })} />
      ) : null}
      {pendingChoice !== null && choiceActive ? (
        <ChoiceOverlay
          choice={pendingChoice}
          onRespond={(index) => send({ type: 'respondUserChoice', choiceId: pendingChoice.choiceId, index })}
          onReply={(text) => send({ type: 'respondUserChoice', choiceId: pendingChoice.choiceId, index: -1, reply: text })}
        />
      ) : null}
      {menuNode}
      {menu?.kind === 'rename' ? (
        <InputOverlay
          title={tt('重命名会话', 'Rename conversation')}
          initial={menu.initial}
          onSubmit={(text) => {
            send({ type: 'renameConversation', sessionId: menu.sessionId, title: text });
            setMenu(null);
          }}
          onCancel={() => setMenu(null)}
        />
      ) : null}

      <Composer
        active={composerActive}
        placeholder={state.activeSessionId === null
          ? tt('Ctrl+L 选择 / 新建会话', 'Ctrl+L to pick / start a conversation')
          : tt('输入消息，Enter 发送；/ 查看斜杠命令', 'Type a message, Enter to send; / for slash commands')}
        onSubmit={submitMessage}
        onEmptyChange={setComposerEmpty}
        preset={preset}
        onSlashRequest={() => setMenu({ kind: 'slash' })}
      />
    </Box>
  );
}
