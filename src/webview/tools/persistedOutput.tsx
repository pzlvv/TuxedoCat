import React from 'react';
import { Icon } from '../Icon';
import { postMessage } from '../webviewEnv';
import { t } from '../i18n';
import { AnsiText } from '../ansi';
import { parsePersistedOutput } from '../persistedOutputParse';

/**
 * 解析持久化输出标签（Bash / assistant 超长文本共用）。
 *
 * 解析本身在 `src/webview/persistedOutputParse.ts`（纯函数，组件与单测共用一份）；
 * 预览内容由工具层统一裁剪（见 shared/tools/toolResultStorage.ts 与
 * core-rs/src/tools.rs 的同一份格式），UI 只负责展示，不再二次截断。
 */
export { parsePersistedOutput };
export { isPersistedOutput } from '../persistedOutputParse';

/**
 * 格式化文件大小
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * 持久化输出展示组件（文件路径 + 预览）
 * 与 Bash 工具大结果持久化展示一致，用于 assistant 消息中
 * 被替换为 `<persisted-output>` 的超大文本（如 Web Search 后模型输出）。
 */
export const PersistedOutputBox: React.FC<{
  content: string;
  colors: any;
}> = ({ content, colors }) => {
  const parsed = React.useMemo(() => parsePersistedOutput(content), [content]);
  if (!parsed) return null;

  const sizeStr = parsed.originalSize > 0 ? formatSize(parsed.originalSize) : '';

  const handleOpenPersistedFile = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (parsed.filePath) {
      postMessage({
        type: 'openFile',
        filePath: parsed.filePath,
      });
    }
  };

  // 预览已由工具层按统一上限裁剪（4K：前 2K + 后 2K），这里整段渲染、不再截断。
  const previewLines = parsed.preview.split('\n');

  return (
    <div
      className="px-3 py-2 ui-fs-11 font-mono"
      style={{
        backgroundColor: colors.bgSecondary,
        color: colors.textSystem,
        border: `1px solid ${colors.border}`,
        borderRadius: '8px',
        marginTop: '4px',
      }}
    >
      {/* 大小提示栏：仅保留“完整输出”按钮 */}
      <div
        className="flex items-center justify-end mb-2 pb-1.5 ui-fs-11"
        style={{
          borderBottom: `1px solid ${colors.border}`,
          color: colors.textSystem,
        }}
      >
        {parsed.filePath && (
          <button
            onClick={handleOpenPersistedFile}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded cursor-pointer hover:underline"
            style={{
              background: 'none',
              border: `1px solid ${colors.border}`,
              color: colors.harness,
              font: 'inherit',
              fontSize: 'inherit',
            }}
            title={t('tool.bash.openFullOutputFile')}
          >
            <Icon name="file" size={10} />
            {t('tool.bash.fullOutput', { size: sizeStr })}
          </button>
        )}
      </div>

      {/* 预览内容：内容已由工具层按统一上限裁剪（4K），这里只限制可视高度、可滚动，
          不再截断内容（与 Edit/Write 预览内容区同高：288px）。 */}
      <div className="overflow-auto inner-scrollbar" style={{ maxHeight: 288 }}>
        {previewLines.map((line, idx) => (
          <div
            key={idx}
            style={{
              whiteSpace: 'pre',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              lineHeight: '1.6',
            }}
          >
            <AnsiText text={line} />
          </div>
        ))}
      </div>
    </div>
  );
};
