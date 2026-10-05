/**
 * TuiSpinDesign - SpinDesign 契约的终端实现（docs/tui.md 第 6 节）。
 *
 * 设计器是自包含 HTML（`src/host/ui/spinDesignHtml.ts`），终端不承载；
 * open / refresh 都以 notice 显式提示「仅在 VS Code / Electron 宿主提供」——
 * 这是设计允许的能力差异而非静默降级。会话内的 Spin 运行数据仍经
 * `spinDesignDataChanged` 照常进入 store（v1 渲染为状态行之外的内容，不做设计器）。
 */

import type { SpinDesign } from '../host/SpinDesign.js';
import { tt } from '../host/i18n.js';
import type { TuiAction } from './store.js';

const UNSUPPORTED_TEXT = () =>
  tt('Spin 设计器仅在 VS Code / Electron 宿主提供', 'The Spin designer is only available in the VS Code / Electron hosts');

export class TuiSpinDesign implements SpinDesign {
  constructor(private readonly dispatch: (action: TuiAction) => void) {}

  async open(_workspacePath?: string): Promise<void> {
    this.dispatch({ type: 'tui:notice', text: UNSUPPORTED_TEXT(), level: 'info' });
  }

  async refresh(): Promise<void> {
    this.dispatch({ type: 'tui:notice', text: UNSUPPORTED_TEXT(), level: 'info' });
  }
}
