/**
 * TodoWrite 工具实现
 * 创建和管理当前会话的任务清单
 */

import { z } from 'zod';
import type { ToolUseContext, ToolResult } from '../Tool.js';
import { buildTool } from '../Tool.js';
import { TOOL_NAME, DESCRIPTION, TODO_WRITE_PROMPT } from './Prompt.js';

/**
 * Todo 项状态枚举
 */
const TodoStatusSchema = z.enum(['pending', 'in_progress', 'completed']);

/**
 * Todo 项 Schema
 */
const TodoItemSchema = z.object({
  content: z.string().min(1, 'Content cannot be empty').describe('The imperative form describing what needs to be done'),
  status: TodoStatusSchema.default('pending').describe('Task status: pending, in_progress, or completed'),
  activeForm: z.string().min(1, 'Active form cannot be empty').describe('The present continuous form shown during execution'),
});

const inputSchema = z.strictObject({
  todos: z.array(TodoItemSchema).describe('The updated todo list'),
});

const outputSchema = z.object({
  oldTodos: z.array(TodoItemSchema).describe('The todo list before the update'),
  newTodos: z.array(TodoItemSchema).describe('The todo list after the update'),
});

type TodoWriteInput = z.infer<typeof inputSchema>;
type TodoWriteOutput = z.infer<typeof outputSchema>;

export type TodoItem = z.infer<typeof TodoItemSchema>;

/**
 * 获取当前会话的 todo key
 */
function getTodoKey(context: ToolUseContext): string {
  return context.sessionId ?? 'default';
}

/**
 * 从应用状态中获取当前会话的 todo 列表
 */
function getCurrentTodos(context: ToolUseContext): TodoItem[] {
  const appState = context.getAppState() as any;
  const todoKey = getTodoKey(context);
  return appState?.todos?.[todoKey] ?? [];
}

/**
 * 更新应用状态中的 todo 列表
 */
function setCurrentTodos(context: ToolUseContext, newTodos: TodoItem[]): void {
  context.setAppState((prev: unknown) => {
    const prevState = prev as any;
    const todoKey = getTodoKey(context);
    return {
      ...prevState,
      todos: {
        ...prevState?.todos,
        [todoKey]: newTodos,
      },
    };
  });
}

export const TodoWriteTool = buildTool({
  name: TOOL_NAME,
  aliases: ['todo', 'todolist', 'tasks'],
  searchHint: 'manage the session task checklist',
  maxResultSizeChars: 100_000,
  strict: true,

  get inputSchema() {
    return inputSchema as z.ZodType<TodoWriteInput>;
  },

  get outputSchema() {
    return outputSchema as z.ZodType<TodoWriteOutput>;
  },

  async description() {
    return DESCRIPTION;
  },

  async prompt() {
    return TODO_WRITE_PROMPT;
  },

  isConcurrencySafe() {
    return false;
  },

  isReadOnly() {
    return false;
  },

  userFacingName() {
    return 'TodoWrite';
  },

  getToolUseSummary(input?: TodoWriteInput) {
    if (!input?.todos) return null;
    const total = input.todos.length;
    const completed = input.todos.filter(t => t.status === 'completed').length;
    const inProgress = input.todos.filter(t => t.status === 'in_progress').length;
    return `Todos: ${total} items (${completed} done, ${inProgress} in progress)`;
  },

  getActivityDescription(input?: TodoWriteInput) {
    const total = input?.todos?.length ?? 0;
    if (total === 0) return 'Clearing todo list';
    return `Updating ${total} todo items`;
  },

  async call(
    input: TodoWriteInput,
    context: ToolUseContext,
  ): Promise<ToolResult<TodoWriteOutput>> {
    let { todos } = input;

    // 兼容处理：LLM 有时返回的 todos 是 JSON 字符串而不是数组
    if (typeof todos === 'string') {
      try {
        todos = JSON.parse(todos);
      } catch {
        throw new Error('todos is required and must be an array, but received an unparseable string');
      }
    }

    if (!todos || !Array.isArray(todos)) {
      throw new Error('todos is required and must be an array');
    }

    // 获取旧的 todo 列表
    const oldTodos = getCurrentTodos(context);

    // 如果所有任务都完成了，清空列表
    const allDone = todos.length > 0 && todos.every(t => t.status === 'completed');
    const newTodos = allDone ? [] : todos;

    // 更新状态
    setCurrentTodos(context, newTodos);

    return {
      data: {
        oldTodos,
        newTodos: todos,
      },
    };
  },

  mapToolResultToToolResultBlockParam(
    data: TodoWriteOutput,
    toolUseID: string,
  ) {
    const { newTodos } = data;
    const totalAdded = newTodos.length;
    const totalCompleted = newTodos.filter(t => t.status === 'completed').length;
    const totalPending = newTodos.filter(t => t.status === 'pending').length;
    const totalInProgress = newTodos.filter(t => t.status === 'in_progress').length;

    let content = `Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable`;
    content += `\n\nCurrent todo list: ${totalAdded} items (${totalCompleted} completed, ${totalInProgress} in progress, ${totalPending} pending)`;

    if (newTodos.length > 0) {
      content += '\n\nTasks:\n';
      newTodos.forEach((todo, index) => {
        const statusIcon = todo.status === 'completed' ? '[x]' : todo.status === 'in_progress' ? '[~]' : '[ ]';
        content += `\n${index + 1}. ${statusIcon} ${todo.content}`;
      });
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content,
    };
  },
});
