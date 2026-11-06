import React, { useMemo } from 'react';
import { ToolCallProps } from './Types';
import { ToolHeader } from './ToolHeader';
import { t } from '../i18n';
import { uiFontSizePx } from '../fontSize';
import { parsePersistedOutput } from '../persistedOutputParse';
import { buildTransferCardModel, truncateMiddle } from '../transferCard';

/**
 * `Transfer` 工具卡片（specs/042）。
 *
 * 只做展示：两端身份、文件数与字节数、跳过的符号链接、文件清单（上限 20 条），
 * 全部来自工具入参 `toolArgs` 与结果文本——不依赖会话内额外状态，因此历史会话
 * 重开后卡片形状与传输当时一致（FR-005）。派生逻辑在 `src/webview/transferCard.ts`，
 * 组件只渲染（同一份解析也只有一处）。
 *
 * 布局：`ToolHeader` 只承载单行摘要（两端 + 统计 + 跳过项），清单在它下面独立一块——
 * `ToolHeader` 的 children 是单行 `overflow: hidden` 的省略容器，多行清单塞进去会被裁掉。
 *
 * 图标用既有的 `send`：lucide 图标集里没有专用的传输图标，新增图标要动资源生成链，
 * 与本次展示面无关。
 */
export const Transfer: React.FC<ToolCallProps> = ({ args, output, colors, status }) => {
  const model = useMemo(
    () => buildTransferCardModel(args ?? {}, output, status, (text) => parsePersistedOutput(text)?.preview ?? null),
    [args, output, status],
  );

  const display = (value: string | null): string =>
    value === null ? t('tool.transfer.currentWorkspace') : truncateMiddle(value);

  // 失败态优先：错误原文是用户最需要看的信息，统计与清单都不猜（FR-004）
  if (model.failed) {
    return (
      <ToolHeader icon="send" name="Transfer" colors={colors}>
        <span style={{ color: colors.error, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {output ?? t('tool.transfer.failed')}
        </span>
      </ToolHeader>
    );
  }

  // `→` 只出现在两端之间（放末尾会让 `当前工作区 → 当前工作区 →` 多出一个箭头）
  const endpoint = (value: string | null): React.ReactNode => (
    <span
      style={{ color: colors.textSystem, fontSize: uiFontSizePx(11), whiteSpace: 'nowrap' }}
      title={value ?? t('tool.transfer.currentWorkspace')}
    >
      {display(value)}
    </span>
  );

  return (
    <>
      <ToolHeader icon="send" name="Transfer" colors={colors}>
        {endpoint(model.source)}
        <span style={{ margin: '0 4px', color: colors.textSystem }}>→</span>
        {endpoint(model.dest)}
        {model.stats && (
          <span style={{ color: colors.textPrimary, fontSize: uiFontSizePx(11) }}>
            {t('tool.transfer.files', {
              count: String(model.stats.files),
              size: model.stats.sizeText,
            })}
          </span>
        )}
        {model.stats && model.stats.skipped > 0 && (
          <span style={{ color: colors.textSystem, marginLeft: '8px', fontSize: uiFontSizePx(11) }}>
            {t('tool.transfer.skipped', { count: String(model.stats.skipped) })}
          </span>
        )}
        {!model.stats && output && (
          // 解析不出统计（旧版本结果）：只显示原文，不猜数字
          <span style={{ color: colors.textSystem, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {output}
          </span>
        )}
      </ToolHeader>
      {model.paths.length > 0 && (
        <div
          style={{
            marginLeft: '20px',
            marginTop: '2px',
            color: colors.textSystem,
            fontSize: uiFontSizePx(11),
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
            whiteSpace: 'pre-wrap',
          }}
        >
          {/* 同一个文件在清单里出现两次时 key 会撞：按「路径 + 序号」生成，不做去重
              （工具结果怎么给就怎么显示，specs/042 边界第 3 条） */}
          {model.paths.map((path, index) => (
            <div key={`${path}#${index}`} title={path}>
              {truncateMiddle(path)}
            </div>
          ))}
          {model.moreCount > 0 && <div>{t('tool.transfer.more', { count: String(model.moreCount) })}</div>}
        </div>
      )}
    </>
  );
};
