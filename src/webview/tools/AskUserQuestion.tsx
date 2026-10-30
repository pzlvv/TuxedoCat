import React from 'react';
import type { ToolCallProps } from './Types';
import { ToolHeader } from './ToolHeader';
import { t, getLocale } from '../i18n';
import { uiFontSizePx } from '../fontSize';

/**
 * 把工具结果 `{"answers":[...]}` 的 JSON 文本转成自然语言描述。
 *
 * 回传给 LLM 的工具结果保持 `{"answers":[...]}` JSON 契约不变
 * （docs/features/ask-user-question.md FR-005），这里只改卡片上的展示：
 * 每条答案按 `id` 对回入参 `questions` 的问题正文，选项用 label、自由文本直接展示；
 * 单问题只显示答案本身（问题正文已在本行前半段），多问题用「问题：答案」对区分。
 * 解析失败 / 形状不符时回退原文，旧对话与非常规内容不丢信息。
 */
function describeAnswers(args: Record<string, any>, output: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return output;
  }
  const answers = (parsed as { answers?: unknown })?.answers;
  if (!Array.isArray(answers) || answers.length === 0) {
    return output;
  }

  // 分隔符随界面语言走（答案文本本身来自模型与用户，标点跟 UI 语言一致）
  const zh = getLocale() === 'zh';
  const pairSep = zh ? '；' : '; ';
  const itemSep = zh ? '、' : ', ';
  const colon = zh ? '：' : ': ';

  // id → 问题正文；对不上（入参缺失 / double-encode）时退回 id 本身
  const questionTexts = new Map<string, string>();
  if (Array.isArray(args?.questions)) {
    for (const item of args.questions) {
      if (item && typeof item.id === 'string' && typeof item.question === 'string') {
        questionTexts.set(item.id, item.question);
      }
    }
  }

  const parts = answers.map((answer: unknown) => {
    const record = (answer ?? {}) as { id?: unknown; selected?: unknown; custom?: unknown };
    const selected = Array.isArray(record.selected)
      ? record.selected.filter(
          (label): label is string => typeof label === 'string' && label.length > 0,
        )
      : [];
    const custom =
      typeof record.custom === 'string' && record.custom.trim().length > 0
        ? record.custom.trim()
        : '';
    const value =
      [...selected, ...(custom ? [custom] : [])].join(itemSep) || t('tool.askUser.noAnswer');
    if (answers.length === 1) {
      return value;
    }
    const id = typeof record.id === 'string' ? record.id : '';
    const text = questionTexts.get(id) ?? id;
    return text ? `${text}${colon}${value}` : value;
  });
  return parts.join(pairSep);
}

export const AskUserQuestion: React.FC<ToolCallProps> = ({ args, colors, status, output }) => {
  // specs/026：新形状是 questions[]；旧对话里的 tool_use 仍是 question / choices。
  const rawQuestions = args?.questions;
  const question = Array.isArray(rawQuestions) && rawQuestions.length > 0
    ? rawQuestions
        .map((item) => item?.question)
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .join(' / ')
    : (typeof args?.question === 'string' ? args.question : '');

  return (
    <ToolHeader icon="HelpCircle" name="Ask User" colors={colors}>
      <span style={{ color: colors.textPrimary, marginRight: '6px', fontSize: uiFontSizePx(11), fontWeight: 600 }}>
        {question}
      </span>
      {status === 'success' && output && (
        <span style={{ color: colors.textSystem, fontSize: uiFontSizePx(11) }}>
          {t('tool.askUser.response', { output: describeAnswers(args, output) })}
        </span>
      )}
      {status === 'running' && (
        <span style={{ color: colors.textSecondary, fontSize: uiFontSizePx(11) }}>
          {t('tool.askUser.waitingResponse')}
        </span>
      )}
      {(status === 'fail') && (
        <span style={{ color: colors.timelineStatusFail || '#ef4444', fontSize: uiFontSizePx(11), fontWeight: 600 }}>
          {output || t('tool.askUser.failed')}
        </span>
      )}
    </ToolHeader>
  );
};
