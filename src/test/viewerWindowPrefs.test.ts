import { viewerWindowWebPreferences, type ViewerWindowKind } from '../../electron/viewerWindowPrefs';
import { createChecker, runTests } from './helpers/harness';

/**
 * 查看器窗口（Monaco 文本查看 + Markdown 预览同一页面工程 / 图片查看器）的
 * webPreferences 经共享工厂创建并关闭后台节流（缺陷 viewer-refresh-stalls-when-unfocused）：
 * 缺 `backgroundThrottling: false` 时，真实机器上窗口被遮挡 / 最小化后渲染进程
 * 进入后台态——rAF 停摆、重绘压到重新可见，Monaco 的 model.setValue 已落但视图
 * 停在旧内容，表现即「聚焦后才刷新」。应用其余内容视图（侧栏 / 标题栏 / 聊天 /
 * 占位页 / 托盘窗）都带该字段并注释了真实事故，查看器是仅有的缺失位点。
 *
 * Markdown 预览窗口加载 dist/monaco/markdown.html（与文本查看器同一 vite 工程
 * 多入口、同一 monacoPreload 桥），webPreferences 与 `text` 同一形态，不设独立 kind。
 *
 * 运行方式：npm run test:unit -- viewerWindowPrefs
 */

runTests('viewerWindowPrefs', async () => {
  const { check, finish } = createChecker();

  // preload / sandbox / contextIsolation / nodeIntegration 是原内联取值（e2e 的
  // US-38 用例验证窗口行为），工厂收敛后必须逐字段保持
  const kinds: Array<{ kind: ViewerWindowKind; preload: string; sandbox: boolean }> = [
    { kind: 'image', preload: 'imageViewerPreload.cjs', sandbox: false },
    { kind: 'text', preload: 'monacoPreload.cjs', sandbox: false },
  ];
  for (const { kind, preload, sandbox } of kinds) {
    const prefs = viewerWindowWebPreferences(kind);
    check(`${kind}：backgroundThrottling 为 false（失焦期间刷新不被节流压住）`,
      prefs.backgroundThrottling === false);
    check(`${kind}：preload 指向 ${preload}`,
      typeof prefs.preload === 'string' && prefs.preload.endsWith(preload));
    check(`${kind}：sandbox 为 ${sandbox}（与原内联取值一致）`, prefs.sandbox === sandbox);
    check(`${kind}：contextIsolation 开、nodeIntegration 关（原内联取值）`,
      prefs.contextIsolation === true && prefs.nodeIntegration === false);
  }
  finish();
});
