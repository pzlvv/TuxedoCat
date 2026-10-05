/**
 * 覆盖层族（docs/tui.md 第 7.3 节）。
 *
 * - MenuOverlay：通用列表菜单（会话切换 / 模型 / 配置 / 斜杠命令），方向键 + 数字 +
 *   Enter 确认、Esc 取消、输入即过滤；
 * - ChoiceOverlay：requestUserChoice 的应答（数字/方向键 + Enter；Esc 转自由输入，
 *   自由输入提交 `{ index: -1, reply }`——与 webview 的语义一致）；
 * - InputOverlay：单行文本输入（重命名等）；
 * - DocumentOverlay：全屏只读查看（虚拟文档 / diff），j/k/方向键滚动、q/Esc 关闭。
 *
 * 覆盖层是渲染层概念：pending 的事实都在 store，这里只有导航类局部状态。
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { tt } from '../../../host/i18n.js';
import type { TuiOverlay, TuiPendingChoice } from '../../store.js';

// ── 通用列表菜单 ──

export interface MenuItem {
  key: string;
  label: string;
  hint?: string;
}

export function MenuOverlay(props: {
  title: string;
  items: ReadonlyArray<MenuItem>;
  onSelect(item: MenuItem): void;
  onCancel(): void;
}): React.ReactElement {
  const { title, items, onSelect, onCancel } = props;
  const [cursor, setCursor] = useState(0);
  const [filter, setFilter] = useState('');
  const filtered = items.filter((item) => filter.length === 0
    || item.label.toLowerCase().includes(filter.toLowerCase())
    || item.key.toLowerCase().includes(filter.toLowerCase()));
  const clamped = filtered.length === 0 ? 0 : Math.min(cursor, filtered.length - 1);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      const selected = filtered[clamped];
      if (selected) onSelect(selected);
      return;
    }
    if (key.upArrow) {
      setCursor(clamped > 0 ? clamped - 1 : filtered.length - 1);
      return;
    }
    if (key.downArrow) {
      setCursor(clamped < filtered.length - 1 ? clamped + 1 : 0);
      return;
    }
    if (key.backspace) {
      setFilter((f) => f.slice(0, -1));
      setCursor(0);
      return;
    }
    if (key.tab || key.ctrl || key.meta) return;
    if (input.length > 0) {
      setFilter((f) => f + input);
      setCursor(0);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">{title}</Text>
      {filter.length > 0 ? <Text dimColor>{`${tt('过滤', 'filter')}: ${filter}`}</Text> : null}
      {filtered.length === 0 ? <Text dimColor>{tt('（无匹配项）', '(no matches)')}</Text> : null}
      {filtered.slice(0, 12).map((item, i) => (
        <Box key={item.key}>
          <Text color={i === clamped ? 'cyan' : 'gray'}>{i === clamped ? '❯ ' : '  '}</Text>
          <Text color={i === clamped ? 'white' : 'gray'}>{item.label}</Text>
          {item.hint ? <Text dimColor>{`  ${item.hint}`}</Text> : null}
        </Box>
      ))}
      {filtered.length > 12 ? <Text dimColor>{`… (+${filtered.length - 12})`}</Text> : null}
      <Text dimColor>{tt('↑↓ 选择 · Enter 确认 · 输入过滤 · Esc 取消', '↑↓ select · Enter confirm · type to filter · Esc cancel')}</Text>
    </Box>
  );
}

// ── 用户选择 / 权限确认 ──

export function ChoiceOverlay(props: {
  choice: TuiPendingChoice;
  onRespond(index: number): void;
  onReply(text: string): void;
}): React.ReactElement {
  const { choice, onRespond, onReply } = props;
  const [cursor, setCursor] = useState(0);
  const [freeInput, setFreeInput] = useState<string | null>(null);

  useInput((input, key) => {
    if (freeInput === null) {
      if (key.escape) {
        setFreeInput('');
        return;
      }
      if (key.return) {
        onRespond(cursor);
        return;
      }
      if (key.upArrow) {
        setCursor(cursor > 0 ? cursor - 1 : Math.max(0, choice.choices.length - 1));
        return;
      }
      if (key.downArrow) {
        setCursor(cursor < choice.choices.length - 1 ? cursor + 1 : 0);
        return;
      }
      if (key.ctrl || key.meta || key.tab) return;
      const digit = Number.parseInt(input, 10);
      if (input.length === 1 && !Number.isNaN(digit) && digit >= 1 && digit <= choice.choices.length) {
        onRespond(digit - 1);
      }
      return;
    }
    if (key.escape) {
      setFreeInput(null);
      return;
    }
    if (key.return) {
      const text = freeInput.trim();
      if (text.length > 0) onReply(text);
      return;
    }
    if (key.backspace) {
      setFreeInput(freeInput.slice(0, -1));
      return;
    }
    if (key.ctrl || key.meta || key.tab) return;
    if (input.length > 0) setFreeInput(freeInput + input);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        {choice.toolName ? `[${choice.toolName}] ` : ''}
        {choice.message}
      </Text>
      {freeInput === null ? (
        <>
          {choice.choices.map((c, i) => (
            <Box key={`${c.label}-${i}`}>
              <Text color={i === cursor ? 'yellow' : 'gray'}>{i === cursor ? '❯ ' : '  '}</Text>
              <Text color={i === cursor ? 'white' : 'gray'}>{c.label}</Text>
              {c.description ? <Text dimColor>{`  ${c.description}`}</Text> : null}
            </Box>
          ))}
          <Text dimColor>{tt('↑↓/数字 选择 · Enter 确认 · Esc 转自由输入', '↑↓/digit select · Enter confirm · Esc free input')}</Text>
        </>
      ) : (
        <>
          <Text>{freeInput}<Text color="yellow">▌</Text></Text>
          <Text dimColor>{tt('Enter 提交 · Esc 返回选项', 'Enter submit · Esc back to options')}</Text>
        </>
      )}
    </Box>
  );
}

// ── 单行文本输入（重命名 / 自由文本） ──

export function InputOverlay(props: {
  title: string;
  initial: string;
  onSubmit(text: string): void;
  onCancel(): void;
}): React.ReactElement {
  const [value, setValue] = useState(props.initial);
  useInput((input, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (key.return) {
      props.onSubmit(value);
      return;
    }
    if (key.backspace) {
      setValue((v) => v.slice(0, -1));
      return;
    }
    if (key.ctrl || key.meta || key.tab) return;
    if (input.length > 0) setValue((v) => v + input);
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">{props.title}</Text>
      <Text>{value}<Text color="cyan">▌</Text></Text>
      <Text dimColor>{tt('Enter 提交 · Esc 取消', 'Enter submit · Esc cancel')}</Text>
    </Box>
  );
}

// ── 全屏只读文档 / diff ──

export function DocumentOverlay(props: { overlay: TuiOverlay; onClose(): void }): React.ReactElement {
  const { overlay, onClose } = props;
  const [offset, setOffset] = useState(0);
  const total = overlay.lines.length;
  const visible = 24;
  const maxOffset = Math.max(0, total - visible);
  const clamped = Math.min(offset, maxOffset);
  const slice = overlay.lines.slice(clamped, clamped + visible);

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onClose();
      return;
    }
    if (key.downArrow || input === 'j') {
      setOffset(Math.min(clamped + 1, maxOffset));
      return;
    }
    if (key.upArrow || input === 'k') {
      setOffset(Math.max(clamped - 1, 0));
      return;
    }
    if (key.pageDown) {
      setOffset(Math.min(clamped + visible, maxOffset));
      return;
    }
    if (key.pageUp) {
      setOffset(Math.max(clamped - visible, 0));
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta">{overlay.title}{`  (${clamped + 1}-${Math.min(clamped + visible, total)}/${total})`}</Text>
      {slice.map((line, i) => (
        <Text key={i} color={line.color === 'white' ? undefined : line.color} wrap="truncate-end">{line.text || ' '}</Text>
      ))}
      <Text dimColor>{tt('j/k/↑↓ 滚动 · PgUp/PgDn 翻页 · q/Esc 关闭', 'j/k/↑↓ scroll · PgUp/PgDn page · q/Esc close')}</Text>
    </Box>
  );
}
