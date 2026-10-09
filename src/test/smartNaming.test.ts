/**
 * 智能命名纯逻辑单元测试（core/history/smartNaming.ts）。
 *
 * 与 `core-rs/src/smart_naming_tests.rs` 同一套用例（两套 Core 同步约定）：
 * 覆盖命名依据的收集（条数 / 截断 / 类型过滤）与标题解析的三级回退
 * （最后一个 JSON 对象 → `{"title": "..."}` 正则 → 最后一行截断）。
 *
 * 运行方式：npm run test:all -- smart-naming
 */
import * as assert from 'assert';
import {
  collectSmartNamingContext,
  parseSmartNamingTitle,
} from '../core/history/smartNaming';
import { runCases } from './helpers/harness';

/** 与 smartNaming.ts 的 MAX_CONTENT_MESSAGES / MAX_CONTENT_CHARS 对齐（模块内常量，不导出） */
const MAX_MESSAGES = 5;
const MAX_CHARS = 500;

function userMessage(text: string): unknown {
  return { type: 'user', message: { role: 'user', content: text } };
}

function assistantMessage(blocks: unknown[]): unknown {
  return { type: 'assistant', message: { role: 'assistant', content: blocks } };
}

const CASES = [
  // ==================== 命名依据收集 ====================
  {
    name: '收集用户与助手文本，thinking 块跳过',
    run: () => {
      const collected = collectSmartNamingContext([
        userMessage('帮我写个排序函数'),
        assistantMessage([
          { type: 'thinking', thinking: '先想一下' },
          { type: 'text', text: '以下是实现' },
        ]),
      ]);
      assert.deepStrictEqual(collected, ['[用户]: 帮我写个排序函数', '[助手]: 以下是实现']);
    },
  },
  {
    name: `最多收集 ${MAX_MESSAGES} 条`,
    run: () => {
      const messages = Array.from({ length: 8 }, (_, i) => userMessage(`第 ${i} 条`));
      const collected = collectSmartNamingContext(messages);
      assert.strictEqual(collected.length, MAX_MESSAGES);
      assert.strictEqual(collected[0], '[用户]: 第 0 条');
      assert.strictEqual(collected[4], '[用户]: 第 4 条');
    },
  },
  {
    name: '一条助手消息的多个 text 块各占一个名额（与 Rust 同口径）',
    run: () => {
      const collected = collectSmartNamingContext([
        assistantMessage([
          { type: 'text', text: '第一段' },
          { type: 'text', text: '第二段' },
        ]),
      ]);
      assert.deepStrictEqual(collected, ['[助手]: 第一段', '[助手]: 第二段']);
    },
  },
  {
    name: `单条截断到 ${MAX_CHARS} 个 UTF-16 单元且不切开代理对`,
    run: () => {
      // 500 单元恰好落在代理对中间：整个对被丢弃（499 单元），不产生孤立代理
      const pairText = '字'.repeat(499) + '𝐀';
      const collected = collectSmartNamingContext([userMessage(pairText)]);
      assert.strictEqual(collected.length, 1);
      const body = collected[0].slice('[用户]: '.length);
      assert.strictEqual(body.length, MAX_CHARS - 1);
      // 代理对被整对丢弃：不含孤立高位代理
      assert.strictEqual(body.includes('\uD835'), false);
    },
  },
  {
    name: '非文本消息与空文本块跳过',
    run: () => {
      const collected = collectSmartNamingContext([
        { type: 'system', message: { role: 'system', content: '系统提示' } },
        assistantMessage([{ type: 'tool_use', id: 't1' }]),
        userMessage('只有这条有效'),
      ]);
      assert.deepStrictEqual(collected, ['[用户]: 只有这条有效']);
    },
  },

  // ==================== 标题解析 ====================
  {
    name: '从 JSON 对象解析标题',
    run: () => {
      assert.strictEqual(parseSmartNamingTitle('{"title": "Python排序函数"}'), 'Python排序函数');
    },
  },
  {
    name: '从 ```json 代码块里解析标题（前置思考文本含花括号也可）',
    run: () => {
      const raw = '好的：\n```json\n{"title": "查询天气"}\n```';
      assert.strictEqual(parseSmartNamingTitle(raw), '查询天气');
      assert.strictEqual(parseSmartNamingTitle('思考 {"a":1} 完成\n{"title": "最终"}'), '最终');
    },
  },
  {
    name: '非法 JSON 且正则不中 → 最后一行原文',
    run: () => {
      // 值里有未转义的引号：整段不是合法 JSON，正则也要求值后直接跟 `}`
      assert.strictEqual(parseSmartNamingTitle('{"title": "a"b"}'), '{"title": "a"b"}');
    },
  },
  {
    name: '正则兜底容忍空白、空值不算；多个候选时取第一个',
    run: () => {
      // JS `\s` 含 U+FEFF：`{` 与引号之间的 FEFF 不破坏正则兜底
      assert.strictEqual(parseSmartNamingTitle('xx { \uFEFF"title" : "查询天气" } yy'), '查询天气');
      // 空值不算匹配 → 落到最后一行
      assert.strictEqual(parseSmartNamingTitle('{"title": ""}'), '{"title": ""}');
      // JSON 提取失败（FEFF 前缀，JSON.parse 不认）时走正则兜底：
      // 非全局正则 → 取第一个匹配（与 Rust feff 用例同口径）
      const feffPair = '{\uFEFF"title": "A"} {\uFEFF"title": "B"}';
      assert.strictEqual(parseSmartNamingTitle(feffPair), 'A');
      // 对照：无 FEFF 时「最后一个 JSON 对象」优先，不进正则兜底
      assert.strictEqual(parseSmartNamingTitle('{"title": "A"} {"title": "B"}'), 'B');
    },
  },
  {
    name: '回退到最后一行非空文本（trim 后）',
    run: () => {
      assert.strictEqual(parseSmartNamingTitle('思考中\n\n  最终标题  \n'), '最终标题');
    },
  },
  {
    name: '输出为空 → 兜底占位标题',
    run: () => {
      assert.strictEqual(parseSmartNamingTitle(''), '智能命名');
      assert.strictEqual(parseSmartNamingTitle('   \n\n  '), '智能命名');
    },
  },
  {
    name: '最后一行截断 50 个 UTF-16 单元且不切开代理对',
    run: () => {
      const line = '题'.repeat(80);
      assert.strictEqual(parseSmartNamingTitle(line).length, 50);
      // 50 单元落在代理对中间：整对丢弃，不产生孤立代理
      const withPair = 'a'.repeat(49) + '𝐀';
      const title = parseSmartNamingTitle(withPair);
      assert.strictEqual(title.length, 49);
      assert.strictEqual(title.includes('\uD835'), false);
    },
  },
];

runCases('smart-naming', CASES);
