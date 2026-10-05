/**
 * 底部多行编辑器（docs/tui.md 第 7.2 节；风险 11.1 #3「多行编辑器是最大单点」的可用版）。
 *
 * 能力：输入 / 粘贴（含多行，粘贴的换行原样保留）、退格、删除、方向键移动、
 * Ctrl+U 清行、Ctrl+O 插入换行、Enter 发送。状态机是 `src/tui/composerState.ts`
 * 的纯函数（CJS 作用域，可单测）；本组件只持有状态与接键。
 *
 * 键位的现实约束（终端无法区分的组合不承诺）：
 * - 多数终端里 Shift+Enter 与 Enter 同码（\r），换行用 Ctrl+O（emacs open-line 习惯）；
 * - Ctrl+J 在部分终端解析为 \n（等同 Enter），此处仍按换行处理以防万一。
 * IME / 撤销 / 富编辑不在 v1 范围。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { tt } from '../../../host/i18n.js';
import {
  applyInput,
  editorText,
  initialEditor,
  insertNewline,
  insertText,
  type EditorState,
} from '../../composerState.js';

export interface ComposerProps {
  /** 是否接收按键（覆盖层打开时让位） */
  active: boolean;
  /** 占位提示（等待态文案由 App 决定） */
  placeholder: string;
  onSubmit(text: string): void;
  /** 内容有无变化上报（App 据此决定 Esc 的语义：清空还是 abort） */
  onEmptyChange(empty: boolean): void;
  /** 外部注入文本（斜杠命令菜单选择后回填），seq 单调递增触发一次 */
  preset?: { text: string; seq: number } | null;
  /** 空编辑器按下 '/' 时请求打开斜杠命令菜单 */
  onSlashRequest?(): void;
}

export function Composer(props: ComposerProps): React.ReactElement {
  const { active, placeholder, onSubmit, onEmptyChange, preset, onSlashRequest } = props;
  const [editor, setEditor] = useState<EditorState>(initialEditor);
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const presetSeqRef = useRef(preset?.seq ?? 0);

  const empty = editor.lines.every((l) => l.length === 0);
  useEffect(() => {
    onEmptyChange(empty);
  }, [empty, onEmptyChange]);

  // 外部注入文本（斜杠菜单回填）：每个 seq 只消费一次
  useEffect(() => {
    if (preset && preset.seq !== presetSeqRef.current) {
      presetSeqRef.current = preset.seq;
      setEditor((prev) => insertText(prev, preset.text));
    }
  }, [preset]);

  const submit = useCallback(() => {
    const text = editorText(editorRef.current);
    if (text.trim().length === 0) return;
    setEditor(initialEditor());
    onSubmit(text);
  }, [onSubmit]);

  useInput((input, key) => {
    if (key.return) {
      submit();
      return;
    }
    if (key.ctrl && (input === 'o' || input === 'j')) {
      setEditor((prev) => insertNewline(prev));
      return;
    }
    if (key.ctrl && input === 'u') {
      setEditor((prev) => ({ ...prev, lines: Object.assign([...prev.lines], { [prev.row]: '' }), col: 0 }));
      return;
    }
    if (key.escape) {
      // Esc 的清空 / abort 语义由 App 决定；编辑器只负责清空自己
      setEditor(initialEditor());
      return;
    }
    if (input === '/' && editorRef.current.lines.every((l) => l.length === 0) && onSlashRequest) {
      setEditor((prev) => insertText(prev, '/'));
      onSlashRequest();
      return;
    }
    setEditor((prev) => applyInput(prev, input, key));
  }, { isActive: active });

  const renderedLines = editor.lines.length > 6 ? editor.lines.slice(-6) : editor.lines;
  const hiddenLines = editor.lines.length - renderedLines.length;
  const renderRow = editor.row - hiddenLines;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={active ? 'cyan' : 'gray'}>
      {empty ? (
        <Text dimColor>{placeholder}</Text>
      ) : (
        renderedLines.map((line, i) => (
          <Text key={i}>
            {line}
            {active && i === renderRow ? <Text color="cyan">▌</Text> : null}
            {line.length === 0 && !(active && i === renderRow) ? ' ' : null}
          </Text>
        ))
      )}
      {hiddenLines > 0 ? <Text dimColor>{`… (+${hiddenLines})`}</Text> : null}
      <Text dimColor>
        {tt('Enter 发送 · Ctrl+O 换行 · Ctrl+L 会话 · Ctrl+M 模型 · Ctrl+K 配置 · Esc 中止/清空', 'Enter send · Ctrl+O newline · Ctrl+L sessions · Ctrl+M model · Ctrl+K config · Esc abort/clear')}
      </Text>
    </Box>
  );
}
