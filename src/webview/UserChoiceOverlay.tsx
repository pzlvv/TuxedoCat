import React, { useState, useCallback, memo } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import type { UserChoiceRequest, Colors } from './types';
import { t } from './i18n';

interface UserChoiceOverlayProps {
  userChoiceRequest: UserChoiceRequest;
  onChoiceResponse: (index: number) => void;
  onSubmit: (inputValue: string) => void;
  inputFocused: boolean;
  choiceInputRef: React.RefObject<HTMLTextAreaElement | null>;
  inputSyncRef: React.MutableRefObject<string>;
  initialInputValue?: string;
  colors: Colors;
}

const UserChoiceOverlay = memo(function UserChoiceOverlay({
  userChoiceRequest,
  onChoiceResponse,
  onSubmit,
  inputFocused,
  choiceInputRef,
  inputSyncRef,
  initialInputValue,
  colors,
}: UserChoiceOverlayProps) {
  const [localChoiceInput, setLocalChoiceInput] = useState(initialInputValue || '');

  const handleChoiceClick = useCallback((index: number) => {
    onChoiceResponse(index);
  }, [onChoiceResponse]);

  // 空格 / 回车会触发 <button> 的原生 click。overlay 打开时焦点默认落在第一个选项上
  // （App.tsx 为数字键 1-9 快捷键而聚焦），一次误触即等于确认该选项，权限请求下通常是
  // 「允许」，风险最高。按产品要求禁用键盘确认：只能鼠标点击，避免误触。
  const handleButtonKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
    }
  }, []);

  const handleChoiceKeyDown = useCallback((e: React.KeyboardEvent, _index: number) => {
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      choiceInputRef.current?.focus();
      return;
    }
    handleButtonKeyDown(e);
  }, [choiceInputRef, handleButtonKeyDown]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setLocalChoiceInput(value);
    inputSyncRef.current = value;
  }, [inputSyncRef]);

  return (
    <div
      className="user-choice-overlay max-w-[680px] mx-auto rounded-lg border-2 transition-colors focus:outline-none"
      style={{
        backgroundColor: 'transparent',
        borderColor: inputFocused ? colors.borderFocus : colors.border,
      }}
    >
      {/* 选项说明 — 可滚动区域，仅消息内容滚动 */}
      <div className="choice-list overflow-y-auto px-3 pt-2 animate-fade-in">
        <div className="text-sm whitespace-pre-wrap pb-2" style={{ color: colors.textPrimary }}>
          {userChoiceRequest.message}
        </div>
      </div>

	      {/* 选项按钮 — 仅在有 choices 时显示 */}
	      {userChoiceRequest.choices && userChoiceRequest.choices.length > 0 && (
	      <div className="px-3 pb-2">
	        <div className="flex flex-col gap-1.5">
	          {userChoiceRequest.choices.map((choice, index) => (
	            <button
	              key={index}
	              onClick={() => handleChoiceClick(index)}
	              onKeyDown={(e) => handleChoiceKeyDown(e, index)}
	              className="user-choice-button user-choice-button-stagger w-full px-3 py-[9px] rounded-lg text-left text-sm leading-[1.5] transition-all"
	              style={{
	                backgroundColor: colors.primaryFrame,
	                color: colors.textPrimary,
	                border: `1px solid ${colors.border}`,
	                ['--stagger-index' as string]: index,
	              }}
	            >
	              <div className="flex items-start justify-between gap-2">
	                <span
	                  className="font-medium leading-[1.5] whitespace-nowrap overflow-hidden text-ellipsis shrink-0"
	                  style={{ maxWidth: '50%' }}
	                  title={choice.label}
	                >
	                  {index + 1} {choice.label}
	                </span>
	                {choice.description && (
	                  <span className="text-xs opacity-80 leading-[1.5] flex-1 min-w-0 whitespace-pre-wrap break-words">
	                    {choice.description}
	                  </span>
	                )}
	              </div>
	            </button>
	          ))}
	        </div>
	      </div>
	      )}

      {/* Row: 文本输入 + 提交按钮 — 固定区域 */}
      <div className="px-3 py-1 flex justify-between items-center gap-2 user-choice-button-stagger" style={{ ['--stagger-index' as string]: userChoiceRequest.choices?.length ?? 0 }}>
        <div className="flex-1 border rounded-lg overflow-hidden" style={{ borderColor: colors.border }}>
          <TextareaAutosize
            ref={choiceInputRef as React.RefObject<HTMLTextAreaElement>}
            value={localChoiceInput}
            onChange={handleInputChange}
            placeholder={t('userChoice.placeholder')}
            className="w-full resize-none focus:outline-none max-h-[200px] text-sm"
            style={{
              backgroundColor: 'transparent',
              color: colors.textPrimary,
              padding: '10px 12px',
              lineHeight: '1.5',
              display: 'block',
            }}
            minRows={1}
            maxRows={12}
          />
        </div>
        <button
          type="button"
          onClick={() => onSubmit(localChoiceInput)}
          onKeyDown={handleButtonKeyDown}
          aria-label={t('userChoice.submit')}
          className="w-8 h-8 rounded-lg flex items-center justify-center transition-all hover:brightness-110 flex-shrink-0"
          style={{
            backgroundColor: colors.harness,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>
    </div>
  );
});

export default UserChoiceOverlay;
