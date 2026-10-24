import React, { useCallback, useRef, useState } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import type { Colors, UserChoiceAnswer, UserChoiceQuestion } from './types';
import { t } from './i18n';

interface QuestionOverlayProps {
  questions: UserChoiceQuestion[];
  onSubmit: (answers: UserChoiceAnswer[]) => void;
  colors: Colors;
}

interface Draft {
  selected: string[];
  otherSelected: boolean;
  custom: string;
}

function createDrafts(questions: UserChoiceQuestion[]): Record<string, Draft> {
  const drafts: Record<string, Draft> = {};
  for (const question of questions) {
    drafts[question.id] = { selected: [], otherSelected: false, custom: '' };
  }
  return drafts;
}

/**
 * AskUserQuestion 的逐页选择框（specs/026 FR-003 / FR-004）。
 *
 * 一次只呈现一个问题，底部固定进度条与导航；普通 radio 点击后自动进入下一页，
 * 最后一页不自动提交。输入框始终显示，输入内容即代表「其他」。
 */
const QuestionOverlay: React.FC<QuestionOverlayProps> = ({ questions, onSubmit, colors }) => {
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => createDrafts(questions));
  const [index, setIndex] = useState(0);
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => new Set());
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 程序聚焦（点选项后把焦点送进输入框）不应被当成用户主动聚焦，否则会立刻把
  // 刚选的普通选项改成「其他」（docs/features/ask-user-question.md FR-004）。
  const programmaticFocusRef = useRef(false);

  const current = questions[index];
  const draft = drafts[current.id];
  const isLast = index === questions.length - 1;

  const answered = useCallback((question: UserChoiceQuestion): boolean => {
    const value = drafts[question.id];
    return value.selected.length > 0 || (value.otherSelected && value.custom.trim().length > 0);
  }, [drafts]);

  const updateDraft = useCallback((id: string, next: Draft) => {
    setDrafts((prev) => ({ ...prev, [id]: next }));
  }, []);

  const goTo = useCallback((target: number, fromAnswered: boolean) => {
    if (target === index || target < 0 || target >= questions.length) return;
    setSkipped((prev) => {
      const next = new Set(prev);
      if (fromAnswered) next.delete(current.id);
      else next.add(current.id);
      return next;
    });
    setIndex(target);
  }, [current.id, index, questions.length]);

  const submit = useCallback(() => {
    onSubmit(questions.map((question) => {
      const value = drafts[question.id];
      const answer: UserChoiceAnswer = { id: question.id, selected: [...value.selected] };
      if (value.otherSelected && value.custom.trim()) answer.custom = value.custom.trim();
      return answer;
    }));
  }, [drafts, onSubmit, questions]);

  const focusInput = useCallback(() => {
    const el = inputRef.current;
    if (!el || document.activeElement === el) return;
    programmaticFocusRef.current = true;
    el.focus();
  }, []);

  const handleOptionClick = useCallback((label: string, isOther: boolean) => {
    const question = current;
    const value = drafts[question.id];
    let next: Draft;

    if (question.multi_select) {
      if (isOther) {
        next = { ...value, otherSelected: !value.otherSelected, custom: value.otherSelected ? '' : value.custom };
      } else {
        next = {
          ...value,
          selected: value.selected.includes(label)
            ? value.selected.filter((item) => item !== label)
            : [...value.selected, label],
        };
      }
    } else if (isOther) {
      next = { ...value, selected: [], otherSelected: true };
    } else {
      next = { ...value, selected: [label], otherSelected: false, custom: '' };
    }

    updateDraft(question.id, next);

    const willAnswer = next.selected.length > 0
      || (next.otherSelected && next.custom.trim().length > 0);

    if (!question.multi_select && !isOther && !isLast) {
      goTo(index + 1, willAnswer);
      setTimeout(focusInput, 0);
      return;
    }
    setTimeout(focusInput, 0);
  }, [current, drafts, focusInput, goTo, index, isLast, updateDraft]);

  // 用户主动聚焦输入框即视为选择「其他」：单选清空普通选项，多选保留。
  const handleCustomFocus = useCallback(() => {
    if (programmaticFocusRef.current) {
      programmaticFocusRef.current = false;
      return;
    }
    const question = current;
    const value = drafts[question.id];
    if (value.otherSelected) return;
    updateDraft(question.id, {
      ...value,
      otherSelected: true,
      selected: question.multi_select ? value.selected : [],
    });
  }, [current, drafts, updateDraft]);

  const handleCustomChange = useCallback((value: string) => {
    const question = current;
    const previous = drafts[question.id];
    const next: Draft = { ...previous, custom: value };
    if (value.trim()) {
      next.otherSelected = true;
      if (!question.multi_select) next.selected = [];
    } else {
      next.otherSelected = false;
    }
    updateDraft(question.id, next);
  }, [current, drafts, updateDraft]);

  const handleCustomKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    if (isLast) submit();
    else goTo(index + 1, answered(current));
  }, [answered, current, goTo, index, isLast, submit]);

  const options = (current.options ?? []).map((option) => ({ ...option, isOther: false }));
  if (options.length > 0) {
    options.push({
      label: t('userChoice.other'),
      description: t('userChoice.otherDescription'),
      isOther: true,
    });
  }

  const progressColor = (question: UserChoiceQuestion): string => {
    if (answered(question)) return colors.harness;
    if (skipped.has(question.id)) return colors.timelineStatusRunning;
    return colors.border;
  };

  return (
    <div
      className="user-choice-overlay max-w-[680px] mx-auto rounded-lg border-2 transition-colors focus:outline-none"
      style={{
        backgroundColor: 'transparent',
        borderColor: colors.border,
      }}
    >
      <div className="px-3 pt-2">
        {current.header && (
          <div className="text-xs font-semibold mb-1" style={{ color: colors.harness }}>
            {current.header}
          </div>
        )}
        <div className="text-sm whitespace-pre-wrap pb-2" style={{ color: colors.textPrimary }}>
          {current.question}
        </div>

        {options.length > 0 && (
          <div className="flex flex-col gap-1.5 pb-2">
            {options.map((option) => {
              const selected = option.isOther
                ? draft.otherSelected
                : draft.selected.includes(option.label);
              return (
                <button
                  key={option.isOther ? '__other__' : option.label}
                  type="button"
                  onClick={() => handleOptionClick(option.label, option.isOther)}
                  className="user-choice-button w-full px-3 py-[9px] rounded-lg text-left text-sm leading-[1.5] transition-all"
                  style={{
                    backgroundColor: selected ? colors.primaryFrame : 'transparent',
                    color: colors.textPrimary,
                    border: `1px solid ${selected ? colors.harness : colors.border}`,
                  }}
                >
                  <div className="flex items-start gap-2">
                    <span
                      aria-hidden
                      style={{
                        width: 16,
                        height: 16,
                        marginTop: 2,
                        flexShrink: 0,
                        borderRadius: current.multi_select ? 4 : '50%',
                        border: `2px solid ${selected ? colors.harness : colors.border}`,
                        display: 'grid',
                        placeItems: 'center',
                      }}
                    >
                      {selected && (
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: current.multi_select ? 2 : '50%',
                            background: colors.harness,
                            display: 'block',
                          }}
                        />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className="font-medium leading-[1.5] block"
                        style={{ color: option.isOther ? colors.textSystem : colors.textPrimary }}
                      >
                        {option.label}
                      </span>
                      {option.description && (
                        <span className="text-xs opacity-80 leading-[1.5] block whitespace-pre-wrap break-words">
                          {option.description}
                        </span>
                      )}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <div className="pb-2">
          <TextareaAutosize
            ref={inputRef}
            value={draft.custom}
            onChange={(e) => handleCustomChange(e.target.value)}
            onFocus={handleCustomFocus}
            onKeyDown={handleCustomKeyDown}
            placeholder={isLast
              ? t('userChoice.questionPlaceholderLast')
              : t('userChoice.questionPlaceholder')}
            className="w-full resize-none focus:outline-none text-sm rounded-lg"
            style={{
              backgroundColor: 'transparent',
              color: colors.textPrimary,
              border: `1px solid ${colors.border}`,
              padding: '10px 12px',
              lineHeight: '1.5',
              display: 'block',
            }}
            minRows={1}
            maxRows={12}
          />
        </div>
      </div>

      <div className="px-3 pb-2 pt-2" style={{ borderTop: `1px solid ${colors.border}` }}>
        <div className="flex items-center justify-end gap-2 mb-1">
          <span style={{ color: colors.textSystem, fontSize: 12 }}>{index + 1} / {questions.length}</span>
        </div>

        <div className="flex gap-[3px] mb-1">
          {questions.map((question, i) => (
            <button
              key={question.id}
              type="button"
              onClick={() => goTo(i, answered(current))}
              aria-label={`${i + 1}`}
              style={{
                flex: 1,
                height: 14,
                padding: 0,
                border: 0,
                background: 'transparent',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <span
                style={{
                  display: 'block',
                  width: '100%',
                  height: 4,
                  borderRadius: 999,
                  background: progressColor(question),
                  transform: i === index ? 'scaleY(1.8)' : undefined,
                }}
              />
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={index === 0}
            onClick={() => goTo(index - 1, answered(current))}
            className="px-3 py-[7px] rounded-lg text-sm"
            style={{ border: `1px solid ${colors.border}`, color: colors.textPrimary, background: 'transparent' }}
          >
            {t('userChoice.prev')}
          </button>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => (isLast ? submit() : goTo(index + 1, answered(current)))}
            className="px-3 py-[7px] rounded-lg text-sm font-semibold"
            style={{ border: `1px solid ${colors.harness}`, color: '#fff', background: colors.harness }}
          >
            {isLast ? t('userChoice.submitAnswers') : t('userChoice.next')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default QuestionOverlay;
