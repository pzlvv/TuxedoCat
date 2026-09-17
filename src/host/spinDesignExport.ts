import type { SaveFileResult, UIHost } from './UIHost.js';

/**
 * 将 Spin Design 数据导出为用户选择的 spin.json。
 *
 * 宿主差异（VS Code showSaveDialog / Electron dialog）由 UIHost.saveTextFile 抽象，
 * 这里只负责 Spin 导出相关的序列化与对话框默认选项，供 WebViewUI 共用。
 */
export async function exportSpinDesignJson(
  host: UIHost,
  data: unknown,
  title: string,
): Promise<SaveFileResult> {
  return host.saveTextFile(JSON.stringify(data, null, 2) + '\n', {
    defaultFileName: 'spin.json',
    title,
    filters: [{ name: 'Spin JSON', extensions: ['json'] }],
  });
}
