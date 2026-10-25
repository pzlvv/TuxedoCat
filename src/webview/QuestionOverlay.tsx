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
 * 一次只呈现一个问题，底部固定进度条与导航；单选点击普通选项后自动进入下一页，
 * 最后一页不自动提交。有选项时末尾附「其他」卡片：指示器与内嵌输入框并排，聚焦、
 * 点击或输入都勾选「其他」，多选勾选后 checkbox 置灰锁定、与普通选项并存。
 */
const QuestionOverlay: React.FC<QuestionOverlayProps> = ({ questions, onSubmit, colors }) => {
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => createDrafts(questions));
  const [index, setIndex] = useState(0);
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => new Set());
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 程序聚焦（点选项后把焦点送进输入框）不应被当成用户主动聚焦，否则单选会立刻把
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

  const handleOptionClick = useCallback((label: string) => {
    const question = current;
    const value = drafts[question.id];

    if (question.multi_select) {
      // 多选与「其他」互不影响：切换普通选项不动勾选与文本（并存，FR-004）。
      updateDraft(question.id, {
        ...value,
        selected: value.selected.includes(label)
          ? value.selected.filter((item) => item !== label)
          : [...value.selected, label],
      });
    } else {
      updateDraft(question.id, { ...value, selected: [label], otherSelected: false, custom: '' });
    }

    if (!question.multi_select && !isLast) {
      goTo(index + 1, true);
      setTimeout(focusInput, 0);
      return;
    }
    setTimeout(focusInput, 0);
  }, [current, drafts, focusInput, goTo, index, isLast, updateDraft]);

  // 用户主动聚焦输入框即勾选「其他」：单选清空普通选项，多选保留已选普通项（并存）。
  // 程序聚焦（点选项后送入焦点）不改变选择（FR-004）。
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

  // 输入非空即勾选「其他」；多选勾选后锁定，清空文本不取消（disable，不是 Clear），
  // 单选清空文本即取消。多选下「其他」与普通选项并存，互不清除（FR-004）。
  const handleCustomChange = useCallback((value: string) => {
    const question = current;
    const previous = drafts[question.id];
    const next: Draft = { ...previous, custom: value };
    if (value.trim()) {
      next.otherSelected = true;
      if (!question.multi_select) next.selected = [];
    } else if (!question.multi_select) {
      next.otherSelected = false;
    }
    updateDraft(question.id, next);
  }, [current, drafts, updateDraft]);

  // 点击「其他」卡片：未勾选时勾选并聚焦输入框（单选同时清空普通选项）；多选已勾选
  // 时再点一次即取消——清空文本、保留普通选项勾选并解锁（FR-004）。
  const handleOtherCardClick = useCallback(() => {
    const question = current;
    const value = drafts[question.id];
    if (question.multi_select) {
      if (value.otherSelected) {
        updateDraft(question.id, { ...value, otherSelected: false, custom: '' });
        return;
      }
      updateDraft(question.id, { ...value, otherSelected: true });
    } else if (!value.otherSelected) {
      updateDraft(question.id, { ...value, otherSelected: true, selected: [] });
    }
    focusInput();
  }, [current, drafts, focusInput, updateDraft]);

  const handleCustomKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    if (isLast) submit();
    else goTo(index + 1, answered(current));
  }, [answered, current, goTo, index, isLast, submit]);

  const options = current.options ?? [];
  // 多选勾选「其他」后（焦点入框 / 点卡片 / 输入非空文本）整题置灰锁定：普通选项
  // 不可再切换、已勾选保持勾选；再点一次卡片取消勾选并解锁（FR-004）。
  const otherLocked = current.multi_select && draft.otherSelected;

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
              const selected = draft.selected.includes(option.label);
              return (
                <button
                  key={option.label}
                  type="button"
                  disabled={otherLocked}
                  onClick={() => handleOptionClick(option.label)}
                  className="user-choice-button w-full px-3 py-[9px] rounded-lg text-left text-sm leading-[1.5] transition-all"
                  style={{
                    backgroundColor: selected ? colors.primaryFrame : 'transparent',
                    color: colors.textPrimary,
                    border: `1px solid ${selected ? colors.harness : colors.border}`,
                    // 「其他」勾选后整题置灰锁定：已勾选保持勾选；pointerEvents
                    // 一并压掉 hover 与误点击。
                    opacity: otherLocked ? 0.5 : 1,
                    cursor: otherLocked ? 'default' : undefined,
                    pointerEvents: otherLocked ? 'none' : undefined,
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
                        style={{ color: colors.textPrimary }}
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

            {/* 「其他」卡片（FR-004）：指示器与内嵌输入框并排，占位符以「其它」开头；
                多选勾选后整题置灰锁定，再点一次卡片取消勾选并解锁。 */}
            <div
              className="user-choice-button w-full px-3 py-[9px] rounded-lg text-left text-sm leading-[1.5] transition-all"
              onClick={handleOtherCardClick}
              style={{
                backgroundColor: draft.otherSelected ? colors.primaryFrame : 'transparent',
                color: colors.textPrimary,
                border: `1px solid ${draft.otherSelected ? colors.harness : colors.border}`,
                cursor: 'pointer',
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
                    border: `2px solid ${draft.otherSelected && !current.multi_select ? colors.harness : colors.border}`,
                    display: 'grid',
                    placeItems: 'center',
                  }}
                >
                  {draft.otherSelected && (
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: current.multi_select ? 2 : '50%',
                        background: current.multi_select ? colors.textSystem : colors.harness,
                        display: 'block',
                      }}
                    />
                  )}
                </span>
                <TextareaAutosize
                  ref={inputRef}
                  value={draft.custom}
                  onChange={(e) => handleCustomChange(e.target.value)}
                  onFocus={handleCustomFocus}
                  onKeyDown={handleCustomKeyDown}
                  // 点击输入框只做编辑：阻断冒泡，否则锁定态下点进输入框会触发卡片
                  // 的「再点一次取消」，把已输入的文本清掉。
                  onClick={(e) => e.stopPropagation()}
                  placeholder={isLast
                    ? t('userChoice.otherPlaceholderLast')
                    : t('userChoice.otherPlaceholder')}
                  className="min-w-0 flex-1 resize-none focus:outline-none text-sm"
                  style={{
                    backgroundColor: 'transparent',
                    color: colors.textPrimary,
                    border: 'none',
                    padding: 0,
                    lineHeight: '1.5',
                    display: 'block',
                  }}
                  minRows={1}
                  maxRows={12}
                />
              </div>
            </div>
          </div>
        )}

        {/* 纯文本问题没有「其他」概念，保持独立输入框（FR-004：输入框始终显示）。 */}
        {options.length === 0 && (
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
        )}
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
