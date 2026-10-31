import React from 'react';
import { Icon } from '../Icon';
import { ToolCallProps } from './Types';
import { ToolHeader } from './ToolHeader';
import { postMessage } from '../webviewEnv';
import { t } from '../i18n';
import { resolveReadSelection, wslToWindowsPath } from '../readFileCard';

export const ReadFile: React.FC<ToolCallProps> = ({ args, colors }) => {
  const filePath = args?.file_path || args?.path;
  const offset = typeof args?.offset === 'string' ? parseInt(args.offset, 10) : args?.offset;
  const limit = typeof args?.limit === 'string' ? parseInt(args.limit, 10) : args?.limit;

  if (!filePath) {
    return (
      <div
        className="inline-flex items-center gap-2 px-2 py-1 rounded ui-fs-12"
        style={{
          color: colors.textPrimary,
        }}
      >
        <Icon name="file" size={12} />
        <span style={{ fontWeight: 600, color: colors.textPrimary }}>Read</span>
        <span style={{ opacity: 0.5 }}>{t('tool.readFile.unknownFile')}</span>
      </div>
    );
  }

  // 行区间是 1-based（Read 的 offset 就是 1-based 起始行号），显示与跳转共用这一份派生。
  // 没有 offset 就是整文件打开，不带选区——判空在这里，派生函数只收已归一化的数值。
  const selection = typeof offset === 'number' && Number.isFinite(offset)
    ? resolveReadSelection(offset, typeof limit === 'number' ? limit : null)
    : null;

  const handleOpenFile = () => {
    // 点击打开时，将 WSL 路径转换为 Windows 路径
    const resolvedPath = wslToWindowsPath(filePath);
    const message: {
      type: 'openFile';
      filePath: string;
      selectedLines?: { start: number; end: number };
    } = {
      type: 'openFile',
      filePath: resolvedPath,
    };

    // 有行号参数时把选区带过去（无 offset 就是整文件打开，不带 selectedLines）
    if (selection) {
      message.selectedLines = { start: selection.start, end: selection.end };
    }

    postMessage(message);
  };

  // 构建显示文本
  let displayText = filePath;
  if (selection) {
    displayText += limit !== undefined && limit > 0
      ? `:${selection.start}-${selection.end}`
      : `:${selection.start}+`;
  }

  return (
    <ToolHeader icon="File" name="Read" colors={colors}>
      <button
        onClick={handleOpenFile}
        className="hover:underline cursor-pointer"
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          color: colors.textSystem,
          font: 'inherit',
          fontSize: 'inherit',
        }}
        title={offset !== undefined || limit !== undefined
          ? t('tool.readFile.clickOpenFileLines', { path: filePath })
          : t('tool.readFile.clickOpenFile', { path: filePath })}
      >
        {displayText}
      </button>
    </ToolHeader>
  );
};
