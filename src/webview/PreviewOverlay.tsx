import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Colors, PreviewPayload } from './types';
import { t } from './i18n';

/** 单次最多渲染的行数：超大文件避免一次性生成过多 DOM 节点 */
const MAX_RENDER_LINES = 5000;

/**
 * PreviewOverlay - 浏览器端（内置 HTTP 服务器）的页内查看浮层。
 *
 * 桌面 / VS Code 宿主下「查看文件 / 虚拟文档 / diff / Mermaid」由宿主原生窗口打开；
 * 浏览器端没有原生窗口，改由服务端把内容回推（带 sessionId + clientId 定向到发起端），
 * 在这里就地展示，做到「查看类操作不跨端」。
 */
const PreviewOverlay = ({
  payload,
  colors,
  onClose,
}: {
  payload: PreviewPayload;
  colors: Colors;
  onClose: () => void;
}) => {
  const bodyRef = useRef<HTMLDivElement>(null);

  // 每次打开新内容时把滚动位置重置到顶部（含选中行定位前的初始态）
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [payload]);

  // Esc 关闭
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  const textLines = useMemo(() => {
    if (payload.mode !== 'text' || typeof payload.content !== 'string') return null;
    const all = payload.content.split('\n');
    return { lines: all.slice(0, MAX_RENDER_LINES), truncated: all.length > MAX_RENDER_LINES };
  }, [payload]);

  // 打开带行号的文本时，滚动到选中行附近
  useEffect(() => {
    const sel = payload.selectedLines;
    if (payload.mode !== 'text' || !sel || !textLines) return;
    const container = bodyRef.current;
    if (!container) return;
    const target = container.querySelector<HTMLElement>(`[data-line="${sel.start}"]`);
    if (target) {
      target.scrollIntoView({ block: 'center' });
    }
  }, [payload, textLines]);

  const lineRangeText = payload.selectedLines
    ? `:${payload.selectedLines.start}${payload.selectedLines.start !== payload.selectedLines.end ? `~${payload.selectedLines.end}` : ''}`
    : '';

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.55)', padding: '24px' }}
      onClick={onClose}
    >
      <div
        className="flex flex-col overflow-hidden"
        style={{
          width: 'min(1100px, 100%)',
          height: 'min(760px, 100%)',
          backgroundColor: colors.primaryFrame,
          border: `1px solid ${colors.border}`,
          borderRadius: '10px',
          boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between gap-3 px-4 py-2 border-b shrink-0"
          style={{ borderColor: colors.border }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[13px] font-semibold truncate" style={{ color: colors.textPrimary }}>
              {payload.title || payload.filePath || t('preview.title')}
              {lineRangeText}
            </span>
            {payload.filePath && payload.title && payload.filePath !== payload.title && (
              <span className="text-[11px] truncate" style={{ color: colors.textSystem }}>
                {payload.filePath}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-md flex items-center justify-center shrink-0 hover:bg-white/10"
            style={{ color: colors.textSystem }}
            title={t('preview.close')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div ref={bodyRef} className="flex-1 overflow-auto" style={{ overscrollBehavior: 'contain' }}>
          {payload.error ? (
            <div className="p-4 text-[12px]" style={{ color: colors.error }}>
              {t('preview.readError')}: {payload.error}
            </div>
          ) : payload.mode === 'image' ? (
            <div className="w-full h-full flex items-center justify-center p-4">
              <img
                src={payload.dataUrl}
                alt={payload.title || 'image'}
                style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
              />
            </div>
          ) : payload.mode === 'diff' ? (
            <DiffView payload={payload} colors={colors} />
          ) : payload.mode === 'mermaid' ? (
            <div className="flex flex-col h-full">
              <div className="px-4 py-2 text-[11px] shrink-0" style={{ color: colors.textSystem }}>
                {t('preview.mermaidHint')}
              </div>
              <pre
                className="flex-1 overflow-auto m-0 px-4 pb-4 text-[12px]"
                style={{ color: colors.textPrimary, fontFamily: 'Consolas, "Courier New", monospace' }}
              >
                {payload.code || ''}
              </pre>
            </div>
          ) : (
            <div className="text-[12px]" style={{ fontFamily: 'Consolas, "Courier New", monospace' }}>
              {(textLines?.lines ?? []).map((line, idx) => {
                const lineNo = idx + 1;
                const sel = payload.selectedLines;
                const highlighted = !!sel && lineNo >= sel.start && lineNo <= sel.end;
                return (
                  <div
                    key={lineNo}
                    data-line={lineNo}
                    className="flex"
                    style={{ backgroundColor: highlighted ? 'rgba(99, 102, 241, 0.16)' : undefined }}
                  >
                    <span
                      className="select-none text-right pr-3 pl-3 shrink-0"
                      style={{ color: colors.textSystem, opacity: 0.6, minWidth: '56px' }}
                    >
                      {lineNo}
                    </span>
                    <span
                      className="pr-4"
                      style={{ color: colors.textPrimary, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                    >
                      {line.length > 0 ? line : ' '}
                    </span>
                  </div>
                );
              })}
              {textLines?.truncated && (
                <div className="px-4 py-3 text-[11px]" style={{ color: colors.textSystem }}>
                  {t('preview.truncated', { count: String(MAX_RENDER_LINES) })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/** diff 模式：左右两栏展示修改前后内容 */
const DiffView = ({ payload, colors }: { payload: PreviewPayload; colors: Colors }) => {
  const before = payload.beforeContent ?? '';
  const after = payload.afterContent ?? payload.newContent ?? '';
  const [side, setSide] = useState<'split' | 'after'>('split');

  const pane = (label: string, content: string, color: string) => (
    <div className="flex flex-col min-w-0 flex-1">
      <div
        className="px-3 py-1 text-[11px] border-b shrink-0"
        style={{ color, borderColor: colors.border, backgroundColor: colors.bgSecondary }}
      >
        {label}
      </div>
      <pre
        className="flex-1 overflow-auto m-0 p-3 text-[12px]"
        style={{ color: colors.textPrimary, fontFamily: 'Consolas, "Courier New", monospace' }}
      >
        {content || ' '}
      </pre>
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-1.5 shrink-0 border-b" style={{ borderColor: colors.border }}>
        <button
          onClick={() => setSide('split')}
          className="px-2 h-6 rounded text-[11px]"
          style={{
            backgroundColor: side === 'split' ? colors.harness : colors.bgTertiary,
            color: side === 'split' ? '#fff' : colors.textSystem,
          }}
        >
          {t('preview.diffSplit')}
        </button>
        <button
          onClick={() => setSide('after')}
          className="px-2 h-6 rounded text-[11px]"
          style={{
            backgroundColor: side === 'after' ? colors.harness : colors.bgTertiary,
            color: side === 'after' ? '#fff' : colors.textSystem,
          }}
        >
          {t('preview.diffAfter')}
        </button>
      </div>
      <div className="flex flex-1 min-h-0">
        {side === 'split' ? (
          <>
            {pane(t('preview.diffBefore'), before, colors.error)}
            <div style={{ width: '1px', backgroundColor: colors.border }} />
            {pane(t('preview.diffAfter'), after, colors.success)}
          </>
        ) : (
          pane(t('preview.diffAfter'), after, colors.success)
        )}
      </div>
    </div>
  );
};

export default PreviewOverlay;
