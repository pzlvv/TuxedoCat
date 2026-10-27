---
status: 已修
---

# 缺陷：查看器窗口缺后台节流豁免，失焦期间刷新被压到重新聚焦

specs/018 定义的三类文件监听刷新面（文件树、文档视图、内置查看器）中，主窗口子视图
（侧栏 / 标题栏 / 聊天 webview）都带 `backgroundThrottling: false` 并注释了真实事故
（「窗口失焦/被遮挡时暂停渲染导致整个页面空白，调整窗口大小后才恢复」），唯独三个
查看器窗口（Markdown 预览 / 图片查看器 / Monaco 查看）创建时漏了该字段。真实机器上
窗口被遮挡 / 最小化后渲染进程进入后台态，Monaco 的 `model.setValue` 已落但重渲染经
rAF 调度不执行、所有面的重绘被合成器压到窗口重新可见——表现即「聚焦后才刷新」
（用户报告 + 代码走读定位，TODO.md 评估项）。

## 现状

- 三个查看器窗口的 `webPreferences` 无 `backgroundThrottling` 字段：
  `electron/ElectronUIHost.ts` 的 `openImagePreviewWindow` / `openMarkdownPreviewWindow` /
  `openMonacoWindow` 三处 `new BrowserWindowCtor`。
- 应用其余内容视图全部带该字段：侧栏 / 标题栏 / 标题栏下拉菜单（`electron/main.ts`
  三处）、聊天视图与占位页（`electron/ChatViewManager.ts` 两处）、托盘声音窗
  （`electron/traySoundWindow.ts`）——注释记录的「整页空白 / 恢复后不重绘」在本应用
  真实发生过，三个查看器是仅有的缺失位点。
- 机制差异决定症状可见性：Markdown / 图片的刷新投递在 IPC 到达即同步改 DOM
  （`electron/markdownPreload.ts` 的 innerHTML 替换、`electron/imageViewerPreload.ts`
  的 `img.src`），DOM 不停但**绘制**停；Monaco 的 `onRefresh` 同步 `model.setValue`
  （`electron/monaco/main.ts`），但 Monaco 视图重渲染由内部 rAF 调度，后台态下
  rAF 停摆，视图 DOM 停在旧内容。两者在用户眼里都是「回窗才见新内容」。
- 复现路径（真实机器）：打开任一查看器 → 窗口最小化或被其它窗口完全遮挡 → 外部
  修改被监听文件 → 主进程监听链路照常读到新内容并投递（`electron/viewerWatch.ts`
  的串行链在主进程，不受节流影响）→ 切回窗口才看到刷新。
- 评估期间实测（本机 Windows / Electron 44，三组 e2e 探测）：e2e 环境因 Playwright
  CDP 附加豁免渲染进程后台化——最小化 + 关焦点仿真 + 原始 CDP 读写下，页面
  `visibilityState` 恒为 `visible`、rAF 满帧推进；运行时 API 也读不到该字段
  （`webContents.getLastWebPreferences()` 返回的 15 个键里无 `backgroundThrottling`）。
  行为级红绿在本仓库 e2e 车道不可行，回归测试落点改为共享工厂 + 单测锁。

## 期望

1. 三个查看器窗口的 webPreferences 带 `backgroundThrottling: false`，三处内联对象
   收敛到共享工厂 `electron/viewerWindowPrefs.ts`（同一字段只有一处定义），各窗口的
   `preload` / `sandbox` / `contextIsolation` / `nodeIntegration` 逐字段保持原值。
2. 不引入 app 级 `CalculateNativeWinOcclusion` 禁用（TODO 评估里的「必要时」项）：
   `backgroundThrottling: false` 的契约是「页面无论可见性都按前台行为运行」，逐视图
   生效已覆盖全部刷新面；全局关遮挡跟踪影响面大（内存 / 电池 / 既有 bug 掩蔽），
   无对应实证，不采纳。
3. 不改刷新链路对 rAF 的依赖（TODO 评估里的「去 rAF 强依赖」项）：flag 生效时
   隐藏态 rAF 照常触发；三类面的投递路径本身是同步 DOM 更新，无需改造。侧栏文件树 /
   文档视图已带 flag（评估期间实测最小化下 Write 新建自动进树），不在本次范围。

## 不变量

- 各窗口 `preload` / `sandbox` / `contextIsolation` / `nodeIntegration` 取值逐字段不变
  （e2e 的 US-38 用例验证窗口实际行为，不因工厂收敛漂移）。
- specs/018 刷新语义不变：内容判重、标题标记、滚动 / 缩放 / 光标保持、单窗口名额顶替、
  Core 重启重注册（`electron/viewerWatch.ts`）。
- 主窗口子视图与托盘窗既有的 `backgroundThrottling: false` 位点不动。

## 回归测试

- **RT-1**：工厂对三个查看器窗口（markdown / image / text）返回
  `backgroundThrottling === false`，且 `preload` / `sandbox` / `contextIsolation` /
  `nodeIntegration` 与原内联取值一致（落点：`src/test/viewerWindowPrefs.test.ts`
  「三个查看器窗口的 webPreferences 关闭后台节流」）。
- 行为面回归：specs/018 既有 e2e 刷新用例（`e2e/electron/preview.spec.ts` 的
  Markdown / 图片 / Monaco 刷新三例）验证修复不破坏可见态刷新链路；「失焦期间刷新」
  的行为断言因 e2e 环境豁免后台化不可行（见现状末条），flag 契约由 Electron 文档保证。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1（修复前） | `npm run test:unit -- viewerWindowPrefs` | 红 | TS2307：`electron/viewerWindowPrefs` 模块尚不存在，编译期失败 |
| RT-1（修复后） | `npm run test:unit -- viewerWindowPrefs` | 绿 | 12 断言全通过；markdown 分支补写显式 `contextIsolation: true` / `nodeIntegration: false`（原靠 Electron 默认值，行为等价） |
| 既有回归（查看器刷新） | `npx playwright test --project=electron-app e2e/electron/preview.spec.ts` | 绿 | 5 通过：Markdown / 图片 / Monaco 刷新、单实例顶替、位置记忆 |
| 既有回归（双击开窗） | `npx playwright test --project=electron-app e2e/electron/fileExplorer.spec.ts -g 双击` | 绿 | 5 通过：文本 / Markdown / 图片分流与窗口行为 |
| 类型 / lint | `npm run check-types && npm run lint` | 绿 | 三份 tsconfig 全过、eslint 无报错 |
| 失焦行为断言 | — | not-run | e2e 环境因 Playwright CDP 附加豁免渲染进程后台化（评估期间三组探测：最小化 + 关焦点仿真 + 原始 CDP 读写，页面恒 `visible`、rAF 满帧），行为级红绿不可行；`backgroundThrottling: false` 的失焦契约由 Electron 文档保证 |
