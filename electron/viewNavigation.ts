/**
 * 应用自有页面的导航防御（聊天视图 / 侧栏 / 标题栏 / 菜单 / 预览窗口 / 对话框共用）。
 *
 * 这些页面都随窗口注入 preload（contextBridge 暴露宿主 API）。页面一旦被拖放或脚本
 * 导航到外部站点，preload 会在新页面重跑，把宿主 API 交给外部页面；页面里的
 * `<a href>` / `window.open` 也会在应用内部打开（原地替换页面，或按 `target=_blank`
 * 新起一个 Electron 窗口）。两种后果都不该发生，所以所有应用自有 webContents 统一走这里：
 *
 * - `window.open` / `target=_blank`：一律拒绝，外部链接交给系统默认浏览器；
 * - 渲染进程发起的导航：应用内 `file://` 放行，其余拦下，外部链接交给系统默认浏览器。
 *
 * 程序化导航（`webContents.loadURL` / `loadFile`）不触发 `will-navigate`，不受影响。
 * 「用系统浏览器打开外部链接」是 UI 侧的宿主界面能力（`docs/architecture/core-ui-separation.md` 第 5 节），不进 core。
 */
import { shell, type WebContents } from 'electron';

/** 是否为需要在系统浏览器打开的外部链接（应用自身 file:// / 相对路径不算） */
function isExternalUrl(targetUrl: string): boolean {
  return /^(https?|mailto|tel):/i.test(targetUrl);
}

/**
 * 交给系统默认浏览器打开；失败只记日志——打开浏览器失败不该影响应用自身，
 * 且这里没有可用的用户提示通道（调用点在主进程，不在任何视图内）。
 */
function openInSystemBrowser(targetUrl: string, label: string, trigger: string): void {
  void shell.openExternal(targetUrl).catch((err) => {
    console.error(`[${label}] Failed to open external URL (${trigger}): ${err}`);
  });
}

/**
 * 给应用自有 webContents 装上导航防御。
 *
 * `label` 只用于日志定位来源（如 `chat-view` / `sidebar`），不参与行为判定。
 */
export function guardViewNavigation(wc: WebContents, label: string): void {
  wc.setWindowOpenHandler(({ url: targetUrl }) => {
    if (isExternalUrl(targetUrl)) openInSystemBrowser(targetUrl, label, 'window.open');
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, targetUrl) => {
    if (targetUrl.startsWith('file://')) return; // 应用内导航放行
    event.preventDefault();
    if (isExternalUrl(targetUrl)) openInSystemBrowser(targetUrl, label, 'navigate');
  });
}
