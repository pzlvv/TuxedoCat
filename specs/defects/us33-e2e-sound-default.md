---
status: 已修
---

# 缺陷：US-33 e2e 提示音默认值断言与基线不一致（用例期待默认开启，基线为默认关闭）

`e2e/electron/desktopShell.spec.ts` 的用例「US-33 偏好设置：提示音开关与音量落盘，音量条随开关显隐」
第一条断言期待新装实例音量条可见，而现行基线与实现均为提示音默认关闭、音量条隐藏。e2e 的
electron 项目不进 CI 门禁，基线改版时这条断言没跟上，长期红着未被发现。影响面只有该用例：
实现与基线一致，不需要改任何产品代码。

## 现状

- 用例开头的断言 `await expect(dialogPage.locator('#volume-row')).toBeVisible()`（注释写
  「提示音默认开启：音量条可见（US-33 验收 4）」）必然失败：e2e 每次起全新 userData，
  `workspace-state.json` 无 `soundEnabled` 字段，偏好设置窗口按状态渲染
  `volumeRow.hidden = !state.soundEnabled`，新装实例音量条带 `hidden` 属性。
- 根因是基线与用例的时序错位，不是实现漂移：
  - 断言由提交 1669a32（2026-10-18，L2「US-33/34 基线改版」）落库，当时
    [US-33 验收 4](../../docs/features/user-stories/desktop.md#us-33-系统托盘与任务提醒)
    还没规定默认值（原文本只有「可在偏好设置窗口里开关」），实现当时默认开启，断言与
    当时的实现一致。
  - 随后 specs/016（归档提交 c564e5f，2026-10-20）把默认值决策改为关——全新安装或状态
    文件无声音字段时开关为未勾选、音量滑条 50%（AC-15，FR-006「缺失按关闭——默认不打扰」）。
    基线文本与实现（`electron/soundSettings.ts` 的 `readSoundSettings`：
    `enabled: state.soundEnabled === true`）同步改了，唯独这条 e2e 断言没跟上。
  - electron e2e 不进 CI 门禁，所以一直红着没人发现；已验证与其它改动无关：在干净
    HEAD（f855383）上复跑同样失败。
- 实现 `electron/soundSettings.ts` 与基线一致，本缺陷只涉及该用例与基线的口径对齐。

## 期望

- 用例对齐基线口径（[US-33 验收 4](../../docs/features/user-stories/desktop.md#us-33-系统托盘与任务提醒)、
  specs/016 FR-006）：新装实例提示音默认关闭，`#volume-row` 隐藏；`check()` 打开后可见，
  且 `soundEnabled` 落盘为 `true`。
- 既有覆盖语义不变地保留：关掉 → 音量条隐藏 → 落盘 `false`；打开后拖音量到 40 →
  `change` 才落盘、值为 0.4。
- 不改任何实现代码：`electron/soundSettings.ts`、偏好设置窗口渲染与落盘路径全部不动。

## 不变量

- 提示音偏好的读取语义不变：开关缺失按关闭、音量缺失 / 非法按 0.5，
  `electron/soundSettings.ts` 保持纯函数（`src/test/soundSettings.test.ts` 继续覆盖）。
- 偏好设置窗口的交互语义不变：音量 `input` 事件只改显示、`change` 事件才落盘；开关
  切换即落盘。
- 落盘字段与格式不变：`workspace-state.json` 的 `soundEnabled`（布尔）与 `soundVolume`
  （0–1 数）。
- 同文件其它用例（US-31 / US-32 / US-34 / US-37 / US-39 / US-53）不动。

## 回归测试

- **RT-1**：新装实例（无 `soundEnabled` 字段）打开偏好设置 → `#volume-row` 隐藏（默认
  关闭）→ `check()` 打开 → 可见且 `soundEnabled` 落盘 `true` → `uncheck()` 关掉 → 隐藏且
  落盘 `false` → 再打开后把音量滑条拖到 40 → `change` 落盘 0.4。（落点：
  `e2e/electron/desktopShell.spec.ts`「US-33 偏好设置：提示音开关与音量落盘，音量条随开关显隐」）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npx playwright test -c e2e/playwright.config.ts --project=electron-app -g "US-33 偏好设置"` | 红 | 1 failed（20.7s）：首条断言 `expect(locator).toBeVisible() failed`——`locator('#volume-row')` 解析到 `<div hidden="" class="volume" id="volume-row">`，received hidden（e2e/electron/desktopShell.spec.ts:287） |
| 回归用例（修复后） | `npx playwright test -c e2e/playwright.config.ts --project=electron-app -g "US-33 偏好设置"` | 绿 | 1 passed（6.3s）：默认关闭（开关未勾选 + 音量条隐藏）→ `check()` 可见且落盘 `true` → `uncheck()` 隐藏且落盘 `false` → 拖音量 40（`change` 落盘）→ 0.4，全链通过 |
| docs-lint | `npm run test:all -- docs-lint` | 绿 | 缺陷规格组五节齐全 / RT 编号 / 验证记录四列与取值、「已修」落点存活（用例名与行内标识符）均通过 |
