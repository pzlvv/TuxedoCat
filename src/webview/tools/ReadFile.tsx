import React from 'react';
import { File } from 'lucide-react';
import { ToolCallProps } from './Types';
import { ToolHeader } from './ToolHeader';
import { postMessage } from '../webviewEnv';
import { t } from '../i18n';

/**
 * 将 WSL 路径 /mnt/d/xxx 转换为 Windows 路径 D:\xxx
 * 仅在 webview 环境为 Windows 时生效
 */
function wslToWindowsPath(p: string): string {
  // /mnt/d/xxx -> D:\xxx
  if (/^\/mnt\/([a-z])\//i.test(p)) {
    const drive = p[8].toUpperCase();
    return `${drive}:\\${p.slice(9).replace(/\//g, '\\')}`;
  }
  // /mnt/d -> D:\
  if (/^\/mnt\/([a-z])$/i.test(p)) {
    return `${p[5].toUpperCase()}:\\`;
  }
  return p;
}

export const ReadFile: React.FC<ToolCallProps> = ({ args, colors }) => {
  const filePath = args?.file_path || args?.path;
  const offset = typeof args?.offset === 'string' ? parseInt(args.offset, 10) : args?.offset;
  const limit = typeof args?.limit === 'string' ? parseInt(args.limit, 10) : args?.limit;

  if (!filePath) {
    return (
      <div
        className="inline-flex items-center gap-2 px-2 py-1 rounded text-[12px]"
        style={{
          color: colors.textPrimary,
        }}
      >
        <File size={12} />
        <span style={{ fontWeight: 600, color: colors.textPrimary }}>Read</span>
        <span style={{ opacity: 0.5 }}>{t('tool.readFile.unknownFile')}</span>
      </div>
    );
  }

  const handleOpenFile = () => {
    // 点击打开时，将 WSL 路径转换为 Windows 路径
    const resolvedPath = wslToWindowsPath(filePath);
    const message: any = {
      type: 'openFile',
      filePath: resolvedPath,
    };

    // 如果有行号参数，添加到消息中
    if (offset !== undefined) {
      const endLine = limit !== undefined ? offset + limit - 1 : undefined;
      message.selectedLines = {
        start: offset + 1, // 转换为 1-indexed
        end: endLine !== undefined ? endLine + 1 : offset + 1,
      };
    }

    postMessage(message);
  };

  // 构建显示文本
  let displayText = filePath;
  if (offset !== undefined || limit !== undefined) {
    const start = offset !== undefined ? offset + 1 : 1; // 转换为 1-indexed
    const end = limit !== undefined && offset !== undefined
      ? offset + limit // offset + limit - 1 + 1 = offset + limit (转换为 1-indexed)
      : undefined;

    if (end !== undefined) {
      displayText += `:${start}-${end}`;
    } else if (offset !== undefined) {
      displayText += `:${start}+`;
    }
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
