---
status: 已修
---

# 缺陷：本地查看器打开期间的修改丢失，窗口显示旧内容

[specs/018](../../docs/archive/specs/018-viewer-file-refresh/spec.md) FR-005 要求「打开过程中
发生的修改不丢失：窗口完成加载后显示最终内容。本地与远程两种后端遵循同一组行为」（AC-19）。
远程后端在注册成功后立即补读一次实现了该行为；本地后端没有——`ViewerWatchController.open`
的本地分支创建 `fs.watch` 后直接返回，不补读。

## 现状

- 本地查看器的初始内容在开窗**前**读出（`fileOpen.ts` / `ElectronUIHost` 读盘后才开窗），
  `fs.watch` 在窗口加载完成后才建立（`startViewerWatch` → `createLocalFileWatcher`），
  间隔是整段「生成 HTML / 等待窗口加载」的时间（数百毫秒）。
- 该间隔内源文件被外部修改：没有任何 watcher 事件（watcher 尚不存在），也没有补读，
  查看器一直显示打开瞬间读到的旧内容，直到下一次外部修改才纠正。
- 远程分支对称位置（`registerRemote` 注册成功后 `refreshFromSource` 补读一次）已实现，
  行为不对称违反 FR-005 的「同一组行为」。

## 期望

1. 本地查看器建立 watcher 后立即补读一次内容（`refreshFromSource`），覆盖「读盘 →
   watcher 就绪」之间的修改。
2. 内容判重语义不变：文件未变时不投递刷新、不闪动；补读失败（文件恰好被删）按既有
   读取失败标记处理。
3. 远程分支行为不变。

## 不变量

- `fs.watch` 的注册 / 注销生命周期不变（打开注册、关闭 / 顶替 / 换文件注销）。
- 内容判重（文本按字符串、图片按 data URL）与标题标记机制不变。
- 远程注册成功后的补读行为不变。

## 回归测试

- **RT-1**：本地目标 `open` 时不发任何 watcher 事件，打开期间的内容变化经补读投递
  （落点：`src/test/viewerWatch.test.ts` 的「本地打开后补读覆盖打开期间的修改」）。
- **RT-2**：本地被本地顶替时旧 watcher 关闭（落点：`src/test/viewerWatch.test.ts` 的
  「本地顶替关闭旧 watcher」；顺带修正既有用例中「顶替时关闭旧本地 watcher」名实不符的
  断言——它断言的是远程被本地顶替后新 watcher 存活）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1（修复前） | `npm run test:all -- viewerWatch` | 红 | delivered 为空，`Cannot read properties of undefined (reading 'text')` |
| RT-1 / RT-2（修复后） | `npm run test:all -- viewerWatch` | 绿 | 25 通过 / 0 失败 |
| 类型 / lint | `npm run check-types && npm run lint` | 绿 | 无 TS 报错、无 lint 报错 |
