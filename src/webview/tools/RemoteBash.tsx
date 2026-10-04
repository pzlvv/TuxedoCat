import React, { useMemo } from 'react';
import { Icon } from '../Icon';
import { ToolCallProps } from './Types';
import { ToolHeader } from './ToolHeader';
import { postMessage } from '../webviewEnv';
import { t } from '../i18n';
import { uiFontSizePx } from '../fontSize';
import { AnsiText } from '../ansi';
import { formatSize, parsePersistedOutput } from './persistedOutput';

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
          className="px-3 py-2 ui-fs-11 font-mono"
          style={{
            backgroundColor: colors.bgSecondary,
            color: colors.textSystem,
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
          </div>

          {/* 预览内容：由工具层按「前 2K + 后 2K」裁剪，这里整段渲染、不再截断 */}
          <div
            className="cursor-pointer overflow-auto"
            onClick={handleOutputClick}
            title={t('tool.bash.clickFullOutput')}
            style={{ maxHeight: 115 }}
          >
            {persistedInfo.preview.split('\n').map((line, idx) => (
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
          </div>
        </div>
      );
    }

    // 普通输出：内容已由工具层按统一上限裁剪，整段渲染 + 滚动
    const lines = output.split('\n');

    return (
      <div
        className="px-3 py-2 ui-fs-11 font-mono cursor-pointer overflow-auto"
        style={{
          backgroundColor: colors.bgSecondary,
          color: colors.textSystem,
          maxHeight: 115,
        }}
        onClick={handleOutputClick}
        title={t('tool.bash.clickFullOutput')}
      >
        {lines.map((line, idx) => (
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
              fontSize: uiFontSizePx(11),
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
              className="ui-fs-12 font-mono truncate cursor-pointer text-left w-full"
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
            <Icon name="copy" size={12} style={{ color: colors.textSystem }} />
          </button>
        </div>

        {/* 执行结果 */}
        {output && renderOutputContent()}
      </div>
    </div>
  );
};
