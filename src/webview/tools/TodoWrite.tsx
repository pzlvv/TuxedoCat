import React from 'react';
import { Icon } from '../Icon';
import { ToolCallProps } from './Types';
import { ToolHeader } from './ToolHeader';
import { t } from '../i18n';

interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * 状态标记配色（`docs/features/todo-list.md` FR-004）：唯一一份定义，消息流工具卡片与
 * 输入区任务进度浮层都从这里取色，保证两个渲染面颜色一致。
 */
export const TODO_STATUS_COLOR = {
  pending: '',
  in_progress: '#6366f1',
  completed: '#22c55e',
} as const;

const STATUS_ICON: Record<string, React.ReactNode> = {
  pending: <Icon name="square" size={12} />,
  in_progress: <Icon name="circle-dot" size={12} />,
  completed: <Icon name="check-square" size={12} />,
};

export const TodoWrite: React.FC<ToolCallProps> = ({ args, colors, status }) => {
  // 确保 todos 是数组（兼容 LLM 返回 JSON 字符串的情况）
  let rawTodos = args?.todos;
  if (typeof rawTodos === 'string') {
    try {
      rawTodos = JSON.parse(rawTodos);
    } catch {
      rawTodos = [];
    }
  }
  const todos: TodoItem[] = Array.isArray(rawTodos) ? rawTodos : [];
  const totalTodos = todos.length;
  const completedCount = todos.filter(t => t.status === 'completed').length;
  const inProgressCount = todos.filter(t => t.status === 'in_progress').length;
  const pendingCount = todos.filter(t => t.status === 'pending').length;

  // 显示文本："3 items (1 done, 1 in progress)"
  const summaryText = totalTodos > 0
    ? t('tool.todoWrite.summary', {
        total: totalTodos,
        done: completedCount > 0 ? t('tool.todoWrite.done', { count: completedCount }) : '',
        inProgress: inProgressCount > 0 ? t('tool.todoWrite.inProgress', { count: inProgressCount }) : '',
        pending: pendingCount > 0 ? t('tool.todoWrite.pending', { count: pendingCount }) : '',
      })
    : '';

  if (totalTodos === 0) {
    return (
      <ToolHeader icon="CheckSquare" name="TodoWrite" colors={colors}>
        <span style={{ opacity: 0.5, marginLeft: '8px' }}>{t('tool.todoWrite.noTasks')}</span>
        {status === 'fail' && <span style={{ color: '#ef4444', marginLeft: '8px', fontWeight: 600 }}>{t('tool.todoWrite.error')}</span>}
      </ToolHeader>
    );
  }

  // 错误时不显示列表，只显示 header + error 标记
  if (status === 'fail') {
    return (
      <div className="w-full">
        <ToolHeader icon="CheckSquare" name="TodoWrite" colors={colors}>
          <span style={{ marginLeft: '8px', color: colors.textPrimary }}>
            {summaryText}
          </span>
          <span style={{ color: '#ef4444', marginLeft: '8px', fontWeight: 600 }}>{t('tool.todoWrite.error')}</span>
        </ToolHeader>
      </div>
    );
  }

  return (
    <div className="w-full">
      <ToolHeader icon="CheckSquare" name="TodoWrite" colors={colors}>
        <span style={{ marginLeft: '8px', color: colors.textPrimary }}>
          {summaryText}
        </span>
      </ToolHeader>
      
      {/* Todo 列表 */}
      <div
        className="mt-2 rounded-lg overflow-hidden"
        style={{
          border: '1px solid',
          borderColor: colors.timelineLine,
          backgroundColor: 'transparent',
        }}
      >
        {todos.map((todo, index) => (
          <div
            key={index}
            className="flex items-start gap-2 px-3 py-1.5 ui-fs-12"
            style={{
              borderBottom: index < totalTodos - 1 ? `1px solid ${colors.timelineLine}` : 'none',
              backgroundColor: todo.status === 'in_progress'
                ? (colors.bgSecondary)
                : 'transparent',
              opacity: todo.status === 'completed' ? 0.6 : 1,
            }}
          >
            {/* 状态图标 */}
            <span
              className="flex-shrink-0 mt-0.5"
              style={{
                color: todo.status === 'in_progress'
                  ? TODO_STATUS_COLOR.in_progress
                  : todo.status === 'completed'
                    ? TODO_STATUS_COLOR.completed
                    : colors.textSystem,
              }}
            >
              {STATUS_ICON[todo.status] || <Icon name="circle" size={12} />}
            </span>

            {/* 任务内容 */}
            <div className="flex-1 min-w-0">
              <span
                style={{
                  color: todo.status === 'completed' ? colors.textSystem : colors.textPrimary,
                  textDecoration: todo.status === 'completed' ? 'line-through' : 'none',
                  fontWeight: todo.status === 'in_progress' ? 700 : undefined,
                  wordBreak: 'break-word',
                }}
              >
                {todo.content}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
