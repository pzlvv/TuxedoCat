/**
 * Markdown → Ink 元素映射（docs/tui.md 第 3.2 节）。
 *
 * marked 解析 + 自研「AST → Ink」映射（不依赖现成 Ink markdown 组件）；
 * v1 控制在常用子集（标题 / 强调 / 代码 / 列表 / 引用 / 表格 / 链接 / 分隔线），
 * 语法高亮（shiki ANSI）不在 v1 范围。原生 HTML 片段按字面文本展示（终端无 DOM）。
 *
 * marked 是 ESM-only：动态 import（与 `src/host/markdownHtml.ts` 同一用法），
 * 解析结果按原文缓存（同一条流式消息反复重渲染不重复解析）。
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';

/** 结构化最小渲染器（不把 marked 的泛型与重载漏给组件层） */
interface SyncLexer {
  lexer(src: string, options?: unknown): unknown[];
}

let lexerSingleton: Promise<SyncLexer> | undefined;

function loadLexer(): Promise<SyncLexer> {
  lexerSingleton ??= (async () => {
    const { marked } = await import('marked');
    const instance = marked as unknown as { lexer(src: string, options?: unknown): unknown[] };
    return { lexer: (src: string, options?: unknown) => instance.lexer(src, options) };
  })();
  return lexerSingleton;
}

/** 解析缓存（key = 原文；流式消息每帧重渲染时命中） */
const parseCache = new Map<string, unknown[]>();

async function parseMarkdown(text: string): Promise<unknown[]> {
  const cached = parseCache.get(text);
  if (cached) return cached;
  const lexer = await loadLexer();
  const tokens = lexer.lexer(text);
  if (parseCache.size > 64) parseCache.clear(); // 粗粒度上限：防止长会话无限增长
  parseCache.set(text, tokens);
  return tokens;
}

// ── token 形状（marked 的结构子集；按字段存在性窄化，不引 marked 类型） ──

interface MarkdownToken {
  type?: string;
  raw?: string;
  text?: string;
  depth?: number;
  ordered?: boolean;
  start?: string | number;
  items?: MarkdownToken[];
  tokens?: MarkdownToken[];
  header?: MarkdownToken[];
  rows?: MarkdownToken[][];
  lang?: string;
  href?: string;
}

function inlineText(token: MarkdownToken | undefined): string {
  if (!token) return '';
  if (token.type === 'text' || token.type === 'escape' || token.type === 'codespan') {
    return token.text ?? token.raw ?? '';
  }
  if (token.tokens?.length) return token.tokens.map(inlineText).join('');
  return token.text ?? token.raw ?? '';
}

function inlineNodes(tokens: ReadonlyArray<MarkdownToken> | undefined, keyPrefix: string): React.ReactNode[] {
  if (!tokens?.length) return [];
  return tokens.map((token, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (token.type) {
      case 'strong':
        return <Text key={key} bold>{inlineNodes(token.tokens, key)}</Text>;
      case 'em':
        return <Text key={key} italic>{inlineNodes(token.tokens, key)}</Text>;
      case 'del':
        return <Text key={key} dimColor strikethrough>{inlineNodes(token.tokens, key)}</Text>;
      case 'codespan':
        return <Text key={key} color="cyan">{token.text ?? ''}</Text>;
      case 'link':
        return (
          <Text key={key} color="blue" underline>
            {inlineNodes(token.tokens, key)}
            {token.href ? ` (${token.href})` : ''}
          </Text>
        );
      case 'image':
        return <Text key={key} color="blue" underline>[img] {token.href ?? token.text ?? ''}</Text>;
      case 'html':
        return <Text key={key} dimColor>{(token.text ?? token.raw ?? '').trim()}</Text>;
      case 'br':
        return <React.Fragment key={key}>{'\n'}</React.Fragment>;
      default:
        // text / escape 等：内嵌行内 token 时递归，否则原样
        return token.tokens?.length
          ? <React.Fragment key={key}>{inlineNodes(token.tokens, key)}</React.Fragment>
          : <React.Fragment key={key}>{token.text ?? token.raw ?? ''}</React.Fragment>;
    }
  });
}

function blockNodes(tokens: ReadonlyArray<MarkdownToken> | undefined, keyPrefix: string, indent = 0): React.ReactNode[] {
  if (!tokens?.length) return [];
  return tokens.flatMap((token, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (token.type) {
      case 'heading': {
        const color = token.depth === 1 ? 'green' : token.depth === 2 ? 'cyan' : 'white';
        return [
          <Text key={key} bold color={color}>
            {inlineNodes(token.tokens, key)}
          </Text>,
        ];
      }
      case 'paragraph':
        return [<Text key={key}>{inlineNodes(token.tokens, key)}</Text>];
      case 'code':
        return [
          <Box key={key} flexDirection="column" borderStyle="round" borderColor="gray" paddingLeft={1} paddingRight={1}>
            {String(token.text ?? '')
              .replace(/\n$/, '')
              .split('\n')
              .map((line, li) => (
                <Text key={`${key}-l${li}`} color="cyan">{line || ' '}</Text>
              ))}
          </Box>,
        ];
      case 'blockquote':
        return [
          <Box key={key} flexDirection="column">
            {blockNodes(token.tokens, key, indent).map((node, bi) => (
              <Box key={`${key}-b${bi}`} flexDirection="row">
                <Text color="gray">▏ </Text>
                <Box flexDirection="column">{node}</Box>
              </Box>
            ))}
          </Box>,
        ];
      case 'list': {
        const items = token.items ?? [];
        return items.map((item, li) => {
          const marker = token.ordered ? `${Number(token.start ?? 1) + li}. ` : '• ';
          const plain = item.text && (!item.tokens || item.tokens.every((t) => t.type === 'text'))
            ? item.text
            : null;
          return (
            <Box key={`${key}-${li}`} flexDirection="row">
              <Text color="yellow">{marker}</Text>
              <Box flexDirection="column">
                {plain !== null
                  ? <Text>{plain}</Text>
                  : blockNodes(item.tokens, `${key}-${li}`, indent)}
              </Box>
            </Box>
          );
        });
      }
      case 'table': {
        const header = (token.header ?? []).map((h) => inlineText(h));
        const rows = (token.rows ?? []).map((r) => r.map((c) => inlineText(c)));
        const width = Math.max(header.length, ...rows.map((r) => r.length));
        const line = (cells: string[], isHeader = false) => (
          <Text key={`${key}-h${isHeader ? '1' : '0'}`} bold={isHeader}>
            {Array.from({ length: width }, (_, ci) => (cells[ci] ?? '').padEnd(14)).join(' │ ')}
          </Text>
        );
        return [
          <Box key={key} flexDirection="column" marginBottom={0}>
            {line(header, true)}
            <Text color="gray">{'─'.repeat(Math.max(1, width * 16))}</Text>
            {rows.map((r, ri) => (
              <Text key={`${key}-r${ri}`}>{line(r)}</Text>
            ))}
          </Box>,
        ];
      }
      case 'hr':
        return [<Text key={key} color="gray">{'─'.repeat(40)}</Text>];
      case 'space':
        return [<React.Fragment key={key}>{'\n'}</React.Fragment>];
      case 'html':
        return [
          <Text key={key} dimColor>
            {String(token.text ?? token.raw ?? '').trim().split('\n').slice(0, 3).join('\n')}
          </Text>,
        ];
      default:
        // 未映射的块级 token：退化为纯文本行（不丢内容）
        return [
          <Text key={key}>{token.tokens?.length ? inlineNodes(token.tokens, key) : (token.text ?? token.raw ?? '')}</Text>,
        ];
    }
  });
}

/** Markdown 渲染组件：先按原文显示，解析完成后替换为富文本（解析为异步动态 import） */
export function Markdown({ text }: { text: string }): React.ReactElement {
  const [nodes, setNodes] = useState<React.ReactNode[] | null>(null);
  useEffect(() => {
    let alive = true;
    void parseMarkdown(text).then((tokens) => {
      if (alive) setNodes(blockNodes(tokens as MarkdownToken[], 'md'));
    });
    return () => {
      alive = false;
    };
  }, [text]);
  if (nodes === null) {
    return (
      <Text>
        {text.split('\n').map((line, i) => (
          <React.Fragment key={i}>
            {i > 0 ? '\n' : ''}
            {line}
          </React.Fragment>
        ))}
      </Text>
    );
  }
  return <Box flexDirection="column">{nodes}</Box>;
}
