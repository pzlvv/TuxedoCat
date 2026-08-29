import React, { useMemo } from 'react';
import { Copy, File, ExternalLink } from 'lucide-react';
import { ToolCallProps } from './Types';
import { ToolHeader } from './ToolHeader';
import { postMessage } from '../webviewEnv';
import { t } from '../i18n';
import { AnsiText } from '../ansi';

/**
 * 解析持久化输出标签
 * 格式:
 * <persisted-output>
 * Output too large (XXKB). Full output saved to: /path/to/file
 *
 * Preview (first 8KB):
 * ...preview text...
 * ...
 * </persisted-output>
 */
function parsePersistedOutput(output: string): {
  isPersisted: boolean;
  originalSize: number;
  filePath: string;
  preview: string;
  hasMore: boolean;
} | null {
  const persistedTag = '<persisted-output>';
  const closingTag = '</persisted-output>';

  const startIdx = output.indexOf(persistedTag);
  const endIdx = output.indexOf(closingTag);

  if (startIdx === -1 || endIdx === -1) {
    return null;
  }

  const body = output.slice(startIdx + persistedTag.length, endIdx).trim();

  // 解析文件路径
  // 格式: "Output too large (XXKB). Full output saved to: /path/to/file"
  const filePathMatch = body.match(/Full output saved to: (.+)$/m);
  const sizeMatch = body.match(/Output too large \((\d+)KB\)/);

  // 预览文本在 "Preview (first 8KB):" 之后
  const previewMarker = 'Preview';
  const previewMarkerIdx = body.indexOf(previewMarker);
  let preview = '';
  let hasMore = false;

  if (previewMarkerIdx !== -1) {
    // 跳过 "Preview (first 8KB):\n"
    const previewStart = body.indexOf('\n', previewMarkerIdx);
    if (previewStart !== -1) {
      preview = body.slice(previewStart + 1).trimEnd();
      // 移除末尾的 "..." 和 closing tag 之前的内容
      if (preview.endsWith('...')) {
        hasMore = true;
        preview = preview.slice(0, -3).trimEnd();
      }
      // 去掉末尾可能残留的换行
      preview = preview.replace(/\n\.\.\.$/, '');
    }
  }

  return {
    isPersisted: true,
    originalSize: sizeMatch ? parseInt(sizeMatch[1], 10) * 1024 : 0,
    filePath: filePathMatch ? filePathMatch[1] : '',
    preview,
    hasMore,
  };
}

/**
 * 格式化文件大小
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export const RemoteBash: React.FC<ToolCallProps> = ({ args, output, colors, toolCallId }) => {
  const command = args.command || '';
  const description = args.description || '';
  const host = args.host || '';
  const username = args.username || 'root';
  const port = args.port || '';

  // 构造远程连接标识: user@host 或 user@host:port
  const remoteHost = port && port !== '22' ? `${host}:${port}` : host;
  const remoteIdentity = `${username}@${remoteHost}`;

  // 构造唯一 title，编码 toolCallId 确保每个 RemoteBash 框有独立的虚拟文档
  const outputTitle = toolCallId ? `RemoteBash Output (${toolCallId})` : 'RemoteBash Output';
  const commandTitle = toolCallId ? `RemoteBash Command (${toolCallId})` : 'RemoteBash Command';

  // 解析持久化输出信息
  const persistedInfo = useMemo(() => {
    if (!output) return null;
    return parsePersistedOutput(output);
  }, [output]);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (command) {
      navigator.clipboard.writeText(command);
    }
  };

  const handleCommandClick = () => {
    if (command) {
      postMessage({
        type: 'showVirtualDocument',
        content: command,
        title: commandTitle,
        language: 'shellscript',
      });
    }
  };

  const handleOutputClick = () => {
    if (output) {
      postMessage({
        type: 'showVirtualDocument',
        content: output,
        title: outputTitle,
      });
    }
  };

  const handleOpenPersistedFile = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (persistedInfo?.filePath) {
      postMessage({
        type: 'openFile',
        filePath: persistedInfo.filePath,
      });
    }
  };

  // 构建输出内容显示
  const renderOutputContent = () => {
    if (!output) return null;

    // 如果是持久化输出，显示预览和文件链接
    if (persistedInfo) {
      const sizeStr = persistedInfo.originalSize > 0
        ? formatSize(persistedInfo.originalSize)
        : '';

      return (
        <div
          className="px-3 py-2 text-[11px] font-mono"
          style={{
            backgroundColor: colors.bgSecondary,
            color: colors.textSystem,
          }}
        >
          {/* 大小提示栏：仅保留“完整输出”按钮 */}
          <div
            className="flex items-center justify-end mb-2 pb-1.5 text-[11px]"
            style={{
              borderBottom: `1px solid ${colors.border}`,
              color: colors.textSystem,
            }}
          >
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
              <File size={10} />
              {t('tool.bash.fullOutput', { size: sizeStr })}
            </button>
          </div>

          {/* 预览内容：按行显示，最多 5 行，不换行截断 */}
          <div
            className="cursor-pointer overflow-hidden"
            onClick={handleOutputClick}
            title={t('tool.bash.clickFullOutput')}
            style={{ maxHeight: 115 }}
          >
            {(() => {
              const previewLines = persistedInfo.preview.split('\n');
              const MAX_PREVIEW_LINES = 5;
              const showTruncated = previewLines.length > MAX_PREVIEW_LINES;
              const displayLines = showTruncated ? previewLines.slice(0, MAX_PREVIEW_LINES) : previewLines;
              return (
                <>
                  {displayLines.map((line, idx) => (
                    <div
                      key={idx}
                      className="truncate"
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
                  {showTruncated && (
                    <div style={{ color: colors.textSystem, opacity: 0.7, whiteSpace: 'pre', lineHeight: '1.6' }}>
                      {t('tool.bash.previewTruncated', { count: previewLines.length, size: formatSize(persistedInfo.originalSize) })} ...
                    </div>
                  )}
                  {!showTruncated && persistedInfo.hasMore && (
                    <div style={{ color: colors.textSystem, opacity: 0.7, whiteSpace: 'pre', lineHeight: '1.6' }}>
                      ...
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      );
    }

    // 普通输出：显示前几行 + 截断指示
    const lines = output.split('\n');
    const MAX_PREVIEW_LINES = 5;
    const showTruncated = lines.length > MAX_PREVIEW_LINES;
    const previewLines = showTruncated ? lines.slice(0, MAX_PREVIEW_LINES) : lines;

    return (
      <div
        className="px-3 py-2 text-[11px] font-mono cursor-pointer overflow-hidden"
        style={{
          backgroundColor: colors.bgSecondary,
          color: colors.textSystem,
          maxHeight: 115,
        }}
        onClick={handleOutputClick}
        title={t('tool.bash.clickFullOutput')}
      >
        {previewLines.map((line, idx) => (
          <div
            key={idx}
            className="truncate"
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
        {showTruncated && (
          <div style={{ color: colors.textSystem, opacity: 0.7, whiteSpace: 'pre', lineHeight: '1.6' }}>
            {t('tool.bash.linesTotal', { count: lines.length })} ...
          </div>
        )}
        {output.length > 5000 && (
          <div className="flex items-center gap-1 mt-1.5 text-[10px]" style={{ color: colors.textSystem, opacity: 0.6 }}>
            <ExternalLink size={9} />
            {t('tool.bash.clickFullOutputSize', { size: formatSize(output.length) })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="w-full">
      {/* 第一行：工具名 + 描述 + 远程主机 */}
      <ToolHeader icon="Terminal" name="RemoteBash" colors={colors}>
        {description && (
          <span style={{ color: colors.textSystem }}>{description}</span>
        )}
        {host && (
          <span
            style={{
              color: colors.toolName,
              fontSize: '11px',
              fontFamily: 'monospace',
              whiteSpace: 'nowrap',
              opacity: 0.8,
            }}
            title={`${t('tool.remoteBash.sshConnecting', { identity: remoteIdentity })}`}
          >
            [{remoteIdentity}]
          </span>
        )}
      </ToolHeader>

      {/* 第二行：命令面板 */}
      <div
        className="w-full max-w-[95%] rounded-lg overflow-hidden mt-1"
        style={{
          backgroundColor: colors.bgSecondary,
          border: `1px solid ${colors.border}`,
        }}
      >
        {/* 命令行 */}
        <div
          className="flex items-center gap-2 px-3 border-b"
          style={{
            borderColor: colors.border,
            backgroundColor: colors.primaryFrame,
            minHeight: '32px',
          }}
        >
          <div className="flex-1 min-w-0">
            <button
              onClick={handleCommandClick}
              className="text-[12px] font-mono truncate cursor-pointer text-left w-full"
              style={{
                color: colors.textPrimary,
                background: 'none',
                border: 'none',
                padding: 0,
              }}
              title={t('tool.bash.clickFullCommand')}
            >
              {command}
            </button>
          </div>
          <button
            onClick={handleCopy}
            className="flex-shrink-0 p-1 rounded hover:bg-opacity-80 transition-colors"
            style={{ backgroundColor: 'transparent' }}
            title={t('tool.bash.copyCommand')}
          >
            <Copy size={12} style={{ color: colors.textSystem }} />
          </button>
        </div>

        {/* 执行结果 */}
        {output && renderOutputContent()}
      </div>
    </div>
  );
};
