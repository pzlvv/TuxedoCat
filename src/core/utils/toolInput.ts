/**
 * 工具入参归一化工具
 *
 * 背景：LLM / Provider 偶尔会把 tool_use 的整个 input 再 JSON.stringify 一次
 * （double-encode），例如 AskUserQuestion 的入参变成字符串：
 *   "{\"question\": \"...\", \"choices\": [...]}"
 * 而不是对象：
 *   { question: "...", choices: [...] }
 *
 * 这类数据一旦落盘，恢复历史对话时会被当作对象使用（对其写入 contextBefore
 * 等字段），在严格模式下会抛
 *   TypeError: Cannot create property 'xxx' on string '...'
 * 因此统一在这里做「解包 + 保证对象」处理，供执行层、LLM 适配层与 UI 层复用。
 */

/**
 * 循环解包可能被多层 JSON 编码的字符串（最多 3 层）。
 *
 * 返回值可能是任意 JSON 类型；只有最终解出对象 / 数组时才认为有意义，
 * 调用方需自行判断（避免把 "123" 这类普通字符串误改语义）。
 */
export function unwrapJsonString(input: unknown): unknown {
  let current: unknown = input;
  for (let i = 0; i < 3; i++) {
    if (typeof current !== 'string') break;
    const trimmed = current.trim();
    if (!trimmed) break;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed === current) break;
      current = parsed;
    } catch {
      break;
    }
  }
  return current;
}

/**
 * 解包 tool_use.input：字符串 → 对象 / 数组。
 * 仅当最终得到对象 / 数组时才替换，否则原样返回，避免误改普通字符串。
 */
export function unwrapToolInput(input: unknown): unknown {
  const unwrapped = unwrapJsonString(input);
  return unwrapped && typeof unwrapped === 'object' ? unwrapped : input;
}

/**
 * 将任意 tool_use.input 归一化成「可安全读写属性的对象」：
 * - 对象：原样返回
 * - JSON 字符串（含 double-encode）：解包后返回对象
 * - 其他（数字 / 布尔 / 非法字符串）：返回空对象
 */
export function normalizeToolInput(input: unknown): Record<string, unknown> {
  const unwrapped = unwrapToolInput(input);
  if (unwrapped && typeof unwrapped === 'object' && !Array.isArray(unwrapped)) {
    return unwrapped as Record<string, unknown>;
  }
  return {};
}

/**
 * 序列化 tool_use.input 为「字符串型 arguments」协议（OpenAI Chat Completions /
 * Responses）要求的 JSON 文本，保证输出一定是合法 JSON。
 *
 * LLM 生成的工具参数解析失败时，非法 JSON 原文会残留在 `tool_use.input`（string）。
 * 若把它原样塞进 `arguments` 发给严格校验的服务商，整轮请求 400，且该消息留在
 * 上下文里会让**此后每一轮**请求都失败。因此：合法 JSON 字符串原样保留（兼容
 * double-encode 场景），非法字符串降级为 `JSON.stringify` 的字符串字面量。
 */
export function serializeToolArguments(input: unknown): string {
  if (typeof input === 'string') {
    try {
      JSON.parse(input);
      return input;
    } catch {
      return JSON.stringify(input);
    }
  }
  return JSON.stringify(input ?? {});
}

/**
 * 生成用于日志的 tool_use.input 摘要。
 *
 * 不要直接对 input 调用 `Object.keys()`：当 input 是被 double-encode 的字符串时，
 * `Object.keys('{"question":...}')` 会展开成 `['0','1','2',...]`（每个字符一个索引），
 * 在日志里刷出几百个无意义的下标。这里统一按「类型 + 长度 + 预览」输出。
 */
export function describeToolInput(input: unknown): string {
  let inputStr = '';
  if (typeof input === 'string') {
    inputStr = input;
  } else if (input !== undefined && input !== null) {
    try {
      inputStr = JSON.stringify(input) ?? String(input);
    } catch {
      inputStr = String(input);
    }
  }

  const inputType = Array.isArray(input) ? 'array' : typeof input;
  const keys = input && typeof input === 'object' && !Array.isArray(input)
    ? Object.keys(input as Record<string, unknown>).join(', ')
    : '';

  return (
    `input_type=${inputType}, input_keys=[${keys}], ` +
    `input_size=${inputStr.length}, input_preview=${inputStr.substring(0, 500)}`
  );
}
