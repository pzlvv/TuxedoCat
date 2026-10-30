---
owner: pzlvv
last_reviewed: 2026-10-31
---

# 需求基线：PyCharm 宿主（EP-15）

需求基线索引（附录 e2e 映射、未覆盖豁免段）见
[user-stories.md](../user-stories.md)。本册收录 EP-15 PyCharm 插件宿主
（[specs/035 归档](../../archive/specs/035-pycharm-plugin/spec.md)）。

### US-68 安装分发 zip 即用

作为用户，我希望把分发 zip 从磁盘装进 PyCharm 就能用，以便无需任何外部依赖与手工配置。

验收标准：

1. zip 内含插件 jar、四平台（win32/linux × x64/arm64）Core 产物 + fingerprint +
   ripgrep、webview 静态资源与图标；解压后不依赖 Node / Python / 预装 Core
   （`e2e/pycharm/pluginPackage.spec.ts`）。
2. 安装后打开工具窗口，面板完成 Core 握手进入可输入状态，全程无手工配置
   （`e2e/pycharm/pluginInIde.spec.ts`）。

### US-69 在 PyCharm 工具窗口完成对话

作为用户，我希望在 PyCharm 的工具窗口里与助手对话，以便在 IDE 内完成全部交互。

验收标准：

1. 每个 project 窗口独立面板与独立会话，工作目录取 project 内容根。
2. 消息、流式回复、工具卡片按既有 webview 行为渲染（与 VS Code 宿主同一渲染实现）
   （`e2e/pycharm/pluginInIde.spec.ts` 的对话轮断言）。

### US-70 manual 模式 Edit / Write 的 IDE diff 确认

作为用户，我希望 manual 模式下 Edit / Write 需要确认时在 IDE 内看到 diff，以便在改动
处直接判断。

验收标准：

1. before/after 双侧 diff 视图打开且不夺焦点；Write 新建文件只展示新内容单侧。
2. 相同内容不重复打开；同一时刻至多一个 diff 视图；应答后关闭。
3. auto / risk 模式不弹 IDE diff（`e2e/pycharm/pluginInIde.spec.ts` 的 manual / auto
   两用例）。

### US-71 从卡片跳转文件改动位置

作为用户，我希望点击工具卡片上的文件路径后编辑器打开该文件并选中改动行，以便快速核对。

验收标准：

1. 编辑器打开文件、焦点切到编辑器、选中 `startLine`–`endLine` 行区间
   （`e2e/pycharm/pluginInIde.spec.ts` 的跳转用例 + idea.log 诊断）。

### US-72 与其它宿主共用配置

作为用户，我希望 PyCharm 插件与 VS Code / Electron 宿主共用一份 settings.json，以便一处
配置处处生效。

验收标准：

1. 读侧默认值与 `src/shared/settingsSnapshot.ts` 一致（Gradle 单测
   SettingsAndLockTest 锁值 + 字段名单对照）。
2. 写侧遵循共享文件写安全（跨进程锁 + 读不出拒绝写 + 原子落盘 + 内容未变不落盘），
   未知字段与键序保留（同测试文件覆盖）。
