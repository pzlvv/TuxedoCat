# 核心架构说明

## 架构概览

核心对话循环架构，采用流式处理模式。

```
ask()
  ↓
QueryEngine.submitMessage()
  ↓
query()
  ↓
queryLoop() ← while(true) 核心循环
```

## 文件说明

### 1. **types.ts** - 类型定义
- `Message`: 核心消息联合类型
- `AssistantMessage`, `UserMessage`, `SystemMessage` 等
- 所有消息和状态相关类型

### 2. **context.ts** - 上下文管理
- `getSystemContext()`: git 状态等系统信息
- `getUserContext()`: CLAUDE.md 等用户信息
- 这些上下文在会话开始时获取并缓存

### 3. **QueryEngine.ts** - 查询引擎
- `QueryEngine` 类: 管理会话状态
- `submitMessage()`: 处理用户消息的主入口
- `ask()`: 便捷的一次性查询函数

### 4. **query.ts** - 核心查询循环
- `query()`: 设置并启动主循环
- `queryLoop()`: **while(true) 循环**，这是最重要的部分

## 核心循环流程

queryLoop 中的每个迭代包含 6 个阶段：

```typescript
while (true) {
  // 1. 准备：应用压缩策略
  messagesForQuery = await applyCompactions(messages)

  // 2. API 调用：调用 LLM API
  for await (const message of callModel()) {
    assistantMessages.push(message)
    yield message
    if (hasToolUse(message)) needsFollowUp = true
  }

  // 3. 检查退出条件
  if (!needsFollowUp) {
    return { reason: 'completed' }
  }

  // 4. 工具执行：执行工具调用
  for await (const result of runTools(toolUseBlocks)) {
    yield result
    toolResults.push(result)
  }

  // 5. 附件处理：内存、队列命令等
  for await (const attachment of getAttachments()) {
    yield attachment
  }

  // 6. 准备下一轮
  state = {
    messages: [...messages, ...assistantMessages, ...toolResults],
    turnCount: turnCount + 1,
  }
}
```

## 使用示例

```typescript
import { QueryEngine } from './core/QueryEngine.js'
import { getProjectRoot } from './core/history/Config.js'

const engine = new QueryEngine({
  cwd: getProjectRoot(),
  tools: [readTool, writeTool],
  canUseTool: async (tool, input) => {
    // TODO: 实现权限检查
    return { behavior: 'allow' }
  },
  getAppState: () => ({ /* ... */ }),
  setAppState: (updater) => { /* ... */ },
})

// 处理用户消息
for await (const message of engine.submitMessage("帮我分析这个项目")) {
  console.log('Received:', message)
}
```

## TODO 清单

- [ ] 实现 `processUserInput` - 处理斜杠命令
- [ ] 实现 `callModel` - LLM API 调用
- [ ] 实现 `runTools` - 工具执行框架
- [ ] 实现 `getAttachments` - 附件处理
- [ ] 实现压缩策略
- [ ] 实现 stop hooks
- [ ] 添加错误处理和重试逻辑
- [ ] 添加 usage 追踪
- [ ] 实现中断机制 (abortController)

## 设计原则

1. **AsyncGenerator**: 所有主要函数都是异步生成器，支持流式输出
2. **不可变参数**: 查询参数在循环中不会改变
3. **可变状态**: 使用 `State` 对象携带迭代间的可变状态
4. **显式退出**: 循环通过 `return` 语句显式退出并返回原因
