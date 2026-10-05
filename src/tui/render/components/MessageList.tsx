/**
 * 消息流渲染（docs/tui.md 第 7.1 节布局的上段）。
 *
 * 按角色分形：用户气泡 / assistant markdown / thinking 折叠行 / 工具卡片 / 系统行；
 * 流式块（spinner + 累积文本）在消息尾部渲染。组件是 store 的纯投影——
 * 不持有任何业务事实。
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Spinner } from './Spinner.js';
import { Markdown } from '../markdown.js';
import { tt } from '../../../host/i18n.js';
import type { TuiMessage, TuiSessionState } from '../../store.js';

/** 工具卡片：状态图标 + 工具名 + 输出摘要（前几行；完整输出经 showVirtualDocument 查看） */
function ToolCard({ message }: { message: TuiMessage }): React.ReactElement {
  const lines = message.content.split('\n').filter((l) => l.length > 0);
  const shown = lines.slice(0, 4);
  const hidden = Math.min(lines.length - shown.length, 99);
  return (
    <Box flexDirection="row" marginLeft={1}>
      <Box flexDirection="column">
        <Text>
          {message.status === 'running' ? <Spinner /> : null}
          {message.status === 'success' ? <Text color="green">✓ </Text> : null}
          {message.status === 'fail' ? <Text color="red">✗ </Text> : null}
          {message.status === 'normal' ? <Text color="gray">· </Text> : null}
          <Text bold color={message.status === 'fail' ? 'red' : 'white'}>{message.toolName ?? 'tool'}</Text>
        </Text>
        {shown.map((line, i) => (
          <Text key={i} dimColor wrap="truncate-end">{'  '}{line}</Text>
        ))}
        {hidden > 0 ? <Text dimColor>{`  … (+${hidden} ${tt('行', 'lines')})`}</Text> : null}
      </Box>
    </Box>
  );
}

function MessageRow({ message }: { message: TuiMessage }): React.ReactElement {
  switch (message.role) {
    case 'user':
      return (
        <Box>
          <Text color="cyan" bold>{tt('你', 'You')}{': '}</Text>
          <Text>{message.content}</Text>
        </Box>
      );
    case 'assistant':
      return (
        <Box flexDirection="column">
          <Markdown text={message.content} />
        </Box>
      );
    case 'thinking': {
      const firstLine = message.content.split('\n')[0] ?? '';
      const preview = firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
      return (
        <Box>
          <Text dimColor italic>{tt('· 思考', '· thinking')} </Text>
          <Text dimColor>{preview}</Text>
        </Box>
      );
    }
    case 'system':
      return (
        <Box>
          <Text color="yellow">{tt('系统', 'system')}{': '}</Text>
          <Text color="yellow">{message.content}</Text>
        </Box>
      );
    case 'toolcall':
      return <ToolCard message={message} />;
  }
}

/** 消息流（活动会话投影 + 流式块 + 排队提示） */
export function MessageList({ session }: { session: TuiSessionState }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {session.messages.map((message) => (
        <MessageRow key={message.id} message={message} />
      ))}
      {session.stream !== null ? (
        <Box flexDirection="column">
          {session.stream.role === 'thinking' ? (
            <Box>
              <Text dimColor italic>{tt('· 思考中…', '· thinking…')} </Text>
              <Text dimColor>{session.stream.text.split('\n').slice(-1)[0] ?? ''}</Text>
            </Box>
          ) : (
            <Markdown text={session.stream.text} />
          )}
        </Box>
      ) : null}
      {session.showThinking && session.stream === null ? (
        <Box>
          <Spinner />
          <Text> {tt('思考中…', 'Thinking…')}</Text>
        </Box>
      ) : null}
      {session.queued !== null ? (
        <Box>
          <Text color="magenta">{tt('排队中', 'Queued')}{': '}</Text>
          <Text dimColor>{session.queued.content}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
