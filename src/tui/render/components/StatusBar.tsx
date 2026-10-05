/**
 * 状态栏（docs/tui.md 第 7.1 节布局的中段，1 行）。
 *
 * 工作目录 · 模型 · 模式标志 · 会话流水灯 · 上下文 tokens。全部只读 store 投影
 * （runtimeStates / contextTokens / maxContextTokens），不自持状态。
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { SessionRuntimeState } from '../../../core/AssistantEventBus.js';
import type { TuiState } from '../../store.js';

const RUNTIME_COLOR: Record<string, string> = {
  idle: 'green',
  waiting: 'yellow',
  running: 'cyan',
  compacting: 'magenta',
  background: 'magenta',
  subagent: 'magenta',
};

function runtimeDot(state: SessionRuntimeState | null): string {
  if (!state) return '○';
  if (state.compacting || state.backgroundRunning || state.subAgentRunning) return '◍';
  if (state.queryRunning) return '●';
  if (state.waiting) return '◑';
  return '○';
}

function formatTokens(tokens: number): string {
  if (tokens <= 0) return '-';
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

export function StatusBar(props: {
  state: TuiState;
  workspacePath: string;
  runtime: SessionRuntimeState | null;
  runtimeName: string;
}): React.ReactElement {
  const { state, workspacePath, runtime, runtimeName } = props;
  const session = state.activeSessionId !== null ? state.sessions[state.activeSessionId] : undefined;
  const dirName = workspacePath.split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? workspacePath;
  const model = session?.model ?? state.settingsDefaults?.model ?? '…';
  const contextMax = state.maxContextTokens;
  return (
    <Box borderStyle="single" borderTop={false} borderLeft={false} borderRight={false} borderColor="gray">
      <Text color="blue">{dirName}</Text>
      <Text dimColor>{' │ '}</Text>
      <Text color="white">{model}</Text>
      {session?.agentMode ? <Text color={session.agentMode === 'auto' ? 'red' : session.agentMode === 'risk' ? 'yellow' : 'green'}>{` ${session.agentMode}`}</Text> : null}
      {session?.thinkingMode && session.thinkingMode !== 'off' ? <Text color="magenta">{` ✦${session.thinkingMode}`}</Text> : null}
      {session?.webSearch ? <Text color="cyan">{' ⌕web'}</Text> : null}
      <Text dimColor>{' │ '}</Text>
      <Text color={(runtime && RUNTIME_COLOR[runtimeName]) || 'gray'}>{runtimeDot(runtime)}</Text>
      {runtimeName ? <Text dimColor>{` ${runtimeName}`}</Text> : null}
      <Text dimColor>{' │ '}</Text>
      <Text dimColor>{`${formatTokens(session?.contextTokens ?? 0)}${contextMax ? `/${formatTokens(contextMax)}` : ''} tok`}</Text>
      {state.balance ? <Text dimColor>{` │ $${state.balance.totalBalance.toFixed(2)}`}</Text> : null}
    </Box>
  );
}
