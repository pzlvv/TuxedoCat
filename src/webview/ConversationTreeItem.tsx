/**
 * ConversationTreeItem — recursively renders a conversation tree node.
 *
 * Extracted from App.tsx to reduce the main file's size. Accepts all
 * necessary callbacks as props to remain composable and testable.
 *
 * Circular reference protection: depth is capped at MAX_DEPTH.
 */

import React, { memo, useState, useRef, useCallback, useEffect } from 'react';
import type { Colors } from './types';
import { postMessage } from './webviewEnv';
import { t, resolveTitle } from './i18n';

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */
export interface ConversationTreeItemProps {
  item: any;
  isActive: boolean;
  isRoot: boolean;
  isExpanded: boolean;
  isRunning: boolean;
  /** 会话是否正在等待用户输入（ask user / 权限确认）——流水灯显示黄色 */
  isWaitingForUser?: boolean;
  getSessionRunningState: (sessionId: string) => boolean;
  /** 获取子会话是否正在等待用户输入 */
  getSessionWaitingState?: (sessionId: string) => boolean;
  onToggle: () => void;
  onSelect: () => void;
  onDelete: () => void;
  onSmartNaming?: (sessionId: string) => void;
  colors: Colors;
  formatRelativeTime: (ts: string | number) => string;
  children: any[];
  childMap: Map<string, any[]>;
  currentSessionId: string | null;
  expandedSubSessions: Record<string, boolean>;
  onToggleSub: (sessionId: string) => void;
  depth: number;
  /** Called when a child conversation is selected */
  onChildSelect?: (sessionId: string) => void;
  /** Called when a child conversation's delete button is clicked */
  onChildDelete?: (sessionId: string, title: string) => void;
  /** 正在智能命名的会话 ID 集合 */
  namingSessions?: Set<string>;
}

const MAX_DEPTH = 20; // circular reference / stack overflow protection

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */
export const ConversationTreeItem = memo(function ConversationTreeItem({
  item,
  isActive,
  isRoot,
  isExpanded,
  isRunning,
  isWaitingForUser,
  getSessionRunningState,
  getSessionWaitingState,
  onToggle,
  onSelect,
  onDelete,
  onSmartNaming,
  colors,
  formatRelativeTime,
  children,
  childMap,
  currentSessionId,
  expandedSubSessions,
  onToggleSub,
  depth,
  onChildSelect,
  onChildDelete,
  namingSessions,
}: ConversationTreeItemProps) {
  // Prevent infinite recursion due to circular parentSessionId references
  if (depth > MAX_DEPTH) {
    return null;
  }

  // 重命名状态
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  // 当开始重命名时聚焦输入框
  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  const handleStartRename = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setRenameValue(item.title || '');
    setIsRenaming(true);
  }, [item.title]);

  const handleRenameSubmit = useCallback(() => {
    const newTitle = renameValue.trim();
    if (newTitle && newTitle !== item.title) {
      postMessage({
        type: 'renameConversation',
        sessionId: item.sessionId,
        title: newTitle,
      });
    }
    setIsRenaming(false);
  }, [renameValue, item.sessionId, item.title]);

  const handleRenameKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleRenameSubmit();
    } else if (e.key === 'Escape') {
      setIsRenaming(false);
    }
  }, [handleRenameSubmit]);

  const handleSmartNaming = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSmartNaming?.(item.sessionId);
  }, [item.sessionId, onSmartNaming]);

  const isNaming = namingSessions?.has(item.sessionId) ?? false;
  // 空标题显示为本地化的"未命名"
  const displayTitle = resolveTitle(item.title);

  return (
    <div className="mb-1 last:mb-0 group">
      <div
        className="p-2 rounded hover:bg-opacity-80 transition-colors cursor-pointer"
        style={{
          borderBottom: `1px solid ${colors.border}`,
          backgroundColor: isActive ? (colors.harness + '26') : 'transparent',
          position: 'relative',
        }}
        onClick={isRenaming ? undefined : onSelect}
      >
        {isRunning && (
          <div className={isWaitingForUser ? 'running-bar running-bar--waiting' : 'running-bar'} />
        )}
        <div className="flex items-center justify-between gap-2">
          <div className="flex-1 min-w-0 flex items-center gap-1">
            {/* 展开/折叠按钮（仅在有关联子对话时显示） */}
            {children.length > 0 ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle();
                }}
                className="w-4 h-4 shrink-0 flex items-center justify-center rounded hover:bg-white/10 transition-colors"
                style={{ color: colors.textSystem }}
              >
                <svg
                  width="8"
                  height="8"
                  viewBox="0 0 8 8"
                  fill="none"
                  style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
                >
                  <path d="M2 0L6 4L2 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            ) : (
              <div className="w-4 shrink-0" />
            )}
            {/* 操作按钮组（hover 时显示） — 绝对定位在右上角，不占文档流，避免撑高行高；2 行 2 列排列 */}
            {!item.parentSessionId && (
              <div className="hidden group-hover:grid grid-cols-2 shrink-0 absolute right-2 top-1/2 -translate-y-1/2 z-10 gap-0.5">
                <button
                  onClick={handleStartRename}
                  className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 transition-colors"
                  style={{ color: colors.textSystem }}
                  title={t('conversationTree.rename')}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </button>
                <button
                  onClick={handleSmartNaming}
                  disabled={isNaming}
                  className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 transition-colors disabled:opacity-30"
                  style={{ color: colors.textSystem }}
                  title={t('conversationTree.smartNaming')}
                >
                  {isNaming ? (
                    <div
                      className="animate-spin"
                      style={{
                        width: 14,
                        height: 14,
                        borderRadius: '50%',
                        border: '2px solid transparent',
                        borderTopColor: colors.harness,
                        borderRightColor: colors.harness,
                      }}
                    />
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z" />
                      <path d="M5 3v4" />
                      <path d="M19 17v4" />
                      <path d="M3 5h4" />
                      <path d="M17 19h4" />
                    </svg>
                  )}
                </button>
                {/* 删除（垃圾桶图标） */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete();
                  }}
                  className="w-5 h-5 flex items-center justify-center rounded hover:bg-red-500/20 hover:text-red-400 transition-colors"
                  style={{ color: colors.textSystem }}
                  title={t('conversationTree.deleteConversation')}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    <line x1="10" y1="11" x2="10" y2="17" />
                    <line x1="14" y1="11" x2="14" y2="17" />
                  </svg>
                </button>
              </div>
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-start gap-1">
                    {!isRoot && (
                      <span className="text-[10px] px-1 rounded mt-px shrink-0" style={{ color: colors.textSystem, backgroundColor: colors.bgSecondary }}>
                        sub
                      </span>
                    )}
                    <div className="flex-1 min-w-0">
                      {/* 命名中状态 */}
                      {isNaming ? (
                        <div className="flex items-center gap-1">
                          <span className="text-[13px] font-medium" style={{ color: colors.textPrimary, fontWeight: isActive ? 600 : 500 }}>
                            {displayTitle}
                          </span>
                          <span className="text-[11px] italic" style={{ color: colors.harness }}>{t('conversationTree.namingInProgress')}</span>
                        </div>
                      ) : !isRenaming ? (
                        <div
                          className="text-[13px] font-medium min-w-0"
                          style={{
                            color: colors.textPrimary,
                            fontWeight: isActive ? 600 : 500,
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                          }}
                          title={displayTitle}
                        >
                          {displayTitle}
                        </div>
                      ) : (
                        <input
                          ref={renameInputRef}
                          type="text"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={handleRenameKeyDown}
                          onBlur={handleRenameSubmit}
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            width: '100%',
                            backgroundColor: colors.bgSecondary,
                            color: colors.textPrimary,
                            border: `1px solid ${colors.harness}`,
                            borderRadius: '4px',
                            padding: '2px 6px',
                            fontSize: '13px',
                            outline: 'none',
                          }}
                        />
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex flex-col items-end shrink-0 gap-0.5 text-[11px] group-hover:invisible" style={{ color: colors.textSystem }}>
                  <span>{formatRelativeTime(item.createdAt)}</span>
                  <span>{t('conversationTree.messageCount', { count: item.messageCount })}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {/* 子对话列表 — 使用稳定的回调引用 */}
      {children.length > 0 && isExpanded && (
        <div className="ml-3 mt-0.5">
          {children.map((child: any) => (
            <ConversationTreeItem
              key={child.sessionId}
              item={child}
              isActive={child.sessionId === currentSessionId}
              isRoot={false}
              isExpanded={expandedSubSessions[child.sessionId] === true}
              isRunning={getSessionRunningState(child.sessionId)}
              isWaitingForUser={getSessionWaitingState?.(child.sessionId) ?? false}
              getSessionRunningState={getSessionRunningState}
              getSessionWaitingState={getSessionWaitingState}
              onToggle={() => onToggleSub(child.sessionId)}
              onSelect={() => {
                // 由上层 onChildSelect 统一处理加载状态与导航
                onChildSelect?.(child.sessionId);
              }}
              onDelete={() => {
                onChildDelete?.(child.sessionId, child.title);
              }}
              onSmartNaming={onSmartNaming}
              colors={colors}
              formatRelativeTime={formatRelativeTime}
              children={childMap.get(child.sessionId) || []}
              childMap={childMap}
              currentSessionId={currentSessionId}
              expandedSubSessions={expandedSubSessions}
              onToggleSub={onToggleSub}
              depth={depth + 1}
              onChildSelect={onChildSelect}
              onChildDelete={onChildDelete}
              namingSessions={namingSessions}
            />
          ))}
        </div>
      )}
    </div>
  );
});
