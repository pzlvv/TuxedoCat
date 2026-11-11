/**
 * 系统自动消息的一行摘要（`docs/hosts/webview-ui.md` 第 11 节「自动消息折叠行」）。
 *
 * 后台 Bash 完成通知与子代理 From 消息都以「一行摘要 + 展开正文」呈现：摘要从消息
 * 正文派生，派生逻辑只有这一份纯函数，组件只渲染结果
 * （`docs/architecture/principles.md` 第 5 条：契约只写现状，派生字段从根字段推导）。
 *
 * 本模块零依赖：webview bundle 直接 import，单测也直接 import（不引入 DOM / Node 依赖）。
 */

/** 后台任务完成通知的结论：通知文案里的三种收尾方式 */
export type BackgroundCompletionState = 'completed' | 'failed' | 'stopped' | 'unknown';

export interface BackgroundCompletionSummary {
  state: BackgroundCompletionState;
  /** 单行描述：`Description:` 里引号内的命令描述；解析失败时退回 `Description:` 整行或通知首行 */
  description: string;
  /** `Duration:` 的值（原样保留 core 的格式）；缺失为 null */
  duration: string | null;
}

/** 取通知正文里 `Key: value` 形式的行值；没有该行返回 null */
function lineValue(content: string, key: string): string | null {
  const prefix = `${key}: `;
  for (const line of content.split('\n')) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return null;
}

/** 正文首个非空行（解析失败时的兜底摘要） */
function firstNonEmptyLine(content: string): string {
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line) return line;
  }
  return '';
}

/**
 * `Description:` 行的三种形态（`core-rs/src/bash_task.rs` 的
 * `build_completion_notification`）。描述用贪心匹配：命令描述里可能带引号。
 */
const DESCRIPTION_PATTERNS: { state: BackgroundCompletionState; re: RegExp }[] = [
  { state: 'completed', re: /^Background command "(.*)" completed \(exit code -?\d+\)$/ },
  { state: 'failed', re: /^Background command "(.*)" failed with exit code -?\d+$/ },
  { state: 'stopped', re: /^Background command "(.*)" was stopped$/ },
];

/**
 * 解析后台 Bash 完成通知（`Background task completed` + `Task:` / `Description:` /
 * `Duration:` / 可选 `Output (first 500 chars):`）。
 *
 * 只有 `Description:` 行是结论与描述的来源；格式不认识时返回 `unknown`——组件据此
 * 原样显示该行，不猜状态。
 */
export function parseBackgroundCompletion(content: string): BackgroundCompletionSummary {
  const descriptionLine = lineValue(content, 'Description');
  const duration = lineValue(content, 'Duration');
  if (descriptionLine !== null) {
    for (const { state, re } of DESCRIPTION_PATTERNS) {
      const match = re.exec(descriptionLine);
      if (match) return { state, description: match[1], duration };
    }
  }
  return {
    state: 'unknown',
    description: descriptionLine ?? firstNonEmptyLine(content),
    duration,
  };
}

/**
 * 取正文首行做摘要（子代理 From 消息）：跳过空行与 markdown 块标记（标题 / 列表 /
 * 引用），并去掉强调与行内代码的标记符——一行里只留可读文字。
 *
 * `maxChars` 只截长度、不参与判定：单行仍由 CSS ellipsis 按实际宽度省略。
 */
export function firstLineSummary(content: string, maxChars = 200): string {
  for (const raw of content.split('\n')) {
    const line = raw
      .trim()
      .replace(/^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, '')
      .replace(/\*\*|__|`/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!line) continue;
    return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line;
  }
  return '';
}
