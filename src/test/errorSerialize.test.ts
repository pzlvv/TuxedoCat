/**
 * 错误序列化单元测试（core/llm/shared.ts 的 serializeError / formatErrorChain）。
 *
 * 运行方式：npm run test:all -- error-serialize
 *
 * 背景：undici 的 `fetch failed` 只是外壳，真实根因（ECONNRESET / ENOTFOUND /
 * UND_ERR_CONNECT_TIMEOUT ...）挂在 `error.cause` 上。失败转储此前只写
 * name/message/stack，导致 dump 文件里只剩一句「fetch failed」，无法区分
 * DNS 失败 / 连接被拒 / TLS 失败 / 读超时。这里锁定新的序列化行为。
 */
import * as assert from 'assert';
import { serializeError, formatErrorChain, MAX_ERROR_CAUSE_DEPTH } from '../core/llm/shared';
import { runCases } from './helpers/harness';

/** 构造 undici 风格的网络错误：TypeError('fetch failed') -> SocketError -> Error(read ECONNRESET) */
function buildUndiciStyleError(): Error {
  const socketError = Object.assign(new Error('other side closed'), {
    name: 'SocketError',
    code: 'UND_ERR_SOCKET',
  });
  const rootCause = Object.assign(new Error('read ECONNRESET'), {
    code: 'ECONNRESET',
    errno: -4077,
    syscall: 'read',
  });
  (socketError as Error & { cause?: unknown }).cause = rootCause;
  const fetchError = new TypeError('fetch failed');
  (fetchError as Error & { cause?: unknown }).cause = socketError;
  return fetchError;
}

interface Case {
  name: string;
  run: () => void | Promise<void>;
}

const CASES: Case[] = [
  {
    name: '普通 Error：保留 name/message/stack，无 cause 时不产生多余字段',
    run: () => {
      const e = new Error('boom');
      const s = serializeError(e);
      assert.strictEqual(s.name, 'Error', 'name 应保留');
      assert.strictEqual(s.message, 'boom', 'message 应保留');
      assert.strictEqual(typeof s.stack, 'string', 'stack 应保留');
      assert.strictEqual('cause' in s, false, '无 cause 时不应出现 cause 字段');
      assert.strictEqual('code' in s, false, '无 code 时不应出现 code 字段');
    },
  },
  {
    name: 'undici fetch failed：保留多层 cause 链与系统错误码',
    run: () => {
      const s = serializeError(buildUndiciStyleError());
      assert.strictEqual(s.name, 'TypeError', '外层应为 TypeError');
      assert.strictEqual(s.message, 'fetch failed', '外层 message');

      const cause1 = s.cause as Exclude<typeof s.cause, string | undefined>;
      assert.strictEqual(cause1.name, 'SocketError', '第一层 cause 应为 SocketError');
      assert.strictEqual(cause1.code, 'UND_ERR_SOCKET', '第一层 cause 的 code 应保留');

      const cause2 = cause1.cause as Exclude<typeof cause1.cause, string | undefined>;
      assert.strictEqual(cause2.message, 'read ECONNRESET', '第二层 cause 应为根因');
      assert.strictEqual(cause2.code, 'ECONNRESET', '根因 code 应保留');
      assert.strictEqual(cause2.errno, -4077, '根因 errno 应保留（数字）');
      assert.strictEqual(cause2.syscall, 'read', '根因 syscall 应保留');
    },
  },
  {
    name: '序列化结果可直接 JSON.stringify（写入转储文件的前提）',
    run: () => {
      const s = serializeError(buildUndiciStyleError());
      const text = JSON.stringify({ error: s }, null, 2);
      assert.ok(text.includes('"ECONNRESET"'), 'JSON 文本里应能看到根因 code');
      assert.ok(text.includes('fetch failed'), 'JSON 文本里应能看到外层 message');
      const parsed = JSON.parse(text) as { error: { cause: { cause: { code: string } } } };
      assert.strictEqual(parsed.error.cause.cause.code, 'ECONNRESET', '往返后 cause 链仍在');
    },
  },
  {
    name: 'AggregateError：子错误被逐个序列化',
    run: () => {
      const a = Object.assign(new Error('all connections failed'), {
        name: 'AggregateError',
        code: 'ECONNREFUSED',
        errors: [
          Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), { code: 'ECONNREFUSED', syscall: 'connect' }),
          Object.assign(new Error('connect ETIMEDOUT 5.6.7.8:443'), { code: 'ETIMEDOUT', syscall: 'connect' }),
        ],
      });
      const s = serializeError(a);
      assert.strictEqual(s.name, 'AggregateError', 'name 应为 AggregateError');
      assert.ok(Array.isArray(s.errors), 'errors 应为数组');
      assert.strictEqual(s.errors?.length, 2, '两个子错误');
      const first = s.errors?.[0] as Exclude<NonNullable<typeof s.errors>[number], string>;
      assert.strictEqual(first.code, 'ECONNREFUSED', '子错误 code 应保留');
      const second = s.errors?.[1] as Exclude<NonNullable<typeof s.errors>[number], string>;
      assert.strictEqual(second.code, 'ETIMEDOUT', '第二个子错误 code 应保留');
    },
  },
  {
    name: '非 Error 抛出物：String 化且不抛异常',
    run: () => {
      assert.strictEqual(serializeError('plain string').message, 'plain string', '字符串应被 String 化');
      assert.strictEqual(serializeError('plain string').name, 'NonError', '非 Error 的 name 固定为 NonError');
      assert.strictEqual(serializeError(undefined).message, 'undefined', 'undefined 不应抛异常');
      assert.strictEqual(serializeError({ a: 1 }).message, '[object Object]', '普通对象不应抛异常');
    },
  },
  {
    name: '循环 cause 引用：限深截断，不无限递归',
    run: () => {
      const e1 = new Error('outer');
      const e2 = new Error('inner');
      (e1 as Error & { cause?: unknown }).cause = e2;
      (e2 as Error & { cause?: unknown }).cause = e1; // 循环

      const s = serializeError(e1);
      let depth = 0;
      let cur: unknown = s;
      while (cur && typeof cur === 'object' && 'cause' in (cur as Record<string, unknown>)) {
        depth++;
        cur = (cur as { cause: unknown }).cause;
        assert.ok(depth <= MAX_ERROR_CAUSE_DEPTH + 1, `cause 链深度应被限制，实际 ${depth}`);
      }
      assert.strictEqual(cur, '<max depth reached>', '超深时应截断为占位字符串');
    },
  },
  {
    name: 'formatErrorChain：单行日志包含 cause 与 code',
    run: () => {
      const text = formatErrorChain(buildUndiciStyleError());
      assert.ok(!text.includes('\n'), '单行输出不应含换行');
      assert.ok(text.startsWith('TypeError: fetch failed'), `应以最外层错误开头，实际：${text}`);
      assert.ok(text.includes('SocketError'), '应包含中间层 cause');
      assert.ok(text.includes('read ECONNRESET'), '应包含根因 message');
      assert.ok(text.includes('code=ECONNRESET'), '应包含根因 code');
      assert.ok(text.includes('syscall=read'), '应包含根因 syscall');
    },
  },
  {
    name: 'formatErrorChain：AggregateError 子错误与空值安全',
    run: () => {
      const a = Object.assign(new Error('all failed'), {
        name: 'AggregateError',
        errors: [Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' })],
      });
      const text = formatErrorChain(a);
      assert.ok(text.includes('errors=['), '应展开子错误');
      assert.ok(text.includes('ECONNREFUSED'), '应包含子错误信息');

      assert.strictEqual(typeof formatErrorChain(null), 'string', 'null 不应抛异常');
      assert.strictEqual(typeof formatErrorChain(undefined), 'string', 'undefined 不应抛异常');
      assert.strictEqual(formatErrorChain('oops'), 'oops', '非 Error 直接 String 化');
    },
  },
];

runCases('errorSerialize', CASES);
