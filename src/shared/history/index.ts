/**
 * 历史消息管理 - 统一导出
 *
 * 会话数据由 Core 独占写入；这里只有宿主侧仍需要的路径解析、会话元数据视图与
 * 删除闭包（见 `docs/core/standalone-core.md` 第 4 节）。
 */
export * from './Config.js';
export * from './Conversation.js';
